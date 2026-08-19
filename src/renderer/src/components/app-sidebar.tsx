import {
  FolderClosed,
  FolderPlus,
  MessageSquare,
  Plus,
  Settings,
} from "lucide-react";
import { memo } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { ProjectPicker } from "@/components/project-picker";
import { cn } from "@/lib/utils";
import type { TaskSummary } from "../../../shared/task";
import type {
  GitHubRepository,
  WorkspaceInfo,
} from "../../../shared/workspace";

const navigationClass =
  "[-webkit-app-region:no-drag] flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm font-medium text-sidebar-foreground/75 outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring/50 disabled:pointer-events-none disabled:opacity-45";

function navClass({ isActive }: { isActive: boolean }): string {
  return cn(
    navigationClass,
    isActive && "bg-sidebar-accent text-sidebar-foreground",
  );
}

export const AppSidebar = memo(function AppSidebar({
  projects,
  tasks,
  activeProjectId,
  activeTaskId,
  loadingTaskId,
  choosingProject,
  onAddProject,
  onCreateProject,
  onListGitHub,
  onCloneGitHub,
  onSelectRecentProject,
  onNewConversation,
  onOpenProject,
  onOpenTask,
}: {
  projects: WorkspaceInfo[];
  tasks: TaskSummary[];
  activeProjectId: string | null;
  activeTaskId: string | null;
  loadingTaskId: string | null;
  choosingProject: boolean;
  onAddProject(): Promise<boolean>;
  onCreateProject(name: string): Promise<boolean>;
  onListGitHub(): Promise<GitHubRepository[]>;
  onCloneGitHub(nameWithOwner: string): Promise<boolean>;
  onSelectRecentProject(projectId: string): Promise<void>;
  onNewConversation(projectId: string): Promise<void>;
  onOpenProject(projectId: string): Promise<void>;
  onOpenTask(taskId: string): Promise<void>;
}) {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-2.5 pb-3 pt-11 text-sidebar-foreground [-webkit-app-region:drag]">
      <div className="flex min-h-0 flex-1 flex-col px-1.5">
        <div className="flex h-8 items-center justify-between px-1.5">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-sidebar-foreground/45">
            Projects
          </span>
          <ProjectPicker
            projects={projects}
            disabled={choosingProject}
            side="right"
            align="start"
            trigger={
              <button
                type="button"
                className="[-webkit-app-region:no-drag] flex size-7 items-center justify-center rounded-md text-sidebar-foreground/55 outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring/50 disabled:pointer-events-none disabled:opacity-45"
                aria-label="Add project"
                disabled={choosingProject}
              >
                <FolderPlus aria-hidden="true" className="size-4" />
              </button>
            }
            onSelectProject={async (projectId) => {
              await onSelectRecentProject(projectId);
              navigate("/");
            }}
            onChooseExisting={async () => {
              const selected = await onAddProject();
              if (selected) navigate("/");
              return selected;
            }}
            onCreateFolder={async (name) => {
              const selected = await onCreateProject(name);
              if (selected) navigate("/");
              return selected;
            }}
            onListGitHub={onListGitHub}
            onCloneGitHub={async (nameWithOwner) => {
              const selected = await onCloneGitHub(nameWithOwner);
              if (selected) navigate("/");
              return selected;
            }}
          />
        </div>
        {projects.length === 0 ? (
          <p className="mt-3 text-xs leading-5 text-sidebar-foreground/45">
            Add a project folder to start a conversation.
          </p>
        ) : (
          <div className="mt-1 flex min-h-0 flex-col gap-1 overflow-y-auto">
            {projects.map((project) => {
              const conversations = tasks.filter(
                (task) => task.workspace.id === project.id,
              );
              const active =
                activeProjectId === project.id && location.pathname === "/";
              return (
                <div
                  key={project.id}
                  role="group"
                  aria-label={project.name}
                >
                  <div className="group flex items-center">
                    <button
                      type="button"
                      className={cn(
                        navigationClass,
                        "min-w-0 flex-1",
                        active &&
                          activeTaskId === null &&
                          "bg-sidebar-accent text-sidebar-foreground",
                      )}
                      title={project.path}
                      onClick={() => {
                        void onOpenProject(project.id)
                          .then(() => navigate("/"))
                          .catch(() => undefined);
                      }}
                    >
                      <FolderClosed
                        aria-hidden="true"
                        className="size-4 shrink-0"
                      />
                      <span className="truncate">{project.name}</span>
                    </button>
                    <button
                      type="button"
                      className="[-webkit-app-region:no-drag] flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/45 opacity-0 outline-none transition-[color,background-color,opacity] hover:bg-sidebar-accent hover:text-sidebar-foreground focus:opacity-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring/50 group-hover:opacity-100"
                      aria-label={`New conversation in ${project.name}`}
                      onClick={() => {
                        void onNewConversation(project.id)
                          .then(() => navigate("/"))
                          .catch(() => undefined);
                      }}
                    >
                      <Plus aria-hidden="true" className="size-3.5" />
                    </button>
                  </div>
                  {conversations.length > 0 ? (
                    <div className="ml-5 flex flex-col gap-0.5">
                      {conversations.map((task) => (
                        <button
                          key={task.id}
                          type="button"
                          className={cn(
                            navigationClass,
                            "h-8 font-normal",
                            activeTaskId === task.id &&
                              location.pathname === "/" &&
                              "bg-sidebar-accent text-sidebar-foreground",
                          )}
                          disabled={loadingTaskId === task.id}
                          aria-current={
                            activeTaskId === task.id ? "page" : undefined
                          }
                          onClick={() => {
                            void onOpenTask(task.id)
                              .then(() => navigate("/"))
                              .catch(() => undefined);
                          }}
                        >
                          <MessageSquare
                            aria-hidden="true"
                            className="size-3.5 shrink-0"
                          />
                          <span className="truncate">{task.title}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <nav aria-label="Application" className="border-t border-sidebar-border pt-2">
        <NavLink to="/settings" className={navClass}>
          <Settings aria-hidden="true" />
          Settings
        </NavLink>
      </nav>
    </aside>
  );
});
