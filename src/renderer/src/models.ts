export type { TaskRuntimeState, TaskStatus } from "../../shared/task";
export type { AgentStatus } from "../../shared/agent";

import type {
  TaskAccessMode,
  TaskExecutionTarget,
  TaskInteractionMode,
  TaskRuntimeState,
  TaskStatus,
} from "../../shared/task";
import type {
  SupportedModelSelection,
  ThinkingLevel,
} from "../../shared/models";
import type { WorkspaceInfo } from "../../shared/workspace";
import type { ConversationTodoState } from "../../shared/todo";
import type {
  AgentCapability,
  AgentRole,
  AgentStatus,
} from "../../shared/agent";

export type ToolStatus = "pending" | "running" | "succeeded" | "failed";

export type ActivityItem =
  | {
      id: string;
      kind: "user-message";
      text: string;
    }
  | { id: string; kind: "assistant-message"; text: string; streaming: boolean }
  | { id: string; kind: "reasoning"; text: string; streaming: boolean }
  | { id: string; kind: "status"; text: string }
  | {
      id: string;
      kind: "tool";
      title: string;
      status: ToolStatus;
      input?: string;
      output?: string;
    };

export interface AgentActivityViewModel {
  id: string;
  role: AgentRole;
  profileId: string | null;
  capability: AgentCapability;
  status: AgentStatus;
  assignment: string | null;
  activity: ActivityItem[];
}

export interface TaskViewModel {
  id: string | null;
  title: string;
  status: TaskStatus;
  runtimeState: TaskRuntimeState;
  executionTarget: TaskExecutionTarget;
  accessMode: TaskAccessMode;
  interactionMode: TaskInteractionMode;
  branch: string | null;
  workspace: WorkspaceInfo | null;
  model: SupportedModelSelection;
  thinkingLevel: ThinkingLevel;
  draft: string;
  queue: {
    steering: string[];
    followUp: string[];
  };
  todo: ConversationTodoState | null;
  activity: ActivityItem[];
  agents: AgentActivityViewModel[];
  selectedAgentId: string | null;
}
