import {
  EventType,
  type ToolCall,
} from "@ag-ui/core";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

import {
  AGENT_UI_CUSTOM_EVENT,
  type AgentUiEvent,
  type AgentUiMessage,
} from "../shared/agent-ui.js";
import {
  TODO_TOOL_NAME,
  todoToolDetailsSchema,
} from "../shared/todo.js";

type PiMessage = AgentSession["messages"][number];
type PiAssistantMessage = Extract<PiMessage, { role: "assistant" }>;
type PiToolResultMessage = Extract<PiMessage, { role: "toolResult" }>;

interface ReasoningStream {
  id: string;
  content: string;
  ended: boolean;
}

interface ToolCallStream {
  id: string;
  name: string;
  arguments: string;
  ended: boolean;
}

interface AssistantStream {
  id: string;
  text: string;
  textStarted: boolean;
  reasoning: Map<number, ReasoningStream>;
  toolCalls: Map<number, ToolCallStream>;
}

function messageId(sessionId: string, message: PiMessage): string {
  if (message.role === "toolResult") {
    return `${sessionId}:tool:${message.toolCallId}`;
  }
  return `${sessionId}:${message.role}:${message.timestamp}`;
}

function textFromPiContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return content === undefined ? "" : JSON.stringify(content);
  }
  return content
    .map((item) => {
      if (typeof item !== "object" || item === null) return String(item);
      if ("type" in item && item.type === "text" && "text" in item) {
        return String(item.text);
      }
      if ("type" in item && item.type === "image" && "mimeType" in item) {
        return `[image: ${String(item.mimeType)}]`;
      }
      return "";
    })
    .join("");
}

function toolResultContent(message: PiToolResultMessage): string {
  return textFromPiContent(message.content);
}

function toolActivityId(toolCallId: string): string {
  return `tool-execution:${toolCallId}`;
}

function customEvent(name: string, value: unknown): AgentUiEvent {
  return { type: EventType.CUSTOM, name, value };
}

function toolCallFromPartial(
  message: PiAssistantMessage,
  contentIndex: number,
): ToolCall | undefined {
  const content = message.content[contentIndex];
  if (content?.type !== "toolCall") return undefined;
  return {
    id: content.id,
    type: "function",
    function: {
      name: content.name,
      arguments: JSON.stringify(content.arguments),
    },
  };
}

export class PiToAgUiEventAdapter {
  private assistant: AssistantStream | undefined;

  constructor(private readonly sessionId: string) {}

  map(event: AgentSessionEvent): AgentUiEvent[] {
    switch (event.type) {
      case "agent_start":
      case "agent_end":
      case "agent_settled":
      case "entry_appended":
      case "session_info_changed":
      case "thinking_level_changed":
        return [];
      case "turn_start":
        return [{ type: EventType.STEP_STARTED, stepName: "agent-turn" }];
      case "turn_end":
        return [{ type: EventType.STEP_FINISHED, stepName: "agent-turn" }];
      case "message_start":
        return this.startMessage(event.message);
      case "message_update":
        if (event.message.role !== "assistant") return [];
        return this.updateAssistant(event.message, event.assistantMessageEvent);
      case "message_end":
        return this.endMessage(event.message);
      case "tool_execution_start":
        if (event.toolName === TODO_TOOL_NAME) return [];
        return [
          {
            type: EventType.ACTIVITY_SNAPSHOT,
            messageId: toolActivityId(event.toolCallId),
            activityType: "tool_execution",
            content: {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
              status: "running",
            },
            replace: true,
          },
        ];
      case "tool_execution_update":
        if (event.toolName === TODO_TOOL_NAME) return [];
        return [
          {
            type: EventType.ACTIVITY_SNAPSHOT,
            messageId: toolActivityId(event.toolCallId),
            activityType: "tool_execution",
            content: {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
              partialResult: event.partialResult,
              status: "running",
            },
            replace: true,
          },
        ];
      case "tool_execution_end":
        if (event.toolName === TODO_TOOL_NAME) {
          const details = todoToolDetailsSchema.safeParse(event.result.details);
          if (details.success) {
            return [
              customEvent(AGENT_UI_CUSTOM_EVENT.TODO_UPDATED, details.data),
            ];
          }
          if (!event.isError) return [];
        }
        return [
          {
            type: EventType.ACTIVITY_SNAPSHOT,
            messageId: toolActivityId(event.toolCallId),
            activityType: "tool_execution",
            content: {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              result: event.result,
              status: event.isError ? "failed" : "succeeded",
            },
            replace: true,
          },
        ];
      case "queue_update":
        return [
          customEvent(AGENT_UI_CUSTOM_EVENT.PI_QUEUE_UPDATED, {
            steering: [...event.steering],
            followUp: [...event.followUp],
          }),
        ];
      case "compaction_start":
        return [
          customEvent(AGENT_UI_CUSTOM_EVENT.PI_COMPACTION_STARTED, {
            reason: event.reason,
          }),
        ];
      case "compaction_end":
        return [
          customEvent(AGENT_UI_CUSTOM_EVENT.PI_COMPACTION_FINISHED, {
            reason: event.reason,
            aborted: event.aborted,
            willRetry: event.willRetry,
            ...(event.errorMessage === undefined
              ? {}
              : { message: event.errorMessage }),
          }),
        ];
      case "auto_retry_start":
      case "summarization_retry_scheduled":
        return [
          customEvent(AGENT_UI_CUSTOM_EVENT.PI_RETRY_SCHEDULED, {
            kind:
              event.type === "auto_retry_start" ? "agent" : "summarization",
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
            message: event.errorMessage,
          }),
        ];
      case "summarization_retry_attempt_start":
        return [
          customEvent(AGENT_UI_CUSTOM_EVENT.PI_RETRY_ATTEMPT_STARTED, {
            source: event.source,
            ...(event.source === "compaction" ? { reason: event.reason } : {}),
          }),
        ];
      case "auto_retry_end":
        return [
          customEvent(AGENT_UI_CUSTOM_EVENT.PI_RETRY_FINISHED, {
            kind: "agent",
            attempt: event.attempt,
            success: event.success,
            ...(event.finalError === undefined
              ? {}
              : { message: event.finalError }),
          }),
        ];
      case "summarization_retry_finished":
        return [
          customEvent(AGENT_UI_CUSTOM_EVENT.PI_RETRY_FINISHED, {
            kind: "summarization",
            success: true,
          }),
        ];
      case "bash_execution_update":
        return [
          customEvent(AGENT_UI_CUSTOM_EVENT.PI_BASH_OUTPUT, {
            ...(event.id === undefined ? {} : { id: event.id }),
            delta: event.delta,
          }),
        ];
    }
  }

  private startMessage(message: PiMessage): AgentUiEvent[] {
    if (message.role === "user") {
      const id = messageId(this.sessionId, message);
      const text = textFromPiContent(message.content);
      return [
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: id,
          role: "user",
        },
        ...(text.length === 0
          ? []
          : [
              {
                type: EventType.TEXT_MESSAGE_CONTENT as const,
                messageId: id,
                delta: text,
              },
            ]),
        {
          type: EventType.TEXT_MESSAGE_END,
          messageId: id,
        },
      ];
    }
    if (message.role === "assistant") {
      this.assistant = {
        id: messageId(this.sessionId, message),
        text: "",
        textStarted: false,
        reasoning: new Map(),
        toolCalls: new Map(),
      };
    }
    return [];
  }

  private requireAssistant(message: PiAssistantMessage): AssistantStream {
    if (this.assistant === undefined) {
      this.startMessage(message);
    }
    return this.assistant!;
  }

  private updateAssistant(
    message: PiAssistantMessage,
    update: Extract<AgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"],
  ): AgentUiEvent[] {
    const stream = this.requireAssistant(message);
    switch (update.type) {
      case "start":
      case "done":
      case "error":
        return [];
      case "text_start":
        return this.startText(stream);
      case "text_delta":
        stream.text += update.delta;
        return [
          ...this.startText(stream),
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: stream.id,
            delta: update.delta,
          },
        ];
      case "text_end":
        return [];
      case "thinking_start":
        return this.startReasoning(stream, update.contentIndex);
      case "thinking_delta": {
        const events = this.startReasoning(stream, update.contentIndex);
        const reasoning = stream.reasoning.get(update.contentIndex)!;
        reasoning.content += update.delta;
        return [
          ...events,
          {
            type: EventType.REASONING_MESSAGE_CONTENT,
            messageId: reasoning.id,
            delta: update.delta,
          },
        ];
      }
      case "thinking_end":
        return this.endReasoning(stream, update.contentIndex);
      case "toolcall_start":
        return this.startToolCall(stream, message, update.contentIndex);
      case "toolcall_delta": {
        const events = this.startToolCall(stream, message, update.contentIndex);
        const toolCall = stream.toolCalls.get(update.contentIndex)!;
        toolCall.arguments += update.delta;
        return [
          ...events,
          {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: toolCall.id,
            delta: update.delta,
          },
        ];
      }
      case "toolcall_end":
        return this.endToolCall(stream, message, update.contentIndex, update.toolCall);
    }
  }

  private endMessage(message: PiMessage): AgentUiEvent[] {
    if (message.role === "toolResult") {
      return [
        {
          type: EventType.TOOL_CALL_RESULT,
          messageId: messageId(this.sessionId, message),
          toolCallId: message.toolCallId,
          content: toolResultContent(message),
          role: "tool",
          rawEvent: { isError: message.isError },
        },
      ];
    }
    if (message.role !== "assistant") return [];

    const stream = this.requireAssistant(message);
    const events: AgentUiEvent[] = [];
    const finalText = message.content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("");
    if (finalText.length > 0) {
      events.push(...this.startText(stream));
      if (stream.text.length === 0) {
        events.push({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: stream.id,
          delta: finalText,
        });
      } else if (finalText.startsWith(stream.text) && finalText.length > stream.text.length) {
        events.push({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: stream.id,
          delta: finalText.slice(stream.text.length),
        });
      }
    }
    if (stream.textStarted) {
      events.push({ type: EventType.TEXT_MESSAGE_END, messageId: stream.id });
    }

    message.content.forEach((content, contentIndex) => {
      if (content.type === "thinking") {
        events.push(...this.startReasoning(stream, contentIndex));
        const reasoning = stream.reasoning.get(contentIndex)!;
        if (reasoning.content.length === 0 && content.thinking.length > 0) {
          reasoning.content = content.thinking;
          events.push({
            type: EventType.REASONING_MESSAGE_CONTENT,
            messageId: reasoning.id,
            delta: content.thinking,
          });
        }
        events.push(...this.endReasoning(stream, contentIndex));
      }
      if (content.type === "toolCall") {
        events.push(
          ...this.endToolCall(stream, message, contentIndex, content),
        );
      }
    });

    this.assistant = undefined;
    return events;
  }

  private startText(stream: AssistantStream): AgentUiEvent[] {
    if (stream.textStarted) return [];
    stream.textStarted = true;
    return [
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: stream.id,
        role: "assistant",
      },
    ];
  }

  private startReasoning(
    stream: AssistantStream,
    contentIndex: number,
  ): AgentUiEvent[] {
    if (stream.reasoning.has(contentIndex)) return [];
    const reasoning: ReasoningStream = {
      id: `${stream.id}:reasoning:${contentIndex}`,
      content: "",
      ended: false,
    };
    stream.reasoning.set(contentIndex, reasoning);
    return [
      {
        type: EventType.REASONING_MESSAGE_START,
        messageId: reasoning.id,
        role: "reasoning",
      },
    ];
  }

  private endReasoning(
    stream: AssistantStream,
    contentIndex: number,
  ): AgentUiEvent[] {
    const startEvents = this.startReasoning(stream, contentIndex);
    const reasoning = stream.reasoning.get(contentIndex)!;
    if (reasoning.ended) return startEvents;
    reasoning.ended = true;
    return [
      ...startEvents,
      {
        type: EventType.REASONING_MESSAGE_END,
        messageId: reasoning.id,
      },
    ];
  }

  private startToolCall(
    stream: AssistantStream,
    message: PiAssistantMessage,
    contentIndex: number,
  ): AgentUiEvent[] {
    if (stream.toolCalls.has(contentIndex)) return [];
    const partial = toolCallFromPartial(message, contentIndex);
    const toolCall: ToolCallStream = {
      id: partial?.id ?? `${stream.id}:tool:${contentIndex}`,
      name: partial?.function.name ?? "tool",
      arguments: "",
      ended: false,
    };
    stream.toolCalls.set(contentIndex, toolCall);
    return [
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: toolCall.id,
        toolCallName: toolCall.name,
        parentMessageId: stream.id,
      },
    ];
  }

  private endToolCall(
    stream: AssistantStream,
    message: PiAssistantMessage,
    contentIndex: number,
    finalToolCall: Extract<PiAssistantMessage["content"][number], { type: "toolCall" }>,
  ): AgentUiEvent[] {
    const startEvents = this.startToolCall(stream, message, contentIndex);
    const toolCall = stream.toolCalls.get(contentIndex)!;
    if (toolCall.ended) return startEvents;
    const events = [...startEvents];
    if (toolCall.arguments.length === 0) {
      events.push({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: toolCall.id,
        delta: JSON.stringify(finalToolCall.arguments),
      });
    }
    toolCall.ended = true;
    events.push({
      type: EventType.TOOL_CALL_END,
      toolCallId: toolCall.id,
    });
    return events;
  }
}

export function mapPiMessages(
  messages: AgentSession["messages"],
  sessionId: string,
): AgentUiMessage[] {
  const transcript: AgentUiMessage[] = [];

  messages.forEach((message, index) => {
    const id = `${sessionId}:history:${index}`;
    if (message.role === "user") {
      transcript.push({
        id,
        role: "user",
        content: textFromPiContent(message.content),
      });
      return;
    }
    if (message.role === "assistant") {
      message.content.forEach((content, contentIndex) => {
        if (content.type === "thinking" && content.thinking.length > 0) {
          transcript.push({
            id: `${id}:reasoning:${contentIndex}`,
            role: "reasoning",
            content: content.thinking,
          });
        }
      });
      const text = message.content
        .filter((content) => content.type === "text")
        .map((content) => content.text)
        .join("");
      const toolCalls: ToolCall[] = message.content
        .filter((content) => content.type === "toolCall")
        .map((content) => ({
          id: content.id,
          type: "function",
          function: {
            name: content.name,
            arguments: JSON.stringify(content.arguments),
          },
        }));
      transcript.push({
        id,
        role: "assistant",
        ...(text.length === 0 ? {} : { content: text }),
        ...(toolCalls.length === 0 ? {} : { toolCalls }),
      });
      return;
    }
    if (message.role === "toolResult") {
      const content = toolResultContent(message);
      transcript.push({
        id,
        role: "tool",
        toolCallId: message.toolCallId,
        content,
        ...(message.isError ? { error: content || "Tool execution failed" } : {}),
      });
    }
  });

  return transcript;
}
