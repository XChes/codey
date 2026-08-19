import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL,
  DEFAULT_THINKING_LEVEL,
} from "./models";
import {
  taskConversationProjectionSchema,
  taskCreateInputSchema,
  taskInteractionModeUpdateInputSchema,
  taskStartInputSchema,
} from "./task";

describe("task interaction mode schemas", () => {
  it("defaults new conversations to Agent mode", () => {
    expect(
      taskCreateInputSchema.parse({
        title: "Build",
        workspaceId: "workspace-1",
        executionTarget: "local",
      }).interactionMode,
    ).toBe("agent");
  });

  it("accepts only strict Agent or Plan mode updates", () => {
    expect(
      taskInteractionModeUpdateInputSchema.parse({
        taskId: "task-1",
        interactionMode: "plan",
      }),
    ).toEqual({ taskId: "task-1", interactionMode: "plan" });
    expect(() =>
      taskInteractionModeUpdateInputSchema.parse({
        taskId: "task-1",
        interactionMode: "execute",
      }),
    ).toThrow();
    expect(() =>
      taskInteractionModeUpdateInputSchema.parse({
        taskId: "task-1",
        interactionMode: "agent",
        extra: true,
      }),
    ).toThrow();
  });
});

describe("task thinking level schemas", () => {
  it("requires a valid thinking level when starting a task", () => {
    expect(
      taskStartInputSchema.parse({
        taskId: "task-1",
        text: "Build",
        model: DEFAULT_MODEL,
        thinkingLevel: "high",
      }),
    ).toEqual({
      taskId: "task-1",
      text: "Build",
      model: DEFAULT_MODEL,
      thinkingLevel: "high",
    });
    expect(() =>
      taskStartInputSchema.parse({
        taskId: "task-1",
        text: "Build",
        model: DEFAULT_MODEL,
        thinkingLevel: "extreme",
      }),
    ).toThrow();
  });

  it("defaults legacy conversation projections to Medium", () => {
    expect(
      taskConversationProjectionSchema.parse({
        model: DEFAULT_MODEL,
        messages: [],
        todo: null,
        userEntries: [],
      }).thinkingLevel,
    ).toBe(DEFAULT_THINKING_LEVEL);
  });
});
