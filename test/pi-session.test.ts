// @vitest-environment node

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventType } from "@ag-ui/core";
import {
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import {
  PiAgentSessionFactory,
} from "../src/agent-host/pi-session.js";
import {
  mapPiMessages,
  PiToAgUiEventAdapter,
} from "../src/agent-host/pi-ag-ui-adapter.js";
import {
  AGENT_UI_CUSTOM_EVENT,
  agentUiEventSchema,
} from "../src/shared/agent-ui.js";

type PiAssistantMessage = Extract<
  AgentSession["messages"][number],
  { role: "assistant" }
>;
type PiToolCall = Extract<
  PiAssistantMessage["content"][number],
  { type: "toolCall" }
>;

const temporaryDirectories: string[] = [];

function createSessionDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "desktop-agent-pi-session-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Pi Agent SDK integration", () => {
  it("creates a persistent Pi session with all sandboxed built-in tools", async () => {
    const sessionDir = createSessionDirectory();
    const session = await new PiAgentSessionFactory().create({
      cwd: process.cwd(),
      model: { provider: "anthropic", id: "claude-opus-4-5" },
      accessMode: "auto",
      interactionMode: "agent",
      apiKeys: { anthropic: "test-key" },
      sessionDir,
    }, async () => false);

    expect(session.sessionId).not.toHaveLength(0);
    expect(session.sessionFile.startsWith(sessionDir)).toBe(true);
    await session.dispose();
  });

  it("applies, clamps, and restores the selected thinking level", async () => {
    const sessionDir = createSessionDirectory();
    const created = await new PiAgentSessionFactory().create(
      {
        cwd: process.cwd(),
        model: { provider: "xai", id: "grok-4.6" },
        thinkingLevel: "xhigh",
        accessMode: "auto",
        interactionMode: "agent",
        apiKeys: { xai: "test-key" },
        sessionDir,
      },
      async () => false,
    );
    const { sessionFile } = created;

    expect(created.thinkingLevel).toBe("high");
    await created.dispose();

    const stored = SessionManager.open(
      sessionFile,
      sessionDir,
      process.cwd(),
    );
    stored.appendMessage({
      role: "user",
      content: "Stored prompt",
      timestamp: Date.now(),
    });

    const reopened = await new PiAgentSessionFactory().create(
      {
        cwd: process.cwd(),
        model: { provider: "xai", id: "grok-4.6" },
        accessMode: "auto",
        interactionMode: "agent",
        apiKeys: { xai: "test-key" },
        sessionDir,
        sessionFile,
      },
      async () => false,
    );
    expect(reopened.thinkingLevel).toBe("high");
    await reopened.dispose();
  });

  it("reopens a new session before an assistant response", async () => {
    const sessionDir = createSessionDirectory();
    const created = await new PiAgentSessionFactory().create(
      {
        cwd: process.cwd(),
        model: { provider: "anthropic", id: "claude-opus-4-5" },
        accessMode: "auto",
        interactionMode: "agent",
        apiKeys: { anthropic: "test-key" },
        sessionDir,
      },
      async () => false,
    );
    const { sessionId, sessionFile } = created;

    expect(existsSync(sessionFile)).toBe(true);
    await created.dispose();

    const reopened = await new PiAgentSessionFactory().create(
      {
        cwd: process.cwd(),
        accessMode: "auto",
        interactionMode: "agent",
        apiKeys: { anthropic: "test-key" },
        sessionDir,
        sessionFile,
      },
      async () => false,
    );

    expect(reopened.sessionId).toBe(sessionId);
    await reopened.dispose();
  });

  it("recovers a stored session reference whose file is missing", async () => {
    const sessionDir = createSessionDirectory();
    const sessionId = "stored-session";
    const sessionFile = join(sessionDir, "missing-session.jsonl");

    const recovered = await new PiAgentSessionFactory().create(
      {
        cwd: process.cwd(),
        model: { provider: "anthropic", id: "claude-opus-4-5" },
        accessMode: "auto",
        interactionMode: "agent",
        apiKeys: { anthropic: "test-key" },
        sessionDir,
        sessionId,
        sessionFile,
      },
      async () => false,
    );

    expect(recovered.sessionId).toBe(sessionId);
    expect(existsSync(sessionFile)).toBe(true);
    await recovered.dispose();
  });

  it("creates Plan sessions with only read-only tools and todo_write", async () => {
    const sessionDir = createSessionDirectory();
    const session = await new PiAgentSessionFactory().create(
      {
        cwd: process.cwd(),
        model: { provider: "anthropic", id: "claude-opus-4-5" },
        accessMode: "auto",
        interactionMode: "plan",
        apiKeys: { anthropic: "test-key" },
        sessionDir,
      },
      async () => false,
    );

    expect(session.interactionMode).toBe("plan");
    await session.dispose();
  });

  it("reopens an existing Pi session", async () => {
    const sessionDir = createSessionDirectory();
    const stored = SessionManager.create(process.cwd(), sessionDir);
    stored.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Stored response" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-opus-4-5",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const sessionFile = stored.getSessionFile();
    if (sessionFile === undefined) {
      throw new Error("Expected a persistent Pi session file");
    }
    expect(existsSync(sessionFile)).toBe(true);

    const session = await new PiAgentSessionFactory().create({
      cwd: process.cwd(),
      model: { provider: "xai", id: "grok-4.6" },
      accessMode: "auto",
      interactionMode: "agent",
      apiKeys: { anthropic: "test-key", xai: "test-xai-key" },
      sessionDir,
      sessionFile,
    }, async () => false);

    expect(session.sessionId).toBe(stored.getSessionId());
    expect(session.sessionFile).toBe(sessionFile);
    expect(session.model).toEqual({ provider: "xai", id: "grok-4.6" });
    expect(session.messages).toEqual([
      {
        id: `${stored.getSessionId()}:history:0`,
        role: "assistant",
        content: "Stored response",
      },
    ]);
    await session.dispose();

    const persisted = SessionManager.open(sessionFile, sessionDir, process.cwd());
    expect(persisted.buildSessionContext().model).toEqual({
      provider: "xai",
      modelId: "grok-4.6",
    });
  });

  it("maps a Pi assistant stream to AG-UI message events", () => {
    const timestamp = 1_000;
    const message = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "hello" }],
      api: "anthropic-messages" as const,
      provider: "anthropic",
      model: "claude-opus-4-5",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp,
    };
    const adapter = new PiToAgUiEventAdapter("session-test");
    adapter.map({ type: "message_start", message });
    const events = adapter.map({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "hello",
        partial: message,
      },
    });

    expect(events).toEqual([
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "session-test:assistant:1000",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "session-test:assistant:1000",
        delta: "hello",
      },
    ]);
  });

  it("maps delivered Pi user messages to AG-UI message events", () => {
    const adapter = new PiToAgUiEventAdapter("session-test");
    const message = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Queued follow-up" }],
      timestamp: 1_500,
    };

    expect(adapter.map({ type: "message_start", message })).toEqual([
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "session-test:user:1500",
        role: "user",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "session-test:user:1500",
        delta: "Queued follow-up",
      },
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "session-test:user:1500",
      },
    ]);
  });

  it("maps authoritative Pi queue snapshots to AG-UI", () => {
    const adapter = new PiToAgUiEventAdapter("session-test");

    expect(
      adapter.map({
        type: "queue_update",
        steering: ["Change direction"],
        followUp: ["Check afterward"],
      }),
    ).toEqual([
      {
        type: EventType.CUSTOM,
        name: AGENT_UI_CUSTOM_EVENT.PI_QUEUE_UPDATED,
        value: {
          steering: ["Change direction"],
          followUp: ["Check afterward"],
        },
      },
    ]);
  });

  it("maps Pi reasoning, tools, and retry state to valid AG-UI events", () => {
    const toolCall: PiToolCall = {
      type: "toolCall",
      id: "tool-1",
      name: "read",
      arguments: { path: "README.md" },
    };
    const message: PiAssistantMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Inspect the file" },
        toolCall,
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-opus-4-5",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2_000,
    };
    const adapter = new PiToAgUiEventAdapter("session-test");
    const piEvents: AgentSessionEvent[] = [
      { type: "message_start", message },
      {
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "Inspect the file",
          partial: message,
        },
      },
      {
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "thinking_end",
          contentIndex: 0,
          content: "Inspect the file",
          partial: message,
        },
      },
      {
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 1,
          partial: message,
        },
      },
      {
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 1,
          delta: '{"path":"README.md"}',
          partial: message,
        },
      },
      {
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 1,
          toolCall,
          partial: message,
        },
      },
      { type: "message_end", message },
      {
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "README.md" },
      },
      {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 250,
        errorMessage: "Connection error",
      },
    ];

    const events = piEvents.flatMap((event) => adapter.map(event));

    expect(events.map((event) => event.type)).toEqual([
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.CUSTOM,
    ]);
    expect(events.at(-1)).toMatchObject({
      type: EventType.CUSTOM,
      name: AGENT_UI_CUSTOM_EVENT.PI_RETRY_SCHEDULED,
      value: { attempt: 1, maxAttempts: 3 },
    });
    for (const event of events) {
      expect(agentUiEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("maps Pi tool execution progress and its final result to AG-UI", () => {
    const adapter = new PiToAgUiEventAdapter("session-test");
    const partialResult = {
      content: [{ type: "text" as const, text: "partial output" }],
      details: undefined,
    };
    const finalResult = {
      content: [{ type: "text" as const, text: "final output" }],
      details: undefined,
    };
    const toolResultMessage = {
      role: "toolResult" as const,
      toolCallId: "tool-1",
      toolName: "bash",
      content: finalResult.content,
      details: undefined,
      isError: false,
      timestamp: 3_000,
    };

    const events = [
      ...adapter.map({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "printf hello" },
      }),
      ...adapter.map({
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "printf hello" },
        partialResult,
      }),
      ...adapter.map({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "bash",
        result: finalResult,
        isError: false,
      }),
      ...adapter.map({ type: "message_end", message: toolResultMessage }),
    ];

    expect(events.map((event) => event.type)).toEqual([
      EventType.ACTIVITY_SNAPSHOT,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.TOOL_CALL_RESULT,
    ]);
    expect(events).toMatchObject([
      { content: { toolCallId: "tool-1", status: "running" } },
      {
        content: {
          toolCallId: "tool-1",
          partialResult,
          status: "running",
        },
      },
      { content: { toolCallId: "tool-1", status: "succeeded" } },
      { toolCallId: "tool-1", content: "final output" },
    ]);
    for (const event of events) {
      expect(agentUiEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("normalizes finalized Pi transcript messages", () => {
    expect(
      mapPiMessages(
        [
          {
            role: "user",
            content: [{ type: "text", text: "Prompt" }],
            timestamp: 1,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Response" }],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "claude-opus-4-5",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 2,
          },
        ],
        "session-test",
      ),
    ).toEqual([
      { id: "session-test:history:0", role: "user", content: "Prompt" },
      {
        id: "session-test:history:1",
        role: "assistant",
        content: "Response",
      },
    ]);
  });
});
