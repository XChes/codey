import { EventType } from "@ag-ui/core";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import { App } from "./App";
import type { AppSettings } from "../../shared/settings";
import {
  DEFAULT_MODEL,
  DEFAULT_THINKING_LEVEL,
} from "../../shared/models";
import {
  AGENT_UI_CUSTOM_EVENT,
  type AgentUiEvent,
} from "../../shared/agent-ui";
import type {
  TaskEventEnvelope,
  TaskPermissionRequestEnvelope,
  TaskRuntimeStateEnvelope,
  TaskSnapshot,
  TaskSummary,
} from "../../shared/task";
import type {
  GitHubRepository,
  WorkspaceInfo,
} from "../../shared/workspace";
import type { ReviewSnapshot } from "../../shared/review";
import type {
  ProviderCredentialDeleteInput,
  ProviderCredentialSetInput,
  ProviderCredentialStatus,
} from "../../shared/provider-credentials";
import type { AgentSummary } from "../../shared/agent";

const defaultSettings: AppSettings = {
  theme: "system",
  window: { width: 1180, height: 760, maximized: false },
};

const workspace: WorkspaceInfo = {
  id: "workspace-1",
  name: "desktop-agent",
  path: "/Users/test/desktop-agent",
  worktreeAvailable: false,
  branch: null,
};

const storedTask: TaskSummary = {
  id: "task-1",
  title: "Stored task",
  status: "completed",
  executionTarget: "local",
  accessMode: "auto",
  interactionMode: "agent",
  branch: null,
  workspace,
  createdAt: "2026-08-15T12:00:00.000Z",
  updatedAt: "2026-08-15T12:01:00.000Z",
};

function installBridge(options?: {
  workspaces?: WorkspaceInfo[];
  tasks?: TaskSummary[];
  snapshot?: TaskSnapshot;
  files?: string[];
  reviewSnapshot?: ReviewSnapshot;
}) {
  const update = vi.fn(async ({ theme }: { theme?: AppSettings["theme"] }) => ({
    ...defaultSettings,
    theme: theme ?? defaultSettings.theme,
  }));

  const runtimeTasks = [...(options?.tasks ?? [])];
  let createdCount = 0;
  let taskListener: ((envelope: TaskEventEnvelope) => void) | undefined;
  let fileListener: ((envelope: { taskId: string; revision: number }) => void) | undefined;
  let reviewListener: ((envelope: { taskId: string; revision: number }) => void) | undefined;
  let runtimeListener:
    | ((envelope: TaskRuntimeStateEnvelope) => void)
    | undefined;
  let permissionListener:
    | ((envelope: TaskPermissionRequestEnvelope) => void)
    | undefined;
  const task = {
    list: vi.fn(async () => [...runtimeTasks]),
    create: vi.fn(async ({
      title,
      workspaceId,
      executionTarget,
      accessMode,
      interactionMode,
    }: {
      title: string;
      workspaceId: string;
      executionTarget: "local" | "worktree";
      accessMode: "ask" | "auto" | "full";
      interactionMode: "agent" | "plan";
    }) => {
      createdCount += 1;
      const id = createdCount === 1 ? "task-new" : `task-new-${createdCount}`;
      const selectedWorkspace =
        options?.workspaces?.find((candidate) => candidate.id === workspaceId) ??
        { ...workspace, id: workspaceId };
      const created: TaskSummary = {
        id,
        title,
        status: "idle",
        executionTarget,
        accessMode,
        interactionMode,
        branch:
          executionTarget === "worktree"
            ? `codey/${id}`
            : selectedWorkspace.branch,
        workspace: selectedWorkspace,
        createdAt: "2026-08-15T12:02:00.000Z",
        updatedAt: "2026-08-15T12:02:00.000Z",
      };
      runtimeTasks.unshift(created);
      return { task: created };
    }),
    open: vi.fn(async () =>
      options?.snapshot ?? {
        task: storedTask,
        model: DEFAULT_MODEL,
        thinkingLevel: DEFAULT_THINKING_LEVEL,
        messages: [],
        todo: null,
      },
    ),
    activate: vi.fn(async () => ({ state: "ready" as const })),
    updateAccessMode: vi.fn(
      async ({
        taskId,
        accessMode,
      }: {
        taskId: string;
        accessMode: "ask" | "auto" | "full";
      }) => {
        const index = runtimeTasks.findIndex((candidate) => candidate.id === taskId);
        if (index === -1) throw new Error("Task not found");
        const updated = { ...runtimeTasks[index]!, accessMode };
        runtimeTasks[index] = updated;
        return updated;
      },
    ),
    updateInteractionMode: vi.fn(
      async ({
        taskId,
        interactionMode,
      }: {
        taskId: string;
        interactionMode: "agent" | "plan";
      }) => {
        const index = runtimeTasks.findIndex(
          (candidate) => candidate.id === taskId,
        );
        if (index === -1) throw new Error("Task not found");
        const updated = { ...runtimeTasks[index]!, interactionMode };
        runtimeTasks[index] = updated;
        return updated;
      },
    ),
    decidePermission: vi.fn(async () => ({ resolved: true })),
    start: vi.fn(async () => ({ runId: `run-${createdCount || 1}` })),
    steer: vi.fn(async () => ({ accepted: true as const })),
    followUp: vi.fn(async () => ({ accepted: true as const })),
    clearQueue: vi.fn(async () => ({
      steering: [] as string[],
      followUp: [] as string[],
    })),
    cancel: vi.fn(async () => ({
      cancelled: true,
      queued: { steering: [] as string[], followUp: [] as string[] },
    })),
    onEvent: vi.fn((listener: (envelope: TaskEventEnvelope) => void) => {
      taskListener = listener;
      return () => {
        taskListener = undefined;
      };
    }),
    onRuntimeState: vi.fn(
      (listener: (envelope: TaskRuntimeStateEnvelope) => void) => {
        runtimeListener = listener;
        return () => {
          runtimeListener = undefined;
        };
      },
    ),
    onPermissionRequest: vi.fn(
      (listener: (envelope: TaskPermissionRequestEnvelope) => void) => {
        permissionListener = listener;
        return () => {
          permissionListener = undefined;
        };
      },
    ),
  };

  const workspaceApi = {
    list: vi.fn(async () => [
      ...(options?.workspaces ??
        Array.from(
          new Map(
            runtimeTasks.map((task) => [task.workspace.id, task.workspace]),
          ).values(),
        )),
    ]),
    choose: vi.fn(async (): Promise<WorkspaceInfo | null> => workspace),
    create: vi.fn(async (): Promise<WorkspaceInfo | null> => workspace),
    activate: vi.fn(
      async ({ workspaceId }: { workspaceId: string }): Promise<WorkspaceInfo> =>
        options?.workspaces?.find(
          (candidate) => candidate.id === workspaceId,
        ) ?? { ...workspace, id: workspaceId },
    ),
    listGitHubRepositories: vi.fn(
      async (): Promise<GitHubRepository[]> => [],
    ),
    cloneGitHub: vi.fn(async (): Promise<WorkspaceInfo | null> => workspace),
  };
  const todo = {
    edit: vi.fn(async () => ({ todo: options?.snapshot?.todo ?? null })),
  };
  const reviewSnapshot: ReviewSnapshot = options?.reviewSnapshot ?? {
    taskId: "task-1",
    revision: 1,
    baselineTree: "base",
    files: [],
  };
  const detailFile = reviewSnapshot.files[0] ?? {
    id: "review-file",
    path: "README.md",
    previousPath: null,
    status: "modified" as const,
    additions: 1,
    deletions: 1,
    isBinary: false,
    currentSignature: "signature",
  };
  const fileApi = {
    list: vi.fn(async () => ({ taskId: "task-1", revision: 1, files: options?.files ?? [] })),
    read: vi.fn(async ({ path }: { path: string }) => ({
      path,
      content: `Contents of ${path}`,
      isBinary: false,
      truncated: false,
      size: path.length,
    })),
    onChanged: vi.fn((listener: (envelope: { taskId: string; revision: number }) => void) => {
      fileListener = listener;
      return () => { fileListener = undefined; };
    }),
  };
  const reviewApi = {
    snapshot: vi.fn(async () => reviewSnapshot),
    file: vi.fn(async () => ({
      file: detailFile,
      oldContent: "before",
      newContent: "after",
      truncated: false,
    })),
    keep: vi.fn(async (): Promise<ReviewSnapshot> => ({ ...reviewSnapshot, files: [] })),
    undo: vi.fn(async (): Promise<ReviewSnapshot> => ({ ...reviewSnapshot, files: [] })),
    onChanged: vi.fn((listener: (envelope: { taskId: string; revision: number }) => void) => {
      reviewListener = listener;
      return () => { reviewListener = undefined; };
    }),
  };
  let credentialStatuses: ProviderCredentialStatus[] = [
    { provider: "deepseek", configured: true },
    { provider: "openai", configured: false },
    { provider: "xai", configured: false },
  ];
  const credentials = {
    list: vi.fn(async () => credentialStatuses),
    set: vi.fn(async ({ provider }: ProviderCredentialSetInput) => {
      const status = { provider, configured: true };
      credentialStatuses = [
        ...credentialStatuses.filter((item) => item.provider !== provider),
        status,
      ];
      return status;
    }),
    delete: vi.fn(async ({ provider }: ProviderCredentialDeleteInput) => {
      const status = { provider, configured: false };
      credentialStatuses = [
        ...credentialStatuses.filter((item) => item.provider !== provider),
        status,
      ];
      return status;
    }),
  };

  window.desktop = {
    workspace: workspaceApi,
    settings: {
      get: vi.fn(async () => defaultSettings),
      update,
    },
    credentials,
    task,
    files: fileApi,
    review: reviewApi,
    todo,
  };

  return {
    update,
    credentials,
    workspace: workspaceApi,
    task,
    todo,
    files: fileApi,
    review: reviewApi,
    emitFiles: (taskId: string, revision = 2) => fileListener?.({ taskId, revision }),
    emitReview: (taskId: string, revision = 2) => reviewListener?.({ taskId, revision }),
    emitTask: (
      taskId: string,
      runId: string,
      event: AgentUiEvent,
      agent?: AgentSummary,
    ) => {
      const status =
        event.type === EventType.RUN_STARTED
          ? "running"
          : event.type === EventType.RUN_FINISHED
            ? "completed"
            : event.type === EventType.CUSTOM &&
                event.name === AGENT_UI_CUSTOM_EVENT.RUN_CANCELLED
              ? "cancelled"
              : event.type === EventType.RUN_ERROR
                ? "failed"
                : undefined;
      if (status !== undefined && agent?.role !== "subagent") {
        const index = runtimeTasks.findIndex((candidate) => candidate.id === taskId);
        if (index >= 0) runtimeTasks[index] = { ...runtimeTasks[index]!, status };
      }
      taskListener?.({
        taskId,
        runId,
        agentId: agent?.id,
        agentRunId: agent === undefined ? undefined : `${runId}:${agent.id}`,
        agent,
        event,
      });
    },
    emitRuntimeState: (
      taskId: string,
      state: TaskRuntimeStateEnvelope["state"],
    ) => runtimeListener?.({ taskId, state }),
    emitPermission: (envelope: TaskPermissionRequestEnvelope) =>
      permissionListener?.(envelope),
  };
}

async function selectWorkspace(user: ReturnType<typeof userEvent.setup>) {
  let existingFolder = screen.queryByRole("button", {
    name: "Existing Folder",
  });
  if (existingFolder === null) {
    const addProjectButtons = await screen.findAllByRole("button", {
      name: "Add project",
    });
    await user.click(addProjectButtons[0]!);
    existingFolder = await screen.findByRole("button", {
      name: "Existing Folder",
    });
  }
  await user.click(existingFolder);
}

describe("App", () => {
  beforeEach(() => {
    window.location.hash = "#/";
  });

  it("renders the production empty task state without fake agent behavior", async () => {
    installBridge();
    render(<App />);

    expect(await screen.findByText("What would you like to build?")).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: "Add project" })[0],
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Start conversation" }),
    ).toBeDisabled();
  });

  it("auto-opens the local project picker on first run and dismisses with Escape", async () => {
    installBridge();
    const user = userEvent.setup();
    render(<App />);

    expect(
      await screen.findByRole("textbox", { name: "Search recent projects" }),
    ).toHaveFocus();
    expect(screen.getByRole("button", { name: "Existing Folder" })).toBeVisible();
    expect(screen.getByRole("button", { name: "New Folder" })).toBeVisible();
    expect(screen.getByRole("button", { name: "GitHub" })).toBeVisible();
    expect(screen.queryByText("Cloud")).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Search recent projects" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("filters recents and selects one for a fresh conversation", async () => {
    const otherWorkspace: WorkspaceInfo = {
      id: "workspace-2",
      name: "other-project",
      path: "/Users/test/other-project",
      worktreeAvailable: false,
      branch: null,
    };
    const bridge = installBridge({
      workspaces: [workspace, otherWorkspace],
      tasks: [storedTask],
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      (await screen.findAllByRole("button", { name: "Add project" }))[0]!,
    );
    const picker = screen.getByLabelText("Choose project");
    await user.type(
      within(picker).getByRole("textbox", {
        name: "Search recent projects",
      }),
      "other",
    );
    expect(
      within(picker).queryByText(workspace.path.replace("/Users/test", "~")),
    ).not.toBeInTheDocument();
    await user.click(
      within(picker).getByRole("button", { name: /other-project/ }),
    );

    expect(bridge.workspace.activate).toHaveBeenCalledWith({
      workspaceId: otherWorkspace.id,
    });
    expect(bridge.task.open).not.toHaveBeenCalled();
    expect(
      screen.getByRole("combobox", { name: "Access mode" }),
    ).toBeVisible();
  });

  it("creates a named project folder from the picker", async () => {
    const bridge = installBridge();
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "New Folder" }));
    await user.type(
      screen.getByRole("textbox", { name: "Folder name" }),
      "fresh-project",
    );
    await user.click(
      screen.getByRole("button", { name: "Choose location…" }),
    );

    expect(bridge.workspace.create).toHaveBeenCalledWith({
      name: "fresh-project",
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Folder name" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("lists and clones an authenticated GitHub repository", async () => {
    const bridge = installBridge();
    bridge.workspace.listGitHubRepositories.mockResolvedValueOnce([
      {
        nameWithOwner: "octo/private-repo",
        name: "private-repo",
        description: "Private work",
        isPrivate: true,
      },
    ]);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "GitHub" }));
    const repositoryName = await screen.findByText("octo/private-repo");
    await user.click(repositoryName.closest("button")!);

    expect(bridge.workspace.cloneGitHub).toHaveBeenCalledWith({
      nameWithOwner: "octo/private-repo",
    });
  });

  it("keeps GitHub authentication errors inside the picker", async () => {
    const bridge = installBridge();
    bridge.workspace.listGitHubRepositories.mockRejectedValueOnce(
      new Error("GitHub CLI is not authenticated. Run `gh auth login`."),
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "GitHub" }));

    expect(
      await screen.findByText(/GitHub CLI is not authenticated/),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  it("persists a theme change through the preload contract", async () => {
    const { update } = installBridge();
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("link", { name: "Settings" }));
    await user.click(screen.getByRole("radio", { name: "Dark theme" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith({ theme: "dark" }));
  });

  it("sets and deletes provider keys without reading saved values", async () => {
    const bridge = installBridge();
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("link", { name: "Settings" }));
    const openAi = await screen.findByRole("form", {
      name: "OpenAI credentials",
    });
    expect(openAi).toHaveTextContent("Not configured");

    const input = within(openAi).getByLabelText("OpenAI");
    await user.type(input, "sk-renderer-test");
    await user.click(within(openAi).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(bridge.credentials.set).toHaveBeenCalledWith({
        provider: "openai",
        apiKey: "sk-renderer-test",
      }),
    );
    expect(input).toHaveValue("");
    expect(openAi).toHaveTextContent("Configured");
    expect(screen.queryByText("sk-renderer-test")).not.toBeInTheDocument();

    await user.click(within(openAi).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(bridge.credentials.delete).toHaveBeenCalledWith({
        provider: "openai",
      }),
    );
    expect(openAi).toHaveTextContent("Not configured");
  });

  it("opens an empty saved project as a scoped conversation draft", async () => {
    const bridge = installBridge({ workspaces: [workspace] });
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: workspace.name }),
    );

    expect(bridge.workspace.choose).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Conversation project")).not.toBeInTheDocument();
    expect(screen.queryByText(workspace.path)).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Access mode" }),
    ).toHaveTextContent("Full access");
  });

  it("uses the selected access mode when creating a conversation", async () => {
    const bridge = installBridge({ workspaces: [workspace] });
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", {
        name: `New conversation in ${workspace.name}`,
      }),
    );
    await user.click(screen.getByRole("combobox", { name: "Access mode" }));
    await user.click(await screen.findByRole("option", { name: /Full access/ }));
    await user.type(
      screen.getByRole("textbox", { name: "Conversation message" }),
      "Use broader access",
    );
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(bridge.task.create).toHaveBeenCalledWith({
        title: "Use broader access",
        workspaceId: workspace.id,
        executionTarget: "local",
        accessMode: "full",
        interactionMode: "agent",
      }),
    );
  });

  it("selects Plan from the composer plus menu for a new conversation", async () => {
    const bridge = installBridge({ workspaces: [workspace] });
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", {
        name: `New conversation in ${workspace.name}`,
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Choose interaction mode" }),
    );
    expect(
      screen.getByRole("menuitemradio", {
        name: /Agent Make changes and run commands/,
      }),
    ).toHaveFocus();
    await user.keyboard("{ArrowDown}{Enter}");

    expect(screen.getByLabelText("Interaction mode: Plan")).toBeVisible();
    const composer = screen.getByRole("textbox", {
      name: "Conversation message",
    });
    expect(composer).toHaveAttribute(
      "placeholder",
      "Describe what you want to plan",
    );
    await user.type(composer, "Plan the feature");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(bridge.task.create).toHaveBeenCalledWith({
        title: "Plan the feature",
        workspaceId: workspace.id,
        executionTarget: "local",
        accessMode: "full",
        interactionMode: "plan",
      }),
    );
  });

  it("groups each conversation under its project", async () => {
    const otherWorkspace: WorkspaceInfo = {
      id: "workspace-2",
      name: "other-project",
      path: "/Users/test/other-project",
      worktreeAvailable: false,
      branch: null,
    };
    const otherTask: TaskSummary = {
      ...storedTask,
      id: "task-2",
      title: "Other conversation",
      workspace: otherWorkspace,
    };
    installBridge({ tasks: [storedTask, otherTask] });
    render(<App />);

    const firstProject = await screen.findByRole("group", {
      name: workspace.name,
    });
    const secondProject = screen.getByRole("group", {
      name: otherWorkspace.name,
    });

    expect(
      within(firstProject).getByRole("button", { name: storedTask.title }),
    ).toBeVisible();
    expect(
      within(secondProject).getByRole("button", { name: otherTask.title }),
    ).toBeVisible();
    expect(
      within(firstProject).queryByRole("button", { name: otherTask.title }),
    ).not.toBeInTheDocument();
  });

  it("keeps project order stable when another project is opened", async () => {
    const otherWorkspace: WorkspaceInfo = {
      id: "workspace-2",
      name: "other-project",
      path: "/Users/test/other-project",
      worktreeAvailable: false,
      branch: null,
    };
    const bridge = installBridge({
      workspaces: [workspace, otherWorkspace],
    });
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("group", { name: workspace.name });
    const projectOrder = () =>
      screen
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-label"));
    expect(projectOrder()).toEqual([workspace.name, otherWorkspace.name]);

    await user.click(screen.getByRole("button", { name: otherWorkspace.name }));
    await waitFor(() =>
      expect(bridge.workspace.activate).toHaveBeenCalledWith({
        workspaceId: otherWorkspace.id,
      }),
    );
    expect(projectOrder()).toEqual([workspace.name, otherWorkspace.name]);
  });

  it("opens a project's most recent conversation", async () => {
    const olderTask: TaskSummary = {
      ...storedTask,
      id: "task-older",
      title: "Older conversation",
      updatedAt: "2026-08-15T11:00:00.000Z",
    };
    const latestTask: TaskSummary = {
      ...storedTask,
      id: "task-latest",
      title: "Latest conversation",
      updatedAt: "2026-08-15T13:00:00.000Z",
    };
    const { task } = installBridge({ tasks: [olderTask, latestTask] });
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: workspace.name }),
    );

    expect(task.open).toHaveBeenCalledWith({ taskId: latestTask.id });
  });

  it("creates a new conversation in the selected project without reopening the picker", async () => {
    const bridge = installBridge({ workspaces: [workspace] });
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", {
        name: `New conversation in ${workspace.name}`,
      }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Conversation message" }),
      "Review this project",
    );
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(bridge.task.create).toHaveBeenCalledWith({
        title: "Review this project",
        workspaceId: workspace.id,
        executionTarget: "local",
        accessMode: "full",
        interactionMode: "agent",
      }),
    );
    expect(bridge.workspace.choose).not.toHaveBeenCalled();
  });

  it("defaults a Git project's new conversation to Local", async () => {
    const gitWorkspace = {
      ...workspace,
      worktreeAvailable: true,
      branch: "feature",
    };
    const bridge = installBridge({ workspaces: [gitWorkspace] });
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", {
        name: `New conversation in ${gitWorkspace.name}`,
      }),
    );
    expect(
      screen.getByRole("combobox", { name: "Execution target" }),
    ).toHaveTextContent("Local");
    expect(screen.getByLabelText("Git branch")).toHaveTextContent("feature");
    await user.type(
      screen.getByRole("textbox", { name: "Conversation message" }),
      "Work in the shared folder",
    );
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(bridge.task.create).toHaveBeenCalledWith({
        title: "Work in the shared folder",
        workspaceId: gitWorkspace.id,
        executionTarget: "local",
        accessMode: "full",
        interactionMode: "agent",
      }),
    );
  });

  it("lets a Git project opt into an isolated Worktree", async () => {
    const gitWorkspace = {
      ...workspace,
      worktreeAvailable: true,
      branch: "feature",
    };
    const bridge = installBridge({ workspaces: [gitWorkspace] });
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", {
        name: `New conversation in ${gitWorkspace.name}`,
      }),
    );
    await user.click(
      screen.getByRole("combobox", { name: "Execution target" }),
    );
    await user.click(await screen.findByRole("option", { name: "Worktree" }));
    expect(screen.getByLabelText("Git branch")).toHaveTextContent(
      "New branch on submit",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Conversation message" }),
      "Build in isolation",
    );
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(bridge.task.create).toHaveBeenCalledWith({
        title: "Build in isolation",
        workspaceId: gitWorkspace.id,
        executionTarget: "worktree",
        accessMode: "full",
        interactionMode: "agent",
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Git branch")).toHaveTextContent(
        "codey/task-new",
      ),
    );
  });

  it("keeps the selected project when adding another project is cancelled", async () => {
    const bridge = installBridge();
    const user = userEvent.setup();
    render(<App />);

    await selectWorkspace(user);
    expect(
      screen.getByRole("combobox", { name: "Access mode" }),
    ).toHaveTextContent("Full access");
    bridge.workspace.choose.mockResolvedValueOnce(null);
    await user.click(
      screen.getAllByRole("button", { name: "Add project" })[0]!,
    );
    await user.click(
      await screen.findByRole("button", { name: "Existing Folder" }),
    );

    expect(
      screen.getByRole("combobox", { name: "Access mode" }),
    ).toHaveTextContent("Full access");
    expect(bridge.workspace.choose).toHaveBeenCalledTimes(2);
  });

  it("lists and opens a recent Pi-backed task", async () => {
    const { task } = installBridge({
      tasks: [storedTask],
      snapshot: {
        task: storedTask,
        model: DEFAULT_MODEL,
        thinkingLevel: DEFAULT_THINKING_LEVEL,
        messages: [
          { id: "stored-user", role: "user", content: "Stored prompt" },
          {
            id: "stored-reasoning",
            role: "reasoning",
            content: "Inspect the persisted project state.",
          },
          {
            id: "stored-assistant",
            role: "assistant",
            content: "## Stored response",
            toolCalls: [
              {
                id: "stored-tool",
                type: "function",
                function: {
                  name: "read",
                  arguments: '{"path":"README.md"}',
                },
              },
            ],
          },
          {
            id: "stored-tool-result",
            role: "tool",
            toolCallId: "stored-tool",
            content: "Stored project contents",
          },
        ],
        todo: null,
      },
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Stored task" }));

    expect(task.open).toHaveBeenCalledWith({ taskId: "task-1" });
    expect(await screen.findByText("Stored prompt")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Stored response", level: 2 }),
    ).toBeVisible();
    const reasoning = screen.getByText("Thinking").closest("details");
    expect(reasoning).not.toHaveAttribute("open");
    await user.click(within(reasoning!).getByText("Thinking"));
    expect(
      within(reasoning!).getByText("Inspect the persisted project state."),
    ).toBeVisible();
    const toolDetails = screen.getByText("read").closest("details");
    await user.click(within(toolDetails!).getByText("read"));
    expect(within(toolDetails!).getByText(/"path": "README.md"/)).toBeVisible();
    expect(
      within(toolDetails!).getByText("Stored project contents"),
    ).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "Access mode" }),
    ).toHaveTextContent("Approve for me");
  });

  it("changes access mode for an idle existing conversation", async () => {
    const bridge = installBridge({ tasks: [storedTask] });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Stored task" }));
    await user.click(screen.getByRole("combobox", { name: "Access mode" }));
    await user.click(
      await screen.findByRole("option", { name: /Ask for approval/ }),
    );

    await waitFor(() =>
      expect(bridge.task.updateAccessMode).toHaveBeenCalledWith({
        taskId: storedTask.id,
        accessMode: "ask",
      }),
    );
    expect(
      screen.getByRole("combobox", { name: "Access mode" }),
    ).toHaveTextContent("Ask for approval");
  });

  it("restores persisted Plan mode and switches it back to Agent while idle", async () => {
    const planTask: TaskSummary = {
      ...storedTask,
      interactionMode: "plan",
    };
    const bridge = installBridge({
      tasks: [planTask],
      snapshot: {
        task: planTask,
        model: DEFAULT_MODEL,
        thinkingLevel: DEFAULT_THINKING_LEVEL,
        messages: [],
        todo: null,
      },
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: planTask.title }));
    expect(
      await screen.findByLabelText("Interaction mode: Plan"),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Choose interaction mode" }),
    );
    await user.click(
      screen.getByRole("menuitemradio", {
        name: /Agent Make changes and run commands/,
      }),
    );

    await waitFor(() =>
      expect(bridge.task.updateInteractionMode).toHaveBeenCalledWith({
        taskId: planTask.id,
        interactionMode: "agent",
      }),
    );
    expect(
      screen.queryByLabelText("Interaction mode: Plan"),
    ).not.toBeInTheDocument();
  });

  it("disables interaction mode changes while a response is running", async () => {
    const bridge = installBridge({ tasks: [storedTask] });
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: storedTask.title }),
    );
    act(() => {
      bridge.emitTask(storedTask.id, "run-1", {
        type: EventType.RUN_STARTED,
        threadId: storedTask.id,
        runId: "run-1",
      });
    });

    expect(
      screen.getByRole("button", { name: "Choose interaction mode" }),
    ).toBeDisabled();
  });

  it("shows a correlated approval dialog and returns the decision", async () => {
    const bridge = installBridge({ tasks: [storedTask] });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Stored task" }));

    act(() => {
      bridge.emitPermission({
        taskId: storedTask.id,
        runId: "run-1",
        request: {
          id: "permission-1",
          kind: "network",
          resource: "example.com:443",
          reason: "Allow this conversation to connect to example.com?",
        },
      });
    });

    const dialog = await screen.findByRole("dialog", {
      name: "Approval required",
    });
    expect(dialog).toHaveTextContent("example.com:443");
    await user.click(within(dialog).getByRole("button", { name: "Allow" }));
    await waitFor(() =>
      expect(bridge.task.decidePermission).toHaveBeenCalledWith({
        taskId: storedTask.id,
        requestId: "permission-1",
        allowed: true,
      }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Approval required" }),
    ).not.toBeInTheDocument();
  });

  it("renders and directly edits the conversation todo card", async () => {
    const bridge = installBridge({
      tasks: [storedTask],
      snapshot: {
        task: storedTask,
        model: DEFAULT_MODEL,
        thinkingLevel: DEFAULT_THINKING_LEVEL,
        messages: [
          { id: "stored-assistant", role: "assistant", content: "Working" },
        ],
        todo: {
          revision: 1,
          title: "Build app",
          items: [
            {
              id: "todo-1",
              content: "Implement host",
              status: "pending",
            },
          ],
        },
      },
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Stored task" }));
    const card = await screen.findByRole("region", {
      name: "Conversation todos",
    });
    const activity = screen.getByRole("region", {
      name: "Conversation activity",
    });
    expect(activity.parentElement?.lastElementChild).toHaveClass("h-72");
    const composerForm = screen
      .getByRole("textbox", { name: "Conversation message" })
      .closest("form");
    expect(composerForm?.parentElement).toContainElement(card);
    expect(
      card.compareDocumentPosition(composerForm!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(composerForm?.parentElement).toHaveClass("pointer-events-auto");
    expect(composerForm?.parentElement?.parentElement).toHaveClass(
      "pointer-events-none",
    );
    expect(within(card).getByText("Build app")).toBeVisible();
    expect(within(card).getByText("0/1")).toBeVisible();
    const toggle = within(card).getByRole("button", { name: /Build app/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      within(card).queryByRole("combobox", {
        name: "Status for Implement host",
      }),
    ).not.toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    await user.click(
      within(card).getByRole("combobox", {
        name: "Status for Implement host",
      }),
    );
    await user.click(await screen.findByRole("option", { name: "Completed" }));
    await waitFor(() =>
      expect(bridge.todo.edit).toHaveBeenLastCalledWith({
        taskId: "task-1",
        action: "set_status",
        itemId: "todo-1",
        status: "completed",
      }),
    );

    const itemInput = within(card).getByRole("textbox", {
      name: "Todo: Implement host",
    });
    await user.clear(itemInput);
    await user.type(itemInput, "Implement todo host");
    await user.tab();
    await waitFor(() =>
      expect(bridge.todo.edit).toHaveBeenLastCalledWith({
        taskId: "task-1",
        action: "rename",
        itemId: "todo-1",
        content: "Implement todo host",
      }),
    );

    await user.type(
      within(card).getByRole("textbox", { name: "Add todo" }),
      "Verify behavior",
    );
    await user.click(within(card).getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(bridge.todo.edit).toHaveBeenLastCalledWith({
        taskId: "task-1",
        action: "add",
        content: "Verify behavior",
      }),
    );

    await user.click(
      within(card).getByRole("button", { name: "Delete Implement host" }),
    );
    await waitFor(() =>
      expect(bridge.todo.edit).toHaveBeenLastCalledWith({
        taskId: "task-1",
        action: "delete",
        itemId: "todo-1",
      }),
    );

    bridge.todo.edit.mockResolvedValueOnce({ todo: null });
    await user.click(within(card).getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(bridge.todo.edit).toHaveBeenLastCalledWith({
        taskId: "task-1",
        action: "archive",
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Conversation todos" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("anchors opened conversations and follows only near the latest activity", async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    const secondTask: TaskSummary = {
      ...storedTask,
      id: "task-2",
      title: "Second task",
    };
    const firstSnapshot: TaskSnapshot = {
      task: storedTask,
      model: DEFAULT_MODEL,
      thinkingLevel: DEFAULT_THINKING_LEVEL,
      messages: [
        { id: "stored-user", role: "user", content: "Stored prompt" },
        {
          id: "stored-assistant",
          role: "assistant",
          content: "Stored response",
        },
      ],
      todo: null,
    };
    const secondSnapshot: TaskSnapshot = {
      ...firstSnapshot,
      task: secondTask,
      messages: [
        { id: "second-user", role: "user", content: "Second prompt" },
        {
          id: "second-assistant",
          role: "assistant",
          content: "Second response",
        },
      ],
    };
    const bridge = installBridge({
      tasks: [storedTask, secondTask],
      snapshot: firstSnapshot,
    });
    bridge.task.open
      .mockResolvedValueOnce(firstSnapshot)
      .mockResolvedValueOnce(secondSnapshot);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Stored task" }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());

    let activity = screen.getByRole("region", {
      name: "Conversation activity",
    });
    let viewport = activity.parentElement as HTMLDivElement;
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, value: 100, writable: true },
    });
    scrollIntoView.mockClear();
    fireEvent.scroll(viewport);
    await user.click(screen.getByRole("button", { name: "Second task" }));
    expect(await screen.findByText("Second response")).toBeVisible();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());

    activity = screen.getByRole("region", {
      name: "Conversation activity",
    });
    viewport = activity.parentElement as HTMLDivElement;
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, value: 100, writable: true },
    });
    scrollIntoView.mockClear();
    fireEvent.scroll(viewport);

    act(() => {
      bridge.emitTask(secondTask.id, "run-2", {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "assistant-2",
        role: "assistant",
      });
    });
    expect(scrollIntoView).not.toHaveBeenCalled();

    viewport.scrollTop = 590;
    fireEvent.scroll(viewport);
    act(() => {
      bridge.emitTask(secondTask.id, "run-2", {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-2",
        delta: "New response",
      });
    });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "end" });
  });

  it("renders a stored conversation without exposing background runtime activation", async () => {
    const { task } = installBridge({
      tasks: [storedTask],
      snapshot: {
        task: storedTask,
        model: DEFAULT_MODEL,
        thinkingLevel: DEFAULT_THINKING_LEVEL,
        messages: [
          { id: "stored-user", role: "user", content: "Stored prompt" },
          {
            id: "stored-assistant",
            role: "assistant",
            content: "Stored response",
          },
        ],
        todo: null,
      },
    });
    let finishActivation:
      | ((result: { state: "ready" }) => void)
      | undefined;
    task.activate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishActivation = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Stored task" }));

    expect(await screen.findByText("Stored response")).toBeVisible();
    expect(screen.queryByText("Waking agent…")).not.toBeInTheDocument();

    finishActivation?.({ state: "ready" });
  });

  it("reviews Local changes and keeps file browsing available", async () => {
    const localReview: ReviewSnapshot = {
      taskId: storedTask.id,
      revision: 2,
      baselineTree: "local-base",
      files: [{
        id: "local-review",
        path: "src/index.ts",
        previousPath: null,
        status: "modified",
        additions: 2,
        deletions: 1,
        isBinary: false,
        currentSignature: "local-signature",
      }],
    };
    const bridge = installBridge({
      tasks: [storedTask],
      files: ["README.md", "src/index.ts"],
      reviewSnapshot: localReview,
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Stored task" }));
    expect(await screen.findByRole("region", { name: "Changed files summary" })).toHaveTextContent("1 File Changed");
    await user.click(screen.getByRole("button", { name: "Review" }));
    await user.click(await screen.findByRole("button", { name: "Reject src/index.ts" }));
    await waitFor(() =>
      expect(bridge.review.undo).toHaveBeenCalledWith({
        taskId: storedTask.id,
        fileId: "local-review",
        expectedRevision: 2,
        expectedSignature: "local-signature",
      }),
    );
    const sourceDirectory = await screen.findByRole("treeitem", { name: "src" });
    expect(sourceDirectory).toHaveAttribute("aria-expanded", "false");
    await user.click(sourceDirectory);
    await user.click(await screen.findByRole("treeitem", { name: "index.ts" }));

    expect(screen.getByLabelText("File preview")).toHaveTextContent("Contents of src/index.ts");
    expect(screen.getByText("Review")).toBeVisible();
    bridge.files.read.mockResolvedValueOnce({
      path: "src/index.ts",
      content: "Updated local file",
      isBinary: false,
      truncated: false,
      size: 18,
    });
    bridge.emitFiles(storedTask.id);
    await waitFor(() =>
      expect(screen.getByLabelText("File preview")).toHaveTextContent("Updated local file"),
    );
    expect(screen.getByLabelText("File preview")).toHaveClass("h-full", "overflow-auto");
    await user.click(screen.getByRole("button", { name: "Close tab src/index.ts" }));
    expect(screen.getByText("Select a file to preview it.")).toBeVisible();
    expect(screen.queryByLabelText("File preview")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close file workspace" }));
    expect(screen.getByRole("button", { name: "Open files" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open files" }));
    expect(screen.getByRole("complementary", { name: "File workspace" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Open files" })).toBeVisible();
  });

  it("reviews worktree changes and keeps the selected file", async () => {
    const worktreeWorkspace: WorkspaceInfo = {
      ...workspace,
      id: "workspace-worktree",
      name: "worktree-project",
      worktreeAvailable: true,
      branch: "main",
    };
    const worktreeTask: TaskSummary = {
      ...storedTask,
      id: "task-worktree",
      title: "Worktree task",
      executionTarget: "worktree",
      branch: "codey/task-worktree",
      workspace: worktreeWorkspace,
    };
    const reviewSnapshot: ReviewSnapshot = {
      taskId: worktreeTask.id,
      revision: 3,
      baselineTree: "base-tree",
      files: [
        {
          id: "review-1",
          path: "src/app.ts",
          previousPath: null,
          status: "modified",
          additions: 2,
          deletions: 1,
          isBinary: false,
          currentSignature: "sig-1",
        },
        {
          id: "review-2",
          path: "src/other.ts",
          previousPath: null,
          status: "modified",
          additions: 1,
          deletions: 1,
          isBinary: false,
          currentSignature: "sig-2",
        },
      ],
    };
    const bridge = installBridge({
      tasks: [worktreeTask],
      files: ["src/app.ts", "src/other.ts"],
      reviewSnapshot,
      snapshot: {
        task: worktreeTask,
        model: DEFAULT_MODEL,
        thinkingLevel: DEFAULT_THINKING_LEVEL,
        messages: [],
        todo: null,
      },
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Worktree task" }));
    expect(await screen.findByRole("region", { name: "Changed files summary" })).toHaveTextContent("2 Files Changed+3 −2");
    expect(screen.getByRole("region", { name: "Changed files summary" })).toHaveTextContent("src/app.ts");
    await user.click(screen.getByRole("button", { name: "Review" }));
    bridge.review.keep.mockResolvedValueOnce({
      ...reviewSnapshot,
      revision: 4,
      files: [reviewSnapshot.files[0]!],
    });
    await user.click(await screen.findByRole("button", { name: "Accept src/other.ts" }));
    await waitFor(() =>
      expect(bridge.review.keep).toHaveBeenLastCalledWith({
        taskId: worktreeTask.id,
        fileId: "review-2",
        expectedRevision: 3,
        expectedSignature: "sig-2",
      }),
    );
    expect(screen.getByRole("region", { name: "Changed files summary" })).toHaveTextContent("1 File Changed");
    await user.click(
      await screen.findByRole("button", { name: "Review file src/app.ts" }),
    );
    await user.click(await screen.findByRole("button", { name: "File" }));
    await user.click(screen.getByRole("button", { name: "Diff" }));
    await user.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() =>
      expect(bridge.review.keep).toHaveBeenCalledWith({
        taskId: worktreeTask.id,
        fileId: "review-1",
        expectedRevision: 4,
        expectedSignature: "sig-1",
      }),
    );
    expect(screen.queryByRole("region", { name: "Changed files summary" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Open tab src/app.ts" })).toBeVisible();
    await waitFor(() =>
      expect(screen.getByLabelText("File preview")).toHaveTextContent("Contents of src/app.ts"),
    );
  });

  it("starts a task and renders streamed agent output", async () => {
    const { task, emitTask } = installBridge();
    const user = userEvent.setup();
    render(<App />);

    await selectWorkspace(user);
    const composer = await screen.findByRole("textbox", {
      name: "Conversation message",
    });
    await user.type(composer, "Explain this project");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(task.create).toHaveBeenCalledWith({
        title: "Explain this project",
        workspaceId: workspace.id,
        executionTarget: "local",
        accessMode: "full",
        interactionMode: "agent",
      }),
    );
    await waitFor(() =>
      expect(task.start).toHaveBeenCalledWith({
        taskId: "task-new",
        text: "Explain this project",
        model: DEFAULT_MODEL,
        thinkingLevel: DEFAULT_THINKING_LEVEL,
      }),
    );
    await act(async () => {
      emitTask("task-new", "run-1", {
        type: EventType.RUN_STARTED,
        threadId: "task-new",
        runId: "run-1",
      });
      emitTask("task-new", "run-1", {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "assistant-1",
        role: "assistant",
      });
      emitTask("task-new", "run-1", {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-1",
        delta: "This is a desktop app.",
      });
      emitTask("task-new", "run-1", {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "assistant-1",
      });
      emitTask("task-new", "run-1", {
        type: EventType.RUN_FINISHED,
        threadId: "task-new",
        runId: "run-1",
        outcome: { type: "success" },
      });
    });

    expect(screen.getAllByText("Explain this project")).toHaveLength(3);
    expect(screen.getByText("This is a desktop app.")).toBeVisible();
    expect(screen.getByText("completed")).toBeVisible();
  });

  it("queues a follow-up by default while a response is running", async () => {
    const { task, emitTask } = installBridge();
    const user = userEvent.setup();
    render(<App />);

    await selectWorkspace(user);
    const composer = await screen.findByRole("textbox", {
      name: "Conversation message",
    });
    await user.type(composer, "Start working");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(task.start).toHaveBeenCalledOnce());
    act(() => {
      emitTask("task-new", "run-1", {
        type: EventType.RUN_STARTED,
        threadId: "task-new",
        runId: "run-1",
      });
    });

    await user.type(composer, "Check this afterward");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(task.followUp).toHaveBeenCalledWith({
        taskId: "task-new",
        text: "Check this afterward",
      }),
    );
    expect(task.steer).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("region", { name: "Pending messages" }),
    ).not.toBeInTheDocument();

    act(() => {
      emitTask("task-new", "run-1", {
        type: EventType.CUSTOM,
        name: AGENT_UI_CUSTOM_EVENT.PI_QUEUE_UPDATED,
        value: { steering: [], followUp: ["Check this afterward"] },
      });
    });
    expect(
      within(screen.getByRole("region", { name: "Pending messages" })).getByText(
        "Check this afterward",
      ),
    ).toBeVisible();

    act(() => {
      emitTask("task-new", "run-1", {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "queued-user-1",
        role: "user",
      });
      emitTask("task-new", "run-1", {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "queued-user-1",
        delta: "Check this afterward",
      });
      emitTask("task-new", "run-1", {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "queued-user-1",
      });
      emitTask("task-new", "run-1", {
        type: EventType.CUSTOM,
        name: AGENT_UI_CUSTOM_EVENT.PI_QUEUE_UPDATED,
        value: { steering: [], followUp: [] },
      });
    });
    expect(
      screen.queryByRole("region", { name: "Pending messages" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("Check this afterward")).toHaveLength(1);
  });

  it("promotes a queued row to steer and can restore the remaining queue", async () => {
    const { task, emitTask } = installBridge();
    const user = userEvent.setup();
    render(<App />);

    await selectWorkspace(user);
    const composer = await screen.findByRole("textbox", {
      name: "Conversation message",
    });
    await user.type(composer, "Start working");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(task.start).toHaveBeenCalledOnce());
    act(() => {
      emitTask("task-new", "run-1", {
        type: EventType.RUN_STARTED,
        threadId: "task-new",
        runId: "run-1",
      });
    });

    task.clearQueue.mockResolvedValueOnce({
      steering: [],
      followUp: ["First queued", "Check afterward"],
    });
    act(() => {
      emitTask("task-new", "run-1", {
        type: EventType.CUSTOM,
        name: AGENT_UI_CUSTOM_EVENT.PI_QUEUE_UPDATED,
        value: {
          steering: [],
          followUp: ["First queued", "Check afterward"],
        },
      });
    });
    const pending = screen.getByRole("region", { name: "Pending messages" });
    expect(screen.getAllByRole("button", { name: "Stop response" })).toHaveLength(
      1,
    );
    expect(screen.queryByRole("button", { name: "Queue" })).not.toBeInTheDocument();
    await user.click(within(pending).getAllByRole("button", { name: "Steer" })[0]!);

    await waitFor(() =>
      expect(task.steer).toHaveBeenCalledWith({
        taskId: "task-new",
        text: "First queued",
      }),
    );
    expect(task.followUp).toHaveBeenCalledWith({
      taskId: "task-new",
      text: "Check afterward",
    });

    task.clearQueue.mockResolvedValueOnce({
      steering: ["First queued"],
      followUp: ["Check afterward"],
    });
    act(() => {
      emitTask("task-new", "run-1", {
        type: EventType.CUSTOM,
        name: AGENT_UI_CUSTOM_EVENT.PI_QUEUE_UPDATED,
        value: {
          steering: ["First queued"],
          followUp: ["Check afterward"],
        },
      });
    });
    const restore = screen.getByRole("button", { name: "Restore queued" });
    await waitFor(() => expect(restore).toBeEnabled());
    await user.click(restore);

    expect(task.clearQueue).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(composer).toHaveValue("First queued\n\nCheck afterward"),
    );
    expect(
      screen.queryByRole("region", { name: "Pending messages" }),
    ).not.toBeInTheDocument();
  });

  it("renders folded AG-UI reasoning, tool input, and tool results", async () => {
    const { task, emitTask } = installBridge();
    const user = userEvent.setup();
    render(<App />);

    await selectWorkspace(user);
    const composer = await screen.findByRole("textbox", {
      name: "Conversation message",
    });
    await user.type(composer, "Inspect the project");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(task.start).toHaveBeenCalledOnce());

    act(() => {
      emitTask("task-new", "run-1", {
        type: EventType.RUN_STARTED,
        threadId: "task-new",
        runId: "run-1",
      });
      emitTask("task-new", "run-1", {
        type: EventType.REASONING_MESSAGE_START,
        messageId: "reasoning-1",
        role: "reasoning",
      });
      emitTask("task-new", "run-1", {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "reasoning-1",
        delta: "Inspect the project first.",
      });
      emitTask("task-new", "run-1", {
        type: EventType.REASONING_MESSAGE_END,
        messageId: "reasoning-1",
      });
      emitTask("task-new", "run-1", {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool-1",
        toolCallName: "read",
        parentMessageId: "assistant-1",
      });
      emitTask("task-new", "run-1", {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-1",
        delta: '{"path":"README.md"}',
      });
      emitTask("task-new", "run-1", {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "tool-execution:tool-1",
        activityType: "tool_execution",
        content: {
          toolCallId: "tool-1",
          toolName: "read",
          status: "succeeded",
        },
        replace: true,
      });
      emitTask("task-new", "run-1", {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "tool-result-1",
        toolCallId: "tool-1",
        content: "Project contents",
        role: "tool",
      });
    });

    expect(screen.getByText("read")).toBeVisible();
    expect(screen.getByText("Completed")).toBeVisible();
    expect(
      within(
        screen.getByRole("region", { name: "Conversation activity" }),
      ).queryByText("Grok 4.6"),
    ).not.toBeInTheDocument();
    const reasoning = screen.getByText("Thinking").closest("details");
    const toolDetails = screen.getByText("read").closest("details");
    expect(reasoning).not.toHaveAttribute("open");
    expect(toolDetails).not.toHaveAttribute("open");
    await user.click(within(reasoning!).getByText("Thinking"));
    expect(
      within(reasoning!).getByText("Inspect the project first."),
    ).toBeVisible();
    await user.click(within(toolDetails!).getByText("read"));
    expect(within(toolDetails!).getByText(/"path": "README.md"/)).toBeVisible();
    expect(within(toolDetails!).getByText("Project contents")).toBeVisible();
  });

  it("keeps child activity selectable inside its conversation", async () => {
    const { task, emitTask } = installBridge();
    const user = userEvent.setup();
    render(<App />);

    await selectWorkspace(user);
    const composer = await screen.findByRole("textbox", {
      name: "Conversation message",
    });
    await user.type(composer, "Delegate inspection");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(task.start).toHaveBeenCalledOnce());
    const timestamp = new Date().toISOString();
    const lead: AgentSummary = {
      id: "lead:task-new",
      taskId: "task-new",
      parentAgentId: null,
      role: "lead",
      profileId: null,
      capability: "write",
      status: "running",
      model: DEFAULT_MODEL,
      thinkingLevel: DEFAULT_THINKING_LEVEL,
      assignment: null,
      result: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const child: AgentSummary = {
      ...lead,
      id: "agent-researcher",
      parentAgentId: lead.id,
      role: "subagent",
      profileId: "researcher",
      capability: "read",
      assignment: "Inspect runtime",
    };

    act(() => {
      emitTask(
        "task-new",
        "run-1",
        {
          type: EventType.RUN_STARTED,
          threadId: "task-new",
          runId: "lead-run",
        },
        lead,
      );
      emitTask(
        "task-new",
        "run-1",
        {
          type: EventType.RUN_STARTED,
          threadId: "task-new",
          runId: "child-run",
        },
        child,
      );
      emitTask(
        "task-new",
        "run-1",
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "child-answer",
          role: "assistant",
        },
        child,
      );
      emitTask(
        "task-new",
        "run-1",
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "child-answer",
          delta: "Child runtime evidence",
        },
        child,
      );
      emitTask(
        "task-new",
        "run-1",
        {
          type: EventType.TEXT_MESSAGE_END,
          messageId: "child-answer",
        },
        child,
      );
    });

    const childButton = screen.getByRole("button", {
      name: /Inspect runtime/,
    });
    await user.click(childButton);
    expect(screen.getByText("Child runtime evidence")).toBeVisible();
    expect(
      screen.getByRole("navigation", { name: "Agents" }),
    ).toBeVisible();
  });

  it("inserts a newline with Shift+Return without sending", async () => {
    const { task } = installBridge();
    const user = userEvent.setup();
    render(<App />);

    const composer = await screen.findByRole("textbox", {
      name: "Conversation message",
    });
    await user.type(composer, "First line");
    await user.keyboard("{Shift>}{Enter}{/Shift}Second line");

    expect(composer).toHaveValue("First line\nSecond line");
    expect(task.start).not.toHaveBeenCalled();
  });

  it("clamps thinking level when the selected model has fewer options", async () => {
    installBridge();
    const user = userEvent.setup();
    render(<App />);

    await selectWorkspace(user);
    const modelSettings = await screen.findByRole("button", {
      name: "Model and reasoning",
    });
    await user.click(modelSettings);
    await user.click(
      screen.getByRole("radio", { name: "DeepSeek V4 Flash" }),
    );

    expect(modelSettings).toHaveTextContent("DeepSeek V4 Flash");
    expect(modelSettings).toHaveTextContent("High");
    const reasoning = screen.getByRole("radiogroup", {
      name: "Reasoning",
    });
    expect(within(reasoning).getByRole("radio", { name: "Off" })).toBeVisible();
    expect(within(reasoning).getByRole("radio", { name: "Low" })).toBeVisible();
    expect(within(reasoning).getByRole("radio", { name: "High" })).toBeVisible();
    expect(within(reasoning).getByRole("radio", { name: "Max" })).toBeVisible();
    expect(
      within(reasoning).queryByRole("radio", { name: "Medium" }),
    ).not.toBeInTheDocument();
  });

  it("starts the next turn with the model and thinking level selected in the composer", async () => {
    const { task, emitTask } = installBridge();
    const user = userEvent.setup();
    render(<App />);

    await selectWorkspace(user);
    const modelSettings = await screen.findByRole("button", {
      name: "Model and reasoning",
    });
    await user.click(modelSettings);
    await user.click(screen.getByRole("radio", { name: "GPT-5.6 Sol" }));
    await user.click(screen.getByRole("radio", { name: "Extra High" }));
    const composer = screen.getByRole("textbox", {
      name: "Conversation message",
    });
    await user.type(composer, "Use OpenAI");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(task.start).toHaveBeenCalledWith({
        taskId: "task-new",
        text: "Use OpenAI",
        model: { provider: "openai", id: "gpt-5.6-sol" },
        thinkingLevel: "xhigh",
      }),
    );
    act(() => {
      emitTask("task-new", "run-1", {
        type: EventType.RUN_STARTED,
        threadId: "task-new",
        runId: "run-1",
      });
    });
    expect(modelSettings).toBeDisabled();
  });

  it("exposes cancellation while a task is running", async () => {
    const { task, emitTask } = installBridge();
    const user = userEvent.setup();
    render(<App />);

    await selectWorkspace(user);
    const composer = await screen.findByRole("textbox", {
      name: "Conversation message",
    });
    await user.type(composer, "Wait for me");
    await user.click(
      screen.getByRole("button", { name: "Start conversation" }),
    );
    emitTask("task-new", "run-1", {
      type: EventType.RUN_STARTED,
      threadId: "task-new",
      runId: "run-1",
    });

    task.cancel.mockResolvedValueOnce({
      cancelled: true,
      queued: {
        steering: ["Change immediately"],
        followUp: ["Check afterward"],
      },
    });
    await user.click(await screen.findByRole("button", { name: "Stop response" }));
    expect(task.cancel).toHaveBeenCalledWith({ taskId: "task-new" });
    await waitFor(() =>
      expect(composer).toHaveValue("Change immediately\n\nCheck afterward"),
    );
  });

  it("keeps concurrent task streams isolated while switching", async () => {
    const { task, emitTask } = installBridge();
    const user = userEvent.setup();
    render(<App />);

    await selectWorkspace(user);
    const composer = await screen.findByRole("textbox", {
      name: "Conversation message",
    });
    await user.type(composer, "First agent");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(task.start).toHaveBeenCalledWith({
        taskId: "task-new",
        text: "First agent",
        model: DEFAULT_MODEL,
        thinkingLevel: DEFAULT_THINKING_LEVEL,
      }),
    );
    act(() => {
      emitTask("task-new", "run-1", {
        type: EventType.RUN_STARTED,
        threadId: "task-new",
        runId: "run-1",
      });
      emitTask("task-new", "run-1", {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "assistant-1",
        role: "assistant",
      });
      emitTask("task-new", "run-1", {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-1",
        delta: "First output",
      });
      emitTask("task-new", "run-1", {
        type: EventType.CUSTOM,
        name: AGENT_UI_CUSTOM_EVENT.PI_QUEUE_UPDATED,
        value: { steering: [], followUp: ["First queued"] },
      });
    });
    expect(screen.getByText("First queued")).toBeVisible();

    await user.click(
      screen.getByRole("button", {
        name: `New conversation in ${workspace.name}`,
      }),
    );
    expect(
      screen.queryByRole("region", { name: "Pending messages" }),
    ).not.toBeInTheDocument();
    await user.type(composer, "Second agent");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(task.start).toHaveBeenCalledWith({
        taskId: "task-new-2",
        text: "Second agent",
        model: DEFAULT_MODEL,
        thinkingLevel: DEFAULT_THINKING_LEVEL,
      }),
    );
    act(() => {
      emitTask("task-new-2", "run-2", {
        type: EventType.RUN_STARTED,
        threadId: "task-new-2",
        runId: "run-2",
      });
      emitTask("task-new-2", "run-2", {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "assistant-2",
        role: "assistant",
      });
      emitTask("task-new-2", "run-2", {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-2",
        delta: "Second output",
      });
      emitTask("task-new", "run-1", {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-1",
        delta: " continues",
      });
    });

    expect(screen.getByText("Second output")).toBeVisible();
    expect(screen.queryByText("First output continues")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "First agent" }));
    expect(screen.getByText("First output continues")).toBeVisible();
    expect(screen.getByText("First queued")).toBeVisible();
    expect(screen.queryByText("Second output")).not.toBeInTheDocument();
  });
});
