// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, vi } from "vitest";

import {
  DEFAULT_MODEL,
  DEFAULT_THINKING_LEVEL,
} from "../shared/models";
import { DEFAULT_APP_SETTINGS } from "../shared/settings";
import { AppStore } from "./app-store";

const temporaryDirectories: string[] = [];

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "desktop-agent-store-"));
  temporaryDirectories.push(directory);
  return join(directory, "app.sqlite");
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("AppStore", () => {
  it("creates the approved defaults on first launch", () => {
    const path = createDatabasePath();
    const store = new AppStore(path);
    expect(store.getSettings()).toEqual(DEFAULT_APP_SETTINGS);
    expect(store.listTasks()).toEqual([]);
    store.close();

    const database = new Database(path, { readonly: true });
    expect(database.pragma("user_version", { simple: true })).toBe(9);
    database.close();
  });

  it("migrates existing conversations to automatic approval mode", () => {
    const path = createDatabasePath();
    const database = new Database(path);
    database.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY);
      PRAGMA user_version = 5;
    `);
    database.close();

    const store = new AppStore(path);
    store.close();

    const migrated = new Database(path, { readonly: true });
    const columns = migrated.pragma("table_info(tasks)") as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    expect(columns).toContainEqual(
      expect.objectContaining({
        name: "access_mode",
        dflt_value: "'auto'",
      }),
    );
    expect(columns).toContainEqual(
      expect.objectContaining({
        name: "interaction_mode",
        dflt_value: "'agent'",
      }),
    );
    expect(migrated.pragma("user_version", { simple: true })).toBe(9);
    migrated.close();
  });

  it("migrates version 6 conversations to Agent interaction mode", () => {
    const path = createDatabasePath();
    const database = new Database(path);
    database.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        access_mode TEXT NOT NULL DEFAULT 'auto'
      );
      INSERT INTO tasks (id) VALUES ('task-1');
      PRAGMA user_version = 6;
    `);
    database.close();

    const store = new AppStore(path);
    store.close();

    const migrated = new Database(path, { readonly: true });
    expect(
      migrated
        .prepare("SELECT interaction_mode FROM tasks WHERE id = 'task-1'")
        .get(),
    ).toEqual({ interaction_mode: "agent" });
    expect(migrated.pragma("user_version", { simple: true })).toBe(9);
    migrated.close();
  });

  it("migrates version 7 storage for encrypted provider credentials", () => {
    const path = createDatabasePath();
    const database = new Database(path);
    database.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY);
      PRAGMA user_version = 7;
    `);
    database.close();

    const store = new AppStore(path);
    store.setEncryptedProviderCredential(
      "openai",
      Buffer.from("encrypted-value"),
    );
    store.close();

    const migrated = new Database(path, { readonly: true });
    const row = migrated
      .prepare(
        "SELECT provider, encrypted_blob FROM provider_credentials WHERE provider = ?",
      )
      .get("openai") as { provider: string; encrypted_blob: Buffer };
    expect(row).toEqual({
      provider: "openai",
      encrypted_blob: Buffer.from("encrypted-value"),
    });
    expect(migrated.pragma("user_version", { simple: true })).toBe(9);
    migrated.close();
  });

  it("backfills existing version 8 conversations into lead agents", () => {
    const path = createDatabasePath();
    const original = new AppStore(path);
    const workspace = original.saveWorkspace(dirname(path));
    original.createTask({
      id: "task-1",
      title: "Existing conversation",
      status: "completed",
      workspaceId: workspace.id,
    });
    original.setTaskSessionReference("task-1", {
      sessionId: "session-1",
      sessionFile: join(dirname(path), "session-1.jsonl"),
    });
    original.saveTaskConversationProjection("task-1", {
      model: DEFAULT_MODEL,
      thinkingLevel: "high",
      messages: [
        { id: "assistant-1", role: "assistant", content: "Existing response" },
      ],
      todo: null,
      userEntries: [],
    });
    original.close();

    const legacy = new Database(path);
    legacy.exec(`
      DROP TABLE delegation_dependencies;
      DROP TABLE delegations;
      DROP TABLE agent_conversation_projections;
      DROP TABLE agents;
      DROP TABLE task_runs;
      PRAGMA user_version = 8;
    `);
    legacy.close();

    const migrated = new AppStore(path);
    expect(migrated.listAgents("task-1")).toEqual([
      expect.objectContaining({
        id: "lead:task-1",
        role: "lead",
        status: "completed",
        thinkingLevel: "high",
        sessionReference: {
          sessionId: "session-1",
          sessionFile: join(dirname(path), "session-1.jsonl"),
        },
      }),
    ]);
    expect(
      migrated.getAgentConversationProjection("lead:task-1")?.messages,
    ).toEqual([
      { id: "assistant-1", role: "assistant", content: "Existing response" },
    ]);
    migrated.close();
  });

  it("persists a conversation access mode and allows changing it", () => {
    const path = createDatabasePath();
    const first = new AppStore(path);
    const workspace = first.saveWorkspace(dirname(path));
    first.createTask({
      id: "task-1",
      title: "Controlled conversation",
      status: "idle",
      workspaceId: workspace.id,
    });

    expect(first.getTask("task-1")?.accessMode).toBe("full");
    expect(first.updateTaskAccessMode("task-1", "ask").accessMode).toBe("ask");
    first.close();

    const second = new AppStore(path);
    expect(second.getTask("task-1")?.accessMode).toBe("ask");
    second.close();
  });

  it("persists a conversation interaction mode and allows changing it", () => {
    const path = createDatabasePath();
    const first = new AppStore(path);
    const workspace = first.saveWorkspace(dirname(path));
    first.createTask({
      id: "task-1",
      title: "Planning conversation",
      status: "idle",
      workspaceId: workspace.id,
    });

    expect(first.getTask("task-1")?.interactionMode).toBe("agent");
    expect(
      first.updateTaskInteractionMode("task-1", "plan").interactionMode,
    ).toBe("plan");
    first.close();

    const second = new AppStore(path);
    expect(second.getTask("task-1")?.interactionMode).toBe("plan");
    second.close();
  });

  it("migrates existing conversations to automatic approval", () => {
    const path = createDatabasePath();
    const database = new Database(path);
    database.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL
      );
      INSERT INTO tasks (id, title) VALUES ('task-1', 'Existing task');
    `);
    database.pragma("user_version = 5");
    database.close();

    const store = new AppStore(path);
    store.close();

    const migrated = new Database(path, { readonly: true });
    expect(
      migrated
        .prepare("SELECT access_mode FROM tasks WHERE id = 'task-1'")
        .get(),
    ).toEqual({ access_mode: "auto" });
    expect(
      migrated
        .prepare(
          "SELECT access_mode, interaction_mode FROM tasks WHERE id = 'task-1'",
        )
        .get(),
    ).toEqual({ access_mode: "auto", interaction_mode: "agent" });
    expect(migrated.pragma("user_version", { simple: true })).toBe(9);
    migrated.close();
  });

  it("persists a validated conversation projection across restart", () => {
    const path = createDatabasePath();
    const first = new AppStore(path);
    const workspace = first.saveWorkspace(dirname(path));
    first.createTask({
      id: "task-1",
      title: "Stored conversation",
      status: "completed",
      workspaceId: workspace.id,
    });
    first.saveTaskConversationProjection("task-1", {
      model: DEFAULT_MODEL,
      thinkingLevel: "high",
      messages: [
        { id: "user-1", role: "user", content: "Stored prompt" },
        { id: "assistant-1", role: "assistant", content: "Stored response" },
      ],
      todo: {
        revision: 1,
        title: "Build",
        items: [
          { id: "todo-1", content: "Persist todos", status: "completed" },
        ],
      },
      userEntries: [{ entryId: "entry-1", text: "Stored prompt" }],
    });
    first.close();

    const second = new AppStore(path);
    expect(second.getTaskConversationProjection("task-1")).toEqual({
      model: DEFAULT_MODEL,
      thinkingLevel: "high",
      messages: [
        { id: "user-1", role: "user", content: "Stored prompt" },
        { id: "assistant-1", role: "assistant", content: "Stored response" },
      ],
      todo: {
        revision: 1,
        title: "Build",
        items: [
          { id: "todo-1", content: "Persist todos", status: "completed" },
        ],
      },
      userEntries: [{ entryId: "entry-1", text: "Stored prompt" }],
    });
    second.close();
  });

  it("defaults the thinking level in legacy conversation projections", () => {
    const path = createDatabasePath();
    const first = new AppStore(path);
    const workspace = first.saveWorkspace(dirname(path));
    first.createTask({
      id: "task-1",
      title: "Legacy conversation",
      status: "completed",
      workspaceId: workspace.id,
    });
    first.close();

    const legacy = new Database(path);
    legacy
      .prepare(
        `INSERT INTO task_conversation_projections
           (task_id, projection_json, updated_at)
         VALUES (?, ?, ?)`,
      )
      .run(
        "task-1",
        JSON.stringify({
          model: DEFAULT_MODEL,
          messages: [],
          todo: null,
          userEntries: [],
        }),
        new Date().toISOString(),
      );
    legacy.close();

    const second = new AppStore(path);
    expect(second.getTaskConversationProjection("task-1")).toEqual({
      model: DEFAULT_MODEL,
      thinkingLevel: DEFAULT_THINKING_LEVEL,
      messages: [],
      todo: null,
      userEntries: [],
    });
    second.close();
  });

  it("persists settings and Pi-backed task metadata across restart", () => {
    const path = createDatabasePath();
    const first = new AppStore(path);
    const workspace = first.saveWorkspace(dirname(path));
    first.updateSettings({ theme: "dark" });
    first.updateWindow({ width: 1040, height: 700, maximized: true });
    first.createTask({
      id: "task-1",
      title: "Explain the project",
      status: "running",
      workspaceId: workspace.id,
    });
    first.setTaskSessionReference("task-1", {
      sessionId: "pi-session-1",
      sessionFile: "/tmp/pi-session-1.jsonl",
    });
    first.updateTaskStatus("task-1", "completed");
    first.close();

    const second = new AppStore(path);
    expect(second.getSettings()).toEqual({
      theme: "dark",
      window: { width: 1040, height: 700, maximized: true },
    });
    expect(second.listTasks()).toEqual([
      expect.objectContaining({
        id: "task-1",
        title: "Explain the project",
        status: "completed",
      }),
    ]);
    expect(second.getTask("task-1")).toEqual({
      id: "task-1",
      title: "Explain the project",
      status: "completed",
      executionTarget: "local",
      accessMode: "full",
      interactionMode: "agent",
      branch: null,
      workspace,
      executionPath: workspace.path,
      sessionReference: {
        sessionId: "pi-session-1",
        sessionFile: "/tmp/pi-session-1.jsonl",
      },
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    second.close();
  });

  it("persists a worktree execution root across restart", () => {
    const path = createDatabasePath();
    const first = new AppStore(path);
    const workspace = first.saveWorkspace("/projects/codey", {
      commonDirectory: "/projects/codey/.git",
      integrationBranch: "main",
    }, "feature");
    first.createTask({
      id: "task-1",
      title: "Isolated task",
      status: "idle",
      workspaceId: workspace.id,
      executionTarget: "worktree",
      worktree: {
        path: "/worktrees/task-1",
        branch: "codey/task-1",
        baseCommit: "abc123",
      },
    });
    first.close();

    const second = new AppStore(path);
    expect(second.getTask("task-1")).toEqual(
      expect.objectContaining({
        executionTarget: "worktree",
        branch: "codey/task-1",
        executionPath: "/worktrees/task-1",
        repository: {
          commonDirectory: "/projects/codey/.git",
          integrationBranch: "main",
        },
        worktree: {
          path: "/worktrees/task-1",
          branch: "codey/task-1",
          baseCommit: "abc123",
        },
      }),
    );
    second.close();
  });

  it("uses the checkout branch for local task summaries", () => {
    const store = new AppStore(createDatabasePath());
    const repository = {
      commonDirectory: "/projects/codey/.git",
      integrationBranch: "main",
    };
    const workspace = store.saveWorkspace("/projects/codey", repository, "feature");
    store.createTask({
      id: "task-1",
      title: "Shared task",
      status: "idle",
      workspaceId: workspace.id,
      executionTarget: "local",
    });

    expect(store.getTask("task-1")).toEqual(
      expect.objectContaining({
        branch: "feature",
        workspace: expect.objectContaining({ branch: "feature" }),
      }),
    );

    store.setWorkspaceRepository(workspace.id, repository, "next-feature");
    expect(store.listTasks()[0]).toEqual(
      expect.objectContaining({ branch: "next-feature" }),
    );
    store.close();
  });

  it("lists a saved workspace before it has any tasks", () => {
    const path = createDatabasePath();
    const first = new AppStore(path);
    const workspace = first.saveWorkspace(dirname(path));
    first.close();

    const second = new AppStore(path);
    expect(second.listWorkspaces()).toEqual([workspace]);
    second.close();
  });

  it("keeps workspace order stable when one is activated", () => {
    vi.useFakeTimers();
    const store = new AppStore(createDatabasePath());
    vi.setSystemTime(new Date("2026-08-18T12:00:00.000Z"));
    const first = store.saveWorkspace("/projects/first");
    vi.setSystemTime(new Date("2026-08-18T12:01:00.000Z"));
    const second = store.saveWorkspace("/projects/second");

    expect(store.listWorkspaces()).toEqual([second, first]);
    vi.setSystemTime(new Date("2026-08-18T12:02:00.000Z"));
    expect(store.touchWorkspace(first.id)).toEqual(first);
    expect(store.listWorkspaces()).toEqual([second, first]);
    store.close();
  });

  it("keeps conversation order stable when activity updates", () => {
    vi.useFakeTimers();
    const store = new AppStore(createDatabasePath());
    const workspace = store.saveWorkspace("/projects/codey");
    vi.setSystemTime(new Date("2026-08-18T12:00:00.000Z"));
    store.createTask({
      id: "task-first",
      title: "First",
      status: "idle",
      workspaceId: workspace.id,
    });
    vi.setSystemTime(new Date("2026-08-18T12:01:00.000Z"));
    store.createTask({
      id: "task-second",
      title: "Second",
      status: "idle",
      workspaceId: workspace.id,
    });

    expect(store.listTasks().map(({ id }) => id)).toEqual([
      "task-second",
      "task-first",
    ]);
    vi.setSystemTime(new Date("2026-08-18T12:02:00.000Z"));
    store.updateTaskStatus("task-first", "running");
    expect(store.listTasks().map(({ id }) => id)).toEqual([
      "task-second",
      "task-first",
    ]);
    store.close();
  });

  it("marks unfinished tasks interrupted at startup", () => {
    const path = createDatabasePath();
    const store = new AppStore(path);
    const workspace = store.saveWorkspace(dirname(path));
    store.createTask({
      id: "task-1",
      title: "Running task",
      status: "running",
      workspaceId: workspace.id,
    });
    store.markRunningTasksInterrupted();

    expect(store.getTask("task-1")?.status).toBe("interrupted");
    store.close();
  });

  it("persists the lead, subagent, delegation, and per-agent projection", () => {
    const store = new AppStore(createDatabasePath());
    const workspace = store.saveWorkspace("/tmp");
    store.createTask({
      id: "task-1",
      title: "Delegated task",
      status: "running",
      workspaceId: workspace.id,
    });
    const lead = store.ensureLeadAgent("task-1");
    store.beginTaskRun("run-1", "task-1");
    const child = store.createSubagent({
      id: "agent-1",
      taskId: "task-1",
      parentAgentId: lead.id,
      profileId: "researcher",
      capability: "read",
      model: DEFAULT_MODEL,
      thinkingLevel: DEFAULT_THINKING_LEVEL,
      assignment: "Inspect runtime",
    });
    store.createDelegation({
      id: "delegation-1",
      taskId: "task-1",
      taskRunId: "run-1",
      parentAgentId: lead.id,
      childAgentId: child.id,
      profileId: "researcher",
      capability: "read",
      prompt: "Inspect the runtime.",
      dependsOn: [],
    });
    store.saveAgentConversationProjection(child.id, {
      messages: [{ id: "answer", role: "assistant", content: "Done" }],
      userEntries: [],
    });
    store.updateDelegationStatus("delegation-1", "completed", {
      result: "Done",
    });
    store.updateAgentStatus(child.id, "completed", { result: "Done" });
    store.finishTaskRun("run-1", "completed");

    expect(store.listAgents("task-1").map(({ role }) => role)).toEqual([
      "lead",
      "subagent",
    ]);
    expect(store.getDelegation("delegation-1")).toMatchObject({
      status: "completed",
      result: "Done",
      dependsOn: [],
    });
    expect(store.getAgentConversationProjection(child.id)?.messages).toEqual([
      { id: "answer", role: "assistant", content: "Done" },
    ]);
    store.close();
  });

  it("requires every task to reference a stored workspace", () => {
    const store = new AppStore(createDatabasePath());

    expect(() =>
      store.createTask({
        id: "task-1",
        title: "Invalid task",
        status: "idle",
        workspaceId: "missing-workspace",
      }),
    ).toThrow();
    store.close();
  });
});
