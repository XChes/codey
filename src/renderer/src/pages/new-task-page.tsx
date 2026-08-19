import {
  ArrowUp,
  Check,
  ChevronDown,
  Command,
  CornerDownLeft,
  FolderClosed,
  GitBranch,
  ListTodo,
  Plus,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Square,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityFeed } from "@/components/activity-feed";
import { ConversationTodoCard } from "@/components/conversation-todo-card";
import { FileReviewWorkspace } from "@/components/file-review-workspace";
import { ProjectPicker } from "@/components/project-picker";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useReviewState } from "@/hooks/use-review-state";
import type { TaskRunController } from "@/hooks/use-task-run";
import {
  modelKey,
  modelLabel,
  SUPPORTED_MODELS,
  supportedModelSelectionSchema,
  supportsThinking,
  thinkingLevelLabel,
  thinkingLevelSchema,
  thinkingLevelsForModel,
} from "../../../shared/models";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function NewTaskPage({ taskRun }: { taskRun: TaskRunController }) {
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [fileWorkspaceOpen, setFileWorkspaceOpen] = useState(false);
  const {
    task,
    submitting,
    cancelling,
    choosingWorkspace,
    workspaceError,
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
    steerQueued,
    restoreQueue,
    selectAgent,
    cancel,
  } = taskRun;
  const review = useReviewState(task.id);
  const conversationEndRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const previousConversationIdRef = useRef(task.id);
  useEffect(() => setFileWorkspaceOpen(false), [task.id]);
  const selectedAgent =
    task.agents.find((agent) => agent.id === task.selectedAgentId) ?? null;
  const visibleActivity = selectedAgent?.activity ?? task.activity;
  const visibleStatus = selectedAgent?.status ?? task.status;
  const hasActivity =
    visibleActivity.length > 0 ||
    task.agents.length > 1 ||
    task.todo !== null ||
    (review.snapshot?.files.length ?? 0) > 0;
  useLayoutEffect(() => {
    if (previousConversationIdRef.current !== task.id) {
      followLatestRef.current = true;
    }
    if (hasActivity && followLatestRef.current) {
      conversationEndRef.current?.scrollIntoView({ block: "end" });
    }
    previousConversationIdRef.current = task.id;
  }, [hasActivity, task.id, task.todo, visibleActivity]);
  const running = task.status === "running";
  const waking = task.runtimeState === "preparing" && !running;
  const modeSwitchDisabled =
    running || waking || submitting || changingInteractionMode;
  const projectSelected = task.workspace !== null;
  const thinkingLevels = thinkingLevelsForModel(task.model);
  const refreshedWorkspace = taskRun.projects.find(
    (workspace) => workspace.id === task.workspace?.id,
  );
  const projectBranch = refreshedWorkspace?.branch ?? task.workspace?.branch ?? null;
  const branchLabel =
    task.workspace === null
      ? null
      : task.executionTarget === "worktree"
        ? task.id === null
          ? "New branch on submit"
          : task.branch
        : projectBranch ??
          (task.workspace.worktreeAvailable ? "Detached HEAD" : null);
  const pendingMessages = [
    ...task.queue.steering.map((text) => ({
      kind: "Steer" as const,
      text,
      followUpIndex: null,
    })),
    ...task.queue.followUp.map((text, followUpIndex) => ({
      kind: "Queued" as const,
      text,
      followUpIndex,
    })),
  ];

  return (
    <main className="relative flex min-w-0 flex-1 overflow-hidden bg-background">
      <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center px-5 [-webkit-app-region:drag]">
        <span className="truncate text-sm font-medium">{task.title}</span>
      </header>

      {hasActivity ? (
        <div
          className="min-h-0 flex-1 overflow-y-auto px-8 pt-8"
          onScroll={(event) => {
            const viewport = event.currentTarget;
            followLatestRef.current =
              viewport.scrollHeight -
                viewport.scrollTop -
                viewport.clientHeight <=
              80;
          }}
        >
          {task.agents.length > 1 ? (
            <nav
              aria-label="Agents"
              className="mx-auto mb-5 flex w-full max-w-3xl gap-1 overflow-x-auto rounded-lg border border-border/70 bg-card p-1"
            >
              {task.agents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  aria-pressed={agent.id === task.selectedAgentId}
                  className={
                    agent.id === task.selectedAgentId
                      ? "rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-foreground"
                      : "rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  }
                  onClick={() => selectAgent(agent.id)}
                >
                  {agent.role === "lead"
                    ? "Lead"
                    : agent.assignment ?? agent.profileId ?? "Subagent"}
                  <span className="ml-1.5 capitalize opacity-70">
                    {agent.status}
                  </span>
                </button>
              ))}
            </nav>
          ) : null}
          <ActivityFeed
            items={visibleActivity}
            status={visibleStatus}
            review={selectedAgent?.role === "subagent" ? null : review.snapshot}
            onReview={() => setFileWorkspaceOpen(true)}
          />
          <div
            ref={conversationEndRef}
            aria-hidden="true"
            className={task.todo === null ? "h-56" : "h-72"}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 pb-36">
          <div className="mb-5 flex size-10 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground shadow-xs">
            <Command aria-hidden="true" className="size-5" />
          </div>
          <h1 className="text-balance text-center text-2xl font-semibold tracking-[-0.025em]">
            What would you like to build?
          </h1>
          <p className="mt-2 max-w-md text-center text-sm leading-6 text-muted-foreground">
            Start a conversation with the configured coding agent.
          </p>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-background via-background to-transparent px-6 pb-6 pt-14">
        <div className="pointer-events-auto mx-auto max-w-3xl">
          {task.todo !== null ? (
            <div className="relative z-0 -mb-3 pb-3">
              <ConversationTodoCard
                todo={task.todo}
                disabled={editingTodo}
                onEdit={editTodo}
              />
            </div>
          ) : null}
          {running && pendingMessages.length > 0 ? (
            <section
              aria-label="Pending messages"
              className="relative z-0 -mb-3 overflow-hidden rounded-t-[22px] rounded-b-xl border border-border bg-card pb-3 shadow-xs"
            >
              <div className="divide-y divide-border/70">
                {pendingMessages.map((message, index) => (
                  <div
                    key={`${message.kind}:${index}:${message.text}`}
                    className="flex h-11 min-w-0 items-center gap-2.5 px-4 text-sm"
                  >
                    <ListTodo
                      aria-hidden="true"
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="truncate">{message.text}</span>
                    <div className="ml-auto flex shrink-0 items-center gap-0.5">
                      {message.followUpIndex === null ? (
                        <span className="px-2 text-xs text-muted-foreground">
                          Steering
                        </span>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={submitting || cancelling}
                          className="text-muted-foreground"
                          onClick={() =>
                            void steerQueued(message.followUpIndex)
                          }
                        >
                          <CornerDownLeft />
                          Steer
                        </Button>
                      )}
                      {index === 0 ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span tabIndex={0}>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                disabled={submitting || cancelling}
                                aria-label="Restore queued"
                                className="size-8 rounded-full text-muted-foreground"
                                onClick={() => void restoreQueue()}
                              >
                                <RotateCcw />
                              </Button>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>Restore all queued</TooltipContent>
                        </Tooltip>
                      ) : (
                        <span aria-hidden="true" className="size-8 shrink-0" />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          <form
            className="relative z-10 rounded-[24px] border border-border bg-card shadow-[0_8px_30px_rgba(0,0,0,0.07)] focus-within:border-ring/60"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label htmlFor="conversation-draft" className="sr-only">
              Conversation message
            </label>
            <Textarea
              id="conversation-draft"
              value={task.draft}
              className="min-h-24 px-4 pb-2 pt-4"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={
                task.status === "running"
                  ? "Queue a follow-up"
                  : task.interactionMode === "plan"
                    ? "Describe what you want to plan"
                  : "Ask for a change, fix, or explanation"
              }
            />
            {workspaceError !== null ? (
              <p className="px-3 pb-1 text-xs text-destructive" role="alert">
                {workspaceError}
              </p>
            ) : null}
            <div className="flex items-center justify-between px-3 pb-3">
              <div className="flex min-w-0 items-center gap-1.5">
                <Popover open={modeMenuOpen} onOpenChange={setModeMenuOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={modeSwitchDisabled}
                      aria-label="Choose interaction mode"
                      className="size-8 shrink-0 rounded-full text-muted-foreground"
                    >
                      <Plus />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    side="top"
                    align="start"
                    className="w-80 p-1.5"
                    role="menu"
                    aria-label="Interaction mode"
                    onKeyDown={(event) => {
                      if (
                        event.key !== "ArrowDown" &&
                        event.key !== "ArrowUp" &&
                        event.key !== "Home" &&
                        event.key !== "End"
                      ) {
                        return;
                      }
                      const items = Array.from(
                        event.currentTarget.querySelectorAll<HTMLButtonElement>(
                          '[role="menuitemradio"]',
                        ),
                      );
                      if (items.length === 0) return;
                      event.preventDefault();
                      const currentIndex = items.indexOf(
                        document.activeElement as HTMLButtonElement,
                      );
                      const nextIndex =
                        event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? items.length - 1
                            : event.key === "ArrowDown"
                              ? (currentIndex + 1) % items.length
                              : (currentIndex - 1 + items.length) %
                                items.length;
                      items[nextIndex]?.focus();
                    }}
                  >
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={task.interactionMode === "agent"}
                      aria-label="Agent Make changes and run commands"
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
                      onClick={() => {
                        setModeMenuOpen(false);
                        void setInteractionMode("agent");
                      }}
                    >
                      <Command
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">Agent</span>
                        <span className="block text-xs text-muted-foreground">
                          Make changes and run commands
                        </span>
                      </span>
                      {task.interactionMode === "agent" ? (
                        <Check aria-hidden="true" className="size-4" />
                      ) : null}
                    </button>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={task.interactionMode === "plan"}
                      aria-label="Plan Generate an implementation plan"
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
                      onClick={() => {
                        setModeMenuOpen(false);
                        void setInteractionMode("plan");
                      }}
                    >
                      <ListTodo
                        aria-hidden="true"
                        className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">Plan</span>
                        <span className="block text-xs text-muted-foreground">
                          Generate an implementation plan
                        </span>
                      </span>
                      {task.interactionMode === "plan" ? (
                        <Check aria-hidden="true" className="size-4" />
                      ) : null}
                    </button>
                  </PopoverContent>
                </Popover>
                {task.interactionMode === "plan" ? (
                  <span
                    aria-label="Interaction mode: Plan"
                    className="rounded-md bg-amber-500/12 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-300"
                  >
                    Plan
                  </span>
                ) : null}
                {!projectSelected ? (
                  <ProjectPicker
                    projects={taskRun.projects}
                    autoOpen={
                      taskRun.projectsLoaded && taskRun.projects.length === 0
                    }
                    disabled={submitting || choosingWorkspace}
                    side="top"
                    align="start"
                    trigger={
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={submitting || choosingWorkspace}
                        aria-label="Add project"
                        className="h-auto max-w-72 min-w-0 justify-start py-1 text-muted-foreground"
                      >
                        <FolderClosed />
                        <span>Add project</span>
                      </Button>
                    }
                    onSelectProject={selectRecentProject}
                    onChooseExisting={addProject}
                    onCreateFolder={createProject}
                    onListGitHub={listGitHubRepositories}
                    onCloneGitHub={cloneGitHubProject}
                  />
                ) : null}
                {task.id === null && task.workspace !== null ? (
                  <Select
                    value={task.executionTarget}
                    disabled={submitting}
                    onValueChange={(value) =>
                      setExecutionTarget(
                        value === "worktree" ? "worktree" : "local",
                      )
                    }
                  >
                    <SelectTrigger
                      aria-label="Execution target"
                      className="h-8 w-auto gap-1.5 border-0 bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-muted focus:ring-2 focus:ring-ring/50"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="start">
                      <SelectItem value="local">Local</SelectItem>
                      {task.workspace.worktreeAvailable ? (
                        <SelectItem value="worktree">Worktree</SelectItem>
                      ) : null}
                    </SelectContent>
                  </Select>
                ) : null}
                {task.workspace !== null ? (
                  <Select
                    value={task.accessMode}
                    disabled={
                      running ||
                      waking ||
                      submitting ||
                      changingAccessMode
                    }
                    onValueChange={(value) => {
                      if (
                        value === "ask" ||
                        value === "auto" ||
                        value === "full"
                      ) {
                        void setAccessMode(value);
                      }
                    }}
                  >
                    <SelectTrigger
                      aria-label="Access mode"
                      className={[
                        "h-8 w-auto gap-1.5 border-0 bg-transparent px-2 text-xs shadow-none hover:bg-muted focus:ring-2 focus:ring-ring/50",
                        task.accessMode === "full"
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-muted-foreground",
                      ].join(" ")}
                    >
                      {task.accessMode === "full" ? (
                        <ShieldAlert className="size-3.5" />
                      ) : (
                        <ShieldCheck className="size-3.5" />
                      )}
                      <SelectValue>
                        {task.accessMode === "ask"
                          ? "Ask for approval"
                          : task.accessMode === "auto"
                            ? "Approve for me"
                            : "Full access"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent align="start" className="w-72">
                      <SelectItem value="ask" textValue="Ask for approval">
                        <span className="block font-medium">Ask for approval</span>
                        <span className="block text-xs text-muted-foreground">
                          Ask before external files or internet
                        </span>
                      </SelectItem>
                      <SelectItem value="auto" textValue="Approve for me">
                        <span className="block font-medium">Approve for me</span>
                        <span className="block text-xs text-muted-foreground">
                          Allow internet; ask for external files
                        </span>
                      </SelectItem>
                      <SelectItem value="full" textValue="Full access">
                        <span className="block font-medium text-amber-600 dark:text-amber-400">
                          Full access
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Allow external files and internet
                        </span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                ) : null}
              {branchLabel !== null ? (
                <div
                  aria-label="Git branch"
                  className="flex h-8 max-w-48 min-w-0 items-center gap-1.5 px-2 text-xs text-muted-foreground"
                  title={branchLabel}
                >
                  <GitBranch className="size-3.5 shrink-0" />
                  <span className="truncate">{branchLabel}</span>
                </div>
              ) : null}
                <Popover open={modelMenuOpen} onOpenChange={setModelMenuOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={running || submitting}
                      aria-label="Model and reasoning"
                      className="max-w-64 gap-1.5 px-2 font-normal text-muted-foreground"
                    >
                      <span className="truncate">{modelLabel(task.model)}</span>
                      {supportsThinking(task.model) ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{thinkingLevelLabel(task.thinkingLevel)}</span>
                        </>
                      ) : null}
                      <ChevronDown aria-hidden="true" className="opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    side="top"
                    align="start"
                    className="w-72 p-1.5"
                    role="dialog"
                    aria-label="Model and reasoning settings"
                  >
                    <div
                      role="radiogroup"
                      aria-label="Model"
                      className="space-y-0.5"
                    >
                      <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
                        Model
                      </p>
                      {SUPPORTED_MODELS.map((model) => {
                        const selected = modelKey(model) === modelKey(task.model);
                        return (
                          <button
                            key={modelKey(model)}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
                            onClick={() =>
                              setModel(
                                supportedModelSelectionSchema.parse({
                                  provider: model.provider,
                                  id: model.id,
                                }),
                              )
                            }
                          >
                            <span className="flex-1">{model.label}</span>
                            {selected ? (
                              <Check aria-hidden="true" className="size-4" />
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                    {supportsThinking(task.model) ? (
                      <div
                        role="radiogroup"
                        aria-label="Reasoning"
                        className="mt-1 space-y-0.5 border-t border-border pt-1"
                      >
                        <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
                          Reasoning
                        </p>
                        {thinkingLevels.map((level) => {
                          const selected = level === task.thinkingLevel;
                          return (
                            <button
                              key={level}
                              type="button"
                              role="radio"
                              aria-checked={selected}
                              className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
                              onClick={() =>
                                setThinkingLevel(thinkingLevelSchema.parse(level))
                              }
                            >
                              <span className="flex-1">
                                {thinkingLevelLabel(level)}
                              </span>
                              {selected ? (
                                <Check aria-hidden="true" className="size-4" />
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </PopoverContent>
                </Popover>
              </div>
              <div className="flex items-center gap-1">
                {running ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span tabIndex={0}>
                        <Button
                          type="button"
                          size="icon"
                          disabled={cancelling}
                          aria-label="Stop response"
                          onClick={() => void cancel()}
                          className="size-10 rounded-full"
                        >
                          <Square />
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>Stop response</TooltipContent>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span tabIndex={0}>
                        <Button
                          type="submit"
                          size="icon"
                          disabled={
                            task.draft.trim().length === 0 ||
                            task.workspace === null ||
                            submitting
                          }
                          aria-label="Start conversation"
                          className="rounded-full"
                        >
                          <ArrowUp />
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {task.workspace === null
                        ? "Add a project"
                        : "Start conversation"}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
          </form>
        </div>
      </div>
      </section>
      {task.id !== null ? (
        <FileReviewWorkspace
          taskId={task.id}
          review={review}
          open={fileWorkspaceOpen}
          onOpenChange={setFileWorkspaceOpen}
        />
      ) : null}
      {pendingPermission !== null ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-6 backdrop-blur-[1px]">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="approval-dialog-title"
            className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-2xl"
          >
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-500/12 text-amber-600 dark:text-amber-400">
                <ShieldAlert className="size-4.5" />
              </div>
              <div className="min-w-0">
                <h2
                  id="approval-dialog-title"
                  className="text-base font-semibold"
                >
                  Approval required
                </h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  {pendingPermission.request.reason}
                </p>
              </div>
            </div>
            <div className="mt-4 rounded-lg border border-border bg-muted/50 px-3 py-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {pendingPermission.request.kind.replace("-", " ")}
              </p>
              <p className="mt-1 break-all font-mono text-xs">
                {pendingPermission.request.resource}
              </p>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={decidingPermission}
                onClick={() => void decidePermission(false)}
              >
                Deny
              </Button>
              <Button
                type="button"
                disabled={decidingPermission}
                onClick={() => void decidePermission(true)}
              >
                Allow
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
