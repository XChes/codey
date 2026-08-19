import { z } from "zod";
import { agentUiMessageSchema } from "./agent-ui";
import {
  supportedModelSelectionSchema,
  thinkingLevelSchema,
} from "./models";

const nonEmptyText = z.string().refine((value) => value.trim().length > 0);

export const profileIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid subagent id");

export const agentRoleSchema = z.enum(["lead", "subagent"]);
export const agentCapabilitySchema = z.enum(["read", "write"]);

export const agentStatusSchema = z.enum([
  "idle",
  "queued",
  "running",
  "completed",
  "blocked",
  "cancelled",
  "interrupted",
  "failed",
]);

export const delegationStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "blocked",
  "cancelled",
  "interrupted",
  "failed",
]);

export const subagentProfileSchema = z
  .object({
    id: profileIdSchema,
    description: nonEmptyText,
    instructions: nonEmptyText,
    capability: agentCapabilitySchema,
    model: supportedModelSelectionSchema.optional(),
    thinkingLevel: thinkingLevelSchema.optional(),
  })
  .strict();

export const subagentConfigSchema = z
  .object({
    version: z.literal(1),
    agents: z.array(subagentProfileSchema),
  })
  .strict()
  .superRefine((config, context) => {
    const ids = new Set<string>();
    for (const agent of config.agents) {
      if (ids.has(agent.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate subagent id: ${agent.id}`,
          path: ["agents"],
        });
      }
      ids.add(agent.id);
    }
  });

export const agentSummarySchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    parentAgentId: z.string().min(1).nullable(),
    role: agentRoleSchema,
    profileId: z.string().min(1).nullable(),
    capability: agentCapabilitySchema,
    status: agentStatusSchema,
    model: supportedModelSelectionSchema,
    thinkingLevel: thinkingLevelSchema,
    assignment: z.string().nullable(),
    result: z.string().nullable(),
    error: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const agentConversationProjectionSchema = z
  .object({
    messages: z.array(agentUiMessageSchema),
    userEntries: z.array(
      z.object({ entryId: z.string().min(1), text: z.string() }).strict(),
    ),
  })
  .strict();

export const agentSnapshotSchema = z
  .object({
    agent: agentSummarySchema,
    projection: agentConversationProjectionSchema,
  })
  .strict();

export const delegationSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    taskRunId: z.string().min(1),
    parentAgentId: z.string().min(1),
    childAgentId: z.string().min(1),
    profileId: z.string().min(1),
    capability: agentCapabilitySchema,
    prompt: nonEmptyText,
    status: delegationStatusSchema,
    dependsOn: z.array(z.string().min(1)),
    result: z.string().nullable(),
    error: z.string().nullable(),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
  })
  .strict();

export const delegationOperationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z
    .object({
      action: z.literal("run"),
      profileId: profileIdSchema,
      description: nonEmptyText,
      prompt: nonEmptyText,
      capability: agentCapabilitySchema.optional(),
      runInBackground: z.boolean().default(false),
      dependsOn: z.array(z.string().min(1)).default([]),
    })
    .strict(),
  z
    .object({
      action: z.literal("status"),
      delegationIds: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("wait"),
      delegationIds: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("cancel"),
      delegationId: z.string().min(1),
    })
    .strict(),
]);

export const delegationToolResultSchema = z
  .object({
    message: z.string(),
    profiles: z.array(subagentProfileSchema).optional(),
    delegations: z.array(delegationSchema).optional(),
  })
  .strict();

export const delegationRequestSchema = z
  .object({
    requestId: z.string().min(1),
    operation: delegationOperationSchema,
  })
  .strict();

export const delegationResolveParamsSchema = z
  .object({
    requestId: z.string().min(1),
    result: delegationToolResultSchema.optional(),
    error: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (value) => (value.result === undefined) !== (value.error === undefined),
    "Exactly one of result or error is required",
  );

export const delegationCompletionParamsSchema = z
  .object({ delegation: delegationSchema })
  .strict();

export type AgentRole = z.infer<typeof agentRoleSchema>;
export type AgentCapability = z.infer<typeof agentCapabilitySchema>;
export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type AgentSummary = z.infer<typeof agentSummarySchema>;
export type AgentConversationProjection = z.infer<
  typeof agentConversationProjectionSchema
>;
export type AgentSnapshot = z.infer<typeof agentSnapshotSchema>;
export type SubagentProfile = z.infer<typeof subagentProfileSchema>;
export type SubagentConfig = z.infer<typeof subagentConfigSchema>;
export type Delegation = z.infer<typeof delegationSchema>;
export type DelegationStatus = z.infer<typeof delegationStatusSchema>;
export type DelegationOperation = z.infer<typeof delegationOperationSchema>;
export type DelegationToolResult = z.infer<typeof delegationToolResultSchema>;
export type DelegationRequest = z.infer<typeof delegationRequestSchema>;
export type DelegationResolveParams = z.infer<
  typeof delegationResolveParamsSchema
>;
export type DelegationCompletionParams = z.infer<
  typeof delegationCompletionParamsSchema
>;
