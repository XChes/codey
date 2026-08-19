import { randomUUID } from "node:crypto";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  conversationTodoStateSchema,
  TODO_TOOL_NAME,
  todoEditOperationSchema,
  todoToolDetailsSchema,
  todoWriteInputSchema,
  type ConversationTodoState,
  type TodoEditOperation,
  type TodoToolDetails,
  type TodoWriteInput,
} from "../shared/todo.js";

export const TODO_STATE_ENTRY_TYPE = "desktop-agent.todo-state";
export const TODO_CONTEXT_MESSAGE_TYPE = "desktop-agent.todo-context";
export const TODO_CONTINUATION_MESSAGE_TYPE = "desktop-agent.todo-continuation";

function cloneState(
  state: ConversationTodoState | null,
): ConversationTodoState | null {
  return state === null ? null : conversationTodoStateSchema.parse(state);
}

function stateFromDetails(
  value: unknown,
): ConversationTodoState | null | undefined {
  const parsed = todoToolDetailsSchema.safeParse(value);
  return parsed.success ? parsed.data.todo : undefined;
}

export function formatConversationTodoState(
  state: ConversationTodoState | null,
): string {
  if (state === null) return "The conversation todo list is empty.";
  const items = state.items
    .map((item) => {
      const reason =
        item.status === "blocked" ? ` — blocked: ${item.blockedReason}` : "";
      return `- [${item.status}] ${item.id}: ${item.content}${reason}`;
    })
    .join("\n");
  return `Todo list "${state.title}" (revision ${state.revision}):\n${items}`;
}

export class ConversationTodos {
  private state: ConversationTodoState | null = null;

  constructor(private readonly sessionManager: SessionManager) {
    this.reconstruct();
  }

  get current(): ConversationTodoState | null {
    return cloneState(this.state);
  }

  get hasActionableItems(): boolean {
    return (
      this.state?.items.some(
        (item) => item.status === "pending" || item.status === "in_progress",
      ) ?? false
    );
  }

  reconstruct(): ConversationTodoState | null {
    this.state = null;
    for (const entry of this.sessionManager.getBranch()) {
      let restored: ConversationTodoState | null | undefined;
      if (
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === TODO_TOOL_NAME
      ) {
        restored = stateFromDetails(entry.message.details);
      } else if (
        entry.type === "custom" &&
        entry.customType === TODO_STATE_ENTRY_TYPE
      ) {
        restored = stateFromDetails(entry.data);
      }
      if (restored !== undefined) this.state = cloneState(restored);
    }
    return this.current;
  }

  write(input: TodoWriteInput): TodoToolDetails {
    const value = todoWriteInputSchema.parse(input);
    const previousItems = this.state?.items ?? [];
    const usedIds = new Set<string>();
    const items = value.todos.map((item) => {
      const matchingId = previousItems.find(
        (candidate) =>
          candidate.content === item.content && !usedIds.has(candidate.id),
      )?.id;
      const id = item.id ?? matchingId ?? randomUUID();
      if (usedIds.has(id)) {
        throw new Error(`Duplicate todo ID: ${id}`);
      }
      usedIds.add(id);
      return {
        id,
        content: item.content,
        status: item.status,
        ...(item.status === "blocked"
          ? { blockedReason: item.blockedReason! }
          : {}),
      };
    });

    this.state =
      items.length === 0
        ? null
        : conversationTodoStateSchema.parse({
            revision: (this.state?.revision ?? 0) + 1,
            title: value.title,
            items,
          });
    return { todo: this.current };
  }

  applyUserEdit(input: TodoEditOperation): ConversationTodoState | null {
    const edit = todoEditOperationSchema.parse(input);
    const current = this.state;
    if (current === null) {
      throw new Error("This conversation has no todo list");
    }
    if (edit.action === "archive") return this.archive();

    let items = [...current.items];
    switch (edit.action) {
      case "add":
        items.push({
          id: randomUUID(),
          content: edit.content,
          status: "pending",
        });
        break;
      case "rename": {
        const index = items.findIndex((item) => item.id === edit.itemId);
        if (index === -1) throw new Error(`Todo does not exist: ${edit.itemId}`);
        items[index] = { ...items[index]!, content: edit.content };
        break;
      }
      case "delete":
        if (!items.some((item) => item.id === edit.itemId)) {
          throw new Error(`Todo does not exist: ${edit.itemId}`);
        }
        items = items.filter((item) => item.id !== edit.itemId);
        break;
      case "set_status": {
        const index = items.findIndex((item) => item.id === edit.itemId);
        if (index === -1) throw new Error(`Todo does not exist: ${edit.itemId}`);
        items[index] = {
          ...items[index]!,
          status: edit.status,
          ...(edit.status === "blocked"
            ? { blockedReason: edit.blockedReason! }
            : { blockedReason: undefined }),
        };
        break;
      }
    }

    this.state =
      items.length === 0
        ? null
        : conversationTodoStateSchema.parse({
            ...current,
            revision: current.revision + 1,
            items,
          });
    const details = { todo: this.current };
    this.sessionManager.appendCustomEntry(TODO_STATE_ENTRY_TYPE, details);
    return this.current;
  }

  archive(): null {
    this.state = null;
    this.sessionManager.appendCustomEntry(TODO_STATE_ENTRY_TYPE, { todo: null });
    return null;
  }

  contextMessage(): string {
    return [
      "The user-visible conversation todo state is authoritative.",
      formatConversationTodoState(this.state),
      "Use todo_write to preserve item IDs and update progress as work changes.",
      "Refresh the list with todo_write on every user turn while this goal remains relevant; write an empty list when it is obsolete.",
    ].join("\n\n");
  }

  continuationMessage(attempt: number, maxAttempts: number): string {
    return [
      `Continue working through the todo list (${attempt}/${maxAttempts}).`,
      formatConversationTodoState(this.state),
      "Do not finish while pending or in-progress items remain.",
      "Complete them, or mark genuinely impossible work blocked with a specific reason.",
    ].join("\n\n");
  }
}
