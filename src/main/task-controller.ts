import { randomUUID } from "node:crypto";
import { EventType } from "@ag-ui/core";

import type {
  AgentAttachParams,
  AgentBootParams,
  AgentBootResult,
  AgentCancelResult,
  AgentInitializeResult,
  AgentPromptResult,
  AgentQueueSnapshot,
  AgentSessionReference,
  AgentSnapshotResult,
  AgentTodoEditResult,
  AgentTranscriptMessage,
} from "../shared/agent-host-protocol";
import type {
  AgentCapability,
  AgentRole,
  DelegationCompletionParams,
  DelegationRequest,
  DelegationResolveParams,
} from "../shared/agent";
import {
  AGENT_UI_CUSTOM_EVENT,
  type AgentUiEvent,
} from "../shared/agent-ui";
import {
  supportedModelSelectionSchema,
  type SupportedModelSelection,
  type ThinkingLevel,
} from "../shared/models";
import type {
  TaskCancelResult,
  TaskAccessMode,
  TaskClearQueueResult,
  TaskFollowUpResult,
  TaskPermissionRequest,
  TaskInteractionMode,
  TaskSteerResult,
} from "../shared/task";
import type {
  ConversationTodoState,
  TodoEditOperation,
} from "../shared/todo";

export interface AgentConnection {
  readonly booted: boolean;
  start(): Promise<void>;
  setExitHandler(handler: (error: Error) => void): void;
  boot(params: AgentBootParams): Promise<AgentBootResult>;
  attach(params: AgentAttachParams): Promise<AgentInitializeResult>;
  prompt(text: string): Promise<AgentPromptResult>;
  snapshot(): Promise<AgentSnapshotResult>;
  steer(text: string): Promise<{ accepted: true }>;
  followUp(text: string): Promise<{ accepted: true }>;
  editTodo(input: TodoEditOperation): Promise<AgentTodoEditResult>;
  clearQueue(): Promise<AgentQueueSnapshot>;
  cancel(): Promise<AgentCancelResult>;
  resolvePermission(
    requestId: string,
    allowed: boolean,
  ): Promise<{ resolved: boolean }>;
  resolveDelegation?(
    params: DelegationResolveParams,
  ): Promise<{ resolved: boolean }>;
  completeDelegation?(
    params: DelegationCompletionParams,
  ): Promise<{ accepted: true }>;
  dispose(): Promise<void>;
  terminate(): void;
}

export type AgentConnectionFactory = (
  onEvent: (event: AgentUiEvent) => void,
  onPermissionRequest: (request: TaskPermissionRequest) => void,
  onDelegationRequest?: (request: DelegationRequest) => void,
) => AgentConnection;

export interface TaskControllerConfig {
  threadId: string;
  cwd: string;
  sessionDir: string;
  sessionReference?: AgentSessionReference;
  initialModel?: SupportedModelSelection;
  initialThinkingLevel?: ThinkingLevel;
  accessMode: TaskAccessMode;
  interactionMode: TaskInteractionMode;
  agentId?: string;
  agentRole?: AgentRole;
  agentCapability?: AgentCapability;
  profileInstructions?: string;
  apiKeys: Record<string, string>;
}

export interface TaskRunStartResult {
  runId: string;
  sessionReference: AgentSessionReference;
}

export interface TaskControllerSnapshot {
  model: SupportedModelSelection;
  thinkingLevel: ThinkingLevel;
  messages: AgentTranscriptMessage[];
  userEntries: Array<{ entryId: string; text: string }>;
  todo: ConversationTodoState | null;
}

export class TaskController {
  private connection: AgentConnection | undefined;
  private openingConnection: AgentConnection | undefined;
  private activeRunId: string | undefined;
  private sessionReference: AgentSessionReference | undefined;
  private currentModel: SupportedModelSelection | undefined;
  private currentThinkingLevel: ThinkingLevel | undefined;
  private latestSnapshot: TaskControllerSnapshot | undefined;
  private starting = false;
  private connecting: Promise<AgentConnection> | undefined;

  constructor(
    private readonly config: TaskControllerConfig,
    private readonly createConnection: AgentConnectionFactory,
    private readonly emit: (runId: string, event: AgentUiEvent) => void,
    private readonly saveSessionReference: (
      reference: AgentSessionReference,
    ) => boolean,
    private readonly onSettled: (
      runId: string,
      result?: AgentPromptResult,
      snapshot?: TaskControllerSnapshot,
    ) => void = () => undefined,
    private readonly onSnapshot: (
      snapshot: TaskControllerSnapshot,
    ) => void = () => undefined,
    private readonly onConnectionLost: (error: Error) => void = () => undefined,
    private readonly emitPermission: (
      runId: string,
      request: TaskPermissionRequest,
    ) => void = () => undefined,
    private readonly emitDelegation: (
      request: DelegationRequest,
    ) => void = () => undefined,
  ) {
    this.sessionReference = config.sessionReference;
  }

  get ready(): boolean {
    return this.connection !== undefined;
  }

  get model(): SupportedModelSelection | undefined {
    return this.currentModel;
  }

  get thinkingLevel(): ThinkingLevel | undefined {
    return this.currentThinkingLevel;
  }

  async start(
    text: string,
    runId: string = randomUUID(),
  ): Promise<TaskRunStartResult> {
    if (this.starting || this.activeRunId !== undefined) {
      throw new Error("A task is already running");
    }

    this.starting = true;
    try {
      const connection = await this.ensureConnection();
      const model = this.currentModel;
      if (model === undefined) {
        throw new Error("Pi session model is unavailable");
      }
      this.activeRunId = runId;
      this.emit(runId, {
        type: EventType.RUN_STARTED,
        threadId: this.config.threadId,
        runId,
      });
      void this.runPrompt(connection, text, runId);
      const sessionReference = this.sessionReference;
      if (sessionReference === undefined) {
        throw new Error("Pi session reference is unavailable");
      }
      return { runId, sessionReference };
    } finally {
      this.starting = false;
    }
  }

  async steer(text: string): Promise<TaskSteerResult> {
    if (this.activeRunId === undefined || this.connection === undefined) {
      throw new Error("No task is running");
    }
    await this.connection.steer(text);
    return { accepted: true };
  }

  async followUp(text: string): Promise<TaskFollowUpResult> {
    if (this.activeRunId === undefined || this.connection === undefined) {
      throw new Error("No task is running");
    }
    await this.connection.followUp(text);
    return { accepted: true };
  }

  async clearQueue(): Promise<TaskClearQueueResult> {
    if (this.activeRunId === undefined || this.connection === undefined) {
      throw new Error("No task is running");
    }
    return this.connection.clearQueue();
  }

  async editTodo(input: TodoEditOperation): Promise<AgentTodoEditResult> {
    const connection = await this.ensureConnection();
    const result = await connection.editTodo(input);
    if (this.latestSnapshot !== undefined) {
      this.latestSnapshot = { ...this.latestSnapshot, todo: result.todo };
      this.onSnapshot(this.latestSnapshot);
    }
    return result;
  }

  async cancel(): Promise<TaskCancelResult> {
    if (this.activeRunId === undefined || this.connection === undefined) {
      return {
        cancelled: false,
        queued: { steering: [], followUp: [] },
      };
    }
    return this.connection.cancel();
  }

  async resolvePermission(
    requestId: string,
    allowed: boolean,
  ): Promise<boolean> {
    const result = await this.connection?.resolvePermission(requestId, allowed);
    return result?.resolved ?? false;
  }

  async resolveDelegation(params: DelegationResolveParams): Promise<boolean> {
    const result = await this.connection?.resolveDelegation?.(params);
    return result?.resolved ?? false;
  }

  async completeDelegation(params: DelegationCompletionParams): Promise<boolean> {
    const result = await this.connection?.completeDelegation?.(params);
    return result?.accepted ?? false;
  }

  async open(): Promise<TaskControllerSnapshot> {
    const connection = await this.ensureConnection();
    return this.latestSnapshot ?? this.snapshot(connection);
  }

  async dispose(): Promise<void> {
    let connection = this.connection;
    if (connection === undefined && this.connecting !== undefined) {
      // A wedged boot/attach must not block disposal forever; after the
      // grace, kill the in-flight connection instead of adopting it.
      const settled = Symbol("connecting-timeout");
      try {
        const raced = await Promise.race([
          this.connecting,
          new Promise<typeof settled>((resolve) => {
            const timer = setTimeout(() => resolve(settled), 10_000);
            timer.unref?.();
          }),
        ]);
        if (raced === settled) {
          this.openingConnection?.terminate();
        } else {
          connection = raced;
        }
      } catch {
        connection = undefined;
      }
    }
    this.connection = undefined;
    this.activeRunId = undefined;
    await connection?.dispose();
  }

  terminate(): void {
    this.connection?.terminate();
    this.openingConnection?.terminate();
    this.connection = undefined;
    this.activeRunId = undefined;
  }

  private async ensureConnection(): Promise<AgentConnection> {
    if (this.connection !== undefined) {
      return this.connection;
    }

    if (this.connecting !== undefined) {
      return this.connecting;
    }

    const connecting = this.openConnection();
    this.connecting = connecting;
    try {
      return await connecting;
    } finally {
      if (this.connecting === connecting) {
        this.connecting = undefined;
      }
    }
  }

  private async openConnection(): Promise<AgentConnection> {
    const connection = this.createConnection(
      (event) => this.handleAgentEvent(event),
      (request) => {
        if (this.activeRunId === undefined) {
          void connection.resolvePermission(request.id, false);
          return;
        }
        this.emitPermission(this.activeRunId, request);
      },
      (request) => this.emitDelegation(request),
    );
    connection.setExitHandler((error) =>
      this.handleConnectionLost(connection, error),
    );
    this.openingConnection = connection;
    try {
      await connection.start();
      // A claimed prewarmed connection is already booted with an identical
      // profile; only fresh connections pay the sandbox + worker boot here.
      if (!connection.booted) {
        await connection.boot({
          cwd: this.config.cwd,
          sessionDir: this.config.sessionDir,
          accessMode: this.config.accessMode,
          interactionMode: this.config.interactionMode,
          agentCapability: this.config.agentCapability ?? "write",
          apiKeys: this.config.apiKeys,
        });
      }
      const initialized = await connection.attach({
        agentId: this.config.agentId ?? this.config.threadId,
        agentRole: this.config.agentRole ?? "lead",
        ...(this.config.profileInstructions === undefined
          ? {}
          : { profileInstructions: this.config.profileInstructions }),
        ...(this.config.initialModel === undefined
          ? {}
          : { model: this.config.initialModel }),
        ...(this.config.initialThinkingLevel === undefined
          ? {}
          : { thinkingLevel: this.config.initialThinkingLevel }),
        ...(this.sessionReference === undefined
          ? {}
          : {
              sessionId: this.sessionReference.sessionId,
              sessionFile: this.sessionReference.sessionFile,
            }),
      });

      if (
        this.sessionReference !== undefined &&
        initialized.sessionId !== this.sessionReference.sessionId
      ) {
        throw new Error("Reopened Pi session ID does not match its stored reference");
      }

      const reference: AgentSessionReference = {
        sessionId: initialized.sessionId,
        sessionFile: initialized.sessionFile,
      };
      if (
        this.sessionReference === undefined &&
        !this.saveSessionReference(reference)
      ) {
        throw new Error("Pi session reference could not be persisted");
      }
      this.sessionReference = reference;
      this.currentModel = supportedModelSelectionSchema.parse(initialized.model);
      this.currentThinkingLevel = initialized.thinkingLevel;
      this.latestSnapshot = {
        model: this.currentModel,
        thinkingLevel: this.currentThinkingLevel,
        messages: initialized.messages,
        userEntries: initialized.userEntries,
        todo: initialized.todo,
      };
      this.onSnapshot(this.latestSnapshot);
      this.connection = connection;
      return connection;
    } catch (error) {
      connection.terminate();
      throw error;
    } finally {
      if (this.openingConnection === connection) {
        this.openingConnection = undefined;
      }
    }
  }

  private async runPrompt(
    connection: AgentConnection,
    text: string,
    runId: string,
  ): Promise<void> {
    let settledResult: AgentPromptResult | undefined;
    let settledSnapshot: TaskControllerSnapshot | undefined;
    try {
      const result = await connection.prompt(text);
      settledResult = result;
      try {
        settledSnapshot = await this.snapshot(connection);
      } catch {
        settledSnapshot = undefined;
      }
      if (this.activeRunId !== runId) {
        return;
      }
      this.emit(
        runId,
        result.status === "cancelled"
          ? {
              type: EventType.CUSTOM,
              name: AGENT_UI_CUSTOM_EVENT.RUN_CANCELLED,
              value: {},
            }
          : {
              type: EventType.RUN_FINISHED,
              threadId: this.config.threadId,
              runId,
              outcome: { type: "success" },
            },
      );
    } catch (error) {
      if (this.activeRunId !== runId) {
        return;
      }
      this.emit(runId, {
        type: EventType.RUN_ERROR,
        message: error instanceof Error ? error.message : "Agent run failed",
      });
      connection.terminate();
      if (this.connection === connection) {
        this.connection = undefined;
      }
    } finally {
      if (this.activeRunId === runId) {
        this.activeRunId = undefined;
      }
      this.onSettled(runId, settledResult, settledSnapshot);
    }
  }

  private async snapshot(
    connection: AgentConnection,
  ): Promise<TaskControllerSnapshot> {
    const snapshot = await connection.snapshot();
    const value = {
      model: supportedModelSelectionSchema.parse(snapshot.model),
      thinkingLevel: snapshot.thinkingLevel,
      messages: snapshot.messages,
      userEntries: snapshot.userEntries,
      todo: snapshot.todo,
    };
    this.currentModel = value.model;
    this.currentThinkingLevel = value.thinkingLevel;
    this.latestSnapshot = value;
    this.onSnapshot(value);
    return value;
  }

  private handleConnectionLost(
    connection: AgentConnection,
    error: Error,
  ): void {
    if (this.connection === connection) {
      this.connection = undefined;
    }
    if (this.openingConnection === connection) {
      this.openingConnection = undefined;
    }
    this.onConnectionLost(error);
  }

  private handleAgentEvent(event: AgentUiEvent): void {
    const runId = this.activeRunId;
    if (runId === undefined) {
      return;
    }
    this.emit(runId, event);
  }
}
