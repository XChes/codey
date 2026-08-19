import { ConversationTodos } from "../agent-host/conversation-todo-state";
import type { TodoEditOperation, TodoEditResult } from "../shared/todo";
import type { StoredTask } from "./app-store";

export class PiSessionTodoStore {
  async edit(
    task: StoredTask,
    input: TodoEditOperation,
  ): Promise<TodoEditResult> {
    const reference = task.sessionReference;
    if (reference === undefined) {
      throw new Error("A conversation must be started before editing its todos");
    }
    const { SessionManager } = await import(
      "@earendil-works/pi-coding-agent"
    );
    const sessionManager = SessionManager.open(
      reference.sessionFile,
      undefined,
      task.executionPath,
    );
    if (sessionManager.getSessionId() !== reference.sessionId) {
      throw new Error("Pi session ID does not match its stored reference");
    }
    const todo = new ConversationTodos(sessionManager).applyUserEdit(input);
    return { todo };
  }
}
