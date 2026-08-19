import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { rgPath as installedRipgrepPath } from "@vscode/ripgrep";

import {
  agentAttachParamsSchema,
  agentBootParamsSchema,
  agentPermissionResolveParamsSchema,
  type AgentBootParams,
  type AgentInitializeParams,
  type AgentInitializeResult,
  type AgentPromptResult,
  type JsonRpcId,
} from "../shared/agent-host-protocol.js";
// agentInitializeParamsSchema stays worker-side: the supervisor forwards the
// merged boot+attach params to its worker as one agent.initialize call.
import { taskPermissionRequestSchema } from "../shared/task.js";
import {
  delegationCompletionParamsSchema,
  delegationRequestSchema,
  delegationResolveParamsSchema,
  type DelegationOperation,
} from "../shared/agent.js";
import { PROVIDER_CREDENTIALS } from "./provider-credentials.js";
import {
  createWorkerSandboxConfig,
  isPermanentlyDeniedNetworkHost,
  isProtectedAccessPath,
  nodeCommandWithSandboxProxy,
  shellQuote,
  type WorkerFilesystemGrant,
} from "./sandbox-policy.js";
import type { AgentPermissionRequestInput } from "./session.js";

const DEFAULT_WORKER_PATH = fileURLToPath(
  new URL("./worker.mjs", import.meta.url),
);

export interface RpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params: unknown;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface WorkerHandle {
  child: ChildProcess;
  temp: string;
  expectedExit: boolean;
  appliedGrantCount: number;
}

interface LogicalRun {
  outerId: JsonRpcId;
  workerId: JsonRpcId;
  userEntryId: string | null;
  cancelled: boolean;
}

interface PendingInternal {
  resolve(message: RpcResponse): void;
  reject(error: Error): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequest(line: string): RpcRequest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.jsonrpc !== "2.0" ||
    (typeof value.id !== "string" && typeof value.id !== "number") ||
    typeof value.method !== "string"
  ) {
    return undefined;
  }
  return value as unknown as RpcRequest;
}

function writeMessage(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function writeError(id: JsonRpcId | null, code: number, message: string): void {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

function unpackedPath(path: string): string {
  return path.replace(".asar/", ".asar.unpacked/");
}

async function canonicalAccessPath(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Access path must be absolute");
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return resolve(await realpath(current), ...missing);
    } catch (error) {
      if (
        !isRecord(error) ||
        error.code !== "ENOENT" ||
        dirname(current) === current
      ) {
        throw error;
      }
      missing.unshift(basename(current));
      current = dirname(current);
    }
  }
}

function responseId(value: unknown): JsonRpcId | null | undefined {
  if (!isRecord(value) || value.jsonrpc !== "2.0") return undefined;
  return typeof value.id === "string" ||
      typeof value.id === "number" ||
      value.id === null
    ? value.id
    : undefined;
}

function workerEnvironment(
  wrapped: NodeJS.ProcessEnv,
  workerTemp: string,
  ripgrepPath: string,
  credentialKeys: string[],
): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "USER",
    "LOGNAME",
    "SHELL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "CURL_CA_BUNDLE",
    "GIT_SSL_CAINFO",
    "CARGO_HTTP_CAINFO",
    "REQUESTS_CA_BUNDLE",
  ]);
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(wrapped)) {
    if (value !== undefined && allowed.has(key)) environment[key] = value;
  }
  for (const key of credentialKeys) {
    environment[key] = "CODEY_CREDENTIAL_MASK_PENDING";
  }
  environment.PATH = [
    dirname(ripgrepPath),
    environment.PATH ??
      "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  ].join(":");
  environment.HOME = workerTemp;
  environment.TMPDIR = workerTemp;
  environment.TMP = workerTemp;
  environment.TEMP = workerTemp;
  environment.ELECTRON_RUN_AS_NODE = "1";
  environment.NODE_USE_SYSTEM_CA = "1";
  environment.CODEY_SANDBOXED_WORKER = "1";
  return environment;
}

class PermissionBroker {
  private readonly pending = new Map<string, (allowed: boolean) => void>();

  constructor(private readonly write: (value: unknown) => void) {}

  request(request: AgentPermissionRequestInput): Promise<boolean> {
    const id = randomUUID();
    this.write({
      jsonrpc: "2.0",
      method: "agent.permission.request",
      params: { request: { id, ...request } },
    });
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
    });
  }

  resolve(requestId: string, allowed: boolean): boolean {
    const resolve = this.pending.get(requestId);
    if (resolve === undefined) return false;
    this.pending.delete(requestId);
    resolve(allowed);
    return true;
  }

  denyAll(): void {
    for (const resolve of this.pending.values()) resolve(false);
    this.pending.clear();
  }
}

async function terminateWorker(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, "exit").then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 150)),
  ]);
  if (child.exitCode !== null || child.signalCode !== null) return;
  const signal = (value: NodeJS.Signals): void => {
    try {
      if (process.platform === "win32") child.kill(value);
      else process.kill(-child.pid!, value);
    } catch {
      // The worker process group may already have exited.
    }
  };
  signal("SIGTERM");
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  signal("SIGKILL");
}

export class WorkerSupervisor {
  private readonly permissionBroker: PermissionBroker;
  private readonly internal = new Map<JsonRpcId, PendingInternal>();
  private readonly fileRequests = new Map<string, WorkerFilesystemGrant>();
  private readonly grants: WorkerFilesystemGrant[] = [];
  private readonly approvedNetworkResources = new Set<string>();
  private readonly pendingDelegations = new Map<string, DelegationOperation>();
  private readonly activeDelegationIds = new Set<string>();
  private worker: WorkerHandle | undefined;
  private bootParams: AgentBootParams | undefined;
  private params: AgentInitializeParams | undefined;
  private sessionFile: string | undefined;
  private logicalRun: LogicalRun | undefined;
  private transition: Promise<void> = Promise.resolve();
  private sandboxInitialized = false;
  private closed = false;

  constructor(
    private readonly workerPath = DEFAULT_WORKER_PATH,
    private readonly write: (value: unknown) => void = writeMessage,
  ) {
    this.permissionBroker = new PermissionBroker(write);
  }

  async handle(request: RpcRequest, line: string): Promise<void> {
    await this.transition;
    if (this.bootParams === undefined) {
      await this.boot(request);
      return;
    }
    if (request.method === "agent.boot") {
      this.writeError(request.id, -32001, "Agent Host is already booted");
      return;
    }
    if (request.method === "agent.attach") {
      await this.attach(request);
      return;
    }
    if (request.method === "agent.initialize") {
      this.writeError(
        request.id,
        -32601,
        "agent.initialize is supervisor-internal; use agent.boot and agent.attach",
      );
      return;
    }
    if (request.method === "agent.permission.resolve") {
      if (await this.handlePermissionResolution(request)) return;
    }
    if (request.method === "agent.delegation.resolve") {
      const parsed = delegationResolveParamsSchema.safeParse(request.params);
      if (parsed.success) {
        const operation = this.pendingDelegations.get(parsed.data.requestId);
        this.pendingDelegations.delete(parsed.data.requestId);
        if (
          operation?.action === "run" &&
          operation.runInBackground &&
          parsed.data.result !== undefined
        ) {
          for (const delegation of parsed.data.result.delegations ?? []) {
            if (
              delegation.status === "queued" ||
              delegation.status === "running"
            ) {
              this.activeDelegationIds.add(delegation.id);
            }
          }
        }
      }
    }
    if (request.method === "agent.delegation.complete") {
      const parsed = delegationCompletionParamsSchema.safeParse(request.params);
      if (parsed.success) {
        this.activeDelegationIds.delete(parsed.data.delegation.id);
      }
    }
    if (request.method === "agent.prompt") {
      if (this.logicalRun !== undefined) {
        this.writeError(request.id, -32001, "A prompt is already active");
        return;
      }
      this.approvedNetworkResources.clear();
      this.logicalRun = {
        outerId: request.id,
        workerId: `run-${randomUUID()}`,
        userEntryId: null,
        cancelled: false,
      };
      this.sendToWorker({
        ...request,
        id: this.logicalRun.workerId,
      });
      return;
    }
    if (request.method === "agent.cancel") {
      this.permissionBroker.denyAll();
      this.pendingDelegations.clear();
      this.activeDelegationIds.clear();
      if (this.logicalRun !== undefined) this.logicalRun.cancelled = true;
      this.fileRequests.clear();
    }
    const input = this.worker?.child.stdin;
    if (input === undefined || input === null || input.destroyed) {
      // Dropping the line would leave the caller waiting forever.
      this.writeError(request.id, -32011, "Agent worker is unavailable");
      return;
    }
    input.write(`${line}\n`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.permissionBroker.denyAll();
    await this.transition.catch(() => undefined);
    await this.stopWorker();
    await this.resetSandbox();
    for (const credential of Object.values(PROVIDER_CREDENTIALS)) {
      delete process.env[credential.environmentKey];
    }
  }

  private async boot(request: RpcRequest): Promise<void> {
    if (request.method !== "agent.boot") {
      this.writeError(request.id, -32001, "Agent Host is not booted");
      return;
    }
    const parsed = agentBootParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      this.writeError(request.id, -32602, "boot params are invalid");
      return;
    }
    try {
      await mkdir(parsed.data.sessionDir, { recursive: true });
      this.bootParams = {
        ...parsed.data,
        cwd: await realpath(parsed.data.cwd),
        sessionDir: await realpath(parsed.data.sessionDir),
      };
      await this.bootWorker();
      this.write({ jsonrpc: "2.0", id: request.id, result: { booted: true } });
    } catch (error) {
      this.bootParams = undefined;
      this.writeError(
        request.id,
        -32002,
        error instanceof Error ? error.message : "Agent worker failed to boot",
      );
    }
  }

  private async attach(request: RpcRequest): Promise<void> {
    if (this.params !== undefined) {
      this.writeError(request.id, -32001, "Agent Host is already attached");
      return;
    }
    const parsed = agentAttachParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      this.writeError(request.id, -32602, "attach params are invalid");
      return;
    }
    this.params = { ...this.bootParams!, ...parsed.data };
    try {
      const result = await this.attachWorker();
      this.write({ ...result, id: request.id });
    } catch (error) {
      this.params = undefined;
      this.writeError(
        request.id,
        -32002,
        error instanceof Error ? error.message : "Agent worker failed to attach",
      );
    }
  }

  private async handlePermissionResolution(
    request: RpcRequest,
  ): Promise<boolean> {
    const parsed = agentPermissionResolveParamsSchema.safeParse(request.params);
    if (!parsed.success) return false;
    if (
      this.permissionBroker.resolve(parsed.data.requestId, parsed.data.allowed)
    ) {
      this.write({
        jsonrpc: "2.0",
        id: request.id,
        result: { resolved: true },
      });
      return true;
    }

    const grant = this.fileRequests.get(parsed.data.requestId);
    if (grant === undefined) return false;
    this.fileRequests.delete(parsed.data.requestId);
    const params = this.bootParams!;
    let canonicalGrant: WorkerFilesystemGrant | undefined;
    if (parsed.data.allowed) {
      try {
        const path = await canonicalAccessPath(grant.path);
        if (!isProtectedAccessPath(params.cwd, path)) {
          canonicalGrant = { ...grant, path };
        }
      } catch {
        // Invalid or inaccessible paths fail closed.
      }
    }
    const allowed = canonicalGrant !== undefined;
    if (canonicalGrant !== undefined) this.addGrant(canonicalGrant);
    this.sendToWorker({
      ...request,
      params: { ...parsed.data, allowed },
    });
    return true;
  }

  private addGrant(grant: WorkerFilesystemGrant): void {
    const existing = this.grants.find((candidate) => candidate.path === grant.path);
    if (existing === undefined) {
      this.grants.push(grant);
    } else if (grant.access === "write") {
      existing.access = "write";
    }
  }

  private async startWorker(): Promise<RpcResponse> {
    await this.bootWorker();
    try {
      return await this.attachWorker();
    } catch (error) {
      await this.stopWorker();
      await this.resetSandbox().catch(() => undefined);
      throw error;
    }
  }

  private async bootWorker(): Promise<void> {
    const params = this.bootParams!;
    await mkdir(params.sessionDir, { recursive: true });
    const workerTemp = await realpath(
      await mkdtemp(join(tmpdir(), "codey-worker-")),
    );
    const ripgrepPath = unpackedPath(installedRipgrepPath);
    const credentialEntries = Object.entries(params.apiKeys).map(
      ([provider, apiKey]) => {
        const credential = PROVIDER_CREDENTIALS[provider];
        if (credential === undefined) {
          throw new Error(`Unsupported credential provider: ${provider}`);
        }
        process.env[credential.environmentKey] = apiKey;
        return { provider, ...credential };
      },
    );
    const credentials = {
      envVars: credentialEntries.map((entry) => ({
        name: entry.environmentKey,
        mode: "mask" as const,
        injectHosts: entry.domains,
      })),
    };
    const allowedDomains = [
      ...new Set(credentialEntries.flatMap((entry) => entry.domains)),
    ];
    try {
      await this.resetSandbox();
      const sandboxConfig = createWorkerSandboxConfig({
        workspace: params.cwd,
        sessionDir: params.sessionDir,
        workerTemp,
        workerPath: this.workerPath,
        executablePath: process.execPath,
        ripgrepPath,
        accessMode: params.accessMode,
        interactionMode: params.interactionMode,
        agentCapability: params.agentCapability,
        grants: this.grants,
        allowedDomains,
        credentials,
      });
      await SandboxManager.initialize(
        sandboxConfig,
        async ({ host, port }) => {
          if (isPermanentlyDeniedNetworkHost(host)) return false;
          if (params.accessMode !== "ask") return true;
          if (this.logicalRun === undefined) return false;
          const resource = `${host}${port === undefined ? "" : `:${port}`}`;
          if (this.approvedNetworkResources.has(resource)) return true;
          const allowed = await this.permissionBroker.request({
            kind: "network",
            resource,
            reason: `Allow this conversation to connect to ${host}?`,
          });
          if (allowed) this.approvedNetworkResources.add(resource);
          return allowed;
        },
        // The violation log monitor spawns one `log stream` process per host
        // (~3-9% CPU each) and nothing consumes its store; keep it off.
        false,
      );
      this.sandboxInitialized = true;
      if (!SandboxManager.isSandboxingEnabled()) {
        throw new Error("Sandbox Runtime did not enable worker confinement");
      }

      const trustBundlePath = SandboxManager.getMitmCA()?.trustBundlePath;
      if (trustBundlePath === undefined) {
        throw new Error("Sandbox TLS trust bundle is unavailable");
      }
      const workerTrustBundlePath = join(workerTemp, "trust-bundle.crt");
      await copyFile(trustBundlePath, workerTrustBundlePath);
      const command = [
        `NODE_EXTRA_CA_CERTS=${shellQuote(workerTrustBundlePath)}`,
        nodeCommandWithSandboxProxy(
          [process.execPath, this.workerPath].map(shellQuote).join(" "),
        ),
      ].join(" ");
      const wrapped = await SandboxManager.wrapWithSandboxArgv(
        command,
        "/bin/bash",
        undefined,
        undefined,
        workerTemp,
        {
          commandId: `worker-${randomUUID()}`,
          commandText: "Codey agent worker",
        },
      );
      const credentialKeys = credentialEntries.map(
        (entry) => entry.environmentKey,
      );
      const executable = wrapped.argv[0];
      if (executable === undefined) {
        throw new Error("Sandbox worker command is empty");
      }
      const child = spawn(executable, wrapped.argv.slice(1), {
        cwd: workerTemp,
        env: workerEnvironment(
          wrapped.env,
          workerTemp,
          ripgrepPath,
          credentialKeys,
        ),
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (
        child.stdin === null ||
        child.stdout === null ||
        child.stderr === null
      ) {
        child.kill();
        throw new Error("Agent worker pipes are unavailable");
      }
      const handle: WorkerHandle = {
        child,
        temp: workerTemp,
        expectedExit: false,
        appliedGrantCount: this.grants.length,
      };
      this.worker = handle;
      child.stderr.pipe(process.stderr, { end: false });
      void this.consumeWorker(handle);
      child.once("exit", (code, signal) => {
        if (!handle.expectedExit && !this.closed) {
          this.failInternal(
            new Error(
              `Agent worker exited unexpectedly (${signal ?? `code ${String(code)}`})`,
            ),
          );
          process.stdin.destroy();
        }
      });
    } catch (error) {
      if (this.worker?.temp === workerTemp) await this.stopWorker();
      await this.resetSandbox().catch(() => undefined);
      await rm(workerTemp, { recursive: true, force: true });
      throw error;
    }
  }

  private async attachWorker(): Promise<RpcResponse> {
    const params = this.params!;
    const initializeResult = await this.callWorker("agent.initialize", {
      ...params,
      activeDelegationIds: [...this.activeDelegationIds],
      apiKeys: Object.fromEntries(
        Object.keys(params.apiKeys).map((provider) => [
          provider,
          "CODEY_MASKED_CREDENTIAL",
        ]),
      ),
      ...(this.sessionFile === undefined
        ? params.sessionFile === undefined
          ? {}
          : { sessionFile: params.sessionFile }
        : { sessionFile: this.sessionFile }),
    });
    if (initializeResult.error !== undefined) {
      throw new Error(initializeResult.error.message);
    }
    const parsed = initializeResult.result as AgentInitializeResult;
    if (!isRecord(parsed) || typeof parsed.sessionFile !== "string") {
      throw new Error("Agent worker returned an invalid initialize result");
    }
    this.sessionFile = parsed.sessionFile;
    return initializeResult;
  }

  private async consumeWorker(handle: WorkerHandle): Promise<void> {
    const output = handle.child.stdout;
    if (output === null) return;
    const lines = createInterface({
      input: output,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      this.handleWorkerMessage(value);
    }
  }

  private handleWorkerMessage(message: unknown): void {
    const id = responseId(message);
    if (id !== undefined && id !== null) {
      const pending = this.internal.get(id);
      if (pending !== undefined) {
        this.internal.delete(id);
        pending.resolve(message as RpcResponse);
        return;
      }
      if (this.logicalRun?.workerId === id) {
        this.transition = this.transition
          .then(() => this.handleLogicalResponse(message as RpcResponse))
          .catch((error: unknown) => this.fail(error));
        return;
      }
    }

    if (
      isRecord(message) &&
      message.method === "agent.permission.request" &&
      isRecord(message.params)
    ) {
      const parsed = taskPermissionRequestSchema.safeParse(message.params.request);
      if (
        parsed.success &&
        (parsed.data.kind === "file-read" ||
          parsed.data.kind === "file-write")
      ) {
        this.fileRequests.set(parsed.data.id, {
          path: parsed.data.resource,
          access: parsed.data.kind === "file-write" ? "write" : "read",
        });
      }
    }
    if (
      isRecord(message) &&
      message.method === "agent.delegation.request"
    ) {
      const parsed = delegationRequestSchema.safeParse(message.params);
      if (parsed.success) {
        this.pendingDelegations.set(
          parsed.data.requestId,
          parsed.data.operation,
        );
      }
    }
    this.write(message);
  }

  private async handleLogicalResponse(response: RpcResponse): Promise<void> {
    const run = this.logicalRun;
    const worker = this.worker;
    if (run === undefined || worker === undefined) return;
    const result = response.result as AgentPromptResult | undefined;
    if (
      run.userEntryId === null &&
      result !== undefined &&
      typeof result.userEntryId === "string"
    ) {
      run.userEntryId = result.userEntryId;
    }
    const restartRequired =
      !run.cancelled &&
      response.error === undefined &&
      this.grants.length > worker.appliedGrantCount;
    if (restartRequired) {
      await this.stopWorker();
      const initialized = await this.startWorker();
      if (initialized.error !== undefined) {
        this.write({ ...initialized, id: run.outerId });
        this.logicalRun = undefined;
        return;
      }
      run.workerId = `access-continuation-${randomUUID()}`;
      this.sendToWorker({
        jsonrpc: "2.0",
        id: run.workerId,
        method: "agent.continueAfterAccess",
        params: {},
      });
      return;
    }

    if (response.error !== undefined) {
      this.write({ ...response, id: run.outerId });
    } else {
      this.write({
        ...response,
        id: run.outerId,
        result: {
          ...(isRecord(response.result) ? response.result : {}),
          userEntryId: run.userEntryId,
        },
      });
    }
    this.logicalRun = undefined;
    this.fileRequests.clear();
    this.approvedNetworkResources.clear();
    if (this.grants.length > 0) {
      this.grants.splice(0);
      await this.stopWorker();
      const initialized = await this.startWorker();
      if (initialized.error !== undefined) {
        throw new Error(
          initialized.error.message || "Failed to recycle Agent worker",
        );
      }
    }
  }

  private callWorker(method: string, params: unknown): Promise<RpcResponse> {
    const id = `supervisor-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      this.internal.set(id, { resolve, reject });
      this.sendToWorker({ jsonrpc: "2.0", id, method, params });
    });
  }

  private sendToWorker(message: unknown): void {
    const input = this.worker?.child.stdin;
    if (input === null || input === undefined || input.destroyed) {
      throw new Error("Agent worker is unavailable");
    }
    input.write(`${JSON.stringify(message)}\n`);
  }

  private writeError(
    id: JsonRpcId | null,
    code: number,
    message: string,
  ): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private async stopWorker(): Promise<void> {
    const active = this.worker;
    this.worker = undefined;
    if (active === undefined) return;
    active.expectedExit = true;
    active.child.stdin?.end();
    await terminateWorker(active.child);
    await rm(active.temp, { recursive: true, force: true });
    this.failInternal(new Error("Agent worker was recycled"));
  }

  private async resetSandbox(): Promise<void> {
    if (!this.sandboxInitialized) return;
    await SandboxManager.reset();
    this.sandboxInitialized = false;
  }

  private failInternal(error: Error): void {
    for (const pending of this.internal.values()) pending.reject(error);
    this.internal.clear();
  }

  private fail(error: unknown): void {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Agent supervisor failed"}\n`,
    );
    process.exitCode = 1;
    process.stdin.destroy();
  }
}

export async function runAgentHost(): Promise<void> {
  const supervisor = new WorkerSupervisor();
  const handleSignal = (): void => {
    process.stdin.destroy();
    void supervisor.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  // If a request handler is wedged, the read loop below never observes EOF,
  // and a host outlives its dead parent. Exit on stdin close regardless,
  // with a bounded attempt to reap the worker and sandbox first.
  process.stdin.once("close", () => {
    const deadline = setTimeout(() => process.exit(1), 5_000);
    deadline.unref();
    void supervisor.close().finally(() => process.exit(0));
  });

  try {
    const lines = createInterface({
      input: process.stdin,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      const request = parseRequest(line);
      if (request === undefined) {
        writeError(null, -32700, "Invalid Agent Host request");
        continue;
      }
      await supervisor.handle(request, line);
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Agent supervisor failed"}\n`,
    );
    process.exitCode = 1;
  } finally {
    await supervisor.close();
  }
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  await runAgentHost();
}
