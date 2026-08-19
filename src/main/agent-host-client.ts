import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createInterface } from "node:readline";
import type { ZodType } from "zod";

import {
  agentBootResultSchema,
  agentCancelResultSchema,
  agentDisposeResultSchema,
  agentDelegationCompleteResultSchema,
  agentDelegationResolveResultSchema,
  agentFollowUpResultSchema,
  agentHostNotificationSchema,
  agentInitializeResultSchema,
  agentPermissionResolveResultSchema,
  agentPromptResultSchema,
  agentQueueSnapshotSchema,
  agentSnapshotResultSchema,
  agentSteerResultSchema,
  agentTodoEditResultSchema,
  jsonRpcFailureSchema,
  jsonRpcSuccessSchema,
  type AgentAttachParams,
  type AgentBootParams,
  type AgentBootResult,
  type AgentCancelResult,
  type AgentInitializeResult,
  type AgentPromptResult,
  type AgentPermissionResolveResult,
  type AgentQueueSnapshot,
  type AgentSnapshotResult,
  type AgentTodoEditResult,
} from "../shared/agent-host-protocol";
import type {
  DelegationCompletionParams,
  DelegationRequest,
  DelegationResolveParams,
} from "../shared/agent";
import type { AgentUiEvent } from "../shared/agent-ui";
import type { TaskPermissionRequest } from "../shared/task";
import type { TodoEditOperation } from "../shared/todo";

interface PendingRequest {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

export interface AgentHostClientOptions {
  entryPath: string;
  cwd: string;
  disposeTimeoutMs?: number;
  setupTimeoutMs?: number;
  cancelTimeoutMs?: number;
  onEvent?(event: AgentUiEvent): void;
  onPermissionRequest?(request: TaskPermissionRequest): void;
  onDelegationRequest?(request: DelegationRequest): void;
}

const DEFAULT_DISPOSE_TIMEOUT_MS = 5_000;
// Boot compiles a sandbox profile and spawns a worker; attach can re-parse a
// large session JSONL. Generous, but bounded: a host that exceeds this is
// wedged, and only prompt turns are allowed to run unbounded.
const DEFAULT_SETUP_TIMEOUT_MS = 60_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 10_000;

class RpcTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`Agent Host did not answer ${method} within ${String(timeoutMs)}ms`);
    this.name = "RpcTimeoutError";
  }
}

export class AgentHostClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stopping = false;
  private starting: Promise<void> | undefined;
  private eventHandler: (event: AgentUiEvent) => void;
  private permissionHandler: (request: TaskPermissionRequest) => void;
  private delegationHandler: (request: DelegationRequest) => void;
  private exitHandler: (error: Error) => void = () => undefined;
  private failureNotified = false;
  private bootedState = false;

  constructor(private readonly options: AgentHostClientOptions) {
    this.eventHandler = options.onEvent ?? (() => undefined);
    this.permissionHandler = options.onPermissionRequest ?? (() => undefined);
    this.delegationHandler = options.onDelegationRequest ?? (() => undefined);
  }

  async start(): Promise<void> {
    if (this.starting !== undefined) {
      return this.starting;
    }
    if (this.child !== undefined) {
      return;
    }

    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_USE_SYSTEM_CA: "1",
    };
    delete environment.DEEPSEEK_API_KEY;
    delete environment.OPENAI_API_KEY;
    delete environment.XAI_API_KEY;

    const child = spawn(process.execPath, [this.options.entryPath], {
      cwd: this.options.cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.stopping = false;
    this.failureNotified = false;
    this.bootedState = false;

    child.on("error", (error) => this.failTransport(error));
    child.on("exit", (code, signal) => {
      if (this.child === child) {
        this.child = undefined;
      }
      const reason = this.stopping
        ? new Error("Agent Host stopped")
        : new Error(
            `Agent Host exited unexpectedly (${signal ?? `code ${String(code)}`})`,
          );
      this.rejectPending(reason);
      if (!this.stopping) {
        this.notifyFailure(reason);
      }
    });

    const lines = createInterface({
      input: child.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    void (async () => {
      for await (const line of lines) {
        if (line.trim().length > 0) {
          this.handleLine(line);
        }
      }
    })().catch((error: unknown) => {
      this.failTransport(
        error instanceof Error ? error : new Error("Agent Host output failed"),
      );
    });

    const starting = new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      child.once("error", onError);
      child.once("spawn", () => {
        child.off("error", onError);
        resolve();
      });
    });
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) {
        this.starting = undefined;
      }
    }
  }

  setEventHandler(handler: (event: AgentUiEvent) => void): void {
    this.eventHandler = handler;
  }

  setPermissionHandler(handler: (request: TaskPermissionRequest) => void): void {
    this.permissionHandler = handler;
  }

  setDelegationHandler(handler: (request: DelegationRequest) => void): void {
    this.delegationHandler = handler;
  }

  setExitHandler(handler: (error: Error) => void): void {
    this.exitHandler = handler;
  }

  get booted(): boolean {
    return this.bootedState && this.child !== undefined;
  }

  async boot(params: AgentBootParams): Promise<AgentBootResult> {
    const result = await this.request(
      "agent.boot",
      params,
      agentBootResultSchema,
      this.options.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS,
    );
    this.bootedState = true;
    return result;
  }

  attach(params: AgentAttachParams): Promise<AgentInitializeResult> {
    return this.request(
      "agent.attach",
      params,
      agentInitializeResultSchema,
      this.options.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS,
    );
  }

  prompt(text: string): Promise<AgentPromptResult> {
    return this.request("agent.prompt", { text }, agentPromptResultSchema);
  }

  snapshot(): Promise<AgentSnapshotResult> {
    return this.request("agent.snapshot", {}, agentSnapshotResultSchema);
  }

  steer(text: string): Promise<{ accepted: true }> {
    return this.request("agent.steer", { text }, agentSteerResultSchema);
  }

  followUp(text: string): Promise<{ accepted: true }> {
    return this.request("agent.followUp", { text }, agentFollowUpResultSchema);
  }

  editTodo(input: TodoEditOperation): Promise<AgentTodoEditResult> {
    return this.request("agent.todo.edit", input, agentTodoEditResultSchema);
  }

  clearQueue(): Promise<AgentQueueSnapshot> {
    return this.request("agent.clearQueue", {}, agentQueueSnapshotSchema);
  }

  async cancel(): Promise<AgentCancelResult> {
    try {
      return await this.request(
        "agent.cancel",
        {},
        agentCancelResultSchema,
        this.options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS,
      );
    } catch (error) {
      if (error instanceof RpcTimeoutError) {
        // Cooperative cancellation failed; kill the host, which tears down
        // the whole sandbox process tree. The pending prompt rejects on exit
        // and the run settles through the normal failure path.
        this.terminate();
        return { cancelled: true, queued: { steering: [], followUp: [] } };
      }
      throw error;
    }
  }

  resolvePermission(
    requestId: string,
    allowed: boolean,
  ): Promise<AgentPermissionResolveResult> {
    return this.request(
      "agent.permission.resolve",
      { requestId, allowed },
      agentPermissionResolveResultSchema,
    );
  }

  resolveDelegation(
    params: DelegationResolveParams,
  ): Promise<AgentPermissionResolveResult> {
    return this.request(
      "agent.delegation.resolve",
      params,
      agentDelegationResolveResultSchema,
    );
  }

  completeDelegation(
    params: DelegationCompletionParams,
  ): Promise<{ accepted: true }> {
    return this.request(
      "agent.delegation.complete",
      params,
      agentDelegationCompleteResultSchema,
    );
  }

  async dispose(): Promise<void> {
    const child = this.child;
    if (child === undefined) {
      return;
    }

    this.stopping = true;
    try {
      // The farewell is best-effort: a wedged host must never block disposal,
      // so the request is bounded and the host is killed regardless.
      await Promise.race([
        this.request("agent.dispose", {}, agentDisposeResultSchema),
        new Promise<void>((resolve) => {
          const timer = setTimeout(
            resolve,
            this.options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS,
          );
          timer.unref?.();
        }),
      ]);
    } catch {
      // Disposal never throws; the kill below reclaims the host either way.
    } finally {
      child.stdin.end();
      child.kill();
    }
  }

  terminate(): void {
    this.stopping = true;
    this.child?.kill();
  }

  private request<Result>(
    method: string,
    params: unknown,
    resultSchema: ZodType<Result>,
    timeoutMs?: number,
  ): Promise<Result> {
    const child = this.child;
    if (child === undefined || child.stdin.destroyed) {
      return Promise.reject(new Error("Agent Host is not running"));
    }

    const id = this.nextRequestId++;
    return new Promise<Result>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(new RpcTimeoutError(method, timeoutMs));
          }
        }, timeoutMs);
        timer.unref?.();
      }
      this.pending.set(id, {
        resolve: (result) => {
          if (timer !== undefined) clearTimeout(timer);
          const parsed = resultSchema.safeParse(result);
          if (!parsed.success) {
            reject(new Error(`Invalid ${method} result from Agent Host`));
            return;
          }
          resolve(parsed.data);
        },
        reject: (error) => {
          if (timer !== undefined) clearTimeout(timer);
          reject(error);
        },
      });

      try {
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
      } catch (error) {
        if (timer !== undefined) clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("Agent Host write failed"));
      }
    });
  }

  private handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      this.failTransport(new Error("Agent Host emitted invalid JSON"));
      return;
    }

    const notification = agentHostNotificationSchema.safeParse(value);
    if (notification.success) {
      switch (notification.data.method) {
        case "agent.event":
          this.eventHandler(notification.data.params.event);
          break;
        case "agent.permission.request":
          this.permissionHandler(notification.data.params.request);
          break;
        case "agent.delegation.request":
          this.delegationHandler(notification.data.params);
          break;
      }
      return;
    }

    const success = jsonRpcSuccessSchema.safeParse(value);
    if (success.success && typeof success.data.id === "number") {
      const pending = this.pending.get(success.data.id);
      if (pending !== undefined) {
        this.pending.delete(success.data.id);
        pending.resolve(success.data.result);
      }
      return;
    }

    const failure = jsonRpcFailureSchema.safeParse(value);
    if (failure.success && typeof failure.data.id === "number") {
      const pending = this.pending.get(failure.data.id);
      if (pending !== undefined) {
        this.pending.delete(failure.data.id);
        pending.reject(
          new Error(
            `Agent Host error ${failure.data.error.code}: ${failure.data.error.message}`,
          ),
        );
      }
      return;
    }

    this.failTransport(new Error("Agent Host emitted an invalid protocol message"));
  }

  private failTransport(error: Error): void {
    this.rejectPending(error);
    if (!this.stopping) {
      this.notifyFailure(error);
    }
    this.child?.kill();
  }

  private notifyFailure(error: Error): void {
    if (this.failureNotified) return;
    this.failureNotified = true;
    this.exitHandler(error);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      request.reject(error);
    }
    this.pending.clear();
  }
}
