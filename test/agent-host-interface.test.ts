// @vitest-environment node

import { PassThrough } from "node:stream";
import { EventType } from "@ag-ui/core";

import { afterEach, describe, expect, it } from "vitest";

import { JsonRpcLineServer } from "../src/agent-host/json-rpc-server.js";
import type {
  AgentSessionEventListener,
  AgentSessionFactory,
  AgentSessionPort,
  AgentPermissionRequester,
} from "../src/agent-host/session.js";
import type {
  AgentInitializeParams,
} from "../src/shared/agent-host-protocol.js";
import type { AgentUiEvent } from "../src/shared/agent-ui.js";
import type {
  ConversationTodoState,
  TodoEditOperation,
} from "../src/shared/todo.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class MessageCollector {
  private buffer = "";
  private readonly messages: unknown[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(output: PassThrough) {
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length > 0) {
          this.messages.push(JSON.parse(line) as unknown);
        }
      }
      for (const listener of this.listeners) {
        listener();
      }
    });
  }

  waitFor(predicate: (message: unknown) => boolean): Promise<unknown> {
    const existing = this.messages.find(predicate);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error("Timed out waiting for Agent Host output"));
      }, 1_000);
      const check = (): void => {
        const message = this.messages.find(predicate);
        if (message !== undefined) {
          clearTimeout(timeout);
          this.listeners.delete(check);
          resolve(message);
        }
      };
      this.listeners.add(check);
    });
  }
}

class FakeAgentSession implements AgentSessionPort {
  readonly sessionId = "session-test";
  readonly sessionFile = "/tmp/session-test.jsonl";
  readonly model = { provider: "test", id: "test-model" };
  readonly thinkingLevel = "high" as const;
  readonly messages = [
    { id: "message-user", role: "user" as const, content: "Stored prompt" },
    {
      id: "message-assistant",
      role: "assistant" as const,
      content: "Stored response",
    },
  ];
  readonly userEntries = [
    { entryId: "entry-user", text: "Stored prompt" },
  ];
  interactionMode: "agent" | "plan" = "agent";
  todo: ConversationTodoState | null = null;
  readonly prompts: string[] = [];
  readonly steering: string[] = [];
  readonly followUps: string[] = [];
  readonly todoEdits: TodoEditOperation[] = [];
  readonly operations: string[] = [];
  continuationCount = 0;
  completeOnContinuation = false;
  touchTodoOnPrompt = false;
  accessRestart = false;
  disposed = false;
  blockPrompt = false;

  private readonly listeners = new Set<AgentSessionEventListener>();
  private resolvePrompt: (() => void) | undefined;

  async prompt(text: string): Promise<{ userEntryId: string }> {
    this.prompts.push(text);
    this.emit({ type: EventType.STEP_STARTED, stepName: "agent-turn" });
    if (this.blockPrompt) {
      await new Promise<void>((resolve) => {
        this.resolvePrompt = resolve;
      });
      return { userEntryId: "entry-user-live" };
    }
    if (this.touchTodoOnPrompt && this.todo !== null) {
      this.todo = { ...this.todo, revision: this.todo.revision + 1 };
    }
    this.emit({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "message-live",
      role: "assistant",
    });
    this.emit({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "message-live",
      delta: "hello",
    });
    this.emit({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "message-live",
    });
    this.emit({ type: EventType.STEP_FINISHED, stepName: "agent-turn" });
    return { userEntryId: "entry-user-live" };
  }

  updateTodo(
    input: TodoEditOperation,
  ): Promise<ConversationTodoState | null> {
    this.todoEdits.push(input);
    if (input.action === "archive") {
      this.todo = null;
      return Promise.resolve(null);
    }
    if (
      this.todo !== null &&
      input.action === "set_status" &&
      this.todo.items[0]?.id === input.itemId
    ) {
      this.todo = {
        ...this.todo,
        revision: this.todo.revision + 1,
        items: [
          {
            ...this.todo.items[0],
            status: input.status,
            ...(input.status === "blocked"
              ? { blockedReason: input.blockedReason }
              : { blockedReason: undefined }),
          },
        ],
      };
    }
    return Promise.resolve(this.todo);
  }

  archiveTodo(): null {
    this.operations.push("archive-todo");
    this.todo = null;
    return null;
  }

  continueTodos(): Promise<void> {
    this.continuationCount += 1;
    if (this.completeOnContinuation && this.todo !== null) {
      this.todo = {
        ...this.todo,
        revision: this.todo.revision + 1,
        items: this.todo.items.map((item) => ({
          ...item,
          status: "completed" as const,
          blockedReason: undefined,
        })),
      };
    }
    return Promise.resolve();
  }

  continueAfterAccess(): Promise<void> {
    this.operations.push("continue-after-access");
    return Promise.resolve();
  }

  consumeAccessRestart(): boolean {
    const requested = this.accessRestart;
    this.accessRestart = false;
    return requested;
  }

  steer(text: string): Promise<void> {
    this.steering.push(text);
    return Promise.resolve();
  }

  followUp(text: string): Promise<void> {
    this.followUps.push(text);
    return Promise.resolve();
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    this.operations.push("clear");
    const queued = {
      steering: this.steering.splice(0),
      followUp: this.followUps.splice(0),
    };
    return queued;
  }

  abort(): Promise<void> {
    this.operations.push("abort");
    this.emit({ type: EventType.STEP_FINISHED, stepName: "agent-turn" });
    this.resolvePrompt?.();
    this.resolvePrompt = undefined;
    return Promise.resolve();
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return Promise.resolve();
  }

  private emit(event: AgentUiEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

class FakeAgentSessionFactory implements AgentSessionFactory {
  readonly session = new FakeAgentSession();
  initializeParams: AgentInitializeParams | undefined;
  requestPermission: AgentPermissionRequester | undefined;

  create(
    params: AgentInitializeParams,
    requestPermission: AgentPermissionRequester,
  ): Promise<AgentSessionPort> {
    this.initializeParams = params;
    this.requestPermission = requestPermission;
    this.session.interactionMode = params.interactionMode;
    return Promise.resolve(this.session);
  }
}

const activeInputs: PassThrough[] = [];

afterEach(() => {
  for (const input of activeInputs.splice(0)) {
    input.destroy();
  }
});

function createHarness(factory: AgentSessionFactory): {
  input: PassThrough;
  collector: MessageCollector;
  run: Promise<void>;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  activeInputs.push(input);
  const collector = new MessageCollector(output);
  const server = new JsonRpcLineServer(factory, output);
  return { input, collector, run: server.run(input) };
}

function send(input: PassThrough, message: unknown): void {
  input.write(`${JSON.stringify(message)}\n`);
}

function hasId(id: number): (message: unknown) => boolean {
  return (message) => isRecord(message) && message.id === id;
}

function hasEvent(type: EventType): (message: unknown) => boolean {
  return (message) => {
    if (!isRecord(message) || message.method !== "agent.event") {
      return false;
    }
    const params = message.params;
    if (!isRecord(params) || !isRecord(params.event)) {
      return false;
    }
    return params.event.type === type;
  };
}

function hasCustomEvent(name: string): (message: unknown) => boolean {
  return (message) => {
    if (!isRecord(message) || message.method !== "agent.event") return false;
    const params = message.params;
    return (
      isRecord(params) &&
      isRecord(params.event) &&
      params.event.type === EventType.CUSTOM &&
      params.event.name === name
    );
  };
}

function hasMethod(method: string): (message: unknown) => boolean {
  return (message) => isRecord(message) && message.method === method;
}

describe("Agent Host JSON-RPC interface", () => {
  it("initializes and streams normalized prompt events", async () => {
    const factory = new FakeAgentSessionFactory();
    const { input, collector, run } = createHarness(factory);

    send(input, {
      jsonrpc: "2.0",
      id: 1,
      method: "agent.initialize",
      params: {
        cwd: process.cwd(),
        model: { provider: "test", id: "test-model" },
        apiKeys: { test: "test-key" },
        sessionDir: "/tmp/desktop-agent-sessions",
      },
    });
    const initialized = await collector.waitFor(hasId(1));
    expect(initialized).toMatchObject({
      result: {
        sessionId: "session-test",
        sessionFile: "/tmp/session-test.jsonl",
        model: { provider: "test", id: "test-model" },
        thinkingLevel: "high",
        messages: [
          { id: "message-user", role: "user", content: "Stored prompt" },
          {
            id: "message-assistant",
            role: "assistant",
            content: "Stored response",
          },
        ],
      },
    });

    send(input, {
      jsonrpc: "2.0",
      id: 3,
      method: "agent.snapshot",
      params: {},
    });
    await expect(collector.waitFor(hasId(3))).resolves.toMatchObject({
      result: {
        model: { provider: "test", id: "test-model" },
        thinkingLevel: "high",
        messages: [
          { id: "message-user", role: "user", content: "Stored prompt" },
          {
            id: "message-assistant",
            role: "assistant",
            content: "Stored response",
          },
        ],
      },
    });

    send(input, {
      jsonrpc: "2.0",
      id: 2,
      method: "agent.prompt",
      params: { text: "Say hello" },
    });

    await expect(
      collector.waitFor(hasEvent(EventType.STEP_STARTED)),
    ).resolves.toBeDefined();
    await expect(
      collector.waitFor(hasEvent(EventType.TEXT_MESSAGE_CONTENT)),
    ).resolves.toMatchObject({
      params: {
        event: {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "message-live",
          delta: "hello",
        },
      },
    });
    await expect(collector.waitFor(hasId(2))).resolves.toMatchObject({
      result: { status: "completed" },
    });
    expect(factory.session.prompts).toEqual(["Say hello"]);

    input.end();
    await run;
    expect(factory.session.disposed).toBe(true);
  });

  it("returns a resumable cancellation and accepts hidden access continuation", async () => {
    const factory = new FakeAgentSessionFactory();
    factory.session.accessRestart = true;
    const { input, collector, run } = createHarness(factory);

    send(input, {
      jsonrpc: "2.0",
      id: 1,
      method: "agent.initialize",
      params: {
        cwd: process.cwd(),
        model: { provider: "test", id: "test-model" },
        apiKeys: { test: "test-key" },
        sessionDir: "/tmp/desktop-agent-sessions",
      },
    });
    await collector.waitFor(hasId(1));
    send(input, {
      jsonrpc: "2.0",
      id: 2,
      method: "agent.prompt",
      params: { text: "Read the external reference" },
    });
    await expect(collector.waitFor(hasId(2))).resolves.toMatchObject({
      result: { status: "cancelled", userEntryId: "entry-user-live" },
    });

    send(input, {
      jsonrpc: "2.0",
      id: 3,
      method: "agent.continueAfterAccess",
      params: {},
    });
    await expect(collector.waitFor(hasId(3))).resolves.toMatchObject({
      result: { status: "completed", userEntryId: null },
    });
    expect(factory.session.operations).toContain("continue-after-access");

    input.end();
    await run;
  });

  it("accepts cancellation while a prompt request is pending", async () => {
    const factory = new FakeAgentSessionFactory();
    factory.session.blockPrompt = true;
    const { input, collector, run } = createHarness(factory);

    send(input, {
      jsonrpc: "2.0",
      id: 1,
      method: "agent.initialize",
      params: {
        cwd: process.cwd(),
        model: { provider: "test", id: "test-model" },
        apiKeys: { test: "test-key" },
        sessionDir: "/tmp/desktop-agent-sessions",
      },
    });
    await collector.waitFor(hasId(1));

    send(input, {
      jsonrpc: "2.0",
      id: 2,
      method: "agent.prompt",
      params: { text: "Wait" },
    });
    await collector.waitFor(hasEvent(EventType.STEP_STARTED));
    send(input, {
      jsonrpc: "2.0",
      id: 4,
      method: "agent.steer",
      params: { text: "Change direction" },
    });
    await expect(collector.waitFor(hasId(4))).resolves.toMatchObject({
      result: { accepted: true },
    });
    expect(factory.session.steering).toEqual(["Change direction"]);

    send(input, {
      jsonrpc: "2.0",
      id: 5,
      method: "agent.followUp",
      params: { text: "Check this afterward" },
    });
    await expect(collector.waitFor(hasId(5))).resolves.toMatchObject({
      result: { accepted: true },
    });

    send(input, {
      jsonrpc: "2.0",
      id: 6,
      method: "agent.clearQueue",
      params: {},
    });
    await expect(collector.waitFor(hasId(6))).resolves.toMatchObject({
      result: {
        steering: ["Change direction"],
        followUp: ["Check this afterward"],
      },
    });

    send(input, {
      jsonrpc: "2.0",
      id: 7,
      method: "agent.followUp",
      params: { text: "Restore this after stop" },
    });
    await collector.waitFor(hasId(7));
    send(input, {
      jsonrpc: "2.0",
      id: 3,
      method: "agent.cancel",
      params: {},
    });

    await expect(collector.waitFor(hasId(3))).resolves.toMatchObject({
      result: {
        cancelled: true,
        queued: { steering: [], followUp: ["Restore this after stop"] },
      },
    });
    expect(factory.session.operations).toEqual(["clear", "clear", "abort"]);
    await expect(collector.waitFor(hasId(2))).resolves.toMatchObject({
      result: { status: "cancelled" },
    });

    input.end();
    await run;
  });

  it("blocks a permission request until a correlated decision arrives", async () => {
    const factory = new FakeAgentSessionFactory();
    factory.session.blockPrompt = true;
    const { input, collector, run } = createHarness(factory);

    send(input, {
      jsonrpc: "2.0",
      id: 1,
      method: "agent.initialize",
      params: {
        cwd: process.cwd(),
        model: { provider: "test", id: "test-model" },
        accessMode: "ask",
        apiKeys: { test: "test-key" },
        sessionDir: "/tmp/desktop-agent-sessions",
      },
    });
    await collector.waitFor(hasId(1));
    send(input, {
      jsonrpc: "2.0",
      id: 2,
      method: "agent.prompt",
      params: { text: "Use the network" },
    });
    await collector.waitFor(hasEvent(EventType.STEP_STARTED));

    const decision = factory.requestPermission!({
      kind: "network",
      resource: "example.com:443",
      reason: "Allow this connection?",
    });
    const notification = await collector.waitFor(
      hasMethod("agent.permission.request"),
    );
    expect(notification).toMatchObject({
      params: {
        request: {
          kind: "network",
          resource: "example.com:443",
        },
      },
    });
    const requestId = (
      notification as { params: { request: { id: string } } }
    ).params.request.id;
    send(input, {
      jsonrpc: "2.0",
      id: 3,
      method: "agent.permission.resolve",
      params: { requestId, allowed: true },
    });

    await expect(collector.waitFor(hasId(3))).resolves.toMatchObject({
      result: { resolved: true },
    });
    await expect(decision).resolves.toBe(true);

    send(input, {
      jsonrpc: "2.0",
      id: 4,
      method: "agent.cancel",
      params: {},
    });
    await collector.waitFor(hasId(4));
    input.end();
    await run;
  });

  it("continues actionable todos up to three times, then yields", async () => {
    const factory = new FakeAgentSessionFactory();
    factory.session.todo = {
      revision: 1,
      title: "Build",
      items: [{ id: "todo-1", content: "Implement", status: "pending" }],
    };
    factory.session.touchTodoOnPrompt = true;
    const { input, collector, run } = createHarness(factory);

    send(input, {
      jsonrpc: "2.0",
      id: 1,
      method: "agent.initialize",
      params: {
        cwd: process.cwd(),
        model: { provider: "test", id: "test-model" },
        apiKeys: { test: "test-key" },
        sessionDir: "/tmp/desktop-agent-sessions",
      },
    });
    await collector.waitFor(hasId(1));
    send(input, {
      jsonrpc: "2.0",
      id: 2,
      method: "agent.prompt",
      params: { text: "Continue" },
    });

    await collector.waitFor(hasId(2));
    expect(factory.session.continuationCount).toBe(3);
    await expect(
      collector.waitFor(
        hasCustomEvent("desktop-agent.todo.continuation-exhausted"),
      ),
    ).resolves.toMatchObject({
      params: { event: { value: { attempts: 3 } } },
    });

    input.end();
    await run;
  });

  it("leaves refreshed actionable todos pending in Plan mode", async () => {
    const factory = new FakeAgentSessionFactory();
    factory.session.todo = {
      revision: 1,
      title: "Plan",
      items: [{ id: "todo-1", content: "Implement", status: "pending" }],
    };
    factory.session.touchTodoOnPrompt = true;
    const { input, collector, run } = createHarness(factory);

    send(input, {
      jsonrpc: "2.0",
      id: 1,
      method: "agent.initialize",
      params: {
        cwd: process.cwd(),
        model: { provider: "test", id: "test-model" },
        interactionMode: "plan",
        apiKeys: { test: "test-key" },
        sessionDir: "/tmp/desktop-agent-sessions",
      },
    });
    await collector.waitFor(hasId(1));
    send(input, {
      jsonrpc: "2.0",
      id: 2,
      method: "agent.prompt",
      params: { text: "Create a plan" },
    });

    await collector.waitFor(hasId(2));
    expect(factory.session.continuationCount).toBe(0);

    input.end();
    await run;
  });

  it.each(["agent", "plan"] as const)(
    "archives an untouched actionable todo after one %s turn",
    async (interactionMode) => {
      const factory = new FakeAgentSessionFactory();
      factory.session.todo = {
        revision: 1,
        title: "Old goal",
        items: [{ id: "todo-1", content: "Obsolete work", status: "pending" }],
      };
      const { input, collector, run } = createHarness(factory);

      send(input, {
        jsonrpc: "2.0",
        id: 1,
        method: "agent.initialize",
        params: {
          cwd: process.cwd(),
          model: { provider: "test", id: "test-model" },
          interactionMode,
          apiKeys: { test: "test-key" },
          sessionDir: "/tmp/desktop-agent-sessions",
        },
      });
      await collector.waitFor(hasId(1));
      send(input, {
        jsonrpc: "2.0",
        id: 2,
        method: "agent.prompt",
        params: { text: "A different goal" },
      });

      await collector.waitFor(hasId(2));
      expect(factory.session.todo).toBeNull();
      expect(factory.session.continuationCount).toBe(0);
      expect(factory.session.operations).toContain("archive-todo");
      await expect(
        collector.waitFor(hasCustomEvent("desktop-agent.todo.updated")),
      ).resolves.toMatchObject({
        params: { event: { value: { todo: null } } },
      });

      input.end();
      await run;
    },
  );

  it("archives a resolved todo before the next user prompt", async () => {
    const factory = new FakeAgentSessionFactory();
    factory.session.todo = {
      revision: 2,
      title: "Finished goal",
      items: [{ id: "todo-1", content: "Done", status: "completed" }],
    };
    const { input, collector, run } = createHarness(factory);

    send(input, {
      jsonrpc: "2.0",
      id: 1,
      method: "agent.initialize",
      params: {
        cwd: process.cwd(),
        model: { provider: "test", id: "test-model" },
        apiKeys: { test: "test-key" },
        sessionDir: "/tmp/desktop-agent-sessions",
      },
    });
    await collector.waitFor(hasId(1));
    send(input, {
      jsonrpc: "2.0",
      id: 2,
      method: "agent.prompt",
      params: { text: "Start something else" },
    });

    await collector.waitFor(hasId(2));
    expect(factory.session.todo).toBeNull();
    expect(factory.session.operations[0]).toBe("archive-todo");
    expect(factory.session.continuationCount).toBe(0);

    input.end();
    await run;
  });

  it("stops continuing once todo work is resolved and accepts direct edits", async () => {
    const factory = new FakeAgentSessionFactory();
    factory.session.todo = {
      revision: 1,
      title: "Build",
      items: [{ id: "todo-1", content: "Implement", status: "pending" }],
    };
    factory.session.touchTodoOnPrompt = true;
    factory.session.completeOnContinuation = true;
    const { input, collector, run } = createHarness(factory);

    send(input, {
      jsonrpc: "2.0",
      id: 1,
      method: "agent.initialize",
      params: {
        cwd: process.cwd(),
        model: { provider: "test", id: "test-model" },
        apiKeys: { test: "test-key" },
        sessionDir: "/tmp/desktop-agent-sessions",
      },
    });
    await collector.waitFor(hasId(1));
    send(input, {
      jsonrpc: "2.0",
      id: 2,
      method: "agent.prompt",
      params: { text: "Finish" },
    });
    await collector.waitFor(hasId(2));
    expect(factory.session.continuationCount).toBe(1);

    send(input, {
      jsonrpc: "2.0",
      id: 3,
      method: "agent.todo.edit",
      params: {
        action: "set_status",
        itemId: "todo-1",
        status: "pending",
      },
    });
    await expect(collector.waitFor(hasId(3))).resolves.toMatchObject({
      result: {
        todo: {
          revision: 4,
          items: [{ id: "todo-1", status: "pending" }],
        },
      },
    });
    expect(factory.session.todoEdits).toEqual([
      { action: "set_status", itemId: "todo-1", status: "pending" },
    ]);

    send(input, {
      jsonrpc: "2.0",
      id: 4,
      method: "agent.todo.edit",
      params: { action: "archive" },
    });
    await expect(collector.waitFor(hasId(4))).resolves.toMatchObject({
      result: { todo: null },
    });
    expect(factory.session.todoEdits.at(-1)).toEqual({ action: "archive" });

    input.end();
    await run;
  });

  it("rejects calls that do not match the strict interface", async () => {
    const factory = new FakeAgentSessionFactory();
    const { input, collector, run } = createHarness(factory);

    send(input, {
      jsonrpc: "2.0",
      id: 1,
      method: "agent.prompt",
      params: { text: "Before initialization" },
    });
    await expect(collector.waitFor(hasId(1))).resolves.toMatchObject({
      error: { code: -32001, message: "Agent Host is not initialized" },
    });

    send(input, {
      jsonrpc: "2.0",
      id: 2,
      method: "agent.unknown",
      params: {},
    });
    await expect(collector.waitFor(hasId(2))).resolves.toMatchObject({
      error: { code: -32601 },
    });

    input.end();
    await run;
  });
});
