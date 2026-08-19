import { describe, expect, it } from "vitest";

import {
  todoEditInputSchema,
  todoEditOperationSchema,
} from "./todo";

describe("todo schemas", () => {
  it("separates task-scoped IPC input from strict host operations", () => {
    expect(
      todoEditInputSchema.parse({
        taskId: "task-1",
        action: "set_status",
        itemId: "todo-1",
        status: "completed",
      }),
    ).toEqual({
      taskId: "task-1",
      action: "set_status",
      itemId: "todo-1",
      status: "completed",
    });
    expect(
      todoEditOperationSchema.safeParse({
        taskId: "task-1",
        action: "delete",
        itemId: "todo-1",
      }).success,
    ).toBe(false);
    expect(
      todoEditInputSchema.parse({
        taskId: "task-1",
        action: "archive",
      }),
    ).toEqual({ taskId: "task-1", action: "archive" });
  });

  it("requires a reason only for blocked status", () => {
    expect(
      todoEditInputSchema.safeParse({
        taskId: "task-1",
        action: "set_status",
        itemId: "todo-1",
        status: "blocked",
      }).success,
    ).toBe(false);
    expect(
      todoEditInputSchema.safeParse({
        taskId: "task-1",
        action: "set_status",
        itemId: "todo-1",
        status: "blocked",
        blockedReason: "Waiting for access",
      }).success,
    ).toBe(true);
  });
});
