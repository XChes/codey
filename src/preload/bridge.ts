import type { DesktopBridge } from "../shared/desktop-bridge";
import { IPC_CHANNELS } from "../shared/ipc";
import {
  taskEventEnvelopeSchema,
  taskPermissionRequestEnvelopeSchema,
  taskRuntimeStateEnvelopeSchema,
} from "../shared/task";
import { fileChangeEnvelopeSchema } from "../shared/files";
import { reviewChangeEnvelopeSchema } from "../shared/review";
import {
  providerCredentialDeleteInputSchema,
  providerCredentialSetInputSchema,
  providerCredentialStatusesSchema,
  providerCredentialStatusSchema,
} from "../shared/provider-credentials";

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;
type Subscribe = (
  channel: string,
  listener: (payload: unknown) => void,
) => () => void;

export function createDesktopBridge(
  invoke: Invoke,
  subscribe: Subscribe,
): DesktopBridge {
  return {
    workspace: {
      list: () =>
        invoke(IPC_CHANNELS.workspaceList) as ReturnType<
          DesktopBridge["workspace"]["list"]
        >,
      choose: () =>
        invoke(IPC_CHANNELS.workspaceChoose) as ReturnType<
          DesktopBridge["workspace"]["choose"]
        >,
      create: (input) =>
        invoke(IPC_CHANNELS.workspaceCreate, input) as ReturnType<
          DesktopBridge["workspace"]["create"]
        >,
      activate: (input) =>
        invoke(IPC_CHANNELS.workspaceActivate, input) as ReturnType<
          DesktopBridge["workspace"]["activate"]
        >,
      listGitHubRepositories: () =>
        invoke(IPC_CHANNELS.workspaceGitHubList) as ReturnType<
          DesktopBridge["workspace"]["listGitHubRepositories"]
        >,
      cloneGitHub: (input) =>
        invoke(IPC_CHANNELS.workspaceGitHubClone, input) as ReturnType<
          DesktopBridge["workspace"]["cloneGitHub"]
        >,
    },
    settings: {
      get: () => invoke(IPC_CHANNELS.settingsGet) as ReturnType<DesktopBridge["settings"]["get"]>,
      update: (input) => invoke(IPC_CHANNELS.settingsUpdate, input) as ReturnType<DesktopBridge["settings"]["update"]>,
    },
    credentials: {
      list: async () =>
        providerCredentialStatusesSchema.parse(
          await invoke(IPC_CHANNELS.credentialsList),
        ),
      set: async (input) =>
        providerCredentialStatusSchema.parse(
          await invoke(
            IPC_CHANNELS.credentialsSet,
            providerCredentialSetInputSchema.parse(input),
          ),
        ),
      delete: async (input) =>
        providerCredentialStatusSchema.parse(
          await invoke(
            IPC_CHANNELS.credentialsDelete,
            providerCredentialDeleteInputSchema.parse(input),
          ),
        ),
    },
    task: {
      list: () =>
        invoke(IPC_CHANNELS.taskList) as ReturnType<
          DesktopBridge["task"]["list"]
        >,
      create: (input) =>
        invoke(IPC_CHANNELS.taskCreate, input) as ReturnType<
          DesktopBridge["task"]["create"]
        >,
      open: (input) =>
        invoke(IPC_CHANNELS.taskOpen, input) as ReturnType<
          DesktopBridge["task"]["open"]
        >,
      activate: (input) =>
        invoke(IPC_CHANNELS.taskActivate, input) as ReturnType<
          DesktopBridge["task"]["activate"]
        >,
      updateAccessMode: (input) =>
        invoke(IPC_CHANNELS.taskAccessModeUpdate, input) as ReturnType<
          DesktopBridge["task"]["updateAccessMode"]
        >,
      updateInteractionMode: (input) =>
        invoke(IPC_CHANNELS.taskInteractionModeUpdate, input) as ReturnType<
          DesktopBridge["task"]["updateInteractionMode"]
        >,
      decidePermission: (input) =>
        invoke(IPC_CHANNELS.taskPermissionDecide, input) as ReturnType<
          DesktopBridge["task"]["decidePermission"]
        >,
      start: (input) =>
        invoke(IPC_CHANNELS.taskStart, input) as ReturnType<
          DesktopBridge["task"]["start"]
        >,
      steer: (input) =>
        invoke(IPC_CHANNELS.taskSteer, input) as ReturnType<
          DesktopBridge["task"]["steer"]
        >,
      followUp: (input) =>
        invoke(IPC_CHANNELS.taskFollowUp, input) as ReturnType<
          DesktopBridge["task"]["followUp"]
        >,
      clearQueue: (input) =>
        invoke(IPC_CHANNELS.taskClearQueue, input) as ReturnType<
          DesktopBridge["task"]["clearQueue"]
        >,
      cancel: (input) =>
        invoke(IPC_CHANNELS.taskCancel, input) as ReturnType<
          DesktopBridge["task"]["cancel"]
        >,
      onEvent: (listener) =>
        subscribe(IPC_CHANNELS.taskEvent, (payload) => {
          const envelope = taskEventEnvelopeSchema.safeParse(payload);
          if (envelope.success) {
            listener(envelope.data);
          }
        }),
      onRuntimeState: (listener) =>
        subscribe(IPC_CHANNELS.taskRuntimeState, (payload) => {
          const envelope = taskRuntimeStateEnvelopeSchema.safeParse(payload);
          if (envelope.success) {
            listener(envelope.data);
          }
        }),
      onPermissionRequest: (listener) =>
        subscribe(IPC_CHANNELS.taskPermissionRequest, (payload) => {
          const envelope = taskPermissionRequestEnvelopeSchema.safeParse(payload);
          if (envelope.success) {
            listener(envelope.data);
          }
        }),
    },
    files: {
      list: (input) =>
        invoke(IPC_CHANNELS.filesList, input) as ReturnType<
          DesktopBridge["files"]["list"]
        >,
      read: (input) =>
        invoke(IPC_CHANNELS.filesRead, input) as ReturnType<
          DesktopBridge["files"]["read"]
        >,
      onChanged: (listener) =>
        subscribe(IPC_CHANNELS.filesChanged, (payload) => {
          const envelope = fileChangeEnvelopeSchema.safeParse(payload);
          if (envelope.success) listener(envelope.data);
        }),
    },
    review: {
      snapshot: (input) =>
        invoke(IPC_CHANNELS.reviewSnapshot, input) as ReturnType<
          DesktopBridge["review"]["snapshot"]
        >,
      file: (input) =>
        invoke(IPC_CHANNELS.reviewFile, input) as ReturnType<
          DesktopBridge["review"]["file"]
        >,
      keep: (input) =>
        invoke(IPC_CHANNELS.reviewKeep, input) as ReturnType<
          DesktopBridge["review"]["keep"]
        >,
      undo: (input) =>
        invoke(IPC_CHANNELS.reviewUndo, input) as ReturnType<
          DesktopBridge["review"]["undo"]
        >,
      onChanged: (listener) =>
        subscribe(IPC_CHANNELS.reviewChanged, (payload) => {
          const envelope = reviewChangeEnvelopeSchema.safeParse(payload);
          if (envelope.success) listener(envelope.data);
        }),
    },
    todo: {
      edit: (input) =>
        invoke(IPC_CHANNELS.todoEdit, input) as ReturnType<
          DesktopBridge["todo"]["edit"]
        >,
    },
  };
}
