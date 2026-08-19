// @vitest-environment node

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  ConversationTodos,
  TODO_STATE_ENTRY_TYPE,
} from "./conversation-todo-state";
import { createConversationTodoTool } from "./conversation-todos";

function sessionManager(entries: unknown[] = []): SessionManager {
  return {
    getBranch: () => entries,
    appendCustomEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
      return `entry-${entries.length}`;
    },
  } as unknown as SessionManager;
}

describe("ConversationTodos", () => {
  it("creates snapshots with stable IDs and validates blocked items", () => {
    const todos = new ConversationTodos(sessionManager());
    const first = todos.write({
      title: "Build",
      todos: [{ content: "Implement host", status: "in_progress" }],
    }).todo!;
    const second = todos.write({
      title: "Build",
      todos: [
        { content: "Implement host", status: "completed" },
        {
          content: "Verify remote",
          status: "blocked",
          blockedReason: "No credentials",
        },
      ],
    }).todo!;

    expect(second.revision).toBe(2);
    expect(second.items[0]?.id).toBe(first.items[0]?.id);
    expect(() =>
      todos.write({
        title: "Invalid",
        todos: [{ content: "Missing reason", status: "blocked" }],
      }),
    ).toThrow();
  });

  it("persists semantic user edits and removes the card after the last deletion", () => {
    const entries: unknown[] = [];
    const todos = new ConversationTodos(sessionManager(entries));
    const initial = todos.write({
      title: "Build",
      todos: [{ content: "Implement host", status: "pending" }],
    }).todo!;

    const updated = todos.applyUserEdit({
      action: "set_status",
      itemId: initial.items[0]!.id,
      status: "completed",
    });

    expect(updated?.items[0]?.status).toBe("completed");
    expect(entries).toContainEqual({
      type: "custom",
      customType: TODO_STATE_ENTRY_TYPE,
      data: { todo: updated },
    });
    expect(
      todos.applyUserEdit({
        action: "delete",
        itemId: initial.items[0]!.id,
      }),
    ).toBeNull();
  });

  it("reconstructs the latest state on the active session branch", () => {
    const toolState = {
      revision: 1,
      title: "Build",
      items: [{ id: "one", content: "Implement host", status: "pending" }],
    };
    const userState = {
      revision: 2,
      title: "Build",
      items: [{ id: "one", content: "Implement host", status: "completed" }],
    };
    const entries = [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "todo_write",
          details: { todo: toolState },
        },
      },
      {
        type: "custom",
        customType: TODO_STATE_ENTRY_TYPE,
        data: { todo: userState },
      },
    ];

    expect(new ConversationTodos(sessionManager(entries)).current).toEqual(
      userState,
    );
    expect(
      new ConversationTodos(sessionManager(entries.slice(0, 1))).current,
    ).toEqual(toolState);
  });

  it("archives the live list while retaining earlier JSONL snapshots", () => {
    const entries: unknown[] = [];
    const todos = new ConversationTodos(sessionManager(entries));
    todos.write({
      title: "Old goal",
      todos: [{ content: "Obsolete work", status: "pending" }],
    });

    expect(todos.applyUserEdit({ action: "archive" })).toBeNull();
    expect(entries.at(-1)).toEqual({
      type: "custom",
      customType: TODO_STATE_ENTRY_TYPE,
      data: { todo: null },
    });
    expect(new ConversationTodos(sessionManager(entries)).current).toBeNull();
  });

  it("allows pending implementation steps in Plan mode guidance", () => {
    const tool = createConversationTodoTool(
      new ConversationTodos(sessionManager()),
      "plan",
    );

    expect(tool.promptGuidelines).toContain(
      "Keep proposed implementation steps pending because Plan mode does not execute them.",
    );
    expect(tool.promptGuidelines).not.toContain(
      "Never finish with pending or in-progress todos; complete them or mark genuinely blocked work with a reason.",
    );
  });
});
