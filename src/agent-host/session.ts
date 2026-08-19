import type {
  AgentInitializeParams,
  AgentModelSelection,
  AgentTranscriptMessage,
} from "../shared/agent-host-protocol.js";
import type { AgentUiEvent } from "../shared/agent-ui.js";
import type {
  ConversationTodoState,
  TodoEditOperation,
} from "../shared/todo.js";
import type { ThinkingLevel } from "../shared/models.js";
import type { TaskPermissionRequest } from "../shared/task.js";
import type { TaskInteractionMode } from "../shared/task.js";
import type {
  Delegation,
  DelegationOperation,
  DelegationToolResult,
} from "../shared/agent.js";

export type AgentSessionEventListener = (event: AgentUiEvent) => void;
export type AgentPermissionRequestInput = Omit<TaskPermissionRequest, "id">;
export type AgentPermissionRequester = (
  request: AgentPermissionRequestInput,
) => Promise<boolean>;
export type AgentDelegationRequester = (
  operation: DelegationOperation,
) => Promise<DelegationToolResult>;

export interface AgentSessionPort {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly model: AgentModelSelection;
  readonly thinkingLevel: ThinkingLevel;
  readonly messages: AgentTranscriptMessage[];
  readonly userEntries: Array<{ entryId: string; text: string }>;
  readonly todo: ConversationTodoState | null;
  readonly interactionMode: TaskInteractionMode;
  prompt(text: string): Promise<{ userEntryId: string }>;
  updateTodo(input: TodoEditOperation): Promise<ConversationTodoState | null>;
  archiveTodo(): null;
  continueTodos(attempt: number, maxAttempts: number): Promise<void>;
  continueAfterAccess(): Promise<void>;
  deliverDelegationCompletion?(delegation: Delegation): Promise<void>;
  consumeAccessRestart(): boolean;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  clearQueue(): { steering: string[]; followUp: string[] };
  abort(): Promise<void>;
  subscribe(listener: AgentSessionEventListener): () => void;
  dispose(): Promise<void>;
}

export interface AgentSessionFactory {
  create(
    params: AgentInitializeParams,
    requestPermission: AgentPermissionRequester,
    requestDelegation?: AgentDelegationRequester,
  ): Promise<AgentSessionPort>;
}
