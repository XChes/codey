import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import Database from "better-sqlite3";

import type { AgentSessionReference } from "../shared/agent-host-protocol";
import type { Provider } from "../shared/provider-credentials";
import {
  agentConversationProjectionSchema,
  agentStatusSchema,
  agentSummarySchema,
  delegationSchema,
  delegationStatusSchema,
  type AgentCapability,
  type AgentConversationProjection,
  type AgentStatus,
  type AgentSummary,
  type Delegation,
  type DelegationStatus,
} from "../shared/agent";
import {
  DEFAULT_MODEL,
  defaultThinkingLevel,
  type SupportedModelSelection,
  type ThinkingLevel,
} from "../shared/models";

import {
  DEFAULT_TASK_ACCESS_MODE,
  DEFAULT_TASK_INTERACTION_MODE,
  taskAccessModeSchema,
  taskInteractionModeSchema,
  taskExecutionTargetSchema,
  taskConversationProjectionSchema,
  taskStatusSchema,
  taskSummarySchema,
  type TaskAccessMode,
  type TaskConversationProjection,
  type TaskExecutionTarget,
  type TaskInteractionMode,
  type TaskStatus,
  type TaskSummary,
} from "../shared/task";
import {
  appSettingsSchema,
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type SettingsUpdate,
  type ThemePreference,
} from "../shared/settings";
import {
  workspaceInfoSchema,
  type WorkspaceInfo,
} from "../shared/workspace";

const SCHEMA_VERSION = 9;

interface SettingsRow {
  theme: ThemePreference;
  window_width: number;
  window_height: number;
  window_maximized: 0 | 1;
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  execution_target: string;
  access_mode: string;
  interaction_mode: string;
  workspace_id: string;
  workspace_path: string;
  git_common_dir: string | null;
  integration_branch: string | null;
  checkout_branch: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  base_commit: string | null;
  pi_session_id: string | null;
  session_file: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkspaceRow {
  id: string;
  canonical_path: string;
  git_common_dir: string | null;
  integration_branch: string | null;
  checkout_branch: string | null;
}

interface TaskConversationProjectionRow {
  projection_json: string;
}

interface ProviderCredentialRow {
  provider: Provider;
  encrypted_blob: Buffer;
}

interface AgentRow {
  id: string;
  task_id: string;
  parent_agent_id: string | null;
  role: string;
  profile_id: string | null;
  capability: string;
  status: string;
  model_json: string;
  thinking_level: string;
  assignment: string | null;
  result: string | null;
  error: string | null;
  pi_session_id: string | null;
  session_file: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentProjectionRow {
  projection_json: string;
}

interface DelegationRow {
  id: string;
  task_id: string;
  task_run_id: string;
  parent_agent_id: string;
  child_agent_id: string;
  profile_id: string;
  capability: string;
  prompt: string;
  status: string;
  result: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface DelegationDependencyRow {
  delegation_id: string;
  depends_on_id: string;
}

export interface StoredAgent extends AgentSummary {
  sessionReference?: AgentSessionReference;
}

type TaskSummaryRow = Pick<
  TaskRow,
  | "id"
  | "title"
  | "status"
  | "execution_target"
  | "access_mode"
  | "interaction_mode"
  | "workspace_id"
  | "workspace_path"
  | "git_common_dir"
  | "integration_branch"
  | "checkout_branch"
  | "branch_name"
  | "created_at"
  | "updated_at"
>;

export interface StoredTask extends TaskSummary {
  executionPath: string;
  repository?: StoredRepository;
  worktree?: StoredWorktree;
  sessionReference?: AgentSessionReference;
}

export interface StoredRepository {
  commonDirectory: string;
  integrationBranch: string;
}

export interface StoredWorktree {
  path: string;
  branch: string;
  baseCommit: string;
}

function repositoryFromRow(
  row: Pick<WorkspaceRow, "git_common_dir" | "integration_branch">,
): StoredRepository | undefined {
  if (row.git_common_dir === null || row.integration_branch === null) {
    return undefined;
  }
  return {
    commonDirectory: row.git_common_dir,
    integrationBranch: row.integration_branch,
  };
}

function workspaceFromRow(row: WorkspaceRow): WorkspaceInfo {
  return workspaceInfoSchema.parse({
    id: row.id,
    path: row.canonical_path,
    name: basename(row.canonical_path) || row.canonical_path,
    worktreeAvailable: repositoryFromRow(row) !== undefined,
    branch: row.checkout_branch,
  });
}

function taskBranchFromRow(
  row: Pick<TaskRow, "execution_target" | "checkout_branch" | "branch_name">,
): string | null {
  return row.execution_target === "worktree"
    ? row.branch_name
    : row.checkout_branch;
}

function agentFromRow(row: AgentRow): StoredAgent {
  const agent: StoredAgent = agentSummarySchema.parse({
    id: row.id,
    taskId: row.task_id,
    parentAgentId: row.parent_agent_id,
    role: row.role,
    profileId: row.profile_id,
    capability: row.capability,
    status: row.status,
    model: JSON.parse(row.model_json),
    thinkingLevel: row.thinking_level,
    assignment: row.assignment,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  if (row.pi_session_id !== null && row.session_file !== null) {
    agent.sessionReference = {
      sessionId: row.pi_session_id,
      sessionFile: row.session_file,
    };
  }
  return agent;
}

function delegationFromRow(
  row: DelegationRow,
  dependencies: string[],
): Delegation {
  return delegationSchema.parse({
    id: row.id,
    taskId: row.task_id,
    taskRunId: row.task_run_id,
    parentAgentId: row.parent_agent_id,
    childAgentId: row.child_agent_id,
    profileId: row.profile_id,
    capability: row.capability,
    prompt: row.prompt,
    status: row.status,
    dependsOn: dependencies,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  });
}

export class AppStore {
  private readonly database: Database.Database;

  constructor(databasePath: string) {
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.createSchema();
  }

  getSettings(): AppSettings {
    const row = this.database
      .prepare(
        `SELECT theme, window_width, window_height, window_maximized
         FROM app_settings WHERE id = 1`,
      )
      .get() as SettingsRow | undefined;

    if (!row) {
      throw new Error("Application settings are missing.");
    }

    return appSettingsSchema.parse({
      theme: row.theme,
      window: {
        width: row.window_width,
        height: row.window_height,
        maximized: row.window_maximized === 1,
      },
    });
  }

  updateSettings(input: SettingsUpdate): AppSettings {
    if (input.theme) {
      this.database
        .prepare("UPDATE app_settings SET theme = ? WHERE id = 1")
        .run(input.theme);
    }

    return this.getSettings();
  }

  updateWindow(window: AppSettings["window"]): AppSettings {
    this.database
      .prepare(
        `UPDATE app_settings
         SET window_width = ?, window_height = ?, window_maximized = ?
         WHERE id = 1`,
      )
      .run(window.width, window.height, window.maximized ? 1 : 0);

    return this.getSettings();
  }

  saveWorkspace(
    canonicalPath: string,
    repository?: StoredRepository,
    checkoutBranch: string | null = null,
  ): WorkspaceInfo {
    const timestamp = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO workspaces
           (id, canonical_path, git_common_dir, integration_branch,
            checkout_branch, last_opened_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(canonical_path) DO UPDATE SET
           git_common_dir = excluded.git_common_dir,
           integration_branch = excluded.integration_branch,
           checkout_branch = excluded.checkout_branch,
           last_opened_at = excluded.last_opened_at`,
      )
      .run(
        randomUUID(),
        canonicalPath,
        repository?.commonDirectory ?? null,
        repository?.integrationBranch ?? null,
        checkoutBranch,
        timestamp,
      );

    const workspace = this.database
      .prepare(
        `SELECT id, canonical_path, git_common_dir, integration_branch,
                checkout_branch
         FROM workspaces WHERE canonical_path = ?`,
      )
      .get(canonicalPath) as WorkspaceRow | undefined;
    if (workspace === undefined) {
      throw new Error("Workspace could not be persisted.");
    }
    return workspaceFromRow(workspace);
  }

  getWorkspace(id: string): WorkspaceInfo | undefined {
    const row = this.database
      .prepare(
        `SELECT id, canonical_path, git_common_dir, integration_branch,
                checkout_branch
         FROM workspaces WHERE id = ?`,
      )
      .get(id) as WorkspaceRow | undefined;
    return row === undefined ? undefined : workspaceFromRow(row);
  }

  touchWorkspace(id: string): WorkspaceInfo {
    const result = this.database
      .prepare("UPDATE workspaces SET last_opened_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    if (result.changes !== 1) {
      throw new Error(`Workspace does not exist: ${id}`);
    }
    return this.getWorkspace(id)!;
  }

  getWorkspaceRepository(id: string): StoredRepository | undefined {
    const row = this.database
      .prepare(
        `SELECT id, canonical_path, git_common_dir, integration_branch,
                checkout_branch
         FROM workspaces WHERE id = ?`,
      )
      .get(id) as WorkspaceRow | undefined;
    return row === undefined ? undefined : repositoryFromRow(row);
  }

  setWorkspaceRepository(
    id: string,
    repository?: StoredRepository,
    checkoutBranch: string | null = null,
  ): WorkspaceInfo {
    const result = this.database
      .prepare(
        `UPDATE workspaces
         SET git_common_dir = ?, integration_branch = ?, checkout_branch = ?
         WHERE id = ?`,
      )
      .run(
        repository?.commonDirectory ?? null,
        repository?.integrationBranch ?? null,
        checkoutBranch,
        id,
      );
    if (result.changes !== 1) {
      throw new Error(`Workspace does not exist: ${id}`);
    }
    return this.getWorkspace(id)!;
  }

  listWorkspaces(): WorkspaceInfo[] {
    const rows = this.database
      .prepare(
        `SELECT id, canonical_path, git_common_dir, integration_branch,
                checkout_branch
         FROM workspaces
         ORDER BY rowid DESC`,
      )
      .all() as WorkspaceRow[];
    return rows.map(workspaceFromRow);
  }

  listTasks(): TaskSummary[] {
    const rows = this.database
      .prepare(
        `SELECT tasks.id, tasks.title, tasks.status, tasks.execution_target,
                tasks.access_mode, tasks.interaction_mode,
                tasks.workspace_id,
                workspaces.canonical_path AS workspace_path,
                workspaces.git_common_dir, workspaces.integration_branch,
                workspaces.checkout_branch, tasks.branch_name,
                tasks.created_at, tasks.updated_at
         FROM tasks
         JOIN workspaces ON workspaces.id = tasks.workspace_id
         ORDER BY created_at DESC, tasks.id DESC`,
      )
      .all() as TaskSummaryRow[];

    return rows.map((row) =>
      taskSummarySchema.parse({
        id: row.id,
        title: row.title,
        status: row.status,
        executionTarget: row.execution_target,
        accessMode: row.access_mode,
        interactionMode: row.interaction_mode,
        branch: taskBranchFromRow(row),
        workspace: workspaceFromRow({
          id: row.workspace_id,
          canonical_path: row.workspace_path,
          git_common_dir: row.git_common_dir,
          integration_branch: row.integration_branch,
          checkout_branch: row.checkout_branch,
        }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    );
  }

  getTask(id: string): StoredTask | undefined {
    const row = this.database
      .prepare(
        `SELECT tasks.id, tasks.title, tasks.status, tasks.execution_target,
                tasks.access_mode, tasks.interaction_mode,
                tasks.workspace_id,
                workspaces.canonical_path AS workspace_path,
                workspaces.git_common_dir, workspaces.integration_branch,
                workspaces.checkout_branch,
                tasks.worktree_path, tasks.branch_name, tasks.base_commit,
                tasks.pi_session_id, tasks.session_file,
                tasks.created_at, tasks.updated_at
         FROM tasks
         JOIN workspaces ON workspaces.id = tasks.workspace_id
         WHERE tasks.id = ?`,
      )
      .get(id) as TaskRow | undefined;

    if (row === undefined) return undefined;

    const task: StoredTask = {
      ...taskSummarySchema.parse({
        id: row.id,
        title: row.title,
        status: row.status,
        executionTarget: row.execution_target,
        accessMode: row.access_mode,
        interactionMode: row.interaction_mode,
        branch: taskBranchFromRow(row),
        workspace: workspaceFromRow({
          id: row.workspace_id,
          canonical_path: row.workspace_path,
          git_common_dir: row.git_common_dir,
          integration_branch: row.integration_branch,
          checkout_branch: row.checkout_branch,
        }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
      executionPath: row.worktree_path ?? row.workspace_path,
    };
    const repository = repositoryFromRow({
      git_common_dir: row.git_common_dir,
      integration_branch: row.integration_branch,
    });
    if (repository !== undefined) task.repository = repository;
    if (
      row.worktree_path !== null &&
      row.branch_name !== null &&
      row.base_commit !== null
    ) {
      task.worktree = {
        path: row.worktree_path,
        branch: row.branch_name,
        baseCommit: row.base_commit,
      };
    }
    if (row.pi_session_id !== null && row.session_file !== null) {
      task.sessionReference = {
        sessionId: row.pi_session_id,
        sessionFile: row.session_file,
      };
    }
    return task;
  }

  createTask(input: {
    id: string;
    title: string;
    status: TaskStatus;
    workspaceId: string;
    executionTarget?: TaskExecutionTarget;
    accessMode?: TaskAccessMode;
    interactionMode?: TaskInteractionMode;
    worktree?: StoredWorktree;
  }): StoredTask {
    const status = taskStatusSchema.parse(input.status);
    const executionTarget = taskExecutionTargetSchema.parse(
      input.executionTarget ?? "local",
    );
    const accessMode = taskAccessModeSchema.parse(
      input.accessMode ?? DEFAULT_TASK_ACCESS_MODE,
    );
    const interactionMode = taskInteractionModeSchema.parse(
      input.interactionMode ?? DEFAULT_TASK_INTERACTION_MODE,
    );
    if (
      (executionTarget === "worktree" && input.worktree === undefined) ||
      (executionTarget === "local" && input.worktree !== undefined)
    ) {
      throw new Error("Task execution target does not match its worktree.");
    }
    const timestamp = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO tasks
           (id, title, status, execution_target, access_mode, interaction_mode,
            workspace_id,
            worktree_path, branch_name, base_commit, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.title,
        status,
        executionTarget,
        accessMode,
        interactionMode,
        input.workspaceId,
        input.worktree?.path ?? null,
        input.worktree?.branch ?? null,
        input.worktree?.baseCommit ?? null,
        timestamp,
        timestamp,
      );
    return this.requireTask(input.id);
  }

  updateTaskAccessMode(id: string, accessMode: TaskAccessMode): StoredTask {
    const value = taskAccessModeSchema.parse(accessMode);
    const result = this.database
      .prepare(
        `UPDATE tasks SET access_mode = ?, updated_at = ? WHERE id = ?`,
      )
      .run(value, new Date().toISOString(), id);
    if (result.changes !== 1) {
      throw new Error(`Task access mode could not be set: ${id}`);
    }
    return this.requireTask(id);
  }

  updateTaskInteractionMode(
    id: string,
    interactionMode: TaskInteractionMode,
  ): StoredTask {
    const value = taskInteractionModeSchema.parse(interactionMode);
    const result = this.database
      .prepare(
        `UPDATE tasks SET interaction_mode = ?, updated_at = ? WHERE id = ?`,
      )
      .run(value, new Date().toISOString(), id);
    if (result.changes !== 1) {
      throw new Error(`Task interaction mode could not be set: ${id}`);
    }
    return this.requireTask(id);
  }

  setTaskSessionReference(
    id: string,
    reference: AgentSessionReference,
  ): StoredTask {
    const result = this.database
      .prepare(
        `UPDATE tasks
         SET pi_session_id = ?, session_file = ?, updated_at = ?
         WHERE id = ? AND pi_session_id IS NULL AND session_file IS NULL`,
      )
      .run(
        reference.sessionId,
        reference.sessionFile,
        new Date().toISOString(),
        id,
      );
    if (result.changes !== 1) {
      throw new Error(`Task session reference could not be set: ${id}`);
    }
    return this.requireTask(id);
  }

  updateTaskStatus(id: string, status: TaskStatus): StoredTask {
    const value = taskStatusSchema.parse(status);
    const result = this.database
      .prepare(
        `UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`,
      )
      .run(value, new Date().toISOString(), id);
    if (result.changes !== 1) {
      throw new Error(`Task does not exist: ${id}`);
    }
    return this.requireTask(id);
  }

  markRunningTasksInterrupted(): void {
    const timestamp = new Date().toISOString();
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE tasks SET status = 'interrupted', updated_at = ?
           WHERE status = 'running'`,
        )
        .run(timestamp);
      this.database
        .prepare(
          `UPDATE task_runs
           SET status = 'interrupted', updated_at = ?, finished_at = ?
           WHERE status = 'running'`,
        )
        .run(timestamp, timestamp);
      this.database
        .prepare(
          `UPDATE agents SET status = 'interrupted', updated_at = ?
           WHERE status IN ('queued', 'running', 'waiting')`,
        )
        .run(timestamp);
      this.database
        .prepare(
          `UPDATE delegations
           SET status = 'interrupted', updated_at = ?, finished_at = ?
           WHERE status IN ('queued', 'running')`,
        )
        .run(timestamp, timestamp);
    })();
  }

  saveTaskConversationProjection(
    taskId: string,
    projection: TaskConversationProjection,
  ): TaskConversationProjection {
    const value = taskConversationProjectionSchema.parse(projection);
    this.database
      .prepare(
        `INSERT INTO task_conversation_projections
           (task_id, projection_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           projection_json = excluded.projection_json,
           updated_at = excluded.updated_at`,
      )
      .run(taskId, JSON.stringify(value), new Date().toISOString());
    return value;
  }

  getTaskConversationProjection(
    taskId: string,
  ): TaskConversationProjection | undefined {
    const row = this.database
      .prepare(
        `SELECT projection_json
         FROM task_conversation_projections
         WHERE task_id = ?`,
      )
      .get(taskId) as TaskConversationProjectionRow | undefined;
    if (row === undefined) return undefined;
    return taskConversationProjectionSchema.parse(JSON.parse(row.projection_json));
  }

  beginTaskRun(id: string, taskId: string): void {
    this.requireTask(taskId);
    const timestamp = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO task_runs (id, task_id, status, created_at, updated_at)
         VALUES (?, ?, 'running', ?, ?)`,
      )
      .run(id, taskId, timestamp, timestamp);
  }

  finishTaskRun(
    id: string,
    status: "completed" | "cancelled" | "interrupted" | "failed",
  ): void {
    const timestamp = new Date().toISOString();
    const result = this.database
      .prepare(
        `UPDATE task_runs
         SET status = ?, updated_at = ?, finished_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(status, timestamp, timestamp, id);
    if (result.changes !== 1) {
      throw new Error(`Task run is not active: ${id}`);
    }
  }

  ensureLeadAgent(
    taskId: string,
    model: SupportedModelSelection = DEFAULT_MODEL,
    thinkingLevel: ThinkingLevel = defaultThinkingLevel(model),
  ): StoredAgent {
    this.requireTask(taskId);
    const existing = this.database
      .prepare("SELECT * FROM agents WHERE task_id = ? AND role = 'lead'")
      .get(taskId) as AgentRow | undefined;
    if (existing !== undefined) {
      if (
        existing.model_json !== JSON.stringify(model) ||
        existing.thinking_level !== thinkingLevel
      ) {
        this.database
          .prepare(
            `UPDATE agents
             SET model_json = ?, thinking_level = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            JSON.stringify(model),
            thinkingLevel,
            new Date().toISOString(),
            existing.id,
          );
        return this.requireAgent(existing.id);
      }
      return agentFromRow(existing);
    }
    const timestamp = new Date().toISOString();
    const id = `lead:${taskId}`;
    this.database
      .prepare(
        `INSERT INTO agents
           (id, task_id, parent_agent_id, role, profile_id, capability, status,
            model_json, thinking_level, assignment, result, error,
            pi_session_id, session_file, created_at, updated_at)
         VALUES (?, ?, NULL, 'lead', NULL, 'write', 'idle', ?, ?, NULL, NULL,
                 NULL, NULL, NULL, ?, ?)`,
      )
      .run(id, taskId, JSON.stringify(model), thinkingLevel, timestamp, timestamp);
    const task = this.requireTask(taskId);
    if (task.sessionReference !== undefined) {
      this.setAgentSessionReference(id, task.sessionReference);
    }
    const projection = this.getTaskConversationProjection(taskId);
    if (projection !== undefined) {
      this.saveAgentConversationProjection(id, {
        messages: projection.messages,
        userEntries: projection.userEntries,
      });
    }
    return this.requireAgent(id);
  }

  createSubagent(input: {
    id: string;
    taskId: string;
    parentAgentId: string;
    profileId: string;
    capability: AgentCapability;
    model: SupportedModelSelection;
    thinkingLevel: ThinkingLevel;
    assignment: string;
  }): StoredAgent {
    this.requireTask(input.taskId);
    this.requireAgent(input.parentAgentId);
    const timestamp = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO agents
           (id, task_id, parent_agent_id, role, profile_id, capability, status,
            model_json, thinking_level, assignment, result, error,
            pi_session_id, session_file, created_at, updated_at)
         VALUES (?, ?, ?, 'subagent', ?, ?, 'queued', ?, ?, ?, NULL, NULL,
                 NULL, NULL, ?, ?)`,
      )
      .run(
        input.id,
        input.taskId,
        input.parentAgentId,
        input.profileId,
        input.capability,
        JSON.stringify(input.model),
        input.thinkingLevel,
        input.assignment,
        timestamp,
        timestamp,
      );
    return this.requireAgent(input.id);
  }

  getAgent(id: string): StoredAgent | undefined {
    const row = this.database
      .prepare("SELECT * FROM agents WHERE id = ?")
      .get(id) as AgentRow | undefined;
    return row === undefined ? undefined : agentFromRow(row);
  }

  listAgents(taskId: string): StoredAgent[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM agents WHERE task_id = ?
         ORDER BY CASE role WHEN 'lead' THEN 0 ELSE 1 END, created_at, id`,
      )
      .all(taskId) as AgentRow[];
    return rows.map(agentFromRow);
  }

  updateAgentStatus(
    id: string,
    status: AgentStatus,
    outcome: { result?: string | null; error?: string | null } = {},
  ): StoredAgent {
    const value = agentStatusSchema.parse(status);
    const current = this.requireAgent(id);
    const result = outcome.result === undefined ? current.result : outcome.result;
    const error = outcome.error === undefined ? current.error : outcome.error;
    const updated = this.database
      .prepare(
        `UPDATE agents
         SET status = ?, result = ?, error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(value, result, error, new Date().toISOString(), id);
    if (updated.changes !== 1) throw new Error(`Agent does not exist: ${id}`);
    return this.requireAgent(id);
  }

  setAgentSessionReference(
    id: string,
    reference: AgentSessionReference,
  ): StoredAgent {
    const current = this.requireAgent(id);
    if (
      current.sessionReference?.sessionId === reference.sessionId &&
      current.sessionReference.sessionFile === reference.sessionFile
    ) {
      return current;
    }
    if (current.sessionReference !== undefined) {
      throw new Error(`Agent session reference is already set: ${id}`);
    }
    const result = this.database
      .prepare(
        `UPDATE agents
         SET pi_session_id = ?, session_file = ?, updated_at = ?
         WHERE id = ? AND pi_session_id IS NULL AND session_file IS NULL`,
      )
      .run(
        reference.sessionId,
        reference.sessionFile,
        new Date().toISOString(),
        id,
      );
    if (result.changes !== 1) {
      throw new Error(`Agent session reference could not be set: ${id}`);
    }
    return this.requireAgent(id);
  }

  saveAgentConversationProjection(
    agentId: string,
    projection: AgentConversationProjection,
  ): AgentConversationProjection {
    this.requireAgent(agentId);
    const value = agentConversationProjectionSchema.parse(projection);
    this.database
      .prepare(
        `INSERT INTO agent_conversation_projections
           (agent_id, projection_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           projection_json = excluded.projection_json,
           updated_at = excluded.updated_at`,
      )
      .run(agentId, JSON.stringify(value), new Date().toISOString());
    return value;
  }

  getAgentConversationProjection(
    agentId: string,
  ): AgentConversationProjection | undefined {
    const row = this.database
      .prepare(
        `SELECT projection_json FROM agent_conversation_projections
         WHERE agent_id = ?`,
      )
      .get(agentId) as AgentProjectionRow | undefined;
    return row === undefined
      ? undefined
      : agentConversationProjectionSchema.parse(JSON.parse(row.projection_json));
  }

  createDelegation(input: {
    id: string;
    taskId: string;
    taskRunId: string;
    parentAgentId: string;
    childAgentId: string;
    profileId: string;
    capability: AgentCapability;
    prompt: string;
    dependsOn: string[];
  }): Delegation {
    const timestamp = new Date().toISOString();
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO delegations
             (id, task_id, task_run_id, parent_agent_id, child_agent_id,
              profile_id, capability, prompt, status, result, error,
              created_at, started_at, finished_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, ?, NULL, NULL, ?)`,
        )
        .run(
          input.id,
          input.taskId,
          input.taskRunId,
          input.parentAgentId,
          input.childAgentId,
          input.profileId,
          input.capability,
          input.prompt,
          timestamp,
          timestamp,
        );
      const insertDependency = this.database.prepare(
        `INSERT INTO delegation_dependencies (delegation_id, depends_on_id)
         VALUES (?, ?)`,
      );
      for (const dependency of input.dependsOn) {
        insertDependency.run(input.id, dependency);
      }
    })();
    return this.requireDelegation(input.id);
  }

  getDelegation(id: string): Delegation | undefined {
    const row = this.database
      .prepare("SELECT * FROM delegations WHERE id = ?")
      .get(id) as DelegationRow | undefined;
    return row === undefined ? undefined : this.delegationFromStoredRow(row);
  }

  listDelegations(taskId: string): Delegation[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM delegations WHERE task_id = ? ORDER BY created_at, id",
      )
      .all(taskId) as DelegationRow[];
    return rows.map((row) => this.delegationFromStoredRow(row));
  }

  updateDelegationStatus(
    id: string,
    status: DelegationStatus,
    outcome: { result?: string | null; error?: string | null } = {},
  ): Delegation {
    const value = delegationStatusSchema.parse(status);
    const current = this.requireDelegation(id);
    const timestamp = new Date().toISOString();
    const startedAt =
      value === "running" && current.startedAt === null
        ? timestamp
        : current.startedAt;
    const terminal = !["queued", "running"].includes(value);
    const result = outcome.result === undefined ? current.result : outcome.result;
    const error = outcome.error === undefined ? current.error : outcome.error;
    const updated = this.database
      .prepare(
        `UPDATE delegations
         SET status = ?, result = ?, error = ?, started_at = ?,
             finished_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        value,
        result,
        error,
        startedAt,
        terminal ? (current.finishedAt ?? timestamp) : null,
        timestamp,
        id,
      );
    if (updated.changes !== 1) throw new Error(`Delegation does not exist: ${id}`);
    return this.requireDelegation(id);
  }

  listEncryptedProviderCredentialProviders(): Provider[] {
    const rows = this.database
      .prepare("SELECT provider FROM provider_credentials ORDER BY provider")
      .all() as Array<Pick<ProviderCredentialRow, "provider">>;
    return rows.map((row) => row.provider);
  }

  getEncryptedProviderCredential(provider: Provider): Buffer | undefined {
    const row = this.database
      .prepare(
        `SELECT provider, encrypted_blob
         FROM provider_credentials WHERE provider = ?`,
      )
      .get(provider) as ProviderCredentialRow | undefined;
    return row === undefined ? undefined : Buffer.from(row.encrypted_blob);
  }

  setEncryptedProviderCredential(
    provider: Provider,
    encryptedBlob: Buffer,
  ): void {
    if (encryptedBlob.length === 0) {
      throw new Error("Encrypted provider credential cannot be empty.");
    }
    this.database
      .prepare(
        `INSERT INTO provider_credentials (provider, encrypted_blob, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET
           encrypted_blob = excluded.encrypted_blob,
           updated_at = excluded.updated_at`,
      )
      .run(provider, encryptedBlob, new Date().toISOString());
  }

  deleteEncryptedProviderCredential(provider: Provider): void {
    this.database
      .prepare("DELETE FROM provider_credentials WHERE provider = ?")
      .run(provider);
  }

  close(): void {
    this.database.close();
  }

  private createMultiAgentSchema(): void {
    this.database.exec(`
      CREATE TABLE task_runs (
        id TEXT PRIMARY KEY CHECK (length(id) > 0),
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (
          status IN ('running', 'completed', 'cancelled', 'interrupted', 'failed')
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE agents (
        id TEXT PRIMARY KEY CHECK (length(id) > 0),
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        parent_agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('lead', 'subagent')),
        profile_id TEXT,
        capability TEXT NOT NULL CHECK (capability IN ('read', 'write')),
        status TEXT NOT NULL CHECK (
          status IN (
            'idle', 'queued', 'running', 'waiting', 'completed', 'blocked',
            'cancelled', 'interrupted', 'failed'
          )
        ),
        model_json TEXT NOT NULL CHECK (length(model_json) > 0),
        thinking_level TEXT NOT NULL CHECK (
          thinking_level IN (
            'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'
          )
        ),
        assignment TEXT,
        result TEXT,
        error TEXT,
        pi_session_id TEXT UNIQUE,
        session_file TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (role = 'lead' AND parent_agent_id IS NULL AND profile_id IS NULL) OR
          (
            role = 'subagent' AND parent_agent_id IS NOT NULL AND
            profile_id IS NOT NULL AND length(profile_id) > 0
          )
        ),
        CHECK (
          (pi_session_id IS NULL AND session_file IS NULL) OR
          (
            pi_session_id IS NOT NULL AND session_file IS NOT NULL AND
            length(pi_session_id) > 0 AND length(session_file) > 0
          )
        )
      );

      CREATE UNIQUE INDEX agents_one_lead_per_task
        ON agents(task_id) WHERE role = 'lead';

      CREATE TABLE agent_conversation_projections (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
        projection_json TEXT NOT NULL CHECK (length(projection_json) > 0),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE delegations (
        id TEXT PRIMARY KEY CHECK (length(id) > 0),
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
        parent_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        child_agent_id TEXT NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL CHECK (length(profile_id) > 0),
        capability TEXT NOT NULL CHECK (capability IN ('read', 'write')),
        prompt TEXT NOT NULL CHECK (length(prompt) > 0),
        status TEXT NOT NULL CHECK (
          status IN (
            'queued', 'running', 'completed', 'blocked', 'cancelled',
            'interrupted', 'failed'
          )
        ),
        result TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE delegation_dependencies (
        delegation_id TEXT NOT NULL REFERENCES delegations(id) ON DELETE CASCADE,
        depends_on_id TEXT NOT NULL REFERENCES delegations(id) ON DELETE CASCADE,
        PRIMARY KEY (delegation_id, depends_on_id),
        CHECK (delegation_id <> depends_on_id)
      );
    `);
  }

  private migrateExistingTasksToLeadAgents(): void {
    const tasks = this.database
      .prepare(
        `SELECT id, status, pi_session_id, session_file, created_at, updated_at
         FROM tasks ORDER BY created_at, id`,
      )
      .all() as Array<
      Pick<
        TaskRow,
        | "id"
        | "status"
        | "pi_session_id"
        | "session_file"
        | "created_at"
        | "updated_at"
      >
    >;
    const insert = this.database.prepare(
      `INSERT INTO agents
         (id, task_id, parent_agent_id, role, profile_id, capability, status,
          model_json, thinking_level, assignment, result, error,
          pi_session_id, session_file, created_at, updated_at)
       VALUES (?, ?, NULL, 'lead', NULL, 'write', ?, ?, ?, NULL, NULL, NULL,
               ?, ?, ?, ?)`,
    );
    for (const task of tasks) {
      const projection = this.getTaskConversationProjection(task.id);
      const model = projection?.model ?? DEFAULT_MODEL;
      const thinkingLevel =
        projection?.thinkingLevel ?? defaultThinkingLevel(model);
      const agentId = `lead:${task.id}`;
      insert.run(
        agentId,
        task.id,
        task.status,
        JSON.stringify(model),
        thinkingLevel,
        task.pi_session_id,
        task.session_file,
        task.created_at,
        task.updated_at,
      );
      if (projection !== undefined) {
        this.saveAgentConversationProjection(agentId, {
          messages: projection.messages,
          userEntries: projection.userEntries,
        });
      }
    }
  }

  private createSchema(): void {
    const currentVersion = this.database.pragma("user_version", {
      simple: true,
    }) as number;

    if (currentVersion === SCHEMA_VERSION) return;
    if (
      currentVersion === 5 ||
      currentVersion === 6 ||
      currentVersion === 7 ||
      currentVersion === 8
    ) {
      this.database.transaction(() => {
        if (currentVersion === 5) {
          this.database.exec(`
            ALTER TABLE tasks ADD COLUMN access_mode TEXT NOT NULL
              DEFAULT 'auto' CHECK (access_mode IN ('ask', 'auto', 'full'));
          `);
        }
        if (currentVersion <= 6) {
          this.database.exec(`
            ALTER TABLE tasks ADD COLUMN interaction_mode TEXT NOT NULL
              DEFAULT 'agent' CHECK (interaction_mode IN ('agent', 'plan'));
          `);
        }
        if (currentVersion <= 7) {
          this.database.exec(`
            CREATE TABLE provider_credentials (
              provider TEXT PRIMARY KEY CHECK (
                provider IN ('deepseek', 'openai', 'xai')
              ),
              encrypted_blob BLOB NOT NULL CHECK (length(encrypted_blob) > 0),
              updated_at TEXT NOT NULL
            );
          `);
        }
        this.createMultiAgentSchema();
        if (currentVersion === 8) {
          this.migrateExistingTasksToLeadAgents();
        }
        this.database.pragma(`user_version = ${SCHEMA_VERSION}`);
      })();
      return;
    }
    if (currentVersion !== 0) {
      throw new Error(
        `Unsupported application schema version: ${currentVersion}. Reset the development database.`,
      );
    }

    const createSchema = this.database.transaction(() => {
      this.database.exec(`
        CREATE TABLE app_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          theme TEXT NOT NULL CHECK (theme IN ('system', 'light', 'dark')),
          window_width INTEGER NOT NULL CHECK (window_width BETWEEN 720 AND 10000),
          window_height INTEGER NOT NULL CHECK (window_height BETWEEN 560 AND 10000),
          window_maximized INTEGER NOT NULL CHECK (window_maximized IN (0, 1))
        );

        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY CHECK (length(id) > 0),
          canonical_path TEXT NOT NULL UNIQUE CHECK (length(canonical_path) > 0),
          git_common_dir TEXT,
          integration_branch TEXT,
          checkout_branch TEXT CHECK (
            checkout_branch IS NULL OR length(checkout_branch) > 0
          ),
          last_opened_at TEXT NOT NULL,
          CHECK (
            (git_common_dir IS NULL AND integration_branch IS NULL) OR
            (
              git_common_dir IS NOT NULL AND
              integration_branch IS NOT NULL AND
              length(git_common_dir) > 0 AND
              length(integration_branch) > 0
            )
          )
        );

        CREATE TABLE tasks (
          id TEXT PRIMARY KEY CHECK (length(id) > 0),
          title TEXT NOT NULL CHECK (length(title) > 0),
          status TEXT NOT NULL CHECK (
            status IN ('idle', 'running', 'completed', 'cancelled', 'interrupted', 'failed')
          ),
          execution_target TEXT NOT NULL CHECK (
            execution_target IN ('local', 'worktree')
          ),
          access_mode TEXT NOT NULL DEFAULT 'full' CHECK (
            access_mode IN ('ask', 'auto', 'full')
          ),
          interaction_mode TEXT NOT NULL DEFAULT 'agent' CHECK (
            interaction_mode IN ('agent', 'plan')
          ),
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          worktree_path TEXT,
          branch_name TEXT,
          base_commit TEXT,
          pi_session_id TEXT UNIQUE,
          session_file TEXT UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (
            (pi_session_id IS NULL AND session_file IS NULL) OR
            (
              pi_session_id IS NOT NULL AND
              session_file IS NOT NULL AND
              length(pi_session_id) > 0 AND
              length(session_file) > 0
            )
          ),
          CHECK (
            (
              execution_target = 'local' AND
              worktree_path IS NULL AND
              branch_name IS NULL AND
              base_commit IS NULL
            ) OR
            (
              execution_target = 'worktree' AND
              worktree_path IS NOT NULL AND
              branch_name IS NOT NULL AND
              base_commit IS NOT NULL AND
              length(worktree_path) > 0 AND
              length(branch_name) > 0 AND
              length(base_commit) > 0
            )
          )
        );

        CREATE UNIQUE INDEX workspaces_git_common_dir_unique
          ON workspaces(git_common_dir) WHERE git_common_dir IS NOT NULL;
        CREATE UNIQUE INDEX tasks_worktree_path_unique
          ON tasks(worktree_path) WHERE worktree_path IS NOT NULL;
        CREATE UNIQUE INDEX tasks_branch_name_unique
          ON tasks(branch_name) WHERE branch_name IS NOT NULL;

        CREATE TABLE task_conversation_projections (
          task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
          projection_json TEXT NOT NULL CHECK (length(projection_json) > 0),
          updated_at TEXT NOT NULL
        );

        CREATE TABLE provider_credentials (
          provider TEXT PRIMARY KEY CHECK (
            provider IN ('deepseek', 'openai', 'xai')
          ),
          encrypted_blob BLOB NOT NULL CHECK (length(encrypted_blob) > 0),
          updated_at TEXT NOT NULL
        );
      `);
      this.createMultiAgentSchema();

      this.database
        .prepare(
          `INSERT INTO app_settings
             (id, theme, window_width, window_height, window_maximized)
           VALUES (1, ?, ?, ?, ?)`,
        )
        .run(
          DEFAULT_APP_SETTINGS.theme,
          DEFAULT_APP_SETTINGS.window.width,
          DEFAULT_APP_SETTINGS.window.height,
          DEFAULT_APP_SETTINGS.window.maximized ? 1 : 0,
        );

      this.database.pragma(`user_version = ${SCHEMA_VERSION}`);
    });

    createSchema();
  }

  private requireAgent(id: string): StoredAgent {
    const agent = this.getAgent(id);
    if (agent === undefined) throw new Error(`Agent does not exist: ${id}`);
    return agent;
  }

  private delegationFromStoredRow(row: DelegationRow): Delegation {
    const dependencies = this.database
      .prepare(
        `SELECT delegation_id, depends_on_id
         FROM delegation_dependencies WHERE delegation_id = ?
         ORDER BY depends_on_id`,
      )
      .all(row.id) as DelegationDependencyRow[];
    return delegationFromRow(
      row,
      dependencies.map((dependency) => dependency.depends_on_id),
    );
  }

  private requireDelegation(id: string): Delegation {
    const delegation = this.getDelegation(id);
    if (delegation === undefined) {
      throw new Error(`Delegation does not exist: ${id}`);
    }
    return delegation;
  }

  private requireTask(id: string): StoredTask {
    const task = this.getTask(id);
    if (task === undefined) {
      throw new Error(`Task does not exist: ${id}`);
    }
    return task;
  }
}
