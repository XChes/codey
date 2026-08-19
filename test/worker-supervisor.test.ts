// @vitest-environment node

import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkerSupervisor } from "../src/agent-host/main.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class MessageCollector {
  readonly messages: unknown[] = [];
  private readonly listeners = new Set<() => void>();

  write = (message: unknown): void => {
    this.messages.push(message);
    for (const listener of this.listeners) listener();
  };

  waitFor(
    predicate: (message: unknown) => boolean,
    occurrence = 0,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error("Timed out waiting for supervisor message"));
      }, 5_000);
      const check = (): void => {
        const matches = this.messages.filter(predicate);
        if (matches[occurrence] !== undefined) {
          clearTimeout(timeout);
          this.listeners.delete(check);
          resolve(matches[occurrence]);
        }
      };
      this.listeners.add(check);
      check();
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasId(id: number): (message: unknown) => boolean {
  return (message) => isRecord(message) && message.id === id;
}

function permissionFor(path: string): (message: unknown) => boolean {
  return (message) =>
    isRecord(message) &&
    message.method === "agent.permission.request" &&
    isRecord(message.params) &&
    isRecord(message.params.request) &&
    message.params.request.resource === path;
}

function hasMethod(method: string): (message: unknown) => boolean {
  return (message) => isRecord(message) && message.method === method;
}

async function createFakeWorker(
  directory: string,
  paths: string[],
  holdContinuation = false,
): Promise<string> {
  const path = join(directory, "fake-worker.mjs");
  await writeFile(
    path,
    [
      'import fs from "node:fs";',
      'import { createInterface } from "node:readline";',
      `const accessPaths = ${JSON.stringify(paths)};`,
      `const holdContinuation = ${JSON.stringify(holdContinuation)};`,
      "let pending;",
      "let heldContinuation;",
      "const send = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);",
      "const runTurn = (request, userEntryId) => {",
      "  for (let index = 0; index < accessPaths.length; index += 1) {",
      "    try { fs.readFileSync(accessPaths[index]); }",
      "    catch {",
      "      pending = { promptId: request.id, userEntryId };",
      '      send({ jsonrpc: "2.0", method: "agent.permission.request", params: {',
      '        request: { id: `access-${index}`, kind: "file-read", resource: accessPaths[index], reason: "Read test reference" }',
      "      }});",
      "      return;",
      "    }",
      "  }",
      '  if (holdContinuation && request.method === "agent.continueAfterAccess") {',
      "    heldContinuation = request.id;",
      '    send({ jsonrpc: "2.0", method: "test.continuation.started", params: {} });',
      "    return;",
      "  }",
      '  send({ jsonrpc: "2.0", id: request.id, result: { status: "completed", userEntryId } });',
      "};",
      "const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });",
      "for await (const line of lines) {",
      "  const request = JSON.parse(line);",
      '  if (request.method === "agent.initialize") {',
      '    const sessionFile = request.params.sessionFile ?? `${request.params.sessionDir}/fake-session.jsonl`;',
      '    fs.writeFileSync(sessionFile, fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile) : "session");',
      '    send({ jsonrpc: "2.0", id: request.id, result: {',
      '      sessionId: "fake-session", sessionFile, model: request.params.model, messages: [], userEntries: [], todo: null',
      "    }});",
      '  } else if (request.method === "agent.prompt") {',
      '    runTurn(request, "entry-original");',
      '  } else if (request.method === "agent.continueAfterAccess") {',
      "    runTurn(request, null);",
      '  } else if (request.method === "agent.permission.resolve") {',
      '    send({ jsonrpc: "2.0", id: request.id, result: { resolved: true } });',
      "    const active = pending;",
      "    pending = undefined;",
      '    send({ jsonrpc: "2.0", id: active.promptId, result: {',
      '      status: request.params.allowed ? "cancelled" : "completed", userEntryId: active.userEntryId',
      "    }});",
      '  } else if (request.method === "agent.cancel") {',
      '    send({ jsonrpc: "2.0", id: request.id, result: { cancelled: true, queued: { steering: [], followUp: [] } } });',
      "    if (heldContinuation !== undefined) {",
      '      send({ jsonrpc: "2.0", id: heldContinuation, result: { status: "cancelled", userEntryId: null } });',
      "      heldContinuation = undefined;",
      "    }",
      '  } else if (request.method === "agent.dispose") {',
      '    send({ jsonrpc: "2.0", id: request.id, result: { disposed: true } });',
      "  }",
      "}",
    ].join("\n"),
    "utf8",
  );
  return path;
}

async function send(
  supervisor: WorkerSupervisor,
  id: number,
  method: string,
  params: unknown,
): Promise<void> {
  const request = { jsonrpc: "2.0" as const, id, method, params };
  await supervisor.handle(request, JSON.stringify(request));
}

async function initialize(
  supervisor: WorkerSupervisor,
  collector: MessageCollector,
  workspace: string,
  sessionDir: string,
): Promise<void> {
  await send(supervisor, 100, "agent.boot", {
    cwd: workspace,
    accessMode: "ask",
    interactionMode: "agent",
    apiKeys: { xai: "test-key" },
    sessionDir,
  });
  const booted = await collector.waitFor(hasId(100));
  expect(booted).toMatchObject({ result: { booted: true } });
  await send(supervisor, 101, "agent.attach", {
    model: { provider: "xai", id: "grok-4.6" },
  });
  const attached = await collector.waitFor(hasId(101));
  expect(attached).toMatchObject({ result: { sessionId: "fake-session" } });
}

describe("boot/attach handshake", () => {
  it("rejects attach before boot", async () => {
    const collector = new MessageCollector();
    const supervisor = new WorkerSupervisor(
      "/nonexistent-worker.mjs",
      collector.write,
    );
    try {
      await send(supervisor, 1, "agent.attach", {
        model: { provider: "xai", id: "grok-4.6" },
      });
      await expect(collector.waitFor(hasId(1))).resolves.toMatchObject({
        error: { code: -32001 },
      });
    } finally {
      await supervisor.close();
    }
  });
});

describe("whole-worker access continuation", () => {
  it.skipIf(process.platform !== "darwin")(
    "restarts cumulatively for multiple grants and expires them after the run",
    async () => {
      const workspace = await temporaryDirectory("codey-supervisor-workspace-");
      const sessionDir = await temporaryDirectory("codey-supervisor-session-");
      const workerDir = await temporaryDirectory("codey-supervisor-worker-");
      const externalOne = join(
        await temporaryDirectory("codey-supervisor-outside-one-"),
        "one.txt",
      );
      const externalTwo = join(
        await temporaryDirectory("codey-supervisor-outside-two-"),
        "two.txt",
      );
      await writeFile(externalOne, "one");
      await writeFile(externalTwo, "two");
      const workerPath = await createFakeWorker(workerDir, [
        externalOne,
        externalTwo,
      ]);
      const collector = new MessageCollector();
      const supervisor = new WorkerSupervisor(workerPath, collector.write);

      try {
        await initialize(supervisor, collector, workspace, sessionDir);
        await send(supervisor, 2, "agent.prompt", { text: "Read both" });
        await collector.waitFor(permissionFor(externalOne));
        await send(supervisor, 10, "agent.permission.resolve", {
          requestId: "access-0",
          allowed: true,
        });
        await collector.waitFor(hasId(10));
        await collector.waitFor(permissionFor(externalTwo));
        await send(supervisor, 11, "agent.permission.resolve", {
          requestId: "access-1",
          allowed: true,
        });
        await collector.waitFor(hasId(11));
        await expect(collector.waitFor(hasId(2))).resolves.toMatchObject({
          result: { status: "completed", userEntryId: "entry-original" },
        });

        await send(supervisor, 3, "agent.prompt", { text: "Read again" });
        await collector.waitFor(permissionFor(externalOne), 1);
        await send(supervisor, 12, "agent.permission.resolve", {
          requestId: "access-0",
          allowed: false,
        });
        await expect(collector.waitFor(hasId(3))).resolves.toMatchObject({
          result: { status: "completed", userEntryId: "entry-original" },
        });
      } finally {
        await supervisor.close();
      }
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "cancels a hidden continuation and recycles the grant",
    async () => {
      const workspace = await temporaryDirectory("codey-cancel-workspace-");
      const sessionDir = await temporaryDirectory("codey-cancel-session-");
      const workerDir = await temporaryDirectory("codey-cancel-worker-");
      const external = join(
        await temporaryDirectory("codey-cancel-outside-"),
        "reference.txt",
      );
      await writeFile(external, "reference");
      const workerPath = await createFakeWorker(workerDir, [external], true);
      const collector = new MessageCollector();
      const supervisor = new WorkerSupervisor(workerPath, collector.write);

      try {
        await initialize(supervisor, collector, workspace, sessionDir);
        await send(supervisor, 2, "agent.prompt", { text: "Read it" });
        await collector.waitFor(permissionFor(external));
        await send(supervisor, 10, "agent.permission.resolve", {
          requestId: "access-0",
          allowed: true,
        });
        await collector.waitFor(hasMethod("test.continuation.started"));
        await send(supervisor, 4, "agent.cancel", {});

        await expect(collector.waitFor(hasId(4))).resolves.toMatchObject({
          result: { cancelled: true },
        });
        await expect(collector.waitFor(hasId(2))).resolves.toMatchObject({
          result: { status: "cancelled", userEntryId: "entry-original" },
        });
      } finally {
        await supervisor.close();
      }
    },
  );
});
