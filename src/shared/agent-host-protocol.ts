import { z } from "zod";
import {
  agentUiEventSchema,
  agentUiMessageSchema,
  type AgentUiMessage,
} from "./agent-ui";
import {
  conversationTodoStateSchema,
  todoEditOperationSchema,
  type ConversationTodoState,
  type TodoEditOperation,
} from "./todo";
import {
  taskAccessModeSchema,
  taskInteractionModeSchema,
  taskPermissionRequestSchema,
  type TaskPermissionRequest,
} from "./task";
import {
  thinkingLevelSchema,
  type ThinkingLevel,
} from "./models";
import {
  agentCapabilitySchema,
  agentRoleSchema,
  delegationRequestSchema,
  type DelegationCompletionParams,
  type DelegationRequest,
  type DelegationResolveParams,
} from "./agent";

export type JsonRpcId = number | string;

const nonEmptyString = z.string().refine((value) => value.trim().length > 0);

export const agentModelSelectionSchema = z
  .object({
    provider: nonEmptyString,
    id: nonEmptyString,
  })
  .strict();

export const agentInitializeParamsSchema = z
  .object({
    cwd: nonEmptyString,
    model: agentModelSelectionSchema.optional(),
    thinkingLevel: thinkingLevelSchema.optional(),
    accessMode: taskAccessModeSchema.default("full"),
    interactionMode: taskInteractionModeSchema.default("agent"),
    agentId: nonEmptyString.optional(),
    agentRole: agentRoleSchema.optional(),
    agentCapability: agentCapabilitySchema.optional(),
    profileInstructions: nonEmptyString.optional(),
    activeDelegationIds: z.array(nonEmptyString).optional(),
    apiKeys: z.record(nonEmptyString, nonEmptyString),
    sessionDir: nonEmptyString,
    sessionId: nonEmptyString.optional(),
    sessionFile: nonEmptyString.optional(),
  })
  .strict();

// Host initialization is split so the expensive half can be prewarmed:
// `agent.boot` stands up the sandbox and worker process from identity-free
// inputs, and `agent.attach` binds agent identity and the Pi session. The
// supervisor still initializes its worker with the merged one-shot params.
export const agentBootParamsSchema = z
  .object({
    cwd: nonEmptyString,
    sessionDir: nonEmptyString,
    accessMode: taskAccessModeSchema.default("full"),
    interactionMode: taskInteractionModeSchema.default("agent"),
    agentCapability: agentCapabilitySchema.optional(),
    apiKeys: z.record(nonEmptyString, nonEmptyString),
  })
  .strict();

export const agentBootResultSchema = z
  .object({ booted: z.literal(true) })
  .strict();

export const agentAttachParamsSchema = z
  .object({
    model: agentModelSelectionSchema.optional(),
    thinkingLevel: thinkingLevelSchema.optional(),
    agentId: nonEmptyString.optional(),
    agentRole: agentRoleSchema.optional(),
    profileInstructions: nonEmptyString.optional(),
    activeDelegationIds: z.array(nonEmptyString).optional(),
    sessionId: nonEmptyString.optional(),
    sessionFile: nonEmptyString.optional(),
  })
  .strict();

export const agentSessionReferenceSchema = z
  .object({
    sessionId: nonEmptyString,
    sessionFile: nonEmptyString,
  })
  .strict();

export const agentTextParamsSchema = z
  .object({
    text: nonEmptyString,
  })
  .strict();

export const emptyParamsSchema = z.object({}).strict();

export const agentPermissionResolveParamsSchema = z
  .object({
    requestId: z.string().min(1),
    allowed: z.boolean(),
  })
  .strict();

export type AgentModelSelection = z.infer<typeof agentModelSelectionSchema>;
export type AgentInitializeParams = z.infer<typeof agentInitializeParamsSchema>;
export type AgentBootParams = z.infer<typeof agentBootParamsSchema>;
export type AgentBootResult = z.infer<typeof agentBootResultSchema>;
export type AgentAttachParams = z.infer<typeof agentAttachParamsSchema>;
export type AgentSessionReference = z.infer<typeof agentSessionReferenceSchema>;
export type AgentTranscriptMessage = AgentUiMessage;
export type AgentPromptParams = z.infer<typeof agentTextParamsSchema>;
export type AgentSteerParams = AgentPromptParams;
export type AgentFollowUpParams = AgentPromptParams;
export type AgentTodoEditParams = TodoEditOperation;
export type EmptyParams = z.infer<typeof emptyParamsSchema>;
export type AgentPermissionResolveParams = z.infer<
  typeof agentPermissionResolveParamsSchema
>;

export type AgentHostNotification =
  | {
      jsonrpc: "2.0";
      method: "agent.event";
      params: { event: import("./agent-ui").AgentUiEvent };
    }
  | {
      jsonrpc: "2.0";
      method: "agent.permission.request";
      params: { request: TaskPermissionRequest };
    }
  | {
      jsonrpc: "2.0";
      method: "agent.delegation.request";
      params: DelegationRequest;
    };

export const agentHostNotificationSchema: z.ZodType<AgentHostNotification> = z
  .discriminatedUnion("method", [
    z
      .object({
        jsonrpc: z.literal("2.0"),
        method: z.literal("agent.event"),
        params: z.object({ event: agentUiEventSchema }).strict(),
      })
      .strict(),
    z
      .object({
        jsonrpc: z.literal("2.0"),
        method: z.literal("agent.permission.request"),
        params: z.object({ request: taskPermissionRequestSchema }).strict(),
      })
      .strict(),
    z
      .object({
        jsonrpc: z.literal("2.0"),
        method: z.literal("agent.delegation.request"),
        params: delegationRequestSchema,
      })
      .strict(),
  ]);

export const jsonRpcSuccessSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.number(), z.string()]),
    result: z.unknown(),
  })
  .strict();

export const jsonRpcFailureSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.number(), z.string(), z.null()]),
    error: z
      .object({
        code: z.number().int(),
        message: z.string(),
      })
      .strict(),
  })
  .strict();

export type AgentHostRequest =
  | JsonRpcRequest<"agent.initialize", AgentInitializeParams>
  | JsonRpcRequest<"agent.snapshot", EmptyParams>
  | JsonRpcRequest<"agent.prompt", AgentPromptParams>
  | JsonRpcRequest<"agent.continueAfterAccess", EmptyParams>
  | JsonRpcRequest<"agent.steer", AgentSteerParams>
  | JsonRpcRequest<"agent.followUp", AgentFollowUpParams>
  | JsonRpcRequest<"agent.todo.edit", AgentTodoEditParams>
  | JsonRpcRequest<"agent.clearQueue", EmptyParams>
  | JsonRpcRequest<"agent.cancel", EmptyParams>
  | JsonRpcRequest<"agent.permission.resolve", AgentPermissionResolveParams>
  | JsonRpcRequest<"agent.delegation.resolve", DelegationResolveParams>
  | JsonRpcRequest<"agent.delegation.complete", DelegationCompletionParams>
  | JsonRpcRequest<"agent.dispose", EmptyParams>;

export interface JsonRpcRequest<Method extends string, Params> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: Method;
  params: Params;
}

export interface JsonRpcSuccess<Result = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: Result;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: {
    code: number;
    message: string;
  };
}

export type JsonRpcResponse<Result = unknown> = JsonRpcFailure | JsonRpcSuccess<Result>;

export interface AgentInitializeResult {
  sessionId: string;
  sessionFile: string;
  model: AgentModelSelection;
  thinkingLevel: ThinkingLevel;
  messages: AgentTranscriptMessage[];
  userEntries: Array<{ entryId: string; text: string }>;
  todo: ConversationTodoState | null;
}

export interface AgentPromptResult {
  status: "completed" | "cancelled";
  userEntryId: string | null;
}

export interface AgentSnapshotResult {
  model: AgentModelSelection;
  thinkingLevel: ThinkingLevel;
  messages: AgentTranscriptMessage[];
  userEntries: Array<{ entryId: string; text: string }>;
  todo: ConversationTodoState | null;
}

export interface AgentQueueSnapshot {
  steering: string[];
  followUp: string[];
}

export interface AgentCancelResult {
  cancelled: boolean;
  queued: AgentQueueSnapshot;
}

export interface AgentTodoEditResult {
  todo: ConversationTodoState | null;
}

export interface AgentDisposeResult {
  disposed: true;
}

export interface AgentPermissionResolveResult {
  resolved: boolean;
}

export interface AgentDelegationCompleteResult {
  accepted: true;
}

export const agentInitializeResultSchema = z
  .object({
    sessionId: z.string().min(1),
    sessionFile: z.string().min(1),
    model: agentModelSelectionSchema,
    thinkingLevel: thinkingLevelSchema,
    messages: z.array(agentUiMessageSchema),
    userEntries: z.array(
      z.object({ entryId: z.string().min(1), text: z.string() }).strict(),
    ),
    todo: conversationTodoStateSchema.nullable(),
  })
  .strict();

export const agentPromptResultSchema = z
  .object({
    status: z.enum(["completed", "cancelled"]),
    userEntryId: z.string().min(1).nullable(),
  })
  .strict();

export const agentSnapshotResultSchema = z
  .object({
    model: agentModelSelectionSchema,
    thinkingLevel: thinkingLevelSchema,
    messages: z.array(agentUiMessageSchema),
    userEntries: z.array(
      z.object({ entryId: z.string().min(1), text: z.string() }).strict(),
    ),
    todo: conversationTodoStateSchema.nullable(),
  })
  .strict();

export const agentSteerResultSchema = z
  .object({ accepted: z.literal(true) })
  .strict();

export const agentFollowUpResultSchema = agentSteerResultSchema;

export const agentTodoEditParamsSchema = todoEditOperationSchema;

export const agentTodoEditResultSchema = z
  .object({ todo: conversationTodoStateSchema.nullable() })
  .strict();

export const agentQueueSnapshotSchema = z
  .object({
    steering: z.array(z.string()),
    followUp: z.array(z.string()),
  })
  .strict();

export const agentCancelResultSchema = z
  .object({
    cancelled: z.boolean(),
    queued: agentQueueSnapshotSchema,
  })
  .strict();

export const agentDisposeResultSchema = z
  .object({ disposed: z.literal(true) })
  .strict();

export const agentPermissionResolveResultSchema = z
  .object({ resolved: z.boolean() })
  .strict();

export const agentDelegationResolveResultSchema = agentPermissionResolveResultSchema;

export const agentDelegationCompleteResultSchema = z
  .object({ accepted: z.literal(true) })
  .strict();
