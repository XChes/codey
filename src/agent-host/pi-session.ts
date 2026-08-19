import { existsSync, rmSync, writeFileSync } from "node:fs";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
  CURRENT_SESSION_VERSION,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type SessionHeader,
  type SessionManager as PiSessionManager,
} from "@earendil-works/pi-coding-agent";

import type {
  AgentInitializeParams,
  AgentTranscriptMessage,
} from "../shared/agent-host-protocol.js";
import type { ThinkingLevel } from "../shared/models.js";
import type {
  ConversationTodoState,
  TodoEditOperation,
} from "../shared/todo.js";
import type { TaskInteractionMode } from "../shared/task.js";
import type {
  AgentCapability,
  AgentRole,
  Delegation,
} from "../shared/agent.js";
import {
  ConversationTodos,
  TODO_CONTEXT_MESSAGE_TYPE,
  TODO_CONTINUATION_MESSAGE_TYPE,
} from "./conversation-todo-state.js";
import { createConversationTodoTool } from "./conversation-todos.js";
import {
  mapPiMessages,
  PiToAgUiEventAdapter,
} from "./pi-ag-ui-adapter.js";
import type {
  AgentSessionEventListener,
  AgentSessionFactory,
  AgentSessionPort,
  AgentDelegationRequester,
  AgentPermissionRequester,
} from "./session.js";
import {
  AccessRestartController,
  createRequestAccessTool,
  REQUEST_ACCESS_TOOL_NAME,
} from "./request-access.js";
import { PROVIDER_CREDENTIALS } from "./provider-credentials.js";
import {
  AGENT_TASK_TOOL_NAME,
  createAgentTaskTool,
} from "./agent-task-tool.js";

const PLAN_MODE_CONTEXT_MESSAGE_TYPE = "desktop-agent.plan-context";
const ACCESS_CONTINUATION_MESSAGE_TYPE = "desktop-agent.access-continuation";
const DELEGATION_COMPLETION_MESSAGE_TYPE =
  "desktop-agent.delegation-completion";
const CODEY_SYSTEM_PROMPT_APPEND = [
  "## Codey sandbox search constraints",
  "Never read or search `.git`, especially `.git/config` and `.git/hooks`; these paths are permanently unreadable.",
  "Because `grep` and `find` can traverse hidden paths, do not run repository-wide searches from the project root. First list its top-level entries, then search the relevant non-`.git` files and directories explicitly.",
].join("\n");
const AGENT_MODE_TOOLS = [
  "bash",
  "edit",
  "find",
  "grep",
  "ls",
  "read",
  REQUEST_ACCESS_TOOL_NAME,
  "todo_write",
  "write",
] as const;
const PLAN_MODE_TOOLS = [
  "find",
  "grep",
  "ls",
  "read",
  REQUEST_ACCESS_TOOL_NAME,
  "todo_write",
] as const;

function persistNewSession(
  sessionManager: PiSessionManager,
  sessionFile: string,
): void {
  if (existsSync(sessionFile)) return;
  const header = sessionManager.getHeader();
  if (header === null) {
    throw new Error("Pi session has no header");
  }
  const jsonl = [header, ...sessionManager.getEntries()]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  try {
    writeFileSync(sessionFile, `${jsonl}\n`, { flag: "wx" });
    sessionManager.setSessionFile(sessionFile);
  } catch (error) {
    rmSync(sessionFile, { force: true });
    throw error;
  }
}

function restoreMissingSessionFile(params: AgentInitializeParams): void {
  const { sessionFile, sessionId } = params;
  if (
    sessionFile === undefined ||
    sessionId === undefined ||
    existsSync(sessionFile)
  ) {
    return;
  }
  const header: SessionHeader = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: params.cwd,
  };
  writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, { flag: "wx" });
}

function toolsForAgent(
  mode: TaskInteractionMode,
  role: AgentRole,
  capability: AgentCapability,
): readonly string[] {
  const base: string[] =
    mode === "plan" || capability === "read"
      ? [...PLAN_MODE_TOOLS]
      : [...AGENT_MODE_TOOLS];
  if (mode === "agent" && role === "lead") base.push(AGENT_TASK_TOOL_NAME);
  return base;
}

class PiAgentSession implements AgentSessionPort {
  readonly sessionId: string;
  readonly sessionFile: string;

  get model(): { provider: string; id: string } {
    const model = this.session.model;
    if (model === undefined) {
      throw new Error("Pi session has no selected model");
    }
    return { provider: model.provider, id: model.id };
  }

  get thinkingLevel(): ThinkingLevel {
    return this.session.thinkingLevel;
  }

  get messages(): AgentTranscriptMessage[] {
    return mapPiMessages(this.session.messages, this.sessionId);
  }

  get userEntries(): Array<{ entryId: string; text: string }> {
    const result: Array<{ entryId: string; text: string }> = [];
    for (const entry of this.sessionManager.getBranch()) {
      if (entry.type !== "message" || entry.message.role !== "user") continue;
      const content = entry.message.content;
      result.push({
        entryId: entry.id,
        text:
          typeof content === "string"
            ? content
            : content
                .map((item) => (item.type === "text" ? item.text : ""))
                .join(""),
      });
    }
    return result;
  }

  get todo(): ConversationTodoState | null {
    return this.todos.current;
  }

  private readonly eventAdapter: PiToAgUiEventAdapter;

  constructor(
    private readonly session: AgentSession,
    private readonly sessionManager: PiSessionManager,
    private readonly credentials: InMemoryCredentialStore,
    private readonly providers: string[],
    private readonly todos: ConversationTodos,
    private readonly restartController: AccessRestartController,
    readonly interactionMode: TaskInteractionMode,
    sessionFile: string,
  ) {
    this.sessionId = session.sessionId;
    this.sessionFile = sessionFile;
    this.eventAdapter = new PiToAgUiEventAdapter(this.sessionId);
  }

  async prompt(text: string): Promise<{ userEntryId: string }> {
    if (this.interactionMode === "plan") {
      await this.session.sendCustomMessage(
        {
          customType: PLAN_MODE_CONTEXT_MESSAGE_TYPE,
          content: [
            "[PLAN MODE ACTIVE]",
            "Inspect the project and produce an implementation plan without making changes.",
            "Only read, find, grep, ls, and todo_write are available. Shell commands and file mutations are disabled.",
            "Use todo_write to create or refine a concrete ordered plan, leaving proposed work pending.",
            "Call out material uncertainty or questions in the response instead of guessing.",
            "Do not execute the plan.",
          ].join("\n"),
          display: false,
          details: { interactionMode: this.interactionMode },
        },
        { triggerTurn: false },
      );
    }
    if (this.todos.current !== null) {
      await this.session.sendCustomMessage(
        {
          customType: TODO_CONTEXT_MESSAGE_TYPE,
          content: this.todos.contextMessage(),
          display: false,
          details: { todo: this.todos.current },
        },
        { triggerTurn: false },
      );
    }
    const existing = new Set(
      this.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "user")
        .map((entry) => entry.id),
    );
    try {
      await this.session.prompt(text, { expandPromptTemplates: false });
    } catch (error) {
      if (!this.restartController.pending) throw error;
    }
    const entry = this.sessionManager
      .getBranch()
      .find(
        (candidate) =>
          candidate.type === "message" &&
          candidate.message.role === "user" &&
          !existing.has(candidate.id),
      );
    if (entry === undefined) {
      throw new Error("Pi did not persist the prompt user message");
    }
    return { userEntryId: entry.id };
  }

  async updateTodo(
    input: TodoEditOperation,
  ): Promise<ConversationTodoState | null> {
    const todo = this.todos.applyUserEdit(input);
    if (this.session.isStreaming) {
      await this.session.sendCustomMessage(
        {
          customType: TODO_CONTEXT_MESSAGE_TYPE,
          content: this.todos.contextMessage(),
          display: false,
          details: { todo },
        },
        { deliverAs: "steer" },
      );
    }
    return todo;
  }

  archiveTodo(): null {
    return this.todos.archive();
  }

  async continueTodos(attempt: number, maxAttempts: number): Promise<void> {
    try {
      await this.session.sendCustomMessage(
        {
          customType: TODO_CONTINUATION_MESSAGE_TYPE,
          content: this.todos.continuationMessage(attempt, maxAttempts),
          display: false,
          details: { attempt, maxAttempts, todo: this.todos.current },
        },
        { triggerTurn: true },
      );
      await this.session.waitForIdle();
    } catch (error) {
      if (!this.restartController.pending) throw error;
    }
  }

  async continueAfterAccess(): Promise<void> {
    try {
      await this.session.sendCustomMessage(
        {
          customType: ACCESS_CONTINUATION_MESSAGE_TYPE,
          content:
            "The requested filesystem access is now available. Retry the blocked operation and continue the task.",
          display: false,
          details: { resumedAfterAccessGrant: true },
        },
        { triggerTurn: true },
      );
      await this.session.waitForIdle();
    } catch (error) {
      if (!this.restartController.pending) throw error;
    }
  }

  async deliverDelegationCompletion(delegation: Delegation): Promise<void> {
    const content = [
      `Delegated task ${delegation.id} finished with status ${delegation.status}.`,
      delegation.result === null ? undefined : `Result:\n${delegation.result}`,
      delegation.error === null ? undefined : `Error:\n${delegation.error}`,
      "Use this result in the parent task and continue.",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n\n");
    const streaming = this.session.isStreaming;
    await this.session.sendCustomMessage(
      {
        customType: DELEGATION_COMPLETION_MESSAGE_TYPE,
        content,
        display: false,
        details: { delegation },
      },
      streaming ? { deliverAs: "steer" } : { triggerTurn: true },
    );
    if (!streaming) await this.session.waitForIdle();
  }

  consumeAccessRestart(): boolean {
    return this.restartController.consumeRestartRequest();
  }

  steer(text: string): Promise<void> {
    return this.session.steer(text);
  }

  followUp(text: string): Promise<void> {
    return this.session.followUp(text);
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    return this.session.clearQueue();
  }

  abort(): Promise<void> {
    return this.session.abort();
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    return this.session.subscribe((event) => {
      for (const mapped of this.eventAdapter.map(event)) {
        listener(mapped);
      }
      if (
        event.type === "tool_execution_end" &&
        this.restartController.consumeApproved(event.toolCallId)
      ) {
        setImmediate(() => {
          void this.session.abort();
        });
      }
    });
  }

  async dispose(): Promise<void> {
    this.session.dispose();
    await Promise.all(
      this.providers.map((provider) => this.credentials.delete(provider)),
    );
  }
}

export class PiAgentSessionFactory implements AgentSessionFactory {
  async create(
    params: AgentInitializeParams,
    requestPermission: AgentPermissionRequester,
    requestDelegation?: AgentDelegationRequester,
  ): Promise<AgentSessionPort> {
    const credentials = new InMemoryCredentialStore();
    const modelRuntime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      refreshOnCreate: false,
    });

    const providers = Object.keys(params.apiKeys);
    for (const [provider, apiKey] of Object.entries(params.apiKeys)) {
      const remoteCredential = PROVIDER_CREDENTIALS[provider];
      const sandboxedWorker = process.env.CODEY_SANDBOXED_WORKER === "1";
      const runtimeApiKey =
        sandboxedWorker
          ? remoteCredential === undefined
            ? undefined
            : process.env[remoteCredential.environmentKey]
          : apiKey;
      if (
        runtimeApiKey === undefined ||
        (sandboxedWorker && runtimeApiKey === apiKey)
      ) {
        throw new Error(`Masked credential is unavailable for ${provider}`);
      }
      await modelRuntime.setRuntimeApiKey(provider, runtimeApiKey);
    }

    const requestedModel =
      params.model === undefined
        ? undefined
        : modelRuntime.getModel(params.model.provider, params.model.id);
    if (params.model !== undefined && requestedModel === undefined) {
      await Promise.all(
        providers.map((provider) => credentials.delete(provider)),
      );
      throw new Error(`Unknown Pi model: ${params.model.provider}/${params.model.id}`);
    }

    const settingsManager = SettingsManager.inMemory();
    const agentRole = params.agentRole ?? "lead";
    const agentCapability = params.agentCapability ?? "write";
    const identityPrompt = [
      "## Multi-agent identity",
      `You are the ${agentRole} agent ${params.agentId ?? "lead"}.`,
      `Your workspace capability is ${agentCapability}.`,
      agentCapability === "read"
        ? "Inspect and report only. Do not modify project files."
        : undefined,
      agentRole === "subagent"
        ? "Complete the assigned subtask and return a concise result to the lead. Do not delegate further."
        : "Use the task tool to delegate focused work when configured subagents would help.",
      params.profileInstructions,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
    const resourceLoader = new DefaultResourceLoader({
      cwd: params.cwd,
      agentDir: params.cwd,
      settingsManager,
      appendSystemPrompt: [CODEY_SYSTEM_PROMPT_APPEND, identityPrompt],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    restoreMissingSessionFile(params);
    const sessionManager =
      params.sessionFile === undefined
        ? SessionManager.create(params.cwd, params.sessionDir)
        : SessionManager.open(
            params.sessionFile,
            params.sessionDir,
            params.cwd,
          );
    const todos = new ConversationTodos(sessionManager);
    const restartController = new AccessRestartController();
    const todoTool = createConversationTodoTool(todos, params.interactionMode);
    const requestAccessTool = createRequestAccessTool({
      workspace: params.cwd,
      accessMode: params.accessMode,
      interactionMode: params.interactionMode,
      requestPermission,
      restartController,
    });
    const taskTool =
      agentRole === "lead" && params.interactionMode === "agent"
        ? createAgentTaskTool(
            requestDelegation ??
              (() => Promise.reject(new Error("Delegation is unavailable"))),
          )
        : undefined;
    const expectedToolNames = toolsForAgent(
      params.interactionMode,
      agentRole,
      agentCapability,
    );
    const customTools = [
      todoTool,
      requestAccessTool,
      ...(taskTool === undefined ? [] : [taskTool]),
    ];

    let created: Awaited<ReturnType<typeof createAgentSession>>;
    try {
      created = await createAgentSession({
        cwd: params.cwd,
        ...(params.sessionFile === undefined && requestedModel !== undefined
          ? { model: requestedModel }
          : {}),
        modelRuntime,
        tools: [...expectedToolNames],
        customTools,
        resourceLoader,
        sessionManager,
        settingsManager,
      });
    } catch (error) {
      await Promise.all(
        providers.map((provider) => credentials.delete(provider)),
      );
      throw error;
    }
    const { session, extensionsResult } = created;

    if (extensionsResult.errors.length > 0) {
      session.dispose();
      await Promise.all(
        providers.map((provider) => credentials.delete(provider)),
      );
      throw new Error("Pi resource initialization failed");
    }

    if (
      params.sessionFile !== undefined &&
      requestedModel !== undefined &&
      (session.model?.provider !== requestedModel.provider ||
        session.model.id !== requestedModel.id)
    ) {
      await session.setModel(requestedModel);
    }
    if (params.thinkingLevel !== undefined) {
      session.setThinkingLevel(params.thinkingLevel);
    }

    const activeToolNames = [...session.getActiveToolNames()].sort();
    if (activeToolNames.join(",") !== [...expectedToolNames].sort().join(",")) {
      session.dispose();
      await Promise.all(
        providers.map((provider) => credentials.delete(provider)),
      );
      throw new Error(
        `Pi session initialized with unexpected tools: ${activeToolNames.join(", ")}`,
      );
    }

    if (session.model === undefined) {
      session.dispose();
      await Promise.all(
        providers.map((provider) => credentials.delete(provider)),
      );
      throw new Error("Pi session has no available model");
    }

    const sessionFile = session.sessionFile;
    if (sessionFile === undefined) {
      session.dispose();
      await Promise.all(
        providers.map((provider) => credentials.delete(provider)),
      );
      throw new Error("Pi session was not persisted");
    }
    if (params.sessionFile === undefined) {
      persistNewSession(sessionManager, sessionFile);
    }

    return new PiAgentSession(
      session,
      sessionManager,
      credentials,
      providers,
      todos,
      restartController,
      params.interactionMode,
      sessionFile,
    );
  }
}
