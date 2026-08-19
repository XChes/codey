import type { AppSettings, SettingsUpdate } from "./settings";
import type {
  GitHubCloneInput,
  GitHubRepository,
  WorkspaceCreateInput,
  WorkspaceInfo,
  WorkspaceTargetInput,
} from "./workspace";
import type { TodoEditInput, TodoEditResult } from "./todo";
import type {
  FileChangeEnvelope,
  FileContent,
  FileListInput,
  FileListResult,
  FileReadInput,
} from "./files";
import type {
  ReviewActionInput,
  ReviewChangeEnvelope,
  ReviewFileDetail,
  ReviewFileInput,
  ReviewSnapshot,
  ReviewSnapshotInput,
} from "./review";
import type {
  ProviderCredentialDeleteInput,
  ProviderCredentialSetInput,
  ProviderCredentialStatus,
} from "./provider-credentials";
import type {
  TaskActivateResult,
  TaskAccessModeUpdateInput,
  TaskCancelResult,
  TaskClearQueueResult,
  TaskCreateInput,
  TaskCreateResult,
  TaskEventEnvelope,
  TaskFollowUpResult,
  TaskOpenInput,
  TaskInteractionModeUpdateInput,
  TaskPermissionDecisionInput,
  TaskPermissionDecisionResult,
  TaskPermissionRequestEnvelope,
  TaskSnapshot,
  TaskStartResult,
  TaskStartInput,
  TaskSteerResult,
  TaskSummary,
  TaskRuntimeStateEnvelope,
  TaskTargetInput,
  TaskTextInput,
} from "./task";

export interface DesktopBridge {
  workspace: {
    list(): Promise<WorkspaceInfo[]>;
    choose(): Promise<WorkspaceInfo | null>;
    create(input: WorkspaceCreateInput): Promise<WorkspaceInfo | null>;
    activate(input: WorkspaceTargetInput): Promise<WorkspaceInfo>;
    listGitHubRepositories(): Promise<GitHubRepository[]>;
    cloneGitHub(input: GitHubCloneInput): Promise<WorkspaceInfo | null>;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(input: SettingsUpdate): Promise<AppSettings>;
  };
  credentials: {
    list(): Promise<ProviderCredentialStatus[]>;
    set(input: ProviderCredentialSetInput): Promise<ProviderCredentialStatus>;
    delete(
      input: ProviderCredentialDeleteInput,
    ): Promise<ProviderCredentialStatus>;
  };
  task: {
    list(): Promise<TaskSummary[]>;
    create(input: TaskCreateInput): Promise<TaskCreateResult>;
    open(input: TaskOpenInput): Promise<TaskSnapshot>;
    activate(input: TaskTargetInput): Promise<TaskActivateResult>;
    updateAccessMode(input: TaskAccessModeUpdateInput): Promise<TaskSummary>;
    updateInteractionMode(
      input: TaskInteractionModeUpdateInput,
    ): Promise<TaskSummary>;
    decidePermission(
      input: TaskPermissionDecisionInput,
    ): Promise<TaskPermissionDecisionResult>;
    start(input: TaskStartInput): Promise<TaskStartResult>;
    steer(input: TaskTextInput): Promise<TaskSteerResult>;
    followUp(input: TaskTextInput): Promise<TaskFollowUpResult>;
    clearQueue(input: TaskTargetInput): Promise<TaskClearQueueResult>;
    cancel(input: TaskTargetInput): Promise<TaskCancelResult>;
    onEvent(listener: (envelope: TaskEventEnvelope) => void): () => void;
    onRuntimeState(
      listener: (envelope: TaskRuntimeStateEnvelope) => void,
    ): () => void;
    onPermissionRequest(
      listener: (envelope: TaskPermissionRequestEnvelope) => void,
    ): () => void;
  };
  files: {
    list(input: FileListInput): Promise<FileListResult>;
    read(input: FileReadInput): Promise<FileContent>;
    onChanged(listener: (envelope: FileChangeEnvelope) => void): () => void;
  };
  review: {
    snapshot(input: ReviewSnapshotInput): Promise<ReviewSnapshot>;
    file(input: ReviewFileInput): Promise<ReviewFileDetail>;
    keep(input: ReviewActionInput): Promise<ReviewSnapshot>;
    undo(input: ReviewActionInput): Promise<ReviewSnapshot>;
    onChanged(listener: (envelope: ReviewChangeEnvelope) => void): () => void;
  };
  todo: {
    edit(input: TodoEditInput): Promise<TodoEditResult>;
  };
}
