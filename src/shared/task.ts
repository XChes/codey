import { z } from "zod";
import {
  agentUiEventSchema,
  agentUiMessageSchema,
  type AgentUiEvent,
  type AgentUiMessage,
} from "./agent-ui";
import {
  DEFAULT_THINKING_LEVEL,
  supportedModelSelectionSchema,
  thinkingLevelSchema,
} from "./models";
import { conversationTodoStateSchema } from "./todo";
import { workspaceInfoSchema } from "./workspace";
import {
  agentSnapshotSchema,
  agentSummarySchema,
  delegationSchema,
  type AgentSummary,
} from "./agent";

const nonEmptyText = z.string().refine((value) => value.trim().length > 0);

export const taskStatusSchema = z.enum([
  "idle",
  "running",
  "completed",
  "cancelled",
  "interrupted",
  "failed",
]);

export const taskExecutionTargetSchema = z.enum(["local", "worktree"]);

export const taskAccessModeSchema = z.enum(["ask", "auto", "full"]);
export const DEFAULT_TASK_ACCESS_MODE = "full" as const;

export const taskInteractionModeSchema = z.enum(["agent", "plan"]);
export const DEFAULT_TASK_INTERACTION_MODE = "agent" as const;

export const taskRuntimeStateSchema = z.enum([
  "cold",
  "preparing",
  "ready",
  "running",
]);

export const taskSummarySchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: taskStatusSchema,
    executionTarget: taskExecutionTargetSchema,
    accessMode: taskAccessModeSchema,
    interactionMode: taskInteractionModeSchema,
    branch: z.string().min(1).nullable(),
    workspace: workspaceInfoSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const taskOpenInputSchema = z
  .object({ taskId: z.string().min(1) })
  .strict();

export const taskCreateInputSchema = z
  .object({
    title: nonEmptyText,
    workspaceId: z.string().min(1),
    executionTarget: taskExecutionTargetSchema,
    accessMode: taskAccessModeSchema.default(DEFAULT_TASK_ACCESS_MODE),
    interactionMode: taskInteractionModeSchema.default(
      DEFAULT_TASK_INTERACTION_MODE,
    ),
  })
  .strict();

export const taskAccessModeUpdateInputSchema = z
  .object({
    taskId: z.string().min(1),
    accessMode: taskAccessModeSchema,
  })
  .strict();

export const taskInteractionModeUpdateInputSchema = z
  .object({
    taskId: z.string().min(1),
    interactionMode: taskInteractionModeSchema,
  })
  .strict();

export const taskPermissionKindSchema = z.enum([
  "network",
  "file-read",
  "file-write",
]);

export const taskPermissionRequestSchema = z
  .object({
    id: z.string().min(1),
    kind: taskPermissionKindSchema,
    resource: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

export const taskPermissionRequestEnvelopeSchema = z
  .object({
    taskId: z.string().min(1),
    runId: z.string().min(1),
    agentId: z.string().min(1).optional(),
    agentRunId: z.string().min(1).optional(),
    request: taskPermissionRequestSchema,
  })
  .strict();

export const taskPermissionDecisionInputSchema = z
  .object({
    taskId: z.string().min(1),
    requestId: z.string().min(1),
    allowed: z.boolean(),
  })
  .strict();

export const taskPermissionDecisionResultSchema = z
  .object({ resolved: z.boolean() })
  .strict();

export const taskSnapshotSchema = z
  .object({
    task: taskSummarySchema,
    model: supportedModelSelectionSchema,
    thinkingLevel: thinkingLevelSchema.default(DEFAULT_THINKING_LEVEL),
    messages: z.array(agentUiMessageSchema),
    todo: conversationTodoStateSchema.nullable().default(null),
    agents: z.array(agentSnapshotSchema).optional(),
    delegations: z.array(delegationSchema).optional(),
  })
  .strict();

export const taskConversationProjectionSchema = z
  .object({
    model: supportedModelSelectionSchema,
    thinkingLevel: thinkingLevelSchema.default(DEFAULT_THINKING_LEVEL),
    messages: z.array(agentUiMessageSchema),
    todo: conversationTodoStateSchema.nullable().default(null),
    userEntries: z.array(
      z.object({ entryId: z.string().min(1), text: z.string() }).strict(),
    ),
  })
  .strict();

export const taskTextInputSchema = z
  .object({
    taskId: z.string().min(1),
    text: nonEmptyText,
  })
  .strict();

export const taskStartInputSchema = z
  .object({
    taskId: z.string().min(1),
    text: nonEmptyText,
    model: supportedModelSelectionSchema,
    thinkingLevel: thinkingLevelSchema,
  })
  .strict();

export const taskTargetInputSchema = z
  .object({ taskId: z.string().min(1) })
  .strict();

export interface TaskEventEnvelope {
  taskId: string;
  runId: string;
  agentId?: string;
  agentRunId?: string;
  agent?: AgentSummary;
  event: AgentUiEvent;
}

export const taskEventEnvelopeSchema: z.ZodType<TaskEventEnvelope> = z
  .object({
    taskId: z.string().min(1),
    runId: z.string().min(1),
    agentId: z.string().min(1).optional(),
    agentRunId: z.string().min(1).optional(),
    agent: agentSummarySchema.optional(),
    event: agentUiEventSchema,
  })
  .strict();

export const taskCreateResultSchema = z
  .object({ task: taskSummarySchema })
  .strict();

export const taskStartResultSchema = z
  .object({
    runId: z.string().min(1),
  })
  .strict();

export const taskSteerResultSchema = z
  .object({ accepted: z.literal(true) })
  .strict();

export const taskFollowUpResultSchema = taskSteerResultSchema;

export const taskQueueSnapshotSchema = z
  .object({
    steering: z.array(z.string()),
    followUp: z.array(z.string()),
  })
  .strict();

export const taskClearQueueResultSchema = taskQueueSnapshotSchema;

export const taskCancelResultSchema = z
  .object({
    cancelled: z.boolean(),
    queued: taskQueueSnapshotSchema,
  })
  .strict();

export const taskActivateResultSchema = z
  .object({ state: taskRuntimeStateSchema })
  .strict();

export const taskRuntimeStateEnvelopeSchema = z
  .object({
    taskId: z.string().min(1),
    state: taskRuntimeStateSchema,
  })
  .strict();

export type TaskTextInput = z.infer<typeof taskTextInputSchema>;
export type TaskStartInput = z.infer<typeof taskStartInputSchema>;
export type TaskTargetInput = z.infer<typeof taskTargetInputSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskExecutionTarget = z.infer<typeof taskExecutionTargetSchema>;
export type TaskAccessMode = z.infer<typeof taskAccessModeSchema>;
export type TaskInteractionMode = z.infer<typeof taskInteractionModeSchema>;
export type TaskRuntimeState = z.infer<typeof taskRuntimeStateSchema>;
export type TaskSummary = z.infer<typeof taskSummarySchema>;
export type TaskCreateInput = z.infer<typeof taskCreateInputSchema>;
export type TaskAccessModeUpdateInput = z.infer<
  typeof taskAccessModeUpdateInputSchema
>;
export type TaskInteractionModeUpdateInput = z.infer<
  typeof taskInteractionModeUpdateInputSchema
>;
export type TaskPermissionKind = z.infer<typeof taskPermissionKindSchema>;
export type TaskPermissionRequest = z.infer<
  typeof taskPermissionRequestSchema
>;
export type TaskPermissionRequestEnvelope = z.infer<
  typeof taskPermissionRequestEnvelopeSchema
>;
export type TaskPermissionDecisionInput = z.infer<
  typeof taskPermissionDecisionInputSchema
>;
export type TaskPermissionDecisionResult = z.infer<
  typeof taskPermissionDecisionResultSchema
>;
export type TaskCreateResult = z.infer<typeof taskCreateResultSchema>;
export type TaskOpenInput = z.infer<typeof taskOpenInputSchema>;
export type TaskTranscriptMessage = AgentUiMessage;
export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;
export type TaskConversationProjection = z.infer<
  typeof taskConversationProjectionSchema
>;
export type TaskStartResult = z.infer<typeof taskStartResultSchema>;
export type TaskSteerResult = z.infer<typeof taskSteerResultSchema>;
export type TaskFollowUpResult = z.infer<typeof taskFollowUpResultSchema>;
export type TaskQueueSnapshot = z.infer<typeof taskQueueSnapshotSchema>;
export type TaskClearQueueResult = z.infer<typeof taskClearQueueResultSchema>;
export type TaskCancelResult = z.infer<typeof taskCancelResultSchema>;
export type TaskActivateResult = z.infer<typeof taskActivateResultSchema>;
export type TaskRuntimeStateEnvelope = z.infer<
  typeof taskRuntimeStateEnvelopeSchema
>;
