import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { EventType } from "@ag-ui/core";

import type {
  AgentCancelResult,
  AgentDisposeResult,
  AgentFollowUpParams,
  AgentHostNotification,
  AgentInitializeParams,
  AgentInitializeResult,
  AgentPromptParams,
  AgentPromptResult,
  AgentPermissionResolveParams,
  AgentPermissionResolveResult,
  AgentQueueSnapshot,
  AgentSnapshotResult,
  AgentSteerParams,
  AgentTodoEditParams,
  AgentTodoEditResult,
} from "../shared/agent-host-protocol.js";
import {
  AGENT_UI_CUSTOM_EVENT,
  type AgentUiEvent,
} from "../shared/agent-ui.js";
import {
  agentInitializeParamsSchema,
  agentPermissionResolveParamsSchema,
  agentTextParamsSchema,
  agentTodoEditParamsSchema,
  emptyParamsSchema,
} from "../shared/agent-host-protocol.js";
import type { ConversationTodoState } from "../shared/todo.js";
import type {
  AgentPermissionRequestInput,
  AgentDelegationRequester,
  AgentSessionFactory,
  AgentSessionPort,
} from "./session.js";
import {
  delegationCompletionParamsSchema,
  delegationResolveParamsSchema,
  type DelegationCompletionParams,
  type DelegationOperation,
  type DelegationResolveParams,
  type DelegationToolResult,
} from "../shared/agent.js";

export class AgentHostRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentHostRequestError";
  }
}

type NotificationSink = (notification: AgentHostNotification) => void;
const MAX_TODO_CONTINUATIONS = 3;

function hasActionableTodos(todo: ConversationTodoState | null): boolean {
  return (
    todo?.items.some(
      (item) => item.status === "pending" || item.status === "in_progress",
    ) ?? false
  );
}

function parseInitializeParams(value: unknown): AgentInitializeParams {
  const parsed = agentInitializeParamsSchema.safeParse(value);
  if (!parsed.success) {
    throw new AgentHostRequestError(-32602, "initialize params are invalid");
  }
  if (!isAbsolute(parsed.data.cwd)) {
    throw new AgentHostRequestError(-32602, "cwd must be an absolute path");
  }
  if (!isAbsolute(parsed.data.sessionDir)) {
    throw new AgentHostRequestError(-32602, "sessionDir must be an absolute path");
  }
  if (
    parsed.data.sessionFile !== undefined &&
    !isAbsolute(parsed.data.sessionFile)
  ) {
    throw new AgentHostRequestError(-32602, "sessionFile must be an absolute path");
  }
  if (parsed.data.sessionFile === undefined && parsed.data.model === undefined) {
    throw new AgentHostRequestError(
      -32602,
      "model is required when creating a session",
    );
  }
  return parsed.data;
}

function parseTextParams(value: unknown, method: string): AgentPromptParams {
  const parsed = agentTextParamsSchema.safeParse(value);
  if (!parsed.success) {
    throw new AgentHostRequestError(-32602, `${method} params are invalid`);
  }
  return parsed.data;
}

function requireEmptyParams(value: unknown): void {
  if (!emptyParamsSchema.safeParse(value).success) {
    throw new AgentHostRequestError(-32602, "params must be an empty object");
  }
}

export class AgentHostService {
  private session: AgentSessionPort | undefined;
  private unsubscribe: (() => void) | undefined;
  private activePrompt = false;
  private cancelRequested = false;
  private disposed = false;
  private readonly pendingPermissions = new Map<
    string,
    (allowed: boolean) => void
  >();
  private readonly pendingDelegations = new Map<
    string,
    {
      operation: DelegationOperation;
      resolve: (result: DelegationToolResult) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly activeAsyncDelegations = new Set<string>();
  private readonly delegationWaiters = new Set<() => void>();

  constructor(
    private readonly sessionFactory: AgentSessionFactory,
    private readonly notify: NotificationSink,
  ) {}

  async handle(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "agent.initialize":
        return this.initialize(parseInitializeParams(params));
      case "agent.snapshot":
        requireEmptyParams(params);
        return this.snapshot();
      case "agent.prompt":
        return this.prompt(parseTextParams(params, method));
      case "agent.continueAfterAccess":
        requireEmptyParams(params);
        return this.continueAfterAccess();
      case "agent.steer":
        return this.steer(parseTextParams(params, method));
      case "agent.followUp":
        return this.followUp(parseTextParams(params, method));
      case "agent.todo.edit":
        return this.editTodo(this.parseTodoEditParams(params));
      case "agent.clearQueue":
        requireEmptyParams(params);
        return this.clearQueue();
      case "agent.cancel":
        requireEmptyParams(params);
        return this.cancel();
      case "agent.permission.resolve":
        return this.resolvePermission(this.parsePermissionResolveParams(params));
      case "agent.delegation.resolve":
        return this.resolveDelegation(this.parseDelegationResolveParams(params));
      case "agent.delegation.complete":
        return this.completeDelegation(this.parseDelegationCompletionParams(params));
      case "agent.dispose":
        requireEmptyParams(params);
        return this.disposeFromRequest();
      default:
        throw new AgentHostRequestError(-32601, `Method not found: ${method}`);
    }
  }

  async close(): Promise<void> {
    await this.teardown();
  }

  private async initialize(
    params: AgentInitializeParams,
  ): Promise<AgentInitializeResult> {
    if (this.disposed) {
      throw new AgentHostRequestError(-32001, "Agent Host is disposed");
    }
    if (this.session !== undefined) {
      throw new AgentHostRequestError(-32001, "Agent Host is already initialized");
    }

    const session = await this.sessionFactory.create(
      params,
      (request) => this.requestPermission(request),
      ((operation) =>
        this.requestDelegation(operation)) satisfies AgentDelegationRequester,
    );
    if (this.disposed) {
      await session.dispose();
      throw new AgentHostRequestError(-32001, "Agent Host is disposed");
    }

    this.session = session;
    for (const delegationId of params.activeDelegationIds ?? []) {
      this.activeAsyncDelegations.add(delegationId);
    }
    this.unsubscribe = session.subscribe((event) => this.emit(event));
    return {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      messages: session.messages,
      userEntries: session.userEntries,
      todo: session.todo,
    };
  }

  private async prompt(params: AgentPromptParams): Promise<AgentPromptResult> {
    const session = this.requireSession();
    if (this.activePrompt) {
      throw new AgentHostRequestError(-32001, "A prompt is already active");
    }

    this.activePrompt = true;
    this.cancelRequested = false;
    try {
      const startingTodoRevision = this.prepareTodosForPrompt(session);
      const { userEntryId } = await session.prompt(params.text);
      const accessRestart =
        session.consumeAccessRestart() ||
        (await this.finishTodos(session, startingTodoRevision));
      if (!accessRestart) await this.waitForActiveDelegations();
      return {
        status:
          this.cancelRequested || accessRestart ? "cancelled" : "completed",
        userEntryId,
      };
    } catch (error) {
      if (this.cancelRequested) {
        return { status: "cancelled", userEntryId: null };
      }
      throw error;
    } finally {
      this.activePrompt = false;
    }
  }

  private async continueAfterAccess(): Promise<AgentPromptResult> {
    const session = this.requireSession();
    if (this.activePrompt) {
      throw new AgentHostRequestError(-32001, "A prompt is already active");
    }
    this.activePrompt = true;
    this.cancelRequested = false;
    try {
      const startingTodoRevision = session.todo?.revision ?? null;
      await session.continueAfterAccess();
      const accessRestart =
        session.consumeAccessRestart() ||
        (await this.finishTodos(session, startingTodoRevision));
      if (!accessRestart) await this.waitForActiveDelegations();
      return {
        status:
          this.cancelRequested || accessRestart ? "cancelled" : "completed",
        userEntryId: null,
      };
    } catch (error) {
      if (this.cancelRequested) {
        return { status: "cancelled", userEntryId: null };
      }
      throw error;
    } finally {
      this.activePrompt = false;
    }
  }

  private prepareTodosForPrompt(session: AgentSessionPort): number | null {
    const todo = session.todo;
    if (todo !== null && !hasActionableTodos(todo)) {
      this.archiveTodo(session);
      return null;
    }
    return todo?.revision ?? null;
  }

  private async finishTodos(
    session: AgentSessionPort,
    startingRevision: number | null,
  ): Promise<boolean> {
    const todo = session.todo;
    if (
      todo !== null &&
      startingRevision !== null &&
      todo.revision === startingRevision
    ) {
      this.archiveTodo(session);
      return false;
    }
    for (
      let attempt = 1;
      attempt <= MAX_TODO_CONTINUATIONS &&
      !this.cancelRequested &&
      session.interactionMode === "agent" &&
      hasActionableTodos(session.todo);
      attempt += 1
    ) {
      await session.continueTodos(attempt, MAX_TODO_CONTINUATIONS);
      if (session.consumeAccessRestart()) return true;
    }
    if (
      !this.cancelRequested &&
      session.interactionMode === "agent" &&
      hasActionableTodos(session.todo)
    ) {
      this.emit({
        type: EventType.CUSTOM,
        name: AGENT_UI_CUSTOM_EVENT.TODO_CONTINUATION_EXHAUSTED,
        value: { todo: session.todo, attempts: MAX_TODO_CONTINUATIONS },
      });
    }
    return false;
  }

  private archiveTodo(session: AgentSessionPort): void {
    const todo = session.archiveTodo();
    this.emit({
      type: EventType.CUSTOM,
      name: AGENT_UI_CUSTOM_EVENT.TODO_UPDATED,
      value: { todo },
    });
  }

  private snapshot(): AgentSnapshotResult {
    const session = this.requireSession();
    return {
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      messages: session.messages,
      userEntries: session.userEntries,
      todo: session.todo,
    };
  }

  private parseTodoEditParams(value: unknown): AgentTodoEditParams {
    const parsed = agentTodoEditParamsSchema.safeParse(value);
    if (!parsed.success) {
      throw new AgentHostRequestError(-32602, "todo edit params are invalid");
    }
    return parsed.data;
  }

  private async editTodo(
    params: AgentTodoEditParams,
  ): Promise<AgentTodoEditResult> {
    const todo = await this.requireSession().updateTodo(params);
    this.emit({
      type: EventType.CUSTOM,
      name: AGENT_UI_CUSTOM_EVENT.TODO_UPDATED,
      value: { todo },
    });
    return { todo };
  }

  private async steer(params: AgentSteerParams): Promise<{ accepted: true }> {
    const session = this.requireSession();
    if (!this.activePrompt) {
      throw new AgentHostRequestError(-32001, "No prompt is active");
    }
    await session.steer(params.text);
    return { accepted: true };
  }

  private async followUp(
    params: AgentFollowUpParams,
  ): Promise<{ accepted: true }> {
    const session = this.requireSession();
    if (!this.activePrompt) {
      throw new AgentHostRequestError(-32001, "No prompt is active");
    }
    await session.followUp(params.text);
    return { accepted: true };
  }

  private clearQueue(): AgentQueueSnapshot {
    const session = this.requireSession();
    if (!this.activePrompt) {
      throw new AgentHostRequestError(-32001, "No prompt is active");
    }
    return session.clearQueue();
  }

  private async cancel(): Promise<AgentCancelResult> {
    const session = this.requireSession();
    if (!this.activePrompt) {
      return {
        cancelled: false,
        queued: { steering: [], followUp: [] },
      };
    }
    const queued = session.clearQueue();
    this.cancelRequested = true;
    this.denyPendingPermissions();
    this.rejectPendingDelegations();
    await session.abort();
    return { cancelled: true, queued };
  }

  private async disposeFromRequest(): Promise<AgentDisposeResult> {
    await this.teardown();
    return { disposed: true };
  }

  private parsePermissionResolveParams(
    value: unknown,
  ): AgentPermissionResolveParams {
    const parsed = agentPermissionResolveParamsSchema.safeParse(value);
    if (!parsed.success) {
      throw new AgentHostRequestError(
        -32602,
        "permission resolution params are invalid",
      );
    }
    return parsed.data;
  }

  private resolvePermission(
    params: AgentPermissionResolveParams,
  ): AgentPermissionResolveResult {
    const resolve = this.pendingPermissions.get(params.requestId);
    if (resolve === undefined) return { resolved: false };
    this.pendingPermissions.delete(params.requestId);
    resolve(params.allowed);
    return { resolved: true };
  }

  private parseDelegationResolveParams(value: unknown): DelegationResolveParams {
    const parsed = delegationResolveParamsSchema.safeParse(value);
    if (!parsed.success) {
      throw new AgentHostRequestError(
        -32602,
        "delegation resolution params are invalid",
      );
    }
    return parsed.data;
  }

  private parseDelegationCompletionParams(
    value: unknown,
  ): DelegationCompletionParams {
    const parsed = delegationCompletionParamsSchema.safeParse(value);
    if (!parsed.success) {
      throw new AgentHostRequestError(
        -32602,
        "delegation completion params are invalid",
      );
    }
    return parsed.data;
  }

  private resolveDelegation(
    params: DelegationResolveParams,
  ): AgentPermissionResolveResult {
    const pending = this.pendingDelegations.get(params.requestId);
    if (pending === undefined) return { resolved: false };
    this.pendingDelegations.delete(params.requestId);
    if (params.error === undefined) {
      const result = params.result!;
      if (
        pending.operation.action === "run" &&
        pending.operation.runInBackground
      ) {
        for (const delegation of result.delegations ?? []) {
          if (
            delegation.status === "queued" ||
            delegation.status === "running"
          ) {
            this.activeAsyncDelegations.add(delegation.id);
          }
        }
      }
      pending.resolve(result);
    } else {
      pending.reject(new Error(params.error));
    }
    return { resolved: true };
  }

  private async completeDelegation(
    params: DelegationCompletionParams,
  ): Promise<{ accepted: true }> {
    const deliver = this.requireSession().deliverDelegationCompletion;
    if (deliver === undefined) {
      throw new AgentHostRequestError(
        -32001,
        "Agent session does not support delegation completion",
      );
    }
    await deliver.call(this.requireSession(), params.delegation);
    this.activeAsyncDelegations.delete(params.delegation.id);
    if (this.activeAsyncDelegations.size === 0) {
      for (const resolve of this.delegationWaiters) resolve();
      this.delegationWaiters.clear();
    }
    return { accepted: true };
  }

  private requestPermission(
    request: AgentPermissionRequestInput,
  ): Promise<boolean> {
    if (this.disposed || !this.activePrompt) return Promise.resolve(false);
    const id = randomUUID();
    this.notify({
      jsonrpc: "2.0",
      method: "agent.permission.request",
      params: { request: { id, ...request } },
    });
    return new Promise((resolve) => {
      this.pendingPermissions.set(id, resolve);
    });
  }

  private requestDelegation(
    operation: DelegationOperation,
  ): Promise<DelegationToolResult> {
    if (this.disposed) {
      return Promise.reject(new Error("Agent Host is disposed"));
    }
    const requestId = randomUUID();
    this.notify({
      jsonrpc: "2.0",
      method: "agent.delegation.request",
      params: { requestId, operation },
    });
    return new Promise((resolve, reject) => {
      this.pendingDelegations.set(requestId, {
        operation,
        resolve,
        reject,
      });
    });
  }

  private waitForActiveDelegations(): Promise<void> {
    if (this.activeAsyncDelegations.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.delegationWaiters.add(resolve));
  }

  private denyPendingPermissions(): void {
    for (const resolve of this.pendingPermissions.values()) {
      resolve(false);
    }
    this.pendingPermissions.clear();
  }

  private rejectPendingDelegations(): void {
    for (const pending of this.pendingDelegations.values()) {
      pending.reject(new Error("Delegation was cancelled"));
    }
    this.pendingDelegations.clear();
    this.activeAsyncDelegations.clear();
    for (const resolve of this.delegationWaiters) resolve();
    this.delegationWaiters.clear();
  }

  private requireSession(): AgentSessionPort {
    if (this.disposed) {
      throw new AgentHostRequestError(-32001, "Agent Host is disposed");
    }
    if (this.session === undefined) {
      throw new AgentHostRequestError(-32001, "Agent Host is not initialized");
    }
    return this.session;
  }

  private emit(event: AgentUiEvent): void {
    this.notify({
      jsonrpc: "2.0",
      method: "agent.event",
      params: { event },
    });
  }

  private async teardown(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.denyPendingPermissions();
    this.rejectPendingDelegations();

    const session = this.session;
    if (session !== undefined && this.activePrompt) {
      this.cancelRequested = true;
      await session.abort();
    }

    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session = undefined;
    await session?.dispose();
  }
}
