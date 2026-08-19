import {
  ArrowLeft,
  FolderClosed,
  FolderOpen,
  FolderPlus,
  GitFork,
  Globe2,
  LoaderCircle,
  LockKeyhole,
  Search,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type {
  GitHubRepository,
  WorkspaceInfo,
} from "../../../shared/workspace";

type PickerView = "projects" | "new-folder" | "github";

const rowClass =
  "flex min-h-10 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-45";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function displayPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}

export function ProjectPicker({
  trigger,
  projects,
  autoOpen = false,
  disabled = false,
  side = "top",
  align = "start",
  onSelectProject,
  onChooseExisting,
  onCreateFolder,
  onListGitHub,
  onCloneGitHub,
}: {
  trigger: ReactElement;
  projects: WorkspaceInfo[];
  autoOpen?: boolean;
  disabled?: boolean;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  onSelectProject(projectId: string): Promise<void>;
  onChooseExisting(): Promise<boolean>;
  onCreateFolder(name: string): Promise<boolean>;
  onListGitHub(): Promise<GitHubRepository[]>;
  onCloneGitHub(nameWithOwner: string): Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<PickerView>("projects");
  const [query, setQuery] = useState("");
  const [folderName, setFolderName] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeRepository, setActiveRepository] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [githubRepositories, setGitHubRepositories] = useState<
    GitHubRepository[] | null
  >(null);
  const [githubLoading, setGitHubLoading] = useState(false);
  const autoOpened = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const folderNameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoOpen && !autoOpened.current) {
      autoOpened.current = true;
      setOpen(true);
    }
  }, [autoOpen]);

  const filteredProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const matches =
      normalized.length === 0
        ? projects
        : projects.filter(
            (project) =>
              project.name.toLocaleLowerCase().includes(normalized) ||
              project.path.toLocaleLowerCase().includes(normalized),
          );
    return normalized.length === 0 ? matches.slice(0, 6) : matches;
  }, [projects, query]);

  const filteredRepositories = useMemo(() => {
    if (githubRepositories === null) return [];
    const normalized = query.trim().toLocaleLowerCase();
    if (normalized.length === 0) return githubRepositories;
    return githubRepositories.filter(
      (repository) =>
        repository.nameWithOwner.toLocaleLowerCase().includes(normalized) ||
        repository.description?.toLocaleLowerCase().includes(normalized) ===
          true,
    );
  }, [githubRepositories, query]);

  const setPickerOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setView("projects");
      setQuery("");
      setFolderName("");
      setError(null);
    }
  };

  const moveItemFocus = (event: KeyboardEvent, direction: 1 | -1) => {
    const items = Array.from(
      contentRef.current?.querySelectorAll<HTMLElement>(
        "[data-project-picker-item]:not([disabled])",
      ) ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const nextIndex =
      index === -1
        ? direction === 1
          ? 0
          : items.length - 1
        : (index + direction + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  const runSelection = async (
    action: () => Promise<boolean | void>,
    fallback: string,
  ) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const selected = await action();
      if (selected !== false) setPickerOpen(false);
    } catch (actionError) {
      setError(errorMessage(actionError, fallback));
    } finally {
      setBusy(false);
    }
  };

  const loadGitHubRepositories = async () => {
    if (githubLoading) return;
    setGitHubLoading(true);
    setError(null);
    try {
      setGitHubRepositories(await onListGitHub());
    } catch (loadError) {
      setGitHubRepositories(null);
      setError(errorMessage(loadError, "Could not load GitHub repositories"));
    } finally {
      setGitHubLoading(false);
    }
  };

  const openGitHub = () => {
    setView("github");
    setQuery("");
    setError(null);
    if (githubRepositories === null) void loadGitHubRepositories();
    queueMicrotask(() => searchRef.current?.focus());
  };

  const goBack = () => {
    setView("projects");
    setQuery("");
    setFolderName("");
    setError(null);
    queueMicrotask(() => searchRef.current?.focus());
  };

  return (
    <Popover open={open} onOpenChange={setPickerOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        {trigger}
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        side={side}
        align={align}
        collisionPadding={12}
        aria-label="Choose project"
        className="max-h-[560px] overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          queueMicrotask(() => {
            if (view === "new-folder") folderNameRef.current?.focus();
            else searchRef.current?.focus();
          });
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") moveItemFocus(event, 1);
          if (event.key === "ArrowUp") moveItemFocus(event, -1);
        }}
      >
        {view === "new-folder" ? (
          <>
            <div className="flex h-12 items-center gap-2 border-b border-border px-2">
              <button
                type="button"
                data-project-picker-item
                className="flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                aria-label="Back to projects"
                disabled={busy}
                onClick={goBack}
              >
                <ArrowLeft className="size-4" />
              </button>
              <span className="text-sm font-medium">New Folder</span>
            </div>
            <div className="p-3">
              <label
                htmlFor="new-project-folder-name"
                className="mb-1.5 block text-xs font-medium text-muted-foreground"
              >
                Folder name
              </label>
              <input
                ref={folderNameRef}
                id="new-project-folder-name"
                value={folderName}
                disabled={busy}
                placeholder="my-project"
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20"
                onChange={(event) => setFolderName(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    folderName.trim().length > 0
                  ) {
                    void runSelection(
                      () => onCreateFolder(folderName.trim()),
                      "Could not create project folder",
                    );
                  }
                }}
              />
              {error !== null ? (
                <p className="mt-2 text-xs text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
              <button
                type="button"
                data-project-picker-item
                className={cn(rowClass, "mt-3 justify-center bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:bg-primary/90")}
                disabled={busy || folderName.trim().length === 0}
                onClick={() =>
                  void runSelection(
                    () => onCreateFolder(folderName.trim()),
                    "Could not create project folder",
                  )
                }
              >
                {busy ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <FolderPlus className="size-4" />
                )}
                Choose location…
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex h-12 items-center gap-2 border-b border-border px-2">
              {view === "github" ? (
                <button
                  type="button"
                  data-project-picker-item
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                  aria-label="Back to projects"
                  disabled={busy}
                  onClick={goBack}
                >
                  <ArrowLeft className="size-4" />
                </button>
              ) : null}
              <Search className="ml-1 size-4 shrink-0 text-muted-foreground" />
              <input
                ref={searchRef}
                value={query}
                disabled={busy}
                aria-label={
                  view === "github"
                    ? "Search GitHub repositories"
                    : "Search recent projects"
                }
                placeholder={
                  view === "github"
                    ? "Search GitHub repositories…"
                    : "Search projects…"
                }
                className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>

            {view === "projects" ? (
              <div className="max-h-[508px] overflow-y-auto p-2">
                <div className="px-3 pb-1 pt-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  Recents
                </div>
                {filteredProjects.length > 0 ? (
                  filteredProjects.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      data-project-picker-item
                      className={rowClass}
                      disabled={busy}
                      title={project.path}
                      onClick={() =>
                        void runSelection(
                          () => onSelectProject(project.id),
                          "Could not open project",
                        )
                      }
                    >
                      <FolderClosed className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">
                          {project.name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {displayPath(project.path)}
                        </span>
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="px-3 py-3 text-sm text-muted-foreground">
                    {query.trim().length === 0
                      ? "No recent projects"
                      : "No matching projects"}
                  </p>
                )}
                {error !== null ? (
                  <p className="px-3 py-2 text-xs text-destructive" role="alert">
                    {error}
                  </p>
                ) : null}
                <div className="my-2 border-t border-border" />
                <button
                  type="button"
                  data-project-picker-item
                  className={rowClass}
                  disabled={busy}
                  onClick={() =>
                    void runSelection(
                      onChooseExisting,
                      "Could not open project folder",
                    )
                  }
                >
                  <FolderOpen className="size-4 text-muted-foreground" />
                  Existing Folder
                </button>
                <button
                  type="button"
                  data-project-picker-item
                  className={rowClass}
                  disabled={busy}
                  onClick={() => {
                    setView("new-folder");
                    setError(null);
                    queueMicrotask(() => folderNameRef.current?.focus());
                  }}
                >
                  <FolderPlus className="size-4 text-muted-foreground" />
                  New Folder
                </button>
                <button
                  type="button"
                  data-project-picker-item
                  className={rowClass}
                  disabled={busy}
                  onClick={openGitHub}
                >
                  <GitFork className="size-4 text-muted-foreground" />
                  GitHub
                </button>
              </div>
            ) : (
              <div className="max-h-[508px] overflow-y-auto p-2">
                <div className="flex items-center justify-between px-3 pb-1 pt-1">
                  <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                    GitHub repositories
                  </span>
                  {githubLoading ? (
                    <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
                  ) : null}
                </div>
                {error !== null ? (
                  <div className="px-3 py-3">
                    <p className="text-sm text-destructive" role="alert">
                      {error}
                    </p>
                    {githubRepositories === null && !githubLoading ? (
                      <button
                        type="button"
                        data-project-picker-item
                        className="mt-2 text-xs font-medium text-foreground underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                        onClick={() => void loadGitHubRepositories()}
                      >
                        Retry
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {githubLoading ? (
                  <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                    Loading repositories…
                  </p>
                ) : githubRepositories !== null &&
                  filteredRepositories.length === 0 ? (
                  <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                    {query.trim().length === 0
                      ? "No repositories available"
                      : "No matching repositories"}
                  </p>
                ) : (
                  filteredRepositories.map((repository) => (
                    <button
                      key={repository.nameWithOwner}
                      type="button"
                      data-project-picker-item
                      className={rowClass}
                      disabled={busy}
                      onClick={() => {
                        setActiveRepository(repository.nameWithOwner);
                        void runSelection(
                          () => onCloneGitHub(repository.nameWithOwner),
                          "Could not clone GitHub repository",
                        ).finally(() => setActiveRepository(null));
                      }}
                    >
                      {repository.isPrivate ? (
                        <LockKeyhole className="size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <Globe2 className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate font-medium">
                            {repository.nameWithOwner}
                          </span>
                          <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                            {repository.isPrivate ? "Private" : "Public"}
                          </span>
                        </span>
                        {repository.description !== null ? (
                          <span className="block truncate text-xs text-muted-foreground">
                            {repository.description}
                          </span>
                        ) : null}
                      </span>
                      {activeRepository === repository.nameWithOwner ? (
                        <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
                      ) : null}
                    </button>
                  ))
                )}
              </div>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
