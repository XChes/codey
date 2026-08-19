import { StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  delegationOperationSchema,
  type DelegationOperation,
  type DelegationToolResult,
} from "../shared/agent.js";

export const AGENT_TASK_TOOL_NAME = "task";

const Parameters = Type.Union([
  Type.Object({
    action: Type.Literal("list"),
  }),
  Type.Object({
    action: Type.Literal("run"),
    profileId: Type.String({ minLength: 1 }),
    description: Type.String({
      minLength: 1,
      description: "Short label for the delegated task",
    }),
    prompt: Type.String({ minLength: 1 }),
    capability: Type.Optional(
      StringEnum(["read", "write"] as const, {
        description:
          "Use read for analysis that may run in parallel; use write for a foreground coding turn",
      }),
    ),
    runInBackground: Type.Optional(Type.Boolean({ default: false })),
    dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  }),
  Type.Object({
    action: Type.Literal("status"),
    delegationIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  }),
  Type.Object({
    action: Type.Literal("wait"),
    delegationIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  }),
  Type.Object({
    action: Type.Literal("cancel"),
    delegationId: Type.String({ minLength: 1 }),
  }),
]);

export function createAgentTaskTool(
  request: (operation: DelegationOperation) => Promise<DelegationToolResult>,
): ToolDefinition {
  return defineTool({
    name: AGENT_TASK_TOOL_NAME,
    label: "Delegate task",
    description:
      "List configured subagents, delegate work, inspect or wait for delegated work, and cancel a delegation.",
    promptSnippet: "Delegate focused work to configured subagents",
    promptGuidelines: [
      "Use task list before delegating when available profiles are unknown.",
      "Use foreground delegation when its result is required for the current answer.",
      "Use capability read with runInBackground for independent analysis.",
      "Use capability write only for foreground coding work.",
      "Use dependsOn to express actual task dependencies instead of polling.",
    ],
    parameters: Parameters,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const operation = delegationOperationSchema.parse(params);
      const details = await request(operation);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(details, null, 2),
          },
        ],
        details,
      };
    },
  });
}
