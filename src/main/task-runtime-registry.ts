import { randomUUID } from "node:crypto";
import { EventType } from "@ag-ui/core";

import type {
  AgentPromptResult,
  AgentSessionReference,
} from "../shared/agent-host-protocol";
import type {
  AgentCapability,
  AgentRole,
  AgentSummary,
  Delegation,
  DelegationResolveParams,
  DelegationRequest,
  DelegationToolResult,
  SubagentProfile,
} from "../shared/agent";
import {
  AGENT_UI_CUSTOM_EVENT,
  type AgentUiEvent,
} from "../shared/agent-ui";
import {
  clampThinkingLevel,
  defaultThinkingLevel,
  DEFAULT_MODEL,
  type SupportedModelSelection,
  type ThinkingLevel,
} from "../shared/models";
import type {
  TaskAccessMode,
  TaskCancelResult,
  TaskClearQueueResult,
  TaskEventEnvelope,
  TaskFollowUpResult,
  TaskPermissionRequest,
  TaskPermissionRequestEnvelope,
  TaskActivateResult,
  TaskRuntimeState,
  TaskRuntimeStateEnvelope,
  TaskExecutionTarget,
  TaskInteractionMode,
  TaskSnapshot,
  TaskStartResult,
  TaskSteerResult,
  TaskSummary,
} from "../shared/task";
import {
  DEFAULT_TASK_ACCESS_MODE,
  DEFAULT_TASK_INTERACTION_MODE,
} from "../shared/task";
import type { WorkspaceInfo } from "../shared/workspace";
import type {
  TodoEditOperation,
  TodoEditResult,
} from "../shared/todo";
import { AppStore, type StoredAgent, type StoredTask } from "./app-store";
import type {
  GitWorktreeService,
  WorktreeInput,
} from "./git-worktree-service";
import type { GitReviewService } from "./git-review-service";
import type {
  TaskControllerSnapshot,
  TaskRunStartResult,
} from "./task-controller";
import { PiSessionTodoStore } from "./pi-session-todo-store";
import { SubagentConfigService } from "./subagent-config-service";

export interface TaskRuntimeCallbacks {
  emit(runId: string, event: AgentUiEvent): void;
  saveSessionReference(reference: AgentSessionReference): boolean;
  saveSnapshot(snapshot: TaskControllerSnapshot): void;
  connectionLost(error: Error): void;
  permissionRequest(runId: string, request: TaskPermissionRequest): void;
  delegationRequest(request: DelegationRequest): void;
  settled(
    runId: string,
    result?: AgentPromptResult,
    snapshot?: TaskControllerSnapshot,
  ): void;
}

export interface TaskRuntime {
  readonly ready: boolean;
  readonly model: SupportedModelSelection | undefined;
  readonly thinkingLevel: ThinkingLevel | undefined;
  start(text: string, runId: string): Promise<TaskRunStartResult>;
  open(): Promise<TaskControllerSnapshot>;
  steer(text: string): Promise<TaskSteerResult>;
  followUp(text: string): Promise<TaskFollowUpResult>;
  editTodo(input: TodoEditOperation): Promise<TodoEditResult>;
  clearQueue(): Promise<TaskClearQueueResult>;
  cancel(): Promise<TaskCancelResult>;
  resolvePermission(requestId: string, allowed: boolean): Promise<boolean>;
  resolveDelegation?(
    params: DelegationResolveParams,
  ): Promise<boolean>;
  completeDelegation?(params: { delegation: Delegation }): Promise<boolean>;
  dispose(): Promise<void>;
  terminate(): void;
}

export type TaskControllerFactory = (
  task: StoredTask,
  callbacks: TaskRuntimeCallbacks,
  initialModel?: SupportedModelSelection,
  initialThinkingLevel?: ThinkingLevel,
  agent?: AgentRuntimeConfig,
) => TaskRuntime;

export interface AgentRuntimeConfig {
  id: string;
  role: AgentRole;
  capability: AgentCapability;
  profileInstructions?: string;
  sessionReference?: AgentSessionReference;
}

export type WorkspaceAvailabilityCheck = (
  workspace: WorkspaceInfo,
) => Promise<void>;

export interface TaskRuntimeRegistryOptions {
  maxIdleRuntimes?: number;
  idleTtlMs?: number;
  sendRuntimeState?(envelope: TaskRuntimeStateEnvelope): void;
  sendPermissionRequest?(envelope: TaskPermissionRequestEnvelope): void;
  recordTiming?(
    metric:
      | "conversation-open"
      | "runtime-prepare"
      | "prepared-run-start",
    durationMs: number,
    taskId: string,
  ): void;
  worktrees?: Pick<
    GitWorktreeService,
    "probeProject" | "createWorktree" | "validateWorktree" | "removeWorktree"
  >;
  review?: Pick<GitReviewService, "ensureBaseline">;
  subagentConfig?: Pick<SubagentConfigService, "load">;
}

// A runtime attaches to a run; idle retention is a short grace for follow-up
// prompts, not a latency strategy. Reopening is cheap once boot is prewarmed.
const DEFAULT_MAX_IDLE_RUNTIMES = 1;
const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1_000;

function statusForEvent(event: AgentUiEvent): StoredTask["status"] | undefined {
  switch (event.type) {
    case EventType.RUN_STARTED:
      return "running";
    case EventType.RUN_FINISHED:
      return "completed";
    case EventType.RUN_ERROR:
      return "failed";
    case EventType.CUSTOM:
      return event.name === AGENT_UI_CUSTOM_EVENT.RUN_CANCELLED
        ? "cancelled"
        : undefined;
    default:
      return undefined;
  }
}

function sameModel(
  first: SupportedModelSelection | undefined,
  second: SupportedModelSelection,
): boolean {
  return first?.provider === second.provider && first.id === second.id;
}

function assistantResult(snapshot?: TaskControllerSnapshot): string {
  const message = snapshot?.messages
    .slice()
    .reverse()
    .find((candidate) => candidate.role === "assistant");
  return message?.role === "assistant" ? message.content ?? "" : "";
}

function isDelegationTerminal(delegation: Delegation): boolean {
  return delegation.status !== "queued" && delegation.status !== "running";
}

function toAgentSummary(agent: StoredAgent): AgentSummary {
  const { sessionReference, ...summary } = agent;
  void sessionReference;
  return summary;
}

interface DelegationWaiter {
  promise: Promise<Delegation>;
  resolve(delegation: Delegation): void;
}

interface ChildRuntime {
  taskRunId: string;
  agentRunId: string;
  delegationId: string;
  background: boolean;
  controller: TaskRuntime;
}

export class TaskRuntimeRegistry {
  private readonly sessionTodos = new PiSessionTodoStore();
  private readonly runtimes = new Map<string, TaskRuntime>();
  private readonly runningTaskIds = new Set<string>();
  private readonly activeTaskRuns = new Map<string, string>();
  private readonly childRuntimes = new Map<string, ChildRuntime>();
  private readonly delegationWaiters = new Map<string, DelegationWaiter>();
  private readonly permissionOwners = new Map<string, string>();
  private readonly writeAgents = new Map<string, string>();
  private readonly disposals = new Map<string, Promise<void>>();
  private readonly disposingRuntimes = new Set<TaskRuntime>();
  private readonly lastUsed = new Map<string, number>();
  private readonly evictionTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly maxIdleRuntimes: number;
  private readonly idleTtlMs: number;
  private readonly sendRuntimeState:
    | ((envelope: TaskRuntimeStateEnvelope) => void)
    | undefined;
  private readonly sendPermissionRequest:
    | ((envelope: TaskPermissionRequestEnvelope) => void)
    | undefined;
  private readonly recordTiming: TaskRuntimeRegistryOptions["recordTiming"];
  private readonly worktrees: TaskRuntimeRegistryOptions["worktrees"];
  private readonly review: TaskRuntimeRegistryOptions["review"];
  private readonly subagentConfig: Pick<SubagentConfigService, "load">;
  private selectedTaskId: string | undefined;

  constructor(
    private readonly store: AppStore,
    private readonly createController: TaskControllerFactory,
    private readonly sendEvent: (envelope: TaskEventEnvelope) => void,
    private readonly checkWorkspace: WorkspaceAvailabilityCheck,
    options: TaskRuntimeRegistryOptions = {},
  ) {
    this.maxIdleRuntimes =
      options.maxIdleRuntimes ?? DEFAULT_MAX_IDLE_RUNTIMES;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.sendRuntimeState = options.sendRuntimeState;
    this.sendPermissionRequest = options.sendPermissionRequest;
    this.recordTiming = options.recordTiming;
    this.worktrees = options.worktrees;
    this.review = options.review;
    this.subagentConfig = options.subagentConfig ?? new SubagentConfigService();
  }

  create(title: string, workspaceId: string): TaskSummary;
  create(
    title: string,
    workspaceId: string,
    executionTarget: "local",
    accessMode?: TaskAccessMode,
    interactionMode?: TaskInteractionMode,
  ): TaskSummary;
  create(
    title: string,
    workspaceId: string,
    executionTarget: "worktree",
    accessMode?: TaskAccessMode,
    interactionMode?: TaskInteractionMode,
  ): Promise<TaskSummary>;
  create(
    title: string,
    workspaceId: string,
    executionTarget: TaskExecutionTarget,
    accessMode?: TaskAccessMode,
    interactionMode?: TaskInteractionMode,
  ): TaskSummary | Promise<TaskSummary>;
  create(
    title: string,
    workspaceId: string,
    executionTarget: TaskExecutionTarget = "local",
    accessMode: TaskAccessMode = DEFAULT_TASK_ACCESS_MODE,
    interactionMode: TaskInteractionMode = DEFAULT_TASK_INTERACTION_MODE,
  ): TaskSummary | Promise<TaskSummary> {
    const workspace = this.store.getWorkspace(workspaceId);
    if (workspace === undefined) {
      throw new Error(`Workspace does not exist: ${workspaceId}`);
    }
    const id = randomUUID();
    if (executionTarget === "local") {
      return this.store.createTask({
        id,
        title,
        status: "idle",
        workspaceId,
        executionTarget,
        accessMode,
        interactionMode,
      });
    }
    return this.createWorktreeTask(
      id,
      title,
      workspace,
      accessMode,
      interactionMode,
    );
  }

  private async createWorktreeTask(
    id: string,
    title: string,
    workspace: WorkspaceInfo,
    accessMode: TaskAccessMode,
    interactionMode: TaskInteractionMode,
  ): Promise<TaskSummary> {
    await this.checkWorkspace(workspace);
    if (this.worktrees === undefined) {
      throw new Error("Git worktrees are unavailable.");
    }
    const capability = await this.worktrees.probeProject(workspace.path);
    if (
      capability.path !== workspace.path ||
      capability.repository === undefined
    ) {
      this.store.setWorkspaceRepository(
        workspace.id,
        undefined,
        capability.checkoutBranch,
      );
      throw new Error("This project does not support Git worktrees.");
    }
    this.store.setWorkspaceRepository(
      workspace.id,
      capability.repository,
      capability.checkoutBranch,
    );
    const input: WorktreeInput = {
      projectId: workspace.id,
      taskId: id,
      projectPath: workspace.path,
      repository: capability.repository,
    };
    const worktree = await this.worktrees.createWorktree(input);
    try {
      return this.store.createTask({
        id,
        title,
        status: "idle",
        workspaceId: workspace.id,
        executionTarget: "worktree",
        accessMode,
        interactionMode,
        worktree,
      });
    } catch (error) {
      await this.worktrees.removeWorktree(input, worktree);
      throw error;
    }
  }

  async open(taskId: string): Promise<TaskSnapshot> {
    await this.waitForDisposal(taskId);
    const task = this.requireTask(taskId);
    await this.checkTaskAvailability(task);
    const openedAt = performance.now();
    const projection = this.store.getTaskConversationProjection(taskId);
    if (projection !== undefined) {
      this.measure("conversation-open", openedAt, taskId);
      return this.toSnapshot(task, projection);
    }
    const active = this.runtimes.get(taskId);
    if (active !== undefined) {
      const snapshot = await active.open();
      this.store.saveTaskConversationProjection(taskId, snapshot);
      return this.toSnapshot(task, snapshot);
    }

    if (task.sessionReference === undefined) {
      return this.toSnapshot(task, {
        model: DEFAULT_MODEL,
        thinkingLevel: defaultThinkingLevel(DEFAULT_MODEL),
        messages: [],
        userEntries: [],
        todo: null,
      });
    }

    const controller = this.buildController(task);
    try {
      const snapshot = await controller.open();
      this.store.saveTaskConversationProjection(taskId, snapshot);
      return this.toSnapshot(task, snapshot);
    } finally {
      await controller.dispose();
    }
  }

  async start(
    taskId: string,
    text: string,
    model: SupportedModelSelection,
    thinkingLevel: ThinkingLevel,
  ): Promise<TaskStartResult> {
    await this.waitForDisposal(taskId);
    const task = this.requireTask(taskId);
    await this.checkTaskAvailability(task);
    if (this.runningTaskIds.has(taskId)) {
      throw new Error("A task is already running");
    }
    this.assertProjectConcurrency(task);
    this.runningTaskIds.add(taskId);
    this.emitRuntimeState(taskId, "preparing");
    const runId = randomUUID();
    let taskRunStarted = false;
    try {
      const preparingAt = performance.now();
      const effectiveThinkingLevel = clampThinkingLevel(model, thinkingLevel);
      const lead = this.store.ensureLeadAgent(
        taskId,
        model,
        effectiveThinkingLevel,
      );
      this.store.beginTaskRun(runId, taskId);
      taskRunStarted = true;
      this.activeTaskRuns.set(taskId, runId);
      this.store.updateAgentStatus(lead.id, "running", {
        result: null,
        error: null,
      });
      const prepared = this.prepareRuntimeForStart(
        task,
        model,
        effectiveThinkingLevel,
      ).finally(() => this.measure("runtime-prepare", preparingAt, taskId));
      // The baseline capture scans the execution root and is independent of
      // runtime preparation; only the run itself needs both.
      const [controller] = await Promise.all([
        prepared,
        this.review?.ensureBaseline(taskId),
      ]);
      const runStartingAt = performance.now();
      await controller.start(text, runId);
      this.measure("prepared-run-start", runStartingAt, taskId);
      return { runId };
    } catch (error) {
      this.runningTaskIds.delete(taskId);
      this.activeTaskRuns.delete(taskId);
      this.store.updateTaskStatus(taskId, "failed");
      const lead = this.store.listAgents(taskId).find((agent) => agent.role === "lead");
      if (lead !== undefined) {
        this.store.updateAgentStatus(lead.id, "failed", {
          error: error instanceof Error ? error.message : "Run failed",
        });
      }
      if (taskRunStarted) this.finishTaskRunSafely(runId, "failed");
      const runtime = this.runtimes.get(taskId);
      if (runtime !== undefined && !runtime.ready) {
        this.disposeRuntime(taskId, runtime);
      } else {
        this.emitRuntimeState(taskId, runtime?.ready === true ? "ready" : "cold");
      }
      throw error;
    }
  }

  async steer(taskId: string, text: string): Promise<TaskSteerResult> {
    return this.requireRuntime(taskId).steer(text);
  }

  async followUp(taskId: string, text: string): Promise<TaskFollowUpResult> {
    return this.requireRuntime(taskId).followUp(text);
  }

  async clearQueue(taskId: string): Promise<TaskClearQueueResult> {
    return this.requireRuntime(taskId).clearQueue();
  }

  async editTodo(
    taskId: string,
    input: TodoEditOperation,
  ): Promise<TodoEditResult> {
    await this.waitForDisposal(taskId);
    const runtime = this.runtimes.get(taskId);
    if (this.runningTaskIds.has(taskId)) {
      if (runtime === undefined) {
        throw new Error("The conversation runtime is still preparing");
      }
      return runtime.editTodo(input);
    }
    if (runtime !== undefined) {
      this.disposeRuntime(taskId, runtime);
      await this.waitForDisposal(taskId);
    }

    const task = this.requireTask(taskId);
    await this.checkTaskAvailability(task);
    const result = await this.sessionTodos.edit(task, input);
    const projection = this.store.getTaskConversationProjection(taskId);
    if (projection !== undefined) {
      this.store.saveTaskConversationProjection(taskId, {
        ...projection,
        todo: result.todo,
      });
    }
    return result;
  }

  async cancel(taskId: string): Promise<TaskCancelResult> {
    for (const delegation of this.store
      .listDelegations(taskId)
      .filter((candidate) => !isDelegationTerminal(candidate))) {
      await this.cancelDelegation(delegation);
    }
    return (
      this.runtimes.get(taskId)?.cancel() ?? {
        cancelled: false,
        queued: { steering: [], followUp: [] },
      }
    );
  }

  async resolvePermission(
    taskId: string,
    requestId: string,
    allowed: boolean,
  ): Promise<boolean> {
    const owner = this.permissionOwners.get(requestId);
    const child = owner === undefined ? undefined : this.childRuntimes.get(owner);
    const runtime =
      owner === undefined ? this.runtimes.get(taskId) : child?.controller;
    const resolved =
      (await runtime?.resolvePermission(requestId, allowed)) ?? false;
    if (resolved) this.permissionOwners.delete(requestId);
    return resolved;
  }

  async updateAccessMode(
    taskId: string,
    accessMode: TaskAccessMode,
  ): Promise<TaskSummary> {
    await this.waitForDisposal(taskId);
    const task = this.requireTask(taskId);
    if (task.accessMode === accessMode) return task;
    if (this.runningTaskIds.has(taskId)) {
      throw new Error("Access mode cannot change while a conversation is running.");
    }

    const runtime = this.runtimes.get(taskId);
    if (runtime !== undefined) {
      this.disposeRuntime(taskId, runtime);
      await this.waitForDisposal(taskId);
    }
    const updated = this.store.updateTaskAccessMode(taskId, accessMode);
    if (this.selectedTaskId === taskId && updated.sessionReference !== undefined) {
      await this.activate(taskId);
    }
    return updated;
  }

  async updateInteractionMode(
    taskId: string,
    interactionMode: TaskInteractionMode,
  ): Promise<TaskSummary> {
    await this.waitForDisposal(taskId);
    const task = this.requireTask(taskId);
    if (task.interactionMode === interactionMode) return task;
    if (this.runningTaskIds.has(taskId)) {
      throw new Error(
        "Interaction mode cannot change while a conversation is running.",
      );
    }

    const runtime = this.runtimes.get(taskId);
    if (runtime !== undefined) {
      this.disposeRuntime(taskId, runtime);
      await this.waitForDisposal(taskId);
    }
    const updated = this.store.updateTaskInteractionMode(
      taskId,
      interactionMode,
    );
    if (this.selectedTaskId === taskId && updated.sessionReference !== undefined) {
      await this.activate(taskId);
    }
    return updated;
  }

  async activate(taskId: string): Promise<TaskActivateResult> {
    await this.waitForDisposal(taskId);
    const task = this.requireTask(taskId);
    await this.checkTaskAvailability(task);

    const previous = this.selectedTaskId;
    this.selectedTaskId = taskId;
    this.cancelEviction(taskId);
    if (previous !== undefined && previous !== taskId) {
      this.scheduleEviction(previous);
    }

    if (task.sessionReference === undefined) {
      this.evictOverflow();
      this.emitRuntimeState(taskId, "cold");
      return { state: "cold" };
    }

    let runtime = this.runtimes.get(taskId);
    if (runtime?.ready === true) {
      this.touch(taskId);
      this.evictOverflow();
      this.emitRuntimeState(taskId, "ready");
      return { state: "ready" };
    }
    this.emitRuntimeState(taskId, "preparing");
    const created = runtime === undefined;
    if (runtime === undefined) {
      runtime = this.buildController(task);
      this.runtimes.set(taskId, runtime);
    }
    this.touch(taskId);
    try {
      const snapshot = await runtime.open();
      this.store.saveTaskConversationProjection(taskId, snapshot);
      this.evictOverflow();
      this.emitRuntimeState(taskId, "ready");
      return { state: "ready" };
    } catch (error) {
      if (created) {
        this.disposeRuntime(taskId, runtime);
      }
      this.emitRuntimeState(taskId, "cold");
      throw error;
    }
  }

  disposeIdleRuntimes(): void {
    for (const [taskId, runtime] of [...this.runtimes.entries()]) {
      if (!this.runningTaskIds.has(taskId)) {
        this.disposeRuntime(taskId, runtime);
      }
    }
  }

  terminateAll(): void {
    for (const timer of this.evictionTimers.values()) {
      clearTimeout(timer);
    }
    this.evictionTimers.clear();
    for (const controller of this.runtimes.values()) {
      controller.terminate();
    }
    for (const controller of this.disposingRuntimes) {
      controller.terminate();
    }
    for (const child of this.childRuntimes.values()) {
      child.controller.terminate();
    }
    this.runtimes.clear();
    this.childRuntimes.clear();
    this.runningTaskIds.clear();
    this.activeTaskRuns.clear();
    this.permissionOwners.clear();
    this.writeAgents.clear();
    this.lastUsed.clear();
    this.selectedTaskId = undefined;
    this.disposingRuntimes.clear();
  }

  private async handleDelegationRequest(
    task: StoredTask,
    lead: StoredAgent,
    controller: TaskRuntime,
    request: DelegationRequest,
  ): Promise<void> {
    try {
      const result = await this.performDelegationOperation(
        task,
        lead,
        request.operation,
      );
      await controller.resolveDelegation?.({
        requestId: request.requestId,
        result,
      });
    } catch (error) {
      await controller.resolveDelegation?.({
        requestId: request.requestId,
        error:
          error instanceof Error ? error.message : "Delegation request failed",
      });
    }
  }

  private async performDelegationOperation(
    task: StoredTask,
    lead: StoredAgent,
    operation: DelegationRequest["operation"],
  ): Promise<DelegationToolResult> {
    switch (operation.action) {
      case "list": {
        const config = await this.subagentConfig.load(task.executionPath);
        return {
          message:
            config.agents.length === 0
              ? "No subagents are configured in .codey/agents.json."
              : `${config.agents.length} subagent profile(s) available.`,
          profiles: config.agents,
        };
      }
      case "status": {
        const delegations = operation.delegationIds.map((id) =>
          this.requireTaskDelegation(task.id, id),
        );
        return { message: "Delegation status.", delegations };
      }
      case "wait": {
        const delegations = await Promise.all(
          operation.delegationIds.map((id) => {
            this.requireTaskDelegation(task.id, id);
            return this.waitForDelegation(id);
          }),
        );
        return { message: "Delegated work finished.", delegations };
      }
      case "cancel": {
        const delegation = this.requireTaskDelegation(
          task.id,
          operation.delegationId,
        );
        const cancelled = await this.cancelDelegation(delegation);
        return { message: "Delegation cancelled.", delegations: [cancelled] };
      }
      case "run":
        return this.runDelegation(task, lead, operation);
    }
  }

  private async runDelegation(
    task: StoredTask,
    lead: StoredAgent,
    operation: Extract<DelegationRequest["operation"], { action: "run" }>,
  ): Promise<DelegationToolResult> {
    const taskRunId = this.activeTaskRuns.get(task.id);
    if (taskRunId === undefined) {
      throw new Error("Delegation requires an active conversation run.");
    }
    const config = await this.subagentConfig.load(task.executionPath);
    const profile = config.agents.find(
      (candidate) => candidate.id === operation.profileId,
    );
    if (profile === undefined) {
      throw new Error(`Unknown subagent profile: ${operation.profileId}`);
    }
    const capability = operation.capability ?? profile.capability;
    if (profile.capability === "read" && capability === "write") {
      throw new Error(
        `Subagent profile ${profile.id} cannot be elevated to write capability.`,
      );
    }
    if (operation.runInBackground && capability === "write") {
      throw new Error(
        "Write-capable subagents must run in the foreground to preserve the single-writer invariant.",
      );
    }
    const dependencies = operation.dependsOn.map((id) =>
      this.requireTaskDelegation(task.id, id),
    );
    if (
      dependencies.some((dependency) => dependency.taskRunId !== taskRunId)
    ) {
      throw new Error("Delegation dependencies must belong to the active run.");
    }

    const agentId = randomUUID();
    const delegationId = randomUUID();
    const model = profile.model ?? lead.model;
    const thinkingLevel = clampThinkingLevel(
      model,
      profile.thinkingLevel ?? lead.thinkingLevel,
    );
    this.store.createSubagent({
      id: agentId,
      taskId: task.id,
      parentAgentId: lead.id,
      profileId: profile.id,
      capability,
      model,
      thinkingLevel,
      assignment: operation.description,
    });
    let delegation = this.store.createDelegation({
      id: delegationId,
      taskId: task.id,
      taskRunId,
      parentAgentId: lead.id,
      childAgentId: agentId,
      profileId: profile.id,
      capability,
      prompt: operation.prompt,
      dependsOn: dependencies.map((dependency) => dependency.id),
    });
    this.ensureDelegationWaiter(delegation.id);

    const start = async (): Promise<Delegation> => {
      const settledDependencies = await Promise.all(
        dependencies.map((dependency) => this.waitForDelegation(dependency.id)),
      );
      if (
        settledDependencies.some(
          (dependency) => dependency.status !== "completed",
        )
      ) {
        delegation = this.store.updateDelegationStatus(
          delegation.id,
          "blocked",
          { error: "A dependency did not complete successfully." },
        );
        this.store.updateAgentStatus(agentId, "blocked", {
          error: delegation.error,
        });
        this.resolveDelegationWaiter(delegation);
        if (operation.runInBackground) {
          await this.runtimes
            .get(task.id)
            ?.completeDelegation?.({ delegation });
        }
        return delegation;
      }
      return this.startChildRuntime(
        task,
        profile,
        this.store.getAgent(agentId)!,
        delegation,
        operation.runInBackground,
      );
    };

    if (operation.runInBackground) {
      void start().catch((error: unknown) => {
        this.failChildBeforeStart(
          agentId,
          delegation.id,
          error instanceof Error ? error.message : "Subagent failed to start",
        );
      });
      return {
        message: `Delegation ${delegation.id} queued in the background.`,
        delegations: [delegation],
      };
    }

    const started = await start();
    const finished = isDelegationTerminal(started)
      ? started
      : await this.waitForDelegation(started.id);
    return {
      message: `Delegation ${finished.id} finished with status ${finished.status}.`,
      delegations: [finished],
    };
  }

  private async startChildRuntime(
    task: StoredTask,
    profile: SubagentProfile,
    agent: StoredAgent,
    delegation: Delegation,
    background: boolean,
  ): Promise<Delegation> {
    if (agent.capability === "write") {
      const writer = this.writeAgents.get(task.id);
      if (writer !== undefined) {
        throw new Error(`Writer lease is held by agent ${writer}.`);
      }
      this.writeAgents.set(task.id, agent.id);
    }
    const agentRunId = randomUUID();
    const controller = this.createController(
      task,
      {
        emit: (runId, event) =>
          this.handleEvent(
            task.id,
            delegation.taskRunId,
            agent.id,
            runId,
            event,
            false,
          ),
        saveSessionReference: (reference) => {
          if (this.store.getAgent(agent.id)?.sessionReference === undefined) {
            this.store.setAgentSessionReference(agent.id, reference);
          }
          return true;
        },
        saveSnapshot: (snapshot) => {
          this.store.saveAgentConversationProjection(agent.id, {
            messages: snapshot.messages,
            userEntries: snapshot.userEntries,
          });
        },
        settled: (runId, result, snapshot) => {
          void this.settleChild(agent.id, runId, result, snapshot);
        },
        connectionLost: (error) => {
          this.failChildBeforeStart(agent.id, delegation.id, error.message);
        },
        permissionRequest: (runId, request) => {
          this.permissionOwners.set(request.id, agent.id);
          this.sendPermissionRequest?.({
            taskId: task.id,
            runId: delegation.taskRunId,
            agentId: agent.id,
            agentRunId: runId,
            request,
          });
        },
        delegationRequest: () => undefined,
      },
      agent.model,
      agent.thinkingLevel,
      {
        id: agent.id,
        role: "subagent",
        capability: agent.capability,
        profileInstructions: profile.instructions,
        ...(agent.sessionReference === undefined
          ? {}
          : { sessionReference: agent.sessionReference }),
      },
    );
    this.childRuntimes.set(agent.id, {
      taskRunId: delegation.taskRunId,
      agentRunId,
      delegationId: delegation.id,
      background,
      controller,
    });
    this.store.updateAgentStatus(agent.id, "running");
    const running = this.store.updateDelegationStatus(delegation.id, "running");
    try {
      await controller.start(delegation.prompt, agentRunId);
      return running;
    } catch (error) {
      this.failChildBeforeStart(
        agent.id,
        delegation.id,
        error instanceof Error ? error.message : "Subagent failed to start",
      );
      throw error;
    }
  }

  private async settleChild(
    agentId: string,
    agentRunId: string,
    result?: AgentPromptResult,
    snapshot?: TaskControllerSnapshot,
  ): Promise<void> {
    const active = this.childRuntimes.get(agentId);
    if (active === undefined || active.agentRunId !== agentRunId) return;
    const current = this.store.getDelegation(active.delegationId);
    if (current === undefined || isDelegationTerminal(current)) return;
    const status =
      result?.status === "completed"
        ? "completed"
        : result?.status === "cancelled"
          ? "cancelled"
          : "failed";
    const output = assistantResult(snapshot);
    const delegation = this.store.updateDelegationStatus(current.id, status, {
      result: output.length === 0 ? null : output,
      error: status === "failed" ? "Subagent run failed" : null,
    });
    this.store.updateAgentStatus(agentId, status, {
      result: delegation.result,
      error: delegation.error,
    });
    this.resolveDelegationWaiter(delegation);
    await this.finishChildRuntime(agentId, delegation);
  }

  private failChildBeforeStart(
    agentId: string,
    delegationId: string,
    message: string,
  ): void {
    const current = this.store.getDelegation(delegationId);
    if (current === undefined || isDelegationTerminal(current)) return;
    const delegation = this.store.updateDelegationStatus(
      delegationId,
      "failed",
      { error: message },
    );
    this.store.updateAgentStatus(agentId, "failed", { error: message });
    this.resolveDelegationWaiter(delegation);
    void this.finishChildRuntime(agentId, delegation);
  }

  private async finishChildRuntime(
    agentId: string,
    delegation: Delegation,
  ): Promise<void> {
    const active = this.childRuntimes.get(agentId);
    if (active !== undefined) {
      this.childRuntimes.delete(agentId);
      await active.controller.dispose().catch(() => undefined);
      if (delegation.capability === "write") {
        this.writeAgents.delete(delegation.taskId);
      }
      if (active.background) {
        const lead = this.runtimes.get(delegation.taskId);
        await lead?.completeDelegation?.({ delegation });
      }
    }
  }

  private ensureDelegationWaiter(id: string): DelegationWaiter {
    const existing = this.delegationWaiters.get(id);
    if (existing !== undefined) return existing;
    let resolve!: (delegation: Delegation) => void;
    const promise = new Promise<Delegation>((settle) => {
      resolve = settle;
    });
    const waiter = { promise, resolve };
    this.delegationWaiters.set(id, waiter);
    return waiter;
  }

  private waitForDelegation(id: string): Promise<Delegation> {
    const current = this.store.getDelegation(id);
    if (current === undefined) throw new Error(`Delegation does not exist: ${id}`);
    return isDelegationTerminal(current)
      ? Promise.resolve(current)
      : this.ensureDelegationWaiter(id).promise;
  }

  private resolveDelegationWaiter(delegation: Delegation): void {
    const waiter = this.delegationWaiters.get(delegation.id);
    if (waiter === undefined) return;
    this.delegationWaiters.delete(delegation.id);
    waiter.resolve(delegation);
  }

  private requireTaskDelegation(taskId: string, id: string): Delegation {
    const delegation = this.store.getDelegation(id);
    if (delegation === undefined || delegation.taskId !== taskId) {
      throw new Error(`Delegation does not exist in this conversation: ${id}`);
    }
    return delegation;
  }

  private async cancelDelegation(delegation: Delegation): Promise<Delegation> {
    if (isDelegationTerminal(delegation)) return delegation;
    for (const dependent of this.store
      .listDelegations(delegation.taskId)
      .filter((candidate) => candidate.dependsOn.includes(delegation.id))) {
      await this.cancelDelegation(dependent);
    }
    const active = this.childRuntimes.get(delegation.childAgentId);
    await active?.controller.cancel();
    const cancelled = this.store.updateDelegationStatus(
      delegation.id,
      "cancelled",
    );
    this.store.updateAgentStatus(delegation.childAgentId, "cancelled");
    this.resolveDelegationWaiter(cancelled);
    await this.finishChildRuntime(delegation.childAgentId, cancelled);
    return cancelled;
  }

  private buildController(
    task: StoredTask,
    initialModel?: SupportedModelSelection,
    initialThinkingLevel?: ThinkingLevel,
  ): TaskRuntime {
    const projection = this.store.getTaskConversationProjection(task.id);
    const model = initialModel ?? projection?.model ?? DEFAULT_MODEL;
    const thinkingLevel =
      initialThinkingLevel ??
      projection?.thinkingLevel ??
      defaultThinkingLevel(model);
    const lead = this.store.ensureLeadAgent(task.id, model, thinkingLevel);
    const controller = this.createController(
      task,
      {
        emit: (agentRunId, event) =>
          this.handleEvent(
            task.id,
            this.activeTaskRuns.get(task.id) ?? agentRunId,
            lead.id,
            agentRunId,
            event,
          ),
        saveSessionReference: (reference) => {
          const current = this.store.getTask(task.id);
          if (current?.sessionReference === undefined) {
            this.store.setTaskSessionReference(task.id, reference);
          }
          if (this.store.getAgent(lead.id)?.sessionReference === undefined) {
            this.store.setAgentSessionReference(lead.id, reference);
          }
          return true;
        },
        saveSnapshot: (snapshot) => {
          this.store.saveTaskConversationProjection(task.id, snapshot);
          this.store.saveAgentConversationProjection(lead.id, {
            messages: snapshot.messages,
            userEntries: snapshot.userEntries,
          });
        },
        settled: (runId, result, snapshot) => {
          this.settleLead(task.id, lead.id, runId, result, snapshot);
          this.release(task.id, controller);
        },
        connectionLost: (error) => {
          if (!this.runningTaskIds.has(task.id)) {
            this.emitRuntimeState(task.id, "cold");
          } else {
            this.failActiveRun(task.id, lead.id, error);
          }
        },
        permissionRequest: (agentRunId, request) => {
          const taskRunId = this.activeTaskRuns.get(task.id) ?? agentRunId;
          this.permissionOwners.set(request.id, lead.id);
          this.sendPermissionRequest?.({
            taskId: task.id,
            runId: taskRunId,
            agentId: lead.id,
            agentRunId,
            request,
          });
        },
        delegationRequest: (request) => {
          void this.handleDelegationRequest(task, lead, controller, request);
        },
      },
      initialModel,
      initialThinkingLevel,
      {
        id: lead.id,
        role: "lead",
        capability: "write",
        ...(lead.sessionReference === undefined
          ? {}
          : { sessionReference: lead.sessionReference }),
      },
    );
    return controller;
  }

  private handleEvent(
    taskId: string,
    taskRunId: string,
    agentId: string,
    agentRunId: string,
    event: AgentUiEvent,
    updateTask = true,
  ): void {
    const status = statusForEvent(event);
    if (status !== undefined && updateTask) {
      this.store.updateTaskStatus(taskId, status);
      if (status === "running") {
        this.emitRuntimeState(taskId, "running");
      }
    }
    const agent = this.store.getAgent(agentId);
    this.sendEvent({
      taskId,
      runId: taskRunId,
      agentId,
      agentRunId,
      ...(agent === undefined ? {} : { agent: toAgentSummary(agent) }),
      event,
    });
  }

  private settleLead(
    taskId: string,
    leadAgentId: string,
    runId: string,
    result?: AgentPromptResult,
    snapshot?: TaskControllerSnapshot,
  ): void {
    if (this.activeTaskRuns.get(taskId) !== runId) return;
    const status =
      result?.status === "completed"
        ? "completed"
        : result?.status === "cancelled"
          ? "cancelled"
          : "failed";
    const output = assistantResult(snapshot);
    this.store.updateAgentStatus(leadAgentId, status, {
      result: output.length === 0 ? null : output,
      error: status === "failed" ? "Lead agent run failed" : null,
    });
    this.finishTaskRunSafely(runId, status);
    this.activeTaskRuns.delete(taskId);
  }

  // A run row can already be terminal when this settle races another writer:
  // a connection-loss failure path, or a second app launch whose startup sweep
  // marked stale runs interrupted. The first terminal outcome stands.
  private finishTaskRunSafely(
    runId: string,
    status: Parameters<AppStore["finishTaskRun"]>[1],
  ): void {
    try {
      this.store.finishTaskRun(runId, status);
    } catch {
      // Already finished.
    }
  }

  private failActiveRun(
    taskId: string,
    leadAgentId: string,
    error: Error,
  ): void {
    const runId = this.activeTaskRuns.get(taskId);
    if (runId === undefined) return;
    this.store.updateTaskStatus(taskId, "failed");
    this.store.updateAgentStatus(leadAgentId, "failed", {
      error: error.message,
    });
    this.finishTaskRunSafely(runId, "failed");
    this.activeTaskRuns.delete(taskId);
    this.runningTaskIds.delete(taskId);
  }

  private release(taskId: string, controller: TaskRuntime): void {
    if (this.runtimes.get(taskId) !== controller) {
      return;
    }
    this.runningTaskIds.delete(taskId);
    this.touch(taskId);
    this.emitRuntimeState(taskId, controller.ready ? "ready" : "cold");
    this.scheduleEviction(taskId);
    this.evictOverflow();
  }

  private async prepareRuntimeForStart(
    task: StoredTask,
    model: SupportedModelSelection,
    thinkingLevel: ThinkingLevel,
  ): Promise<TaskRuntime> {
    await this.waitForDisposal(task.id);
    let runtime = this.runtimes.get(task.id);
    if (runtime !== undefined) {
      this.cancelEviction(task.id);
      this.touch(task.id);
      const current = runtime.ready
        ? {
            model: runtime.model,
            thinkingLevel: runtime.thinkingLevel,
          }
        : await runtime.open();
      if (
        sameModel(current.model, model) &&
        current.thinkingLevel === thinkingLevel
      ) {
        return runtime;
      }
      this.disposeRuntime(task.id, runtime, true);
      await this.waitForDisposal(task.id);
    }

    runtime = this.buildController(
      this.requireTask(task.id),
      model,
      thinkingLevel,
    );
    this.runtimes.set(task.id, runtime);
    this.cancelEviction(task.id);
    this.touch(task.id);
    try {
      await runtime.open();
      return runtime;
    } catch (error) {
      this.disposeRuntime(task.id, runtime, true);
      await this.waitForDisposal(task.id);
      throw error;
    }
  }

  private touch(taskId: string): void {
    this.lastUsed.set(taskId, Date.now());
  }

  private cancelEviction(taskId: string): void {
    const timer = this.evictionTimers.get(taskId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.evictionTimers.delete(taskId);
    }
  }

  private scheduleEviction(taskId: string): void {
    this.cancelEviction(taskId);
    if (
      taskId === this.selectedTaskId ||
      this.runningTaskIds.has(taskId) ||
      !this.runtimes.has(taskId)
    ) {
      return;
    }
    const timer = setTimeout(() => {
      this.evictionTimers.delete(taskId);
      const runtime = this.runtimes.get(taskId);
      if (
        runtime !== undefined &&
        taskId !== this.selectedTaskId &&
        !this.runningTaskIds.has(taskId)
      ) {
        this.disposeRuntime(taskId, runtime);
      }
    }, this.idleTtlMs);
    timer.unref?.();
    this.evictionTimers.set(taskId, timer);
  }

  private evictOverflow(): void {
    const idle = [...this.runtimes.entries()]
      .filter(
        ([taskId]) =>
          taskId !== this.selectedTaskId && !this.runningTaskIds.has(taskId),
      )
      .sort(
        ([firstId], [secondId]) =>
          (this.lastUsed.get(firstId) ?? 0) -
          (this.lastUsed.get(secondId) ?? 0),
      );
    while (idle.length > this.maxIdleRuntimes) {
      const [taskId, runtime] = idle.shift()!;
      this.disposeRuntime(taskId, runtime);
    }
  }

  private disposeRuntime(
    taskId: string,
    controller: TaskRuntime,
    preserveRunning = false,
  ): void {
    if (this.runtimes.get(taskId) !== controller) return;
    this.runtimes.delete(taskId);
    if (!preserveRunning) {
      this.runningTaskIds.delete(taskId);
    }
    this.lastUsed.delete(taskId);
    this.cancelEviction(taskId);
    this.disposingRuntimes.add(controller);
    const disposal = controller
      .dispose()
      .catch(() => undefined)
      .then(() => undefined)
      .finally(() => {
        this.disposingRuntimes.delete(controller);
        if (this.disposals.get(taskId) === disposal) {
          this.disposals.delete(taskId);
        }
      });
    this.disposals.set(taskId, disposal);
    this.emitRuntimeState(taskId, "cold");
  }

  private emitRuntimeState(taskId: string, state: TaskRuntimeState): void {
    this.sendRuntimeState?.({ taskId, state });
  }

  private measure(
    metric: Parameters<NonNullable<TaskRuntimeRegistryOptions["recordTiming"]>>[0],
    startedAt: number,
    taskId: string,
  ): void {
    this.recordTiming?.(metric, performance.now() - startedAt, taskId);
  }

  private async waitForDisposal(taskId: string): Promise<void> {
    await this.disposals.get(taskId);
  }

  private async checkTaskAvailability(task: StoredTask): Promise<void> {
    await this.checkWorkspace(task.workspace);
    if (task.executionTarget === "local") return;
    if (
      this.worktrees === undefined ||
      task.repository === undefined ||
      task.worktree === undefined
    ) {
      throw new Error("Conversation worktree metadata is missing.");
    }
    await this.worktrees.validateWorktree(
      this.worktreeInput(task),
      task.worktree,
    );
  }

  private assertProjectConcurrency(task: StoredTask): void {
    for (const runningTaskId of this.runningTaskIds) {
      const runningTask = this.store.getTask(runningTaskId);
      if (
        runningTask !== undefined &&
        runningTask.workspace.id === task.workspace.id &&
        (task.executionTarget === "local" ||
          runningTask.executionTarget === "local")
      ) {
        throw new Error(
          "Local conversations cannot run alongside another conversation in this project.",
        );
      }
    }
  }

  private worktreeInput(task: StoredTask): WorktreeInput {
    if (task.repository === undefined) {
      throw new Error("Conversation repository metadata is missing.");
    }
    return {
      projectId: task.workspace.id,
      taskId: task.id,
      projectPath: task.workspace.path,
      repository: task.repository,
    };
  }

  private requireTask(taskId: string): StoredTask {
    const task = this.store.getTask(taskId);
    if (task === undefined) {
      throw new Error(`Task does not exist: ${taskId}`);
    }
    return task;
  }

  private requireRuntime(taskId: string): TaskRuntime {
    const runtime = this.runtimes.get(taskId);
    if (runtime === undefined || !this.runningTaskIds.has(taskId)) {
      throw new Error(`Task is not running: ${taskId}`);
    }
    return runtime;
  }

  private toSnapshot(
    task: StoredTask,
    snapshot: TaskControllerSnapshot,
  ): TaskSnapshot {
    const lead = this.store.ensureLeadAgent(
      task.id,
      snapshot.model,
      snapshot.thinkingLevel,
    );
    const agents = this.store.listAgents(task.id).map((agent) => ({
      agent: toAgentSummary(agent),
      projection:
        this.store.getAgentConversationProjection(agent.id) ??
        (agent.id === lead.id
          ? {
              messages: snapshot.messages,
              userEntries: snapshot.userEntries,
            }
          : { messages: [], userEntries: [] }),
    }));
    return {
      task,
      model: snapshot.model,
      thinkingLevel: snapshot.thinkingLevel,
      messages: snapshot.messages,
      todo: snapshot.todo,
      agents,
      delegations: this.store.listDelegations(task.id),
    };
  }
}
