import { EventType, type Message } from "@ag-ui/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ActivityItem,
  AgentActivityViewModel,
  TaskViewModel,
} from "@/models";
import {
  AGENT_UI_CUSTOM_EVENT,
  type AgentUiEvent,
} from "../../../shared/agent-ui";
import {
  clampThinkingLevel,
  DEFAULT_THINKING_LEVEL,
  DEFAULT_MODEL,
  type SupportedModelSelection,
  type ThinkingLevel,
} from "../../../shared/models";
import {
  DEFAULT_TASK_ACCESS_MODE,
  type TaskAccessMode,
  type TaskExecutionTarget,
  type TaskInteractionMode,
  type TaskPermissionRequestEnvelope,
  type TaskSnapshot,
  type TaskRuntimeState,
  type TaskStatus,
  type TaskSummary,
} from "../../../shared/task";
import type {
  GitHubRepository,
  WorkspaceInfo,
} from "../../../shared/workspace";
import {
  TODO_TOOL_NAME,
  todoToolDetailsSchema,
  type TodoEditInput,
  type TodoEditOperation,
} from "../../../shared/todo";
import type { AgentStatus, AgentSummary } from "../../../shared/agent";

const NEW_TASK_KEY = "new";

const INITIAL_TASK: TaskViewModel = {
  id: null,
  title: "New conversation",
  status: "idle",
  runtimeState: "cold",
  executionTarget: "local",
  accessMode: DEFAULT_TASK_ACCESS_MODE,
  interactionMode: "agent",
  branch: null,
  workspace: null,
  model: DEFAULT_MODEL,
  thinkingLevel: DEFAULT_THINKING_LEVEL,
  draft: "",
  queue: { steering: [], followUp: [] },
  todo: null,
  activity: [],
  agents: [],
  selectedAgentId: null,
};

function taskForWorkspace(workspace: WorkspaceInfo): TaskViewModel {
  return {
    ...INITIAL_TASK,
    executionTarget: "local",
    branch: workspace.branch,
    workspace,
  };
}

function taskFromSummary(
  task: TaskSummary,
  model: SupportedModelSelection = DEFAULT_MODEL,
  thinkingLevel: ThinkingLevel = clampThinkingLevel(
    model,
    DEFAULT_THINKING_LEVEL,
  ),
): TaskViewModel {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    runtimeState: "cold",
    executionTarget: task.executionTarget,
    accessMode: task.accessMode,
    interactionMode: task.interactionMode,
    branch: task.branch,
    workspace: task.workspace,
    model,
    thinkingLevel: clampThinkingLevel(model, thinkingLevel),
    draft: "",
    queue: { steering: [], followUp: [] },
    todo: null,
    activity: [],
    agents: [],
    selectedAgentId: null,
  };
}

function taskFromSnapshot(snapshot: TaskSnapshot): TaskViewModel {
  const agents: AgentActivityViewModel[] = (snapshot.agents ?? []).map(
    ({ agent, projection }) => ({
      id: agent.id,
      role: agent.role,
      profileId: agent.profileId,
      capability: agent.capability,
      status: agent.status,
      assignment: agent.assignment,
      activity: activityFromMessages(projection.messages),
    }),
  );
  const lead = agents.find((agent) => agent.role === "lead");
  return {
    ...taskFromSummary(
      snapshot.task,
      snapshot.model,
      snapshot.thinkingLevel,
    ),
    todo: snapshot.todo,
    activity: activityFromMessages(snapshot.messages),
    agents,
    selectedAgentId: lead?.id ?? null,
  };
}

function userContentText(message: Extract<Message, { role: "user" }>): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((content) => {
      if (content.type === "text") return content.text;
      if (content.type === "binary") return content.filename ?? `[${content.mimeType}]`;
      if ("source" in content) return `[${content.type}: ${content.source.mimeType ?? "media"}]`;
      return "";
    })
    .join("");
}

function updateAssistantById(
  activity: ActivityItem[],
  messageId: string,
  update: (item: Extract<ActivityItem, { kind: "assistant-message" }>) => ActivityItem,
): ActivityItem[] {
  return activity.map((item) =>
    item.kind === "assistant-message" && item.id === messageId
      ? update(item)
      : item,
  );
}

function updateReasoningById(
  activity: ActivityItem[],
  messageId: string,
  update: (item: Extract<ActivityItem, { kind: "reasoning" }>) => ActivityItem,
): ActivityItem[] {
  return activity.map((item) =>
    item.kind === "reasoning" && item.id === messageId ? update(item) : item,
  );
}

function appendTextMessageContent(
  activity: ActivityItem[],
  messageId: string,
  delta: string,
): ActivityItem[] {
  const item = activity.find(
    (candidate) =>
      (candidate.kind === "assistant-message" ||
        candidate.kind === "user-message") &&
      candidate.id === messageId,
  );
  if (item === undefined) return activity;
  if (item.kind === "assistant-message") {
    return updateAssistantById(activity, messageId, (message) => ({
      ...message,
      text: message.text + delta,
    }));
  }
  if (item.kind !== "user-message") return activity;

  const text = item.text + delta;
  const duplicatesOptimisticMessage = activity.some(
    (candidate) =>
      candidate.kind === "user-message" &&
      candidate.id !== messageId &&
      candidate.id.startsWith("local:user:") &&
      candidate.text === text,
  );
  if (duplicatesOptimisticMessage) {
    return activity.filter((candidate) => candidate.id !== messageId);
  }
  return activity.map((candidate) =>
    candidate.kind === "user-message" && candidate.id === messageId
      ? { ...candidate, text }
      : candidate,
  );
}

function updateTool(
  activity: ActivityItem[],
  toolCallId: string,
  update: (item: Extract<ActivityItem, { kind: "tool" }>) => ActivityItem,
): ActivityItem[] {
  const id = `tool:${toolCallId}`;
  return activity.map((item) =>
    item.kind === "tool" && item.id === id ? update(item) : item,
  );
}

function finalizeStreaming(activity: ActivityItem[]): ActivityItem[] {
  return activity.map((item) => {
    if (
      (item.kind === "assistant-message" || item.kind === "reasoning") &&
      item.streaming
    ) {
      return { ...item, streaming: false };
    }
    return item;
  });
}

function summary(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function activityFromMessages(messages: Message[]): ActivityItem[] {
  let activity: ActivityItem[] = [];
  const ignoredToolCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "user") {
      const text = userContentText(message);
      if (text.length > 0) {
        activity.push({ id: message.id, kind: "user-message", text });
      }
      continue;
    }
    if (message.role === "reasoning") {
      if (message.content.length > 0) {
        activity.push({
          id: message.id,
          kind: "reasoning",
          text: message.content,
          streaming: false,
        });
      }
      continue;
    }
    if (message.role === "assistant") {
      if (message.content !== undefined && message.content.length > 0) {
        activity.push({
          id: message.id,
          kind: "assistant-message",
          text: message.content,
          streaming: false,
        });
      }
      for (const toolCall of message.toolCalls ?? []) {
        if (toolCall.function.name === TODO_TOOL_NAME) {
          ignoredToolCallIds.add(toolCall.id);
          continue;
        }
        activity.push({
          id: `tool:${toolCall.id}`,
          kind: "tool",
          title: toolCall.function.name,
          status: "pending",
          input: toolCall.function.arguments,
        });
      }
      continue;
    }
    if (message.role === "tool") {
      if (ignoredToolCallIds.has(message.toolCallId)) continue;
      const id = `tool:${message.toolCallId}`;
      if (activity.some((item) => item.kind === "tool" && item.id === id)) {
        activity = updateTool(activity, message.toolCallId, (item) => ({
          ...item,
          status: message.error === undefined ? "succeeded" : "failed",
          output: message.content,
        }));
      } else {
        activity.push({
          id,
          kind: "tool",
          title: message.toolCallId,
          status: message.error === undefined ? "succeeded" : "failed",
          output: message.content,
        });
      }
    }
  }
  return activity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function queueFromValue(value: unknown): TaskViewModel["queue"] | undefined {
  if (!isRecord(value)) return undefined;
  const steering = value.steering;
  const followUp = value.followUp;
  if (
    !Array.isArray(steering) ||
    !steering.every((item) => typeof item === "string") ||
    !Array.isArray(followUp) ||
    !followUp.every((item) => typeof item === "string")
  ) {
    return undefined;
  }
  return { steering, followUp };
}

function applyToolActivity(
  task: TaskViewModel,
  event: Extract<AgentUiEvent, { type: EventType.ACTIVITY_SNAPSHOT }>,
): TaskViewModel {
  if (event.activityType !== "tool_execution") return task;
  const toolCallId = event.content.toolCallId;
  if (typeof toolCallId !== "string") return task;
  const status = event.content.status;
  const toolStatus =
    status === "failed"
      ? "failed"
      : status === "succeeded"
        ? "succeeded"
        : "running";
  const id = `tool:${toolCallId}`;
  const existing = task.activity.some(
    (item) => item.kind === "tool" && item.id === id,
  );
  const toolInput = summary(event.content.args);
  const toolOutput = summary(
    event.content.partialResult ?? event.content.result,
  );
  return {
    ...task,
    activity: existing
      ? updateTool(task.activity, toolCallId, (item) => ({
          ...item,
          status: toolStatus,
          ...(toolInput === undefined ? {} : { input: toolInput }),
          ...(toolOutput === undefined ? {} : { output: toolOutput }),
        }))
      : [
          ...task.activity,
          {
            id,
            kind: "tool",
            title:
              typeof event.content.toolName === "string"
                ? event.content.toolName
                : toolCallId,
            status: toolStatus,
            ...(toolInput === undefined ? {} : { input: toolInput }),
            ...(toolOutput === undefined ? {} : { output: toolOutput }),
          },
        ],
  };
}

function customStatusMessage(event: Extract<AgentUiEvent, { type: EventType.CUSTOM }>): string | undefined {
  if (!isRecord(event.value)) return undefined;
  if (event.name === AGENT_UI_CUSTOM_EVENT.PI_RETRY_SCHEDULED) {
    const attempt = event.value.attempt;
    const maxAttempts = event.value.maxAttempts;
    const message = event.value.message;
    if (typeof attempt === "number" && typeof maxAttempts === "number") {
      return `Retrying ${attempt}/${maxAttempts}${typeof message === "string" ? `: ${message}` : ""}`;
    }
  }
  if (
    event.name === AGENT_UI_CUSTOM_EVENT.PI_RETRY_FINISHED &&
    event.value.success === true
  ) {
    return "Connection restored";
  }
  if (event.name === AGENT_UI_CUSTOM_EVENT.PI_COMPACTION_STARTED) {
    return "Compacting context";
  }
  return undefined;
}

function applyTaskEvent(
  task: TaskViewModel,
  runId: string,
  event: AgentUiEvent,
): TaskViewModel {
  switch (event.type) {
    case EventType.RUN_STARTED:
      return {
        ...task,
        status: "running",
        runtimeState: "running",
      };
    case EventType.TEXT_MESSAGE_START:
      if (event.role === "user") {
        return {
          ...task,
          activity: [
            ...task.activity,
            { id: event.messageId, kind: "user-message", text: "" },
          ],
        };
      }
      if (event.role !== "assistant") return task;
      return {
        ...task,
        activity: [
          ...task.activity,
          {
            id: event.messageId,
            kind: "assistant-message",
            text: "",
            streaming: true,
          },
        ],
      };
    case EventType.TEXT_MESSAGE_CONTENT:
      return {
        ...task,
        activity: appendTextMessageContent(
          task.activity,
          event.messageId,
          event.delta,
        ),
      };
    case EventType.TEXT_MESSAGE_END:
      return {
        ...task,
        activity: updateAssistantById(task.activity, event.messageId, (item) => ({
          ...item,
          streaming: false,
        })),
      };
    case EventType.REASONING_MESSAGE_START:
      return {
        ...task,
        activity: [
          ...task.activity,
          {
            id: event.messageId,
            kind: "reasoning",
            text: "",
            streaming: true,
          },
        ],
      };
    case EventType.REASONING_MESSAGE_CONTENT:
      return {
        ...task,
        activity: updateReasoningById(
          task.activity,
          event.messageId,
          (item) => ({
            ...item,
            text: item.text + event.delta,
          }),
        ),
      };
    case EventType.REASONING_MESSAGE_END:
      return {
        ...task,
        activity: updateReasoningById(
          task.activity,
          event.messageId,
          (item) => ({
            ...item,
            streaming: false,
          }),
        ),
      };
    case EventType.TOOL_CALL_START:
      if (event.toolCallName === TODO_TOOL_NAME) return task;
      return {
        ...task,
        activity: [
          ...task.activity,
          {
            id: `tool:${event.toolCallId}`,
            kind: "tool",
            title: event.toolCallName,
            status: "pending",
          },
        ],
      };
    case EventType.TOOL_CALL_ARGS:
      return {
        ...task,
        activity: updateTool(task.activity, event.toolCallId, (item) => ({
          ...item,
          input: (item.input ?? "") + event.delta,
        })),
      };
    case EventType.ACTIVITY_SNAPSHOT:
      return applyToolActivity(task, event);
    case EventType.TOOL_CALL_RESULT: {
      const isError =
        isRecord(event.rawEvent) && event.rawEvent.isError === true;
      return {
        ...task,
        activity: updateTool(task.activity, event.toolCallId, (item) => ({
          ...item,
          status: isError ? "failed" : "succeeded",
          output: event.content,
        })),
      };
    }
    case EventType.RUN_FINISHED:
      return { ...task, status: "completed", runtimeState: "ready" };
    case EventType.RUN_ERROR:
      return {
        ...task,
        status: "failed",
        runtimeState: "cold",
        activity: [
          ...finalizeStreaming(task.activity),
          {
            id: `${runId}:status:failed`,
            kind: "status",
            text: event.message,
          },
        ],
      };
    case EventType.CUSTOM: {
      if (event.name === AGENT_UI_CUSTOM_EVENT.TODO_UPDATED) {
        const details = todoToolDetailsSchema.safeParse(event.value);
        return details.success ? { ...task, todo: details.data.todo } : task;
      }
      if (event.name === AGENT_UI_CUSTOM_EVENT.PI_QUEUE_UPDATED) {
        const queue = queueFromValue(event.value);
        return queue === undefined ? task : { ...task, queue };
      }
      if (event.name === AGENT_UI_CUSTOM_EVENT.RUN_CANCELLED) {
        return {
          ...task,
          status: "cancelled",
          runtimeState: "ready",
          activity: finalizeStreaming(task.activity),
        };
      }
      if (
        event.name === AGENT_UI_CUSTOM_EVENT.TODO_CONTINUATION_EXHAUSTED
      ) {
        return {
          ...task,
          activity: [
            ...task.activity,
            {
              id: `${runId}:status:todo-incomplete`,
              kind: "status",
              text: "Todo work remains after 3 continuation attempts. Review the list and tell the agent how to proceed.",
            },
          ],
        };
      }
      const message = customStatusMessage(event);
      if (message === undefined) return task;
      return {
        ...task,
        activity: [
          ...task.activity,
          {
            id: `${runId}:status:${task.activity.length}`,
            kind: "status",
            text: message,
          },
        ],
      };
    }
    default:
      return task;
  }
}

function statusForEvent(event: AgentUiEvent): TaskStatus | undefined {
  switch (event.type) {
    case EventType.RUN_STARTED:
      return "running";
    case EventType.RUN_FINISHED:
      return "completed";
    case EventType.RUN_ERROR:
      return "failed";
    case EventType.CUSTOM:
      return event.name === AGENT_UI_CUSTOM_EVENT.RUN_CANCELLED
        ? "cancelled"
        : undefined;
    default:
      return undefined;
  }
}

function agentStatusForEvent(event: AgentUiEvent): AgentStatus | undefined {
  return statusForEvent(event);
}

function applyAgentEvent(
  task: TaskViewModel,
  summary: AgentSummary,
  runId: string,
  event: AgentUiEvent,
): TaskViewModel {
  const existing = task.agents.find((agent) => agent.id === summary.id) ?? {
    id: summary.id,
    role: summary.role,
    profileId: summary.profileId,
    capability: summary.capability,
    status: summary.status,
    assignment: summary.assignment,
    activity: [],
  };
  const applied = applyTaskEvent(
    { ...task, activity: existing.activity },
    runId,
    event,
  );
  const nextAgent: AgentActivityViewModel = {
    ...existing,
    status: agentStatusForEvent(event) ?? existing.status,
    activity: applied.activity,
  };
  const agents = task.agents.some((agent) => agent.id === summary.id)
    ? task.agents.map((agent) => (agent.id === summary.id ? nextAgent : agent))
    : [...task.agents, nextAgent];
  return {
    ...task,
    agents,
    selectedAgentId:
      task.selectedAgentId ??
      agents.find((agent) => agent.role === "lead")?.id ??
      summary.id,
  };
}

let localActivityId = 0;

function prependDraft(texts: string[], draft: string): string {
  const restored = texts.filter((text) => text.length > 0).join("\n\n");
  if (restored.length === 0) return draft;
  return draft.length === 0 ? restored : `${restored}\n\n${draft}`;
}

export function useTaskRun() {
  const [newTaskView, setNewTaskView] = useState<TaskViewModel>(INITIAL_TASK);
  const [taskViews, setTaskViews] = useState<Record<string, TaskViewModel>>({});
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<WorkspaceInfo[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [submittingKeys, setSubmittingKeys] = useState<Set<string>>(new Set());
  const [cancellingTaskIds, setCancellingTaskIds] = useState<Set<string>>(
    new Set(),
  );
  const [loadingTaskId, setLoadingTaskId] = useState<string | null>(null);
  const [choosingWorkspace, setChoosingWorkspace] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [editingTodo, setEditingTodo] = useState(false);
  const [changingAccessMode, setChangingAccessMode] = useState(false);
  const [changingInteractionMode, setChangingInteractionMode] = useState(false);
  const [permissionRequests, setPermissionRequests] = useState<
    TaskPermissionRequestEnvelope[]
  >([]);
  const [decidingPermission, setDecidingPermission] = useState(false);

  const activeTaskIdRef = useRef(activeTaskId);
  const projectsRef = useRef(projects);
  const taskViewsRef = useRef(taskViews);
  const tasksRef = useRef(tasks);

  useEffect(() => {
    activeTaskIdRef.current = activeTaskId;
  }, [activeTaskId]);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);
  useEffect(() => {
    taskViewsRef.current = taskViews;
  }, [taskViews]);
  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  const refreshTasks = useCallback(async () => {
    const refreshed = await window.desktop.task.list();
    tasksRef.current = refreshed;
    setTasks(refreshed);
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const refreshed = await window.desktop.workspace.list();
      projectsRef.current = refreshed;
      setProjects(refreshed);
    } finally {
      setProjectsLoaded(true);
    }
  }, []);

  useEffect(() => {
    void Promise.all([refreshProjects(), refreshTasks()]);
    const unsubscribeEvents = window.desktop.task.onEvent(
      ({ taskId, runId, agent, event }) => {
      setTaskViews((current) => {
        const existing =
          current[taskId] ??
          (() => {
            const summary = tasksRef.current.find((task) => task.id === taskId);
            return summary === undefined ? undefined : taskFromSummary(summary);
          })();
        if (existing === undefined) return current;
        const taskEvent =
          agent?.role === "subagent"
            ? existing
            : applyTaskEvent(existing, runId, event);
        const updated =
          agent === undefined
            ? taskEvent
            : applyAgentEvent(taskEvent, agent, runId, event);
        return { ...current, [taskId]: updated };
      });

      const status =
        agent?.role === "subagent" ? undefined : statusForEvent(event);
      if (status !== undefined) {
        setTasks((current) => {
          const updated = current.map((task) =>
            task.id === taskId ? { ...task, status } : task,
          );
          tasksRef.current = updated;
          return updated;
        });
      }
      if (status === "completed" || status === "cancelled" || status === "failed") {
        setPermissionRequests((current) =>
          current.filter((request) => request.taskId !== taskId),
        );
        void refreshTasks();
      }
      },
    );
    const unsubscribeRuntime = window.desktop.task.onRuntimeState(
      ({ taskId, state }) => {
        setTaskViews((current) => {
          const existing = current[taskId];
          if (existing === undefined) return current;
          return {
            ...current,
            [taskId]: { ...existing, runtimeState: state },
          };
        });
      },
    );
    const unsubscribePermissions = window.desktop.task.onPermissionRequest(
      (envelope) => {
        setPermissionRequests((current) => [
          ...current.filter(
            (candidate) => candidate.request.id !== envelope.request.id,
          ),
          envelope,
        ]);
      },
    );
    return () => {
      unsubscribeEvents();
      unsubscribeRuntime();
      unsubscribePermissions();
    };
  }, [refreshProjects, refreshTasks]);

  const task =
    activeTaskId === null
      ? newTaskView
      : taskViews[activeTaskId] ??
        (() => {
          const summary = tasks.find((candidate) => candidate.id === activeTaskId);
          return summary === undefined ? INITIAL_TASK : taskFromSummary(summary);
        })();
  const activeKey = activeTaskId ?? NEW_TASK_KEY;
  const submitting = submittingKeys.has(activeKey);
  const cancelling =
    activeTaskId !== null && cancellingTaskIds.has(activeTaskId);
  const pendingPermission =
    activeTaskId === null
      ? null
      : permissionRequests.find(
          (request) => request.taskId === activeTaskId,
        ) ?? null;

  const setDraft = useCallback(
    (draft: string) => {
      if (activeTaskId === null) {
        setNewTaskView((current) => ({ ...current, draft }));
      } else {
        setTaskViews((current) => {
          const existing = current[activeTaskId];
          return existing === undefined
            ? current
            : { ...current, [activeTaskId]: { ...existing, draft } };
        });
      }
    },
    [activeTaskId],
  );

  const editTodo = useCallback(
    async (operation: TodoEditOperation) => {
      if (activeTaskId === null || editingTodo) return;
      const taskId = activeTaskId;
      setEditingTodo(true);
      try {
        const input = { taskId, ...operation } as TodoEditInput;
        const result = await window.desktop.todo.edit(input);
        setTaskViews((current) => {
          const existing = current[taskId];
          return existing === undefined
            ? current
            : { ...current, [taskId]: { ...existing, todo: result.todo } };
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Could not update todo list";
        setTaskViews((current) => {
          const existing = current[taskId];
          if (existing === undefined) return current;
          return {
            ...current,
            [taskId]: {
              ...existing,
              activity: [
                ...existing.activity,
                {
                  id: `local:status:${localActivityId++}`,
                  kind: "status",
                  text: message,
                },
              ],
            },
          };
        });
      } finally {
        setEditingTodo(false);
      }
    },
    [activeTaskId, editingTodo],
  );

  const sendDuringRun = useCallback(
    async (delivery: "followUp" | "steer") => {
      const taskId = activeTaskId;
      const text = task.draft.trim();
      if (
        taskId === null ||
        task.status !== "running" ||
        text.length === 0 ||
        submittingKeys.has(taskId)
      ) {
        return;
      }

      setSubmittingKeys((current) => new Set(current).add(taskId));
      setTaskViews((current) => {
        const existing = current[taskId];
        return existing === undefined
          ? current
          : { ...current, [taskId]: { ...existing, draft: "" } };
      });
      try {
        if (delivery === "followUp") {
          await window.desktop.task.followUp({ taskId, text });
        } else {
          await window.desktop.task.steer({ taskId, text });
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : `Could not ${delivery}`;
        setTaskViews((current) => {
          const existing = current[taskId];
          if (existing === undefined) return current;
          return {
            ...current,
            [taskId]: {
              ...existing,
              draft: prependDraft([text], existing.draft),
              activity: [
                ...existing.activity,
                {
                  id: `local:status:${localActivityId++}`,
                  kind: "status",
                  text: message,
                },
              ],
            },
          };
        });
      } finally {
        setSubmittingKeys((current) => {
          const next = new Set(current);
          next.delete(taskId);
          return next;
        });
      }
    },
    [activeTaskId, submittingKeys, task.draft, task.status],
  );

  const submit = useCallback(async () => {
    const text = task.draft.trim();
    const initialTaskId = activeTaskId;
    const initialKey = initialTaskId ?? NEW_TASK_KEY;
    if (
      text.length === 0 ||
      submittingKeys.has(initialKey) ||
      task.workspace === null
    ) {
      return;
    }

    if (initialTaskId !== null && task.status === "running") {
      await sendDuringRun("followUp");
      return;
    }
    const userMessage: ActivityItem = {
      id: `local:user:${localActivityId++}`,
      kind: "user-message",
      text,
    };
    const optimisticView: TaskViewModel = {
      ...task,
      draft: "",
      status: "idle",
      runtimeState: "preparing",
      activity: [...task.activity, userMessage],
    };

    setSubmittingKeys((current) => new Set(current).add(initialKey));
    if (initialTaskId === null) {
      setNewTaskView(optimisticView);
    } else {
      setTaskViews((current) => ({
        ...current,
        [initialTaskId]: optimisticView,
      }));
    }

    let taskId = initialTaskId;
    try {
      if (taskId === null) {
        const created = await window.desktop.task.create({
          title: text,
          workspaceId: task.workspace.id,
          executionTarget: task.executionTarget,
          accessMode: task.accessMode,
          interactionMode: task.interactionMode,
        });
        taskId = created.task.id;
        const createdView: TaskViewModel = {
          ...optimisticView,
          id: taskId,
          title: created.task.title,
          executionTarget: created.task.executionTarget,
          accessMode: created.task.accessMode,
          interactionMode: created.task.interactionMode,
          branch: created.task.branch,
          workspace: created.task.workspace,
        };
        setTaskViews((current) => ({ ...current, [taskId!]: createdView }));
        taskViewsRef.current = {
          ...taskViewsRef.current,
          [taskId]: createdView,
        };
        setTasks((current) => {
          const updated = [
            created.task,
            ...current.filter((candidate) => candidate.id !== created.task.id),
          ];
          tasksRef.current = updated;
          return updated;
        });
        setSubmittingKeys((current) => {
          const next = new Set(current);
          next.delete(NEW_TASK_KEY);
          next.add(taskId!);
          return next;
        });
        if (activeTaskIdRef.current === null) {
          activeTaskIdRef.current = taskId;
          setActiveTaskId(taskId);
          setNewTaskView(INITIAL_TASK);
          setWorkspaceError(null);
        }
      }

      await window.desktop.task.start({
        taskId,
        text,
        model: optimisticView.model,
        thinkingLevel: optimisticView.thinkingLevel,
      });
      await refreshTasks();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not start conversation";
      const fail = (current: TaskViewModel): TaskViewModel => ({
        ...current,
        status: "failed",
        runtimeState: "cold",
        activity: [
          ...current.activity,
          {
            id: `local:status:${localActivityId++}`,
            kind: "status",
            text: message,
          },
        ],
      });
      if (taskId === null) {
        setNewTaskView(fail);
      } else {
        setTaskViews((current) => {
          const existing = current[taskId!];
          return existing === undefined
            ? current
            : { ...current, [taskId!]: fail(existing) };
        });
      }
      await refreshTasks();
    } finally {
      setSubmittingKeys((current) => {
        const next = new Set(current);
        next.delete(initialKey);
        if (taskId !== null) next.delete(taskId);
        return next;
      });
    }
  }, [activeTaskId, refreshTasks, sendDuringRun, submittingKeys, task]);

  const steer = useCallback(
    () => sendDuringRun("steer"),
    [sendDuringRun],
  );

  const steerQueued = useCallback(
    async (followUpIndex: number) => {
      if (
        activeTaskId === null ||
        task.status !== "running" ||
        submittingKeys.has(activeTaskId)
      ) {
        return;
      }
      const taskId = activeTaskId;
      let pendingRecovery: string[] = [];
      setSubmittingKeys((current) => new Set(current).add(taskId));
      try {
        const queue = await window.desktop.task.clearQueue({ taskId });
        const selected = queue.followUp[followUpIndex];
        const operations = [
          ...queue.steering.map((text) => ({ delivery: "steer" as const, text })),
          ...(selected === undefined
            ? []
            : [{ delivery: "steer" as const, text: selected }]),
          ...queue.followUp.flatMap((text, index) =>
            index === followUpIndex
              ? []
              : [{ delivery: "followUp" as const, text }],
          ),
        ];
        pendingRecovery = operations.map(({ text }) => text);
        for (const operation of operations) {
          await window.desktop.task[operation.delivery]({
            taskId,
            text: operation.text,
          });
          pendingRecovery.shift();
        }
      } catch (error) {
        try {
          const queue = await window.desktop.task.clearQueue({ taskId });
          pendingRecovery.push(...queue.steering, ...queue.followUp);
        } catch {
          // Preserve the messages already known to have been removed.
        }
        const message =
          error instanceof Error ? error.message : "Could not steer queued message";
        setTaskViews((current) => {
          const existing = current[taskId];
          if (existing === undefined) return current;
          return {
            ...current,
            [taskId]: {
              ...existing,
              draft: prependDraft(pendingRecovery, existing.draft),
              queue: { steering: [], followUp: [] },
              activity: [
                ...existing.activity,
                {
                  id: `local:status:${localActivityId++}`,
                  kind: "status",
                  text: message,
                },
              ],
            },
          };
        });
      } finally {
        setSubmittingKeys((current) => {
          const next = new Set(current);
          next.delete(taskId);
          return next;
        });
      }
    },
    [activeTaskId, submittingKeys, task.status],
  );

  const restoreQueue = useCallback(async () => {
    if (
      activeTaskId === null ||
      task.status !== "running" ||
      submittingKeys.has(activeTaskId) ||
      (task.queue.steering.length === 0 && task.queue.followUp.length === 0)
    ) {
      return;
    }
    const taskId = activeTaskId;
    setSubmittingKeys((current) => new Set(current).add(taskId));
    try {
      const queue = await window.desktop.task.clearQueue({ taskId });
      setTaskViews((current) => {
        const existing = current[taskId];
        if (existing === undefined) return current;
        return {
          ...current,
          [taskId]: {
            ...existing,
            draft: prependDraft(
              [...queue.steering, ...queue.followUp],
              existing.draft,
            ),
            queue: { steering: [], followUp: [] },
          },
        };
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not restore queue";
      setTaskViews((current) => {
        const existing = current[taskId];
        if (existing === undefined) return current;
        return {
          ...current,
          [taskId]: {
            ...existing,
            activity: [
              ...existing.activity,
              {
                id: `local:status:${localActivityId++}`,
                kind: "status",
                text: message,
              },
            ],
          },
        };
      });
    } finally {
      setSubmittingKeys((current) => {
        const next = new Set(current);
        next.delete(taskId);
        return next;
      });
    }
  }, [activeTaskId, submittingKeys, task.queue, task.status]);

  const cancel = useCallback(async () => {
    if (
      activeTaskId === null ||
      cancellingTaskIds.has(activeTaskId) ||
      task.status !== "running"
    ) {
      return;
    }
    const taskId = activeTaskId;
    setCancellingTaskIds((current) => new Set(current).add(taskId));
    try {
      const result = await window.desktop.task.cancel({ taskId });
      setTaskViews((current) => {
        const existing = current[taskId];
        if (existing === undefined) return current;
        return {
          ...current,
          [taskId]: {
            ...existing,
            draft: prependDraft(
              [...result.queued.steering, ...result.queued.followUp],
              existing.draft,
            ),
            queue: { steering: [], followUp: [] },
          },
        };
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not stop conversation";
      setTaskViews((current) => {
        const existing = current[taskId];
        if (existing === undefined) return current;
        return {
          ...current,
          [taskId]: {
            ...existing,
            status: "failed",
            activity: [
              ...existing.activity,
              {
                id: `local:status:${localActivityId++}`,
                kind: "status",
                text: message,
              },
            ],
          },
        };
      });
    } finally {
      setCancellingTaskIds((current) => {
        const next = new Set(current);
        next.delete(taskId);
        return next;
      });
    }
  }, [activeTaskId, cancellingTaskIds, task.status]);

  const rememberProject = useCallback((project: WorkspaceInfo) => {
    const existing = projectsRef.current.some(
      (candidate) => candidate.id === project.id,
    );
    const updated = existing
      ? projectsRef.current.map((candidate) =>
          candidate.id === project.id ? project : candidate,
        )
      : [project, ...projectsRef.current];
    projectsRef.current = updated;
    setProjects(updated);
  }, []);

  const activateProject = useCallback(
    async (projectId: string) => {
      const project = await window.desktop.workspace.activate({
        workspaceId: projectId,
      });
      rememberProject(project);
      return project;
    },
    [rememberProject],
  );

  const adoptProject = useCallback(
    (project: WorkspaceInfo) => {
      rememberProject(project);
      activeTaskIdRef.current = null;
      setActiveTaskId(null);
      setActiveProjectId(project.id);
      setNewTaskView(taskForWorkspace(project));
      setWorkspaceError(null);
    },
    [rememberProject],
  );

  const newConversation = useCallback(
    async (projectId: string) => {
      // Opening a composer for an already-listed project needs nothing from
      // main; refreshing and recency-touching happen off the critical path so
      // a slow project probe can never block conversation creation.
      const cached = projectsRef.current.find(
        (candidate) => candidate.id === projectId,
      );
      const project = cached ?? (await activateProject(projectId));
      activeTaskIdRef.current = null;
      setActiveTaskId(null);
      setActiveProjectId(project.id);
      setNewTaskView(taskForWorkspace(project));
      setWorkspaceError(null);
      void refreshProjects().catch(() => undefined);
      if (cached !== undefined) {
        void activateProject(projectId).catch(() => undefined);
      }
    },
    [activateProject, refreshProjects],
  );

  const addProject = useCallback(async () => {
    if (choosingWorkspace) return false;
    setChoosingWorkspace(true);
    setWorkspaceError(null);
    try {
      const selected = await window.desktop.workspace.choose();
      if (selected === null) return false;
      adoptProject(selected);
      return true;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not add project";
      setWorkspaceError(message);
      throw new Error(message);
    } finally {
      setChoosingWorkspace(false);
    }
  }, [adoptProject, choosingWorkspace]);

  const createProject = useCallback(
    async (name: string) => {
      if (choosingWorkspace) return false;
      setChoosingWorkspace(true);
      setWorkspaceError(null);
      try {
        const selected = await window.desktop.workspace.create({ name });
        if (selected === null) return false;
        adoptProject(selected);
        return true;
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Could not create project folder";
        setWorkspaceError(message);
        throw new Error(message);
      } finally {
        setChoosingWorkspace(false);
      }
    },
    [adoptProject, choosingWorkspace],
  );

  const listGitHubRepositories =
    useCallback(async (): Promise<GitHubRepository[]> => {
      return window.desktop.workspace.listGitHubRepositories();
    }, []);

  const cloneGitHubProject = useCallback(
    async (nameWithOwner: string) => {
      if (choosingWorkspace) return false;
      setChoosingWorkspace(true);
      setWorkspaceError(null);
      try {
        const selected = await window.desktop.workspace.cloneGitHub({
          nameWithOwner,
        });
        if (selected === null) return false;
        adoptProject(selected);
        return true;
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Could not clone GitHub repository";
        setWorkspaceError(message);
        throw new Error(message);
      } finally {
        setChoosingWorkspace(false);
      }
    },
    [adoptProject, choosingWorkspace],
  );

  const selectRecentProject = useCallback(
    async (projectId: string) => {
      const selected = await activateProject(projectId);
      adoptProject(selected);
    },
    [activateProject, adoptProject],
  );

  const setModel = useCallback(
    (model: SupportedModelSelection) => {
      if (activeTaskId === null) {
        setNewTaskView((current) => ({
          ...current,
          model,
          thinkingLevel: clampThinkingLevel(model, current.thinkingLevel),
        }));
      } else {
        setTaskViews((current) => {
          const existing = current[activeTaskId];
          return existing === undefined
            ? current
            : {
                ...current,
                [activeTaskId]: {
                  ...existing,
                  model,
                  thinkingLevel: clampThinkingLevel(
                    model,
                    existing.thinkingLevel,
                  ),
                },
              };
        });
      }
    },
    [activeTaskId],
  );

  const setThinkingLevel = useCallback(
    (thinkingLevel: ThinkingLevel) => {
      if (activeTaskId === null) {
        setNewTaskView((current) => ({
          ...current,
          thinkingLevel: clampThinkingLevel(current.model, thinkingLevel),
        }));
      } else {
        setTaskViews((current) => {
          const existing = current[activeTaskId];
          return existing === undefined
            ? current
            : {
                ...current,
                [activeTaskId]: {
                  ...existing,
                  thinkingLevel: clampThinkingLevel(
                    existing.model,
                    thinkingLevel,
                  ),
                },
              };
        });
      }
    },
    [activeTaskId],
  );

  const setExecutionTarget = useCallback(
    (executionTarget: TaskExecutionTarget) => {
      if (activeTaskId !== null) return;
      setNewTaskView((current) => {
        if (
          executionTarget === "worktree" &&
          current.workspace?.worktreeAvailable !== true
        ) {
          return current;
        }
        return {
          ...current,
          executionTarget,
          branch: executionTarget === "local" ? current.workspace?.branch ?? null : null,
        };
      });
    },
    [activeTaskId],
  );

  const setAccessMode = useCallback(
    async (accessMode: TaskAccessMode) => {
      if (activeTaskId === null) {
        setNewTaskView((current) => ({ ...current, accessMode }));
        return;
      }
      if (
        changingAccessMode ||
        task.status === "running" ||
        task.runtimeState === "preparing"
      ) {
        return;
      }

      const taskId = activeTaskId;
      setChangingAccessMode(true);
      try {
        const updated = await window.desktop.task.updateAccessMode({
          taskId,
          accessMode,
        });
        setTaskViews((current) => {
          const existing = current[taskId];
          return existing === undefined
            ? current
            : {
                ...current,
                [taskId]: { ...existing, accessMode: updated.accessMode },
              };
        });
        setTasks((current) => {
          const next = current.map((candidate) =>
            candidate.id === taskId ? updated : candidate,
          );
          tasksRef.current = next;
          return next;
        });
      } finally {
        setChangingAccessMode(false);
      }
    },
    [
      activeTaskId,
      changingAccessMode,
      task.runtimeState,
      task.status,
    ],
  );

  const setInteractionMode = useCallback(
    async (interactionMode: TaskInteractionMode) => {
      if (activeTaskId === null) {
        setNewTaskView((current) => ({ ...current, interactionMode }));
        return;
      }
      if (
        changingInteractionMode ||
        task.status === "running" ||
        task.runtimeState === "preparing"
      ) {
        return;
      }

      const taskId = activeTaskId;
      setChangingInteractionMode(true);
      try {
        const updated = await window.desktop.task.updateInteractionMode({
          taskId,
          interactionMode,
        });
        setTaskViews((current) => {
          const existing = current[taskId];
          return existing === undefined
            ? current
            : {
                ...current,
                [taskId]: {
                  ...existing,
                  interactionMode: updated.interactionMode,
                },
              };
        });
        setTasks((current) => {
          const next = current.map((candidate) =>
            candidate.id === taskId ? updated : candidate,
          );
          tasksRef.current = next;
          return next;
        });
      } finally {
        setChangingInteractionMode(false);
      }
    },
    [
      activeTaskId,
      changingInteractionMode,
      task.runtimeState,
      task.status,
    ],
  );

  const decidePermission = useCallback(
    async (allowed: boolean) => {
      if (pendingPermission === null || decidingPermission) return;
      const { taskId, request } = pendingPermission;
      setDecidingPermission(true);
      try {
        await window.desktop.task.decidePermission({
          taskId,
          requestId: request.id,
          allowed,
        });
      } finally {
        setPermissionRequests((current) =>
          current.filter((candidate) => candidate.request.id !== request.id),
        );
        setDecidingPermission(false);
      }
    },
    [decidingPermission, pendingPermission],
  );

  const setRuntimeState = useCallback(
    (taskId: string, runtimeState: TaskRuntimeState) => {
      setTaskViews((current) => {
        const existing = current[taskId];
        if (
          existing === undefined ||
          (existing.runtimeState === "running" && runtimeState !== "running")
        ) {
          return current;
        }
        return {
          ...current,
          [taskId]: { ...existing, runtimeState },
        };
      });
    },
    [],
  );

  const activateTask = useCallback(
    (taskId: string) => {
      setRuntimeState(taskId, "preparing");
      void window.desktop.task
        .activate({ taskId })
        .then(({ state }) => setRuntimeState(taskId, state))
        .catch(() => setRuntimeState(taskId, "cold"));
    },
    [setRuntimeState],
  );

  const openTask = useCallback(
    async (taskId: string) => {
      const summary = tasksRef.current.find((task) => task.id === taskId);
      if (summary !== undefined) {
        setActiveProjectId(summary.workspace.id);
        await activateProject(summary.workspace.id);
      }
      if (activeTaskIdRef.current === taskId) {
        activateTask(taskId);
        return;
      }
      if (taskViewsRef.current[taskId] !== undefined) {
        activeTaskIdRef.current = taskId;
        setActiveTaskId(taskId);
        activateTask(taskId);
        return;
      }

      setLoadingTaskId(taskId);
      try {
        const snapshot = await window.desktop.task.open({ taskId });
        const view = taskFromSnapshot(snapshot);
        taskViewsRef.current = { ...taskViewsRef.current, [taskId]: view };
        setTaskViews((current) => ({ ...current, [taskId]: view }));
        activeTaskIdRef.current = taskId;
        setActiveTaskId(taskId);
        setActiveProjectId(view.workspace?.id ?? null);
        if (summary === undefined && view.workspace !== null) {
          await activateProject(view.workspace.id);
        }
        activateTask(taskId);
        await refreshTasks();
      } finally {
        setLoadingTaskId(null);
      }
    },
    [activateProject, activateTask, refreshTasks],
  );

  const openProject = useCallback(
    async (projectId: string) => {
      const latest = tasksRef.current
        .filter((candidate) => candidate.workspace.id === projectId)
        .reduce<TaskSummary | undefined>((current, candidate) => {
          if (current === undefined) return candidate;
          if (candidate.updatedAt !== current.updatedAt) {
            return candidate.updatedAt > current.updatedAt
              ? candidate
              : current;
          }
          return candidate.createdAt > current.createdAt ? candidate : current;
        }, undefined);
      if (latest === undefined) {
        await newConversation(projectId);
        return;
      }
      await openTask(latest.id);
    },
    [newConversation, openTask],
  );

  const selectAgent = useCallback(
    (agentId: string) => {
      if (activeTaskId === null) return;
      setTaskViews((current) => {
        const existing = current[activeTaskId];
        if (
          existing === undefined ||
          !existing.agents.some((agent) => agent.id === agentId)
        ) {
          return current;
        }
        return {
          ...current,
          [activeTaskId]: { ...existing, selectedAgentId: agentId },
        };
      });
    },
    [activeTaskId],
  );

  return {
    task,
    tasks,
    projects,
    projectsLoaded,
    activeProjectId,
    submitting,
    cancelling,
    choosingWorkspace,
    workspaceError,
    loadingTaskId,
    editingTodo,
    changingAccessMode,
    changingInteractionMode,
    pendingPermission,
    decidingPermission,
    setDraft,
    editTodo,
    setModel,
    setThinkingLevel,
    setExecutionTarget,
    setAccessMode,
    setInteractionMode,
    decidePermission,
    addProject,
    createProject,
    listGitHubRepositories,
    cloneGitHubProject,
    selectRecentProject,
    submit,
    steer,
    steerQueued,
    restoreQueue,
    selectAgent,
    cancel,
    newConversation,
    openProject,
    openTask,
  };
}

export type TaskRunController = ReturnType<typeof useTaskRun>;
