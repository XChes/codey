import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  safeStorage,
  screen,
  session,
} from "electron";
import { IPC_CHANNELS } from "../shared/ipc";
import { fileListInputSchema, fileReadInputSchema } from "../shared/files";
import {
  reviewActionInputSchema,
  reviewFileInputSchema,
  reviewSnapshotInputSchema,
} from "../shared/review";
import { settingsUpdateSchema, type ThemePreference } from "../shared/settings";
import type {
  SupportedModelSelection,
  ThinkingLevel,
} from "../shared/models";
import {
  providerCredentialDeleteInputSchema,
  providerCredentialSetInputSchema,
} from "../shared/provider-credentials";
import {
  DEFAULT_TASK_ACCESS_MODE,
  DEFAULT_TASK_INTERACTION_MODE,
  taskAccessModeUpdateInputSchema,
  taskCreateInputSchema,
  taskInteractionModeUpdateInputSchema,
  taskOpenInputSchema,
  taskPermissionDecisionInputSchema,
  taskStartInputSchema,
  taskTargetInputSchema,
  taskTextInputSchema,
} from "../shared/task";
import { todoEditInputSchema } from "../shared/todo";
import {
  githubCloneInputSchema,
  workspaceCreateInputSchema,
  workspaceTargetInputSchema,
} from "../shared/workspace";
import { AgentHostClient } from "./agent-host-client";
import { AgentHostPool, type BootProfile } from "./agent-host-pool";
import { AppStore, type StoredTask } from "./app-store";
import { FileBrowserService } from "./file-browser-service";
import { GitReviewService } from "./git-review-service";
import { GitWorktreeService } from "./git-worktree-service";
import { GitHubService } from "./github-service";
import { ProviderCredentialStore } from "./provider-credential-store";
import { TaskController } from "./task-controller";
import {
  TaskRuntimeRegistry,
  type AgentRuntimeConfig,
  type TaskRuntimeCallbacks,
} from "./task-runtime-registry";
import {
  constrainWindowState,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
} from "./window-state";
import {
  createWorkspaceDirectory,
  registerWorkspace,
  requireAvailableWorkspace,
  requireEmptyWorkspace,
  refreshWorkspaceCapability,
} from "./workspace";

let mainWindow: BrowserWindow | null = null;
let appStore: AppStore | null = null;
let taskRuntimes: TaskRuntimeRegistry | null = null;
let agentHostPool: AgentHostPool | null = null;
let gitWorktrees: GitWorktreeService | null = null;
let fileBrowser: FileBrowserService | null = null;
let gitReview: GitReviewService | null = null;
let providerCredentials: ProviderCredentialStore | null = null;

function themeBackground(theme: ThemePreference): string {
  const dark = theme === "dark" || (theme === "system" && nativeTheme.shouldUseDarkColors);
  return dark ? "#1c1c1a" : "#faf9f6";
}

function assertTrustedSender(sender: Electron.WebContents): void {
  if (!mainWindow || sender.id !== mainWindow.webContents.id) {
    throw new Error("Untrusted renderer request.");
  }
}

function taskTitle(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, 80);
}

function registerIpc(
  store: AppStore,
  credentials: ProviderCredentialStore,
  runtimes: TaskRuntimeRegistry,
  worktrees: GitWorktreeService,
  files: FileBrowserService,
  review: GitReviewService,
): void {
  const github = new GitHubService(
    undefined,
    app.isPackaged
      ? join(process.resourcesPath, "bin", "gh")
      : join(app.getAppPath(), "resources", "gh", process.arch, "gh"),
  );

  ipcMain.handle(IPC_CHANNELS.workspaceList, async (event) => {
    assertTrustedSender(event.sender);
    await Promise.all(
      store.listWorkspaces().map(async (workspace) => {
        try {
          // One slow or unavailable repository must not stall the whole
          // listing; fall back to its last known capability past the grace.
          await Promise.race([
            refreshWorkspaceCapability(store, workspace.id, worktrees),
            new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 3_000);
              timer.unref?.();
            }),
          ]);
        } catch {
          // Keep unavailable projects listed with their last known capability.
        }
      }),
    );
    return store.listWorkspaces();
  });

  ipcMain.handle(IPC_CHANNELS.workspaceChoose, async (event) => {
    assertTrustedSender(event.sender);
    if (mainWindow === null) {
      throw new Error("Application window is unavailable.");
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
    });
    if (result.canceled) {
      return null;
    }
    const selectedPath = result.filePaths[0];
    if (selectedPath === undefined) {
      throw new Error("Workspace selection returned no directory.");
    }
    return registerWorkspace(store, selectedPath, worktrees);
  });

  ipcMain.handle(IPC_CHANNELS.workspaceCreate, async (event, input: unknown) => {
    assertTrustedSender(event.sender);
    const { name } = workspaceCreateInputSchema.parse(input);
    if (mainWindow === null) {
      throw new Error("Application window is unavailable.");
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose where to create the project",
      buttonLabel: "Create Here",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled) return null;
    const parentPath = result.filePaths[0];
    if (parentPath === undefined) {
      throw new Error("Project location selection returned no directory.");
    }
    const selectedPath = await createWorkspaceDirectory(parentPath, name);
    return registerWorkspace(store, selectedPath, worktrees);
  });

  ipcMain.handle(IPC_CHANNELS.workspaceActivate, (event, input: unknown) => {
    assertTrustedSender(event.sender);
    const { workspaceId } = workspaceTargetInputSchema.parse(input);
    const workspace = store.touchWorkspace(workspaceId);
    prewarmWorkspaceHost(workspace.path);
    return workspace;
  });

  ipcMain.handle(IPC_CHANNELS.workspaceGitHubList, async (event) => {
    assertTrustedSender(event.sender);
    return github.listRepositories();
  });

  ipcMain.handle(
    IPC_CHANNELS.workspaceGitHubClone,
    async (event, input: unknown) => {
      assertTrustedSender(event.sender);
      const { nameWithOwner } = githubCloneInputSchema.parse(input);
      if (mainWindow === null) {
        throw new Error("Application window is unavailable.");
      }
      const result = await dialog.showOpenDialog(mainWindow, {
        title: `Choose an empty folder for ${nameWithOwner}`,
        buttonLabel: "Clone Here",
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled) return null;
      const selectedPath = result.filePaths[0];
      if (selectedPath === undefined) {
        throw new Error("Clone destination selection returned no directory.");
      }
      const destination = await requireEmptyWorkspace(selectedPath);
      await github.cloneRepository(nameWithOwner, destination);
      return registerWorkspace(store, destination, worktrees);
    },
  );

  ipcMain.handle(IPC_CHANNELS.settingsGet, (event) => {
    assertTrustedSender(event.sender);
    return store.getSettings();
  });

  ipcMain.handle(IPC_CHANNELS.settingsUpdate, (event, input: unknown) => {
    assertTrustedSender(event.sender);
    const update = settingsUpdateSchema.parse(input);
    const settings = store.updateSettings(update);
    nativeTheme.themeSource = settings.theme;
    mainWindow?.setBackgroundColor(themeBackground(settings.theme));
    return settings;
  });

  ipcMain.handle(IPC_CHANNELS.credentialsList, (event) => {
    assertTrustedSender(event.sender);
    return credentials.list();
  });

  ipcMain.handle(IPC_CHANNELS.credentialsSet, (event, input: unknown) => {
    assertTrustedSender(event.sender);
    const result = credentials.set(providerCredentialSetInputSchema.parse(input));
    // Parked hosts hold the previous key material in their environment.
    agentHostPool?.flushBooted();
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.credentialsDelete, (event, input: unknown) => {
    assertTrustedSender(event.sender);
    const { provider } = providerCredentialDeleteInputSchema.parse(input);
    const result = credentials.delete(provider);
    agentHostPool?.flushBooted();
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.taskList, (event) => {
    assertTrustedSender(event.sender);
    return store.listTasks();
  });

  ipcMain.handle(IPC_CHANNELS.taskCreate, async (event, input: unknown) => {
    assertTrustedSender(event.sender);
    const {
      title,
      workspaceId,
      executionTarget,
      accessMode,
      interactionMode,
    } =
      taskCreateInputSchema.parse(input);
    const workspace = await requireAvailableWorkspace(store, workspaceId);
    return {
      task: await runtimes.create(
        taskTitle(title),
        workspace.id,
        executionTarget,
        accessMode,
        interactionMode,
      ),
    };
  });

  ipcMain.handle(IPC_CHANNELS.taskOpen, async (event, input: unknown) => {
    assertTrustedSender(event.sender);
    const { taskId } = taskOpenInputSchema.parse(input);
    return runtimes.open(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.taskActivate, async (event, input: unknown) => {
    assertTrustedSender(event.sender);
    const { taskId } = taskTargetInputSchema.parse(input);
    return runtimes.activate(taskId);
  });

  ipcMain.handle(
    IPC_CHANNELS.taskAccessModeUpdate,
    async (event, input: unknown) => {
      assertTrustedSender(event.sender);
      const { taskId, accessMode } =
        taskAccessModeUpdateInputSchema.parse(input);
      return runtimes.updateAccessMode(taskId, accessMode);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.taskInteractionModeUpdate,
    async (event, input: unknown) => {
      assertTrustedSender(event.sender);
      const { taskId, interactionMode } =
        taskInteractionModeUpdateInputSchema.parse(input);
      return runtimes.updateInteractionMode(taskId, interactionMode);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.taskPermissionDecide,
    async (event, input: unknown) => {
      assertTrustedSender(event.sender);
      const { taskId, requestId, allowed } =
        taskPermissionDecisionInputSchema.parse(input);
      return {
        resolved: await runtimes.resolvePermission(
          taskId,
          requestId,
          allowed,
        ),
      };
    },
  );

  ipcMain.handle(IPC_CHANNELS.taskStart, async (event, input: unknown) => {
    assertTrustedSender(event.sender);
    const task = taskStartInputSchema.parse(input);
    return runtimes.start(
      task.taskId,
      task.text,
      task.model,
      task.thinkingLevel,
    );
  });

  ipcMain.handle(IPC_CHANNELS.taskSteer, async (event, input: unknown) => {
    assertTrustedSender(event.sender);
    const task = taskTextInputSchema.parse(input);
    return runtimes.steer(task.taskId, task.text);
  });

  ipcMain.handle(IPC_CHANNELS.taskFollowUp, async (event, input: unknown) => {
    assertTrustedSender(event.sender);
    const task = taskTextInputSchema.parse(input);
    return runtimes.followUp(task.taskId, task.text);
  });

  ipcMain.handle(IPC_CHANNELS.taskClearQueue, async (event, input: unknown) => {
    assertTrustedSender(event.sender);
    const { taskId } = taskTargetInputSchema.parse(input);
    return runtimes.clearQueue(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.taskCancel, (event, input: unknown) => {
    assertTrustedSender(event.sender);
    const { taskId } = taskTargetInputSchema.parse(input);
    return runtimes.cancel(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.todoEdit, async (event, input: unknown) => {
    assertTrustedSender(event.sender);
    const { taskId, ...operation } = todoEditInputSchema.parse(input);
    return runtimes.editTodo(taskId, operation);
  });

  ipcMain.handle(IPC_CHANNELS.filesList, async (event, input: unknown) => {
    assertTrustedSender(event.sender);
    return files.list(fileListInputSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.filesRead, async (event, input: unknown) => {
    assertTrustedSender(event.sender);
    return files.read(fileReadInputSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.reviewSnapshot, async (event, input: unknown) => {
    assertTrustedSender(event.sender);
    return review.snapshot(reviewSnapshotInputSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.reviewFile, async (event, input: unknown) => {
    assertTrustedSender(event.sender);
    return review.file(reviewFileInputSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.reviewKeep, async (event, input: unknown) => {
    assertTrustedSender(event.sender);
    return review.keep(reviewActionInputSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.reviewUndo, async (event, input: unknown) => {
    assertTrustedSender(event.sender);
    return review.undo(reviewActionInputSchema.parse(input));
  });
}

// Async work (task events, runtime state, disposal notifications) can land
// between webContents destruction and the window's `closed` event; sending
// there throws an uncaught "Object has been destroyed" and kills main.
function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  const contents = mainWindow.webContents;
  if (contents.isDestroyed()) return;
  contents.send(channel, payload);
}

function logMainProcessFailure(kind: string, error: unknown): void {
  try {
    const detail =
      error instanceof Error ? error.stack ?? error.message : String(error);
    appendFileSync(
      join(app.getPath("userData"), "main-process-failures.log"),
      `${new Date().toISOString()} ${kind}: ${detail}\n`,
    );
  } catch {
    // Logging must never take the process down with it.
  }
}

// Two app instances share one SQLite store and session directory; the second
// instance's startup sweep would clobber the first one's live runs.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}
app.on("second-instance", () => {
  if (mainWindow !== null) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

process.on("uncaughtException", (error) => {
  logMainProcessFailure("uncaughtException", error);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logMainProcessFailure("unhandledRejection", reason);
});
// A dev-launched app loses its stdout/stderr pipes when the launching
// terminal closes; without these guards the next console write raises an
// uncaught EPIPE and kills main.
process.stdout.on("error", () => undefined);
process.stderr.on("error", () => undefined);

// Selecting a project is the earliest signal a conversation may start there.
// Boot a sandbox worker for the default new-conversation profile so the first
// prompt only pays session attach plus model latency.
function prewarmWorkspaceHost(workspacePath: string): void {
  if (agentHostPool === null || providerCredentials === null) return;
  const apiKeys = providerCredentials.getApiKeys();
  if (Object.keys(apiKeys).length === 0) return;
  void agentHostPool
    .prewarmBooted({
      cwd: workspacePath,
      sessionDir: join(app.getPath("userData"), "pi-sessions"),
      accessMode: DEFAULT_TASK_ACCESS_MODE,
      interactionMode: DEFAULT_TASK_INTERACTION_MODE,
      agentCapability: "write",
      apiKeys,
    })
    .catch(() => undefined);
}

function createTaskController(
  storedTask: StoredTask,
  callbacks: TaskRuntimeCallbacks,
  initialModel?: SupportedModelSelection,
  initialThinkingLevel?: ThinkingLevel,
  agent?: AgentRuntimeConfig,
): TaskController {
  if (providerCredentials === null) {
    throw new Error("Provider credential store is unavailable");
  }
  const configuredApiKeys = providerCredentials.getApiKeys();
  const projection = appStore?.getTaskConversationProjection(storedTask.id);
  const selectedModel = initialModel ?? projection?.model;
  const selectedThinkingLevel =
    initialThinkingLevel ?? projection?.thinkingLevel;
  const sessionReference =
    agent === undefined ? storedTask.sessionReference : agent.sessionReference;
  const selectedApiKey =
    selectedModel === undefined
      ? undefined
      : configuredApiKeys[selectedModel.provider];
  const apiKeys: Record<string, string> =
    selectedModel === undefined
      ? configuredApiKeys
      : selectedApiKey === undefined
        ? {}
        : { [selectedModel.provider]: selectedApiKey };
  if (
    selectedModel !== undefined &&
    apiKeys[selectedModel.provider] === undefined
  ) {
    throw new Error(`${selectedModel.provider} API key is not configured`);
  }
  if (Object.keys(apiKeys).length === 0) {
    throw new Error("No model API keys are configured");
  }

  const hostCwd = app.getPath("userData");
  if (agentHostPool === null) {
    throw new Error("Agent Host pool is unavailable");
  }
  const bootProfile: BootProfile = {
    cwd: storedTask.executionPath,
    sessionDir: join(hostCwd, "pi-sessions"),
    accessMode: storedTask.accessMode,
    interactionMode: storedTask.interactionMode,
    agentCapability: agent?.capability ?? "write",
    apiKeys,
  };
  return new TaskController(
    {
      threadId: storedTask.id,
      cwd: storedTask.executionPath,
      accessMode: storedTask.accessMode,
      interactionMode: storedTask.interactionMode,
      sessionDir: join(hostCwd, "pi-sessions"),
      agentId: agent?.id ?? storedTask.id,
      agentRole: agent?.role ?? "lead",
      agentCapability: agent?.capability ?? "write",
      ...(agent?.profileInstructions === undefined
        ? {}
        : { profileInstructions: agent.profileInstructions }),
      ...(sessionReference === undefined
        ? {}
        : { sessionReference }),
      ...(selectedModel === undefined ? {} : { initialModel: selectedModel }),
      ...(selectedThinkingLevel === undefined
        ? {}
        : { initialThinkingLevel: selectedThinkingLevel }),
      apiKeys,
    },
    (onEvent, onPermissionRequest, onDelegationRequest) => {
      const connection = agentHostPool!.acquire(
        onEvent,
        onPermissionRequest,
        onDelegationRequest,
        bootProfile,
      );
      if (connection.booted) {
        // A prewarmed host was claimed; keep one warm for the next one.
        void agentHostPool!.prewarmBooted(bootProfile).catch(() => undefined);
      }
      return connection;
    },
    callbacks.emit,
    callbacks.saveSessionReference,
    callbacks.settled,
    callbacks.saveSnapshot,
    callbacks.connectionLost,
    callbacks.permissionRequest,
    callbacks.delegationRequest,
  );
}

function createWindow(store: AppStore): void {
  const settings = store.getSettings();
  const windowState = constrainWindowState(
    settings.window,
    screen.getPrimaryDisplay().workAreaSize,
  );

  nativeTheme.themeSource = settings.theme;

  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    center: true,
    show: false,
    title: "Desktop Agent",
    titleBarStyle: "hiddenInset",
    backgroundColor: themeBackground(settings.theme),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (windowState.maximized) {
    mainWindow.maximize();
  }

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());

  mainWindow.on("close", () => {
    if (!mainWindow) return;
    const bounds = mainWindow.getNormalBounds();
    const constrained = constrainWindowState(
      {
        width: bounds.width,
        height: bounds.height,
        maximized: mainWindow.isMaximized(),
      },
      screen.getDisplayMatching(bounds).workAreaSize,
    );

    try {
      store.updateWindow(constrained);
    } catch (error) {
      console.error("Failed to persist window state", error);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

void app
  .whenReady()
  .then(() => {
    session.defaultSession.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );

    appStore = new AppStore(join(app.getPath("userData"), "app.sqlite"));
    providerCredentials = new ProviderCredentialStore(appStore, safeStorage);
    appStore.markRunningTasksInterrupted();
    const hostCwd = app.getPath("userData");
    gitWorktrees = new GitWorktreeService(join(hostCwd, "worktrees"));
    fileBrowser = new FileBrowserService(appStore);
    gitReview = new GitReviewService(
      appStore,
      gitWorktrees,
      join(hostCwd, "review-indexes"),
    );
    fileBrowser.subscribe((taskId, revision) => {
      sendToRenderer(IPC_CHANNELS.filesChanged, { taskId, revision });
      sendToRenderer(IPC_CHANNELS.reviewChanged, { taskId, revision });
    });
    agentHostPool = new AgentHostPool(
      () =>
        new AgentHostClient({
          entryPath: join(__dirname, "../agent-host/index.mjs"),
          cwd: hostCwd,
        }),
    );
    void agentHostPool.prewarm().catch((error: unknown) => {
      console.error("Failed to pre-warm Agent Host", error);
    });
    taskRuntimes = new TaskRuntimeRegistry(
      appStore,
      createTaskController,
      (envelope) => sendToRenderer(IPC_CHANNELS.taskEvent, envelope),
      async (workspace) => {
        await requireAvailableWorkspace(appStore!, workspace.id);
      },
      {
        sendRuntimeState: (envelope) =>
          sendToRenderer(IPC_CHANNELS.taskRuntimeState, envelope),
        sendPermissionRequest: (envelope) =>
          sendToRenderer(IPC_CHANNELS.taskPermissionRequest, envelope),
        recordTiming: (metric, durationMs, taskId) => {
          console.debug("Agent runtime timing", {
            metric,
            taskId,
            durationMs: Math.round(durationMs * 10) / 10,
          });
        },
        worktrees: gitWorktrees,
        review: gitReview,
      },
    );
    registerIpc(
      appStore,
      providerCredentials,
      taskRuntimes,
      gitWorktrees,
      fileBrowser,
      gitReview,
    );
    createWindow(appStore);

    nativeTheme.on("updated", () => {
      if (appStore && mainWindow) {
        mainWindow.setBackgroundColor(
          themeBackground(appStore.getSettings().theme),
        );
      }
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0 && appStore) {
        createWindow(appStore);
      }
    });
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown startup error";
    dialog.showErrorBox("Desktop Agent could not start", message);
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
    return;
  }
  // With no window there is nothing to keep warm: drop every idle runtime
  // (running conversations keep theirs) so no sandbox workers idle unseen.
  taskRuntimes?.disposeIdleRuntimes();
});

app.on("will-quit", () => {
  ipcMain.removeHandler(IPC_CHANNELS.workspaceList);
  ipcMain.removeHandler(IPC_CHANNELS.workspaceChoose);
  ipcMain.removeHandler(IPC_CHANNELS.workspaceCreate);
  ipcMain.removeHandler(IPC_CHANNELS.workspaceActivate);
  ipcMain.removeHandler(IPC_CHANNELS.workspaceGitHubList);
  ipcMain.removeHandler(IPC_CHANNELS.workspaceGitHubClone);
  ipcMain.removeHandler(IPC_CHANNELS.settingsGet);
  ipcMain.removeHandler(IPC_CHANNELS.settingsUpdate);
  ipcMain.removeHandler(IPC_CHANNELS.credentialsList);
  ipcMain.removeHandler(IPC_CHANNELS.credentialsSet);
  ipcMain.removeHandler(IPC_CHANNELS.credentialsDelete);
  ipcMain.removeHandler(IPC_CHANNELS.taskList);
  ipcMain.removeHandler(IPC_CHANNELS.taskCreate);
  ipcMain.removeHandler(IPC_CHANNELS.taskOpen);
  ipcMain.removeHandler(IPC_CHANNELS.taskActivate);
  ipcMain.removeHandler(IPC_CHANNELS.taskStart);
  ipcMain.removeHandler(IPC_CHANNELS.taskSteer);
  ipcMain.removeHandler(IPC_CHANNELS.taskFollowUp);
  ipcMain.removeHandler(IPC_CHANNELS.taskClearQueue);
  ipcMain.removeHandler(IPC_CHANNELS.taskCancel);
  ipcMain.removeHandler(IPC_CHANNELS.todoEdit);
  ipcMain.removeHandler(IPC_CHANNELS.filesList);
  ipcMain.removeHandler(IPC_CHANNELS.filesRead);
  ipcMain.removeHandler(IPC_CHANNELS.reviewSnapshot);
  ipcMain.removeHandler(IPC_CHANNELS.reviewFile);
  ipcMain.removeHandler(IPC_CHANNELS.reviewKeep);
  ipcMain.removeHandler(IPC_CHANNELS.reviewUndo);
  fileBrowser?.close();
  fileBrowser = null;
  gitReview?.close();
  gitReview = null;
  taskRuntimes?.terminateAll();
  taskRuntimes = null;
  agentHostPool?.terminate();
  agentHostPool = null;
  providerCredentials = null;
  appStore?.close();
  appStore = null;
});
