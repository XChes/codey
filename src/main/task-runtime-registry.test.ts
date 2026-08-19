// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventType } from "@ag-ui/core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConversationTodos,
  TODO_STATE_ENTRY_TYPE,
} from "../agent-host/conversation-todo-state";
import type { AgentSessionReference } from "../shared/agent-host-protocol";
import type {
  DelegationOperation,
  DelegationToolResult,
} from "../shared/agent";
import {
  DEFAULT_MODEL,
  DEFAULT_THINKING_LEVEL,
  type SupportedModelSelection,
  type ThinkingLevel,
} from "../shared/models";
import { taskEventEnvelopeSchema, type TaskEventEnvelope } from "../shared/task";
import type { TodoEditOperation } from "../shared/todo";
import { AppStore, type StoredTask } from "./app-store";
import {
  TaskRuntimeRegistry,
  type AgentRuntimeConfig,
  type TaskRuntime,
  type TaskRuntimeCallbacks,
} from "./task-runtime-registry";

const temporaryDirectories: string[] = [];

function createStore(): AppStore {
  const directory = mkdtempSync(join(tmpdir(), "desktop-agent-runtimes-"));
  temporaryDirectories.push(directory);
  return new AppStore(join(directory, "app.sqlite"));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class FakeRuntime implements TaskRuntime {
  readonly reference: AgentSessionReference;
  readonly prompts: string[] = [];
  readonly todoEdits: TodoEditOperation[] = [];
  opened = false;
  running = false;
  disposed = false;
  private runId: string | undefined;
  private readonly delegationRequests = new Map<
    string,
    {
      resolve(value: DelegationToolResult): void;
      reject(error: Error): void;
    }
  >();

  constructor(
    readonly task: StoredTask,
    private readonly callbacks: TaskRuntimeCallbacks,
    readonly model: SupportedModelSelection = DEFAULT_MODEL,
    readonly thinkingLevel: ThinkingLevel = DEFAULT_THINKING_LEVEL,
  ) {
    this.reference = { sessionId: `pi-${task.id}`, sessionFile: `/tmp/${task.id}` };
  }

  get ready(): boolean {
    return this.opened;
  }

  async start(text: string, runId: string) {
    this.opened = true;
    this.running = true;
    this.runId = runId;
    this.prompts.push(text);
    this.callbacks.emit(runId, {
      type: EventType.RUN_STARTED,
      threadId: this.task.id,
      runId,
    });
    return { runId, sessionReference: this.reference };
  }

  async open() {
    this.opened = true;
    return {
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      messages: [],
      userEntries: [],
      todo: null,
    };
  }

  async steer() { return { accepted: true as const }; }
  async followUp() { return { accepted: true as const }; }
  async editTodo(input: TodoEditOperation) {
    this.todoEdits.push(input);
    return { todo: null };
  }
  async clearQueue() { return { steering: [], followUp: [] }; }
  async cancel() { return { cancelled: true, queued: { steering: [], followUp: [] } }; }
  async resolvePermission() { return false; }
  async resolveDelegation(params: {
    requestId: string;
    result?: DelegationToolResult;
    error?: string;
  }) {
    const pending = this.delegationRequests.get(params.requestId);
    if (pending === undefined) return false;
    this.delegationRequests.delete(params.requestId);
    if (params.error === undefined) pending.resolve(params.result!);
    else pending.reject(new Error(params.error));
    return true;
  }
  async completeDelegation() { return true; }
  async dispose() { this.running = false; this.disposed = true; }
  terminate() { this.running = false; }

  delegate(operation: DelegationOperation): Promise<DelegationToolResult> {
    const requestId = `request-${this.delegationRequests.size + 1}`;
    const result = new Promise<DelegationToolResult>((resolve, reject) => {
      this.delegationRequests.set(requestId, { resolve, reject });
    });
    this.callbacks.delegationRequest({ requestId, operation });
    return result;
  }

  settle(
    result?: { status: "completed" | "cancelled"; userEntryId: string | null },
    messages: Array<{
      id: string;
      role: "assistant";
      content: string;
    }> = [],
  ): void {
    if (this.runId === undefined) throw new Error("Runtime has not started");
    this.running = false;
    this.callbacks.settled(this.runId, result, {
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      messages,
      userEntries: [],
      todo: null,
    });
  }
}

describe("TaskRuntimeRegistry", () => {
  it("starts a worktree conversation without creating a checkpoint", async () => {
    const store = createStore();
    const repository = { commonDirectory: "/tmp/project/.git", integrationBranch: "main" };
    const workspace = store.saveWorkspace("/tmp", repository, "main");
    const worktrees = {
      probeProject: async (path: string) => ({ path, checkoutBranch: "main", repository }),
      createWorktree: async (input: { taskId: string }) => ({
        path: `/tmp/worktrees/${input.taskId}`,
        branch: `codey/${input.taskId}`,
        baseCommit: "abc123",
      }),
      validateWorktree: async () => undefined,
      removeWorktree: async () => undefined,
    };
    let runtime: FakeRuntime | undefined;
    const registry = new TaskRuntimeRegistry(
      store,
      (task, callbacks, model, thinkingLevel) =>
        (runtime = new FakeRuntime(task, callbacks, model, thinkingLevel)),
      () => undefined,
      async () => undefined,
      { worktrees },
    );
    const task = await registry.create("Review", workspace.id, "worktree");

    await expect(
      registry.start(
        task.id,
        "Implement",
        DEFAULT_MODEL,
        DEFAULT_THINKING_LEVEL,
      ),
    ).resolves.toEqual({
      runId: expect.any(String),
    });
    expect(runtime?.prompts).toEqual(["Implement"]);
    store.close();
  });

  it("captures the review baseline in parallel with runtime preparation", async () => {
    const store = createStore();
    const workspace = store.saveWorkspace("/tmp");
    const order: string[] = [];
    let runtimeCreated!: () => void;
    const runtimeCreation = new Promise<void>((resolve) => {
      runtimeCreated = resolve;
    });
    let runtime: FakeRuntime | undefined;
    const registry = new TaskRuntimeRegistry(
      store,
      (task, callbacks) => {
        order.push("runtime");
        runtimeCreated();
        return (runtime = new FakeRuntime(task, callbacks));
      },
      () => undefined,
      async () => undefined,
      {
        review: {
          // Resolving only after the runtime factory ran would deadlock if
          // start() still serialized the baseline ahead of preparation.
          ensureBaseline: async (taskId) => {
            await runtimeCreation;
            order.push(`baseline:${taskId}`);
          },
        },
      },
    );
    const task = registry.create("Local", workspace.id);

    await registry.start(
      task.id,
      "Implement",
      DEFAULT_MODEL,
      DEFAULT_THINKING_LEVEL,
    );

    expect(order).toEqual(["runtime", `baseline:${task.id}`]);
    expect(runtime?.prompts).toEqual(["Implement"]);
    store.close();
  });

  it("disposes idle runtimes while keeping running conversations", async () => {
    const store = createStore();
    const first = store.saveWorkspace("/tmp/one");
    const second = store.saveWorkspace("/tmp/two");
    const runtimes = new Map<string, FakeRuntime>();
    const registry = new TaskRuntimeRegistry(
      store,
      (task, callbacks) => {
        const runtime = new FakeRuntime(task, callbacks);
        runtimes.set(task.id, runtime);
        return runtime;
      },
      () => undefined,
      async () => undefined,
    );
    const idle = registry.create("Idle", first.id);
    const running = registry.create("Running", second.id);

    await registry.start(idle.id, "One", DEFAULT_MODEL, DEFAULT_THINKING_LEVEL);
    runtimes.get(idle.id)!.settle({ status: "completed", userEntryId: null });
    await registry.start(
      running.id,
      "Two",
      DEFAULT_MODEL,
      DEFAULT_THINKING_LEVEL,
    );

    registry.disposeIdleRuntimes();
    await new Promise((resolve) => setImmediate(resolve));

    expect(runtimes.get(idle.id)?.disposed).toBe(true);
    expect(runtimes.get(running.id)?.disposed).toBe(false);
    expect(runtimes.get(running.id)?.running).toBe(true);
    store.close();
  });

  it("returns snapshots without checkpoint metadata", async () => {
    const store = createStore();
    const workspace = store.saveWorkspace("/tmp");
    const registry = new TaskRuntimeRegistry(
      store,
      (task, callbacks) => new FakeRuntime(task, callbacks),
      () => undefined,
      async () => undefined,
    );
    const task = registry.create("Local", workspace.id);

    await expect(registry.open(task.id)).resolves.toEqual({
      task: expect.objectContaining({ id: task.id }),
      model: DEFAULT_MODEL,
      thinkingLevel: DEFAULT_THINKING_LEVEL,
      messages: [],
      todo: null,
      agents: [
        {
          agent: expect.objectContaining({
            taskId: task.id,
            role: "lead",
            capability: "write",
          }),
          projection: { messages: [], userEntries: [] },
        },
      ],
      delegations: [],
    });
    store.close();
  });

  it("keeps private Pi session references out of renderer snapshots and events", async () => {
    const store = createStore();
    const workspace = store.saveWorkspace("/tmp");
    const events: TaskEventEnvelope[] = [];
    const registry = new TaskRuntimeRegistry(
      store,
      (task, callbacks) => new FakeRuntime(task, callbacks),
      (event) => events.push(event),
      async () => undefined,
    );
    const task = registry.create("Local", workspace.id);
    store.setTaskSessionReference(task.id, {
      sessionId: "private-session",
      sessionFile: "/private/pi-session.jsonl",
    });
    store.saveTaskConversationProjection(task.id, {
      model: DEFAULT_MODEL,
      thinkingLevel: DEFAULT_THINKING_LEVEL,
      messages: [],
      userEntries: [],
      todo: null,
    });

    const snapshot = await registry.open(task.id);
    expect(snapshot.agents?.[0]?.agent).not.toHaveProperty("sessionReference");

    await registry.start(
      task.id,
      "Implement",
      DEFAULT_MODEL,
      DEFAULT_THINKING_LEVEL,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.agent).not.toHaveProperty("sessionReference");
    expect(taskEventEnvelopeSchema.safeParse(events[0]).success).toBe(true);
    store.close();
  });

  it("edits an idle todo in Pi JSONL without creating an Agent Host runtime", async () => {
    const store = createStore();
    const workspace = store.saveWorkspace("/tmp");
    let runtimeCount = 0;
    const registry = new TaskRuntimeRegistry(
      store,
      (task, callbacks) => {
        runtimeCount += 1;
        return new FakeRuntime(task, callbacks);
      },
      () => undefined,
      async () => undefined,
    );
    const task = registry.create("Local", workspace.id);
    const executionPath = store.getTask(task.id)!.executionPath;
    const sessionDir = mkdtempSync(join(tmpdir(), "desktop-agent-session-"));
    temporaryDirectories.push(sessionDir);
    const sessionManager = SessionManager.create(executionPath, sessionDir);
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Stored response" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-opus-4-5",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const todo = {
      revision: 1,
      title: "Ship",
      items: [{ id: "todo-1", content: "Finish", status: "pending" as const }],
    };
    sessionManager.appendCustomEntry(TODO_STATE_ENTRY_TYPE, { todo });
    const sessionFile = sessionManager.getSessionFile();
    if (sessionFile === undefined) throw new Error("Session file was not created");
    store.setTaskSessionReference(task.id, {
      sessionId: sessionManager.getSessionId(),
      sessionFile,
    });
    store.saveTaskConversationProjection(task.id, {
      model: DEFAULT_MODEL,
      thinkingLevel: DEFAULT_THINKING_LEVEL,
      messages: [],
      userEntries: [],
      todo,
    });

    await expect(
      registry.editTodo(task.id, { action: "archive" }),
    ).resolves.toEqual({ todo: null });

    expect(runtimeCount).toBe(0);
    expect(store.getTaskConversationProjection(task.id)?.todo).toBeNull();
    const reopened = SessionManager.open(
      sessionFile,
      sessionDir,
      executionPath,
    );
    expect(new ConversationTodos(reopened).current).toBeNull();
    store.close();
  });

  it("routes todo edits through the active Agent Host runtime", async () => {
    const store = createStore();
    const workspace = store.saveWorkspace("/tmp");
    let runtime: FakeRuntime | undefined;
    const registry = new TaskRuntimeRegistry(
      store,
      (task, callbacks) => (runtime = new FakeRuntime(task, callbacks)),
      () => undefined,
      async () => undefined,
    );
    const task = registry.create("Local", workspace.id);
    await registry.start(
      task.id,
      "Implement",
      DEFAULT_MODEL,
      DEFAULT_THINKING_LEVEL,
    );

    await expect(
      registry.editTodo(task.id, { action: "archive" }),
    ).resolves.toEqual({ todo: null });

    expect(runtime?.todoEdits).toEqual([{ action: "archive" }]);
    store.close();
  });

  it("reuses matching runtimes and replaces them when thinking level changes", async () => {
    const store = createStore();
    const workspace = store.saveWorkspace("/tmp");
    const runtimes: FakeRuntime[] = [];
    const registry = new TaskRuntimeRegistry(
      store,
      (task, callbacks, model, thinkingLevel) => {
        const runtime = new FakeRuntime(
          task,
          callbacks,
          model,
          thinkingLevel,
        );
        runtimes.push(runtime);
        return runtime;
      },
      () => undefined,
      async () => undefined,
    );
    const task = registry.create("Local", workspace.id);

    await registry.start(task.id, "First", DEFAULT_MODEL, "high");
    runtimes[0]?.settle();
    await registry.start(task.id, "Second", DEFAULT_MODEL, "high");
    expect(runtimes).toHaveLength(1);
    runtimes[0]?.settle();

    await registry.start(task.id, "Third", DEFAULT_MODEL, "low");
    expect(runtimes).toHaveLength(2);
    expect(runtimes[0]?.disposed).toBe(true);
    expect(runtimes[1]?.thinkingLevel).toBe("low");
    store.close();
  });

  it("changes an idle conversation access mode and recycles its runtime", async () => {
    const store = createStore();
    const workspace = store.saveWorkspace("/tmp");
    let runtime: FakeRuntime | undefined;
    const registry = new TaskRuntimeRegistry(
      store,
      (task, callbacks) => (runtime = new FakeRuntime(task, callbacks)),
      () => undefined,
      async () => undefined,
    );
    const task = registry.create("Local", workspace.id);
    await registry.start(
      task.id,
      "Implement",
      DEFAULT_MODEL,
      DEFAULT_THINKING_LEVEL,
    );
    runtime?.settle();

    await expect(registry.updateAccessMode(task.id, "ask")).resolves.toEqual(
      expect.objectContaining({ id: task.id, accessMode: "ask" }),
    );
    expect(runtime?.disposed).toBe(true);
    expect(store.getTask(task.id)?.accessMode).toBe("ask");
    store.close();
  });

  it("rejects access mode changes while a conversation is running", async () => {
    const store = createStore();
    const workspace = store.saveWorkspace("/tmp");
    const registry = new TaskRuntimeRegistry(
      store,
      (task, callbacks) => new FakeRuntime(task, callbacks),
      () => undefined,
      async () => undefined,
    );
    const task = registry.create("Local", workspace.id);
    await registry.start(
      task.id,
      "Implement",
      DEFAULT_MODEL,
      DEFAULT_THINKING_LEVEL,
    );

    await expect(registry.updateAccessMode(task.id, "ask")).rejects.toThrow(
      "cannot change while",
    );
    expect(store.getTask(task.id)?.accessMode).toBe("full");
    store.close();
  });

  it("persists an idle interaction mode change and recycles its runtime", async () => {
    const store = createStore();
    const workspace = store.saveWorkspace("/tmp");
    let runtime: FakeRuntime | undefined;
    const registry = new TaskRuntimeRegistry(
      store,
      (task, callbacks) => (runtime = new FakeRuntime(task, callbacks)),
      () => undefined,
      async () => undefined,
    );
    const task = registry.create("Local", workspace.id);
    await registry.start(
      task.id,
      "Implement",
      DEFAULT_MODEL,
      DEFAULT_THINKING_LEVEL,
    );
    runtime?.settle();

    await expect(
      registry.updateInteractionMode(task.id, "plan"),
    ).resolves.toEqual(
      expect.objectContaining({ id: task.id, interactionMode: "plan" }),
    );
    expect(runtime?.disposed).toBe(true);
    expect(store.getTask(task.id)?.interactionMode).toBe("plan");
    store.close();
  });

  it("rejects interaction mode changes while a conversation is running", async () => {
    const store = createStore();
    const workspace = store.saveWorkspace("/tmp");
    const registry = new TaskRuntimeRegistry(
      store,
      (task, callbacks) => new FakeRuntime(task, callbacks),
      () => undefined,
      async () => undefined,
    );
    const task = registry.create("Local", workspace.id);
    await registry.start(
      task.id,
      "Implement",
      DEFAULT_MODEL,
      DEFAULT_THINKING_LEVEL,
    );

    await expect(
      registry.updateInteractionMode(task.id, "plan"),
    ).rejects.toThrow("cannot change while");
    expect(store.getTask(task.id)?.interactionMode).toBe("agent");
    store.close();
  });

  it("narrows a coding subagent to read and returns its result to the lead", async () => {
    const store = createStore();
    const workspace = store.saveWorkspace("/tmp");
    const created: Array<{
      runtime: FakeRuntime;
      agent?: AgentRuntimeConfig;
    }> = [];
    const events: Array<{ agentId?: string; agentRunId?: string }> = [];
    const registry = new TaskRuntimeRegistry(
      store,
      (task, callbacks, model, thinkingLevel, agent) => {
        const runtime = new FakeRuntime(task, callbacks, model, thinkingLevel);
        created.push({ runtime, agent });
        return runtime;
      },
      (event) => events.push(event),
      async () => undefined,
      {
        subagentConfig: {
          load: async () => ({
            version: 1,
            agents: [
              {
                id: "coding",
                description: "General-purpose coding agent",
                instructions: "Complete the assigned coding task.",
                capability: "write",
              },
            ],
          }),
        },
      },
    );
    const task = registry.create("Delegate", workspace.id);
    await registry.start(
      task.id,
      "Lead prompt",
      DEFAULT_MODEL,
      DEFAULT_THINKING_LEVEL,
    );
    const lead = created.find(({ agent }) => agent?.role === "lead")!.runtime;
    const result = lead.delegate({
      action: "run",
      profileId: "coding",
      description: "Inspect runtime",
      prompt: "Inspect the runtime.",
      capability: "read",
      runInBackground: false,
      dependsOn: [],
    });
    await vi.waitFor(() =>
      expect(created.some(({ agent }) => agent?.role === "subagent")).toBe(true),
    );
    const child = created.find(
      ({ agent }) => agent?.role === "subagent",
    )!.runtime;
    child.settle(
      { status: "completed", userEntryId: "child-entry" },
      [{ id: "child-answer", role: "assistant", content: "Runtime evidence" }],
    );

    await expect(result).resolves.toMatchObject({
      delegations: [
        {
          status: "completed",
          result: "Runtime evidence",
        },
      ],
    });
    expect(store.listAgents(task.id).map(({ role }) => role)).toEqual([
      "lead",
      "subagent",
    ]);
    expect(
      store.listAgents(task.id).find(({ role }) => role === "subagent")
        ?.capability,
    ).toBe("read");
    expect(events.some((event) => event.agentId?.startsWith("lead:"))).toBe(true);
    expect(
      events.some(
        (event) =>
          event.agentId !== undefined &&
          !event.agentId.startsWith("lead:") &&
          event.agentRunId !== undefined,
      ),
    ).toBe(true);
    lead.settle({ status: "completed", userEntryId: "lead-entry" });
    store.close();
  });
});
