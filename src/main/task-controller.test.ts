// @vitest-environment node

import { EventType } from "@ag-ui/core";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionReference } from "../shared/agent-host-protocol";
import {
  AGENT_UI_CUSTOM_EVENT,
  type AgentUiEvent,
} from "../shared/agent-ui";
import { DEFAULT_THINKING_LEVEL } from "../shared/models";
import {
  TaskController,
  type AgentConnection,
} from "./task-controller";

class FakeAgentConnection implements AgentConnection {
  bootedWith: Parameters<AgentConnection["boot"]>[0] | undefined;
  attachedWith: Parameters<AgentConnection["attach"]>[0] | undefined;
  promptedWith: string | undefined;
  steeredWith: string | undefined;
  followedUpWith: string | undefined;
  queued = { steering: [] as string[], followUp: [] as string[] };
  terminated = false;
  booted = false;
  private exitHandler: ((error: Error) => void) | undefined;

  private resolvePrompt:
    | ((result: { status: "completed" | "cancelled"; userEntryId: string | null }) => void)
    | undefined;
  private rejectPrompt: ((error: Error) => void) | undefined;

  constructor(private readonly onEvent: (event: AgentUiEvent) => void) {}

  start(): Promise<void> {
    return Promise.resolve();
  }

  setExitHandler(handler: (error: Error) => void): void {
    this.exitHandler = handler;
  }

  boot(
    params: Parameters<AgentConnection["boot"]>[0],
  ): ReturnType<AgentConnection["boot"]> {
    this.bootedWith = params;
    this.booted = true;
    return Promise.resolve({ booted: true });
  }

  attach(
    params: Parameters<AgentConnection["attach"]>[0],
  ): ReturnType<AgentConnection["attach"]> {
    this.attachedWith = params;
    return Promise.resolve({
      sessionId: "session-1",
      sessionFile: params.sessionFile ?? "/tmp/pi-sessions/session-1.jsonl",
      model: params.model ?? {
        provider: "deepseek",
        id: "deepseek-v4-flash",
      },
      thinkingLevel: params.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
      messages: [
        { id: "user-1", role: "user", content: "Stored prompt" },
        { id: "assistant-1", role: "assistant", content: "Stored response" },
      ],
      userEntries: [{ entryId: "entry-user-1", text: "Stored prompt" }],
      todo: null,
    });
  }

  prompt(text: string): ReturnType<AgentConnection["prompt"]> {
    this.promptedWith = text;
    return new Promise((resolve, reject) => {
      this.resolvePrompt = resolve;
      this.rejectPrompt = reject;
    });
  }

  snapshot(): ReturnType<AgentConnection["snapshot"]> {
    return Promise.resolve({
      model: { provider: "deepseek", id: "deepseek-v4-flash" },
      thinkingLevel: "high",
      userEntries: [{ entryId: "entry-user-1", text: "Stored prompt" }],
      messages: [
        { id: "user-1", role: "user", content: "Stored prompt" },
        { id: "assistant-1", role: "assistant", content: "Stored response" },
      ],
      todo: null,
    });
  }

  steer(text: string): ReturnType<AgentConnection["steer"]> {
    this.steeredWith = text;
    this.queued.steering.push(text);
    return Promise.resolve({ accepted: true });
  }

  followUp(text: string): ReturnType<AgentConnection["followUp"]> {
    this.followedUpWith = text;
    this.queued.followUp.push(text);
    return Promise.resolve({ accepted: true });
  }

  editTodo(): ReturnType<AgentConnection["editTodo"]> {
    return Promise.resolve({ todo: null });
  }

  clearQueue(): ReturnType<AgentConnection["clearQueue"]> {
    const queued = this.queued;
    this.queued = { steering: [], followUp: [] };
    return Promise.resolve(queued);
  }

  cancel(): ReturnType<AgentConnection["cancel"]> {
    const queued = this.queued;
    this.queued = { steering: [], followUp: [] };
    this.resolvePrompt?.({ status: "cancelled", userEntryId: null });
    return Promise.resolve({ cancelled: true, queued });
  }

  resolvePermission(): ReturnType<AgentConnection["resolvePermission"]> {
    return Promise.resolve({ resolved: true });
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(event: AgentUiEvent): void {
    this.onEvent(event);
  }

  complete(): void {
    this.resolvePrompt?.({ status: "completed", userEntryId: "user-entry-1" });
  }

  crash(): void {
    const error = new Error("Agent Host crashed");
    this.exitHandler?.(error);
    this.rejectPrompt?.(error);
  }
}

function createHarness(sessionReference?: AgentSessionReference) {
  const events: Array<{ runId: string; event: AgentUiEvent }> = [];
  const savedReferences: AgentSessionReference[] = [];
  const settled: Array<{ runId: string; snapshot: unknown }> = [];
  const connections: FakeAgentConnection[] = [];
  let connection: FakeAgentConnection | undefined;
  const controller = new TaskController(
    {
      threadId: "task-1",
      cwd: "/tmp/desktop-agent-test",
      accessMode: "auto",
      interactionMode: "agent",
      agentId: "task-1",
      agentRole: "lead",
      agentCapability: "write",
      sessionDir: "/tmp/pi-sessions",
      ...(sessionReference === undefined ? {} : { sessionReference }),
      initialModel: { provider: "deepseek", id: "deepseek-v4-flash" },
      initialThinkingLevel: "high",
      apiKeys: { deepseek: "test-key" },
    },
    (onEvent, _onPermissionRequest) => {
      connection = new FakeAgentConnection(onEvent);
      connections.push(connection);
      return connection;
    },
    (runId, event) => events.push({ runId, event }),
    (reference) => {
      savedReferences.push(reference);
      return true;
    },
    (runId, _result, snapshot) => settled.push({ runId, snapshot }),
  );
  return {
    controller,
    events,
    savedReferences,
    settled,
    connections,
    get connection() {
      if (!connection) throw new Error("Connection was not created");
      return connection;
    },
  };
}

describe("TaskController", () => {
  it("initializes DeepSeek and maps streamed events", async () => {
    const harness = createHarness();
    const result = await harness.controller.start("Explain the project");

    expect(harness.connection.bootedWith).toEqual({
      cwd: "/tmp/desktop-agent-test",
      accessMode: "auto",
      interactionMode: "agent",
      agentCapability: "write",
      sessionDir: "/tmp/pi-sessions",
      apiKeys: { deepseek: "test-key" },
    });
    expect(harness.connection.attachedWith).toEqual({
      agentId: "task-1",
      agentRole: "lead",
      model: { provider: "deepseek", id: "deepseek-v4-flash" },
      thinkingLevel: "high",
    });
    expect(harness.savedReferences).toEqual([
      {
        sessionId: "session-1",
        sessionFile: "/tmp/pi-sessions/session-1.jsonl",
      },
    ]);
    expect(harness.connection.promptedWith).toBe("Explain the project");
    harness.connection.emit({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "assistant-live",
      role: "assistant",
    });
    harness.connection.emit({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-live",
      delta: "Hello",
    });
    harness.connection.emit({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "assistant-live",
    });
    harness.connection.complete();

    await vi.waitFor(() =>
      expect(harness.events).toContainEqual({
        runId: result.runId,
        event: {
          type: EventType.RUN_FINISHED,
          threadId: "task-1",
          runId: result.runId,
          outcome: { type: "success" },
        },
      }),
    );
    expect(harness.events).toContainEqual({
      runId: result.runId,
      event: {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-live",
        delta: "Hello",
      },
    });
    expect(result.sessionReference.sessionId).toBe("session-1");
    expect(harness.settled).toEqual([
      {
        runId: result.runId,
        snapshot: {
          model: { provider: "deepseek", id: "deepseek-v4-flash" },
          thinkingLevel: "high",
          userEntries: [{ entryId: "entry-user-1", text: "Stored prompt" }],
          messages: [
            { id: "user-1", role: "user", content: "Stored prompt" },
            { id: "assistant-1", role: "assistant", content: "Stored response" },
          ],
          todo: null,
        },
      },
    ]);
  });

  it("steers, queues follow-up, restores the queue, and cancels the active run", async () => {
    const harness = createHarness();
    const result = await harness.controller.start("Start");

    await expect(harness.controller.steer("Change direction")).resolves.toEqual({
      accepted: true,
    });
    expect(harness.connection.steeredWith).toBe("Change direction");
    await expect(harness.controller.followUp("Check afterward")).resolves.toEqual({
      accepted: true,
    });
    expect(harness.connection.followedUpWith).toBe("Check afterward");
    await expect(harness.controller.clearQueue()).resolves.toEqual({
      steering: ["Change direction"],
      followUp: ["Check afterward"],
    });
    await harness.controller.followUp("Restore after stop");
    await expect(harness.controller.cancel()).resolves.toEqual({
      cancelled: true,
      queued: { steering: [], followUp: ["Restore after stop"] },
    });

    await vi.waitFor(() =>
      expect(harness.events).toContainEqual({
        runId: result.runId,
        event: {
          type: EventType.CUSTOM,
          name: AGENT_UI_CUSTOM_EVENT.RUN_CANCELLED,
          value: {},
        },
      }),
    );
  });

  it("reopens the stored Pi session", async () => {
    const reference = {
      sessionId: "session-1",
      sessionFile: "/tmp/pi-sessions/session-1.jsonl",
    };
    const harness = createHarness(reference);

    await harness.controller.start("Continue");

    expect(harness.connection.bootedWith).toMatchObject({
      sessionDir: "/tmp/pi-sessions",
    });
    expect(harness.connection.attachedWith).toMatchObject({
      sessionId: reference.sessionId,
      sessionFile: reference.sessionFile,
    });
    expect(harness.savedReferences).toEqual([]);
  });

  it("restores transcript messages from the reopened Pi session", async () => {
    const harness = createHarness({
      sessionId: "session-1",
      sessionFile: "/tmp/pi-sessions/session-1.jsonl",
    });

    await expect(harness.controller.open()).resolves.toEqual({
      model: { provider: "deepseek", id: "deepseek-v4-flash" },
      thinkingLevel: "high",
      userEntries: [{ entryId: "entry-user-1", text: "Stored prompt" }],
      messages: [
        { id: "user-1", role: "user", content: "Stored prompt" },
        { id: "assistant-1", role: "assistant", content: "Stored response" },
      ],
      todo: null,
    });
  });

  it("reconnects an idle controller after its Agent Host exits", async () => {
    const harness = createHarness({
      sessionId: "session-1",
      sessionFile: "/tmp/pi-sessions/session-1.jsonl",
    });
    await harness.controller.open();

    harness.connection.crash();
    await harness.controller.open();

    expect(harness.connections).toHaveLength(2);
    expect(harness.connections[1]?.attachedWith).toMatchObject({
      sessionFile: "/tmp/pi-sessions/session-1.jsonl",
    });
  });

  it("fails a crashed run once and reconnects on the next prompt", async () => {
    const harness = createHarness();
    const first = await harness.controller.start("First");

    harness.connection.crash();
    await vi.waitFor(() =>
      expect(
        harness.events.filter(
          ({ runId, event }) =>
            runId === first.runId && event.type === EventType.RUN_ERROR,
        ),
      ).toHaveLength(1),
    );

    await harness.controller.start("Retry");
    expect(harness.connections).toHaveLength(2);
    expect(harness.connections[1]?.attachedWith).toMatchObject({
      sessionFile: "/tmp/pi-sessions/session-1.jsonl",
    });
  });
});
