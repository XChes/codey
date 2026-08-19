import {
  EventSchemas,
  MessageSchema,
  type AGUIEvent,
  type Message,
} from "@ag-ui/core";
import { z } from "zod";

export const AGENT_UI_CUSTOM_EVENT = {
  RUN_CANCELLED: "desktop-agent.run.cancelled",
  PI_QUEUE_UPDATED: "pi.queue.updated",
  PI_COMPACTION_STARTED: "pi.compaction.started",
  PI_COMPACTION_FINISHED: "pi.compaction.finished",
  PI_RETRY_SCHEDULED: "pi.retry.scheduled",
  PI_RETRY_ATTEMPT_STARTED: "pi.retry.attempt.started",
  PI_RETRY_FINISHED: "pi.retry.finished",
  PI_BASH_OUTPUT: "pi.bash.output",
  TODO_UPDATED: "desktop-agent.todo.updated",
  TODO_CONTINUATION_EXHAUSTED: "desktop-agent.todo.continuation-exhausted",
} as const;

export type AgentUiEvent = AGUIEvent;
export type AgentUiMessage = Message;

export const agentUiEventSchema: z.ZodType<AgentUiEvent> = z.custom<AgentUiEvent>(
  (value) => EventSchemas.safeParse(value).success,
  { message: "Invalid AG-UI event" },
);

export const agentUiMessageSchema: z.ZodType<AgentUiMessage> = z.custom<AgentUiMessage>(
  (value) => MessageSchema.safeParse(value).success,
  { message: "Invalid AG-UI message" },
);
