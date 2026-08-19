import { HashRouter, Route, Routes } from "react-router-dom";
import { AppSidebar } from "@/components/app-sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAppSettings } from "@/hooks/use-app-settings";
import { useTaskRun } from "@/hooks/use-task-run";
import { NewTaskPage } from "@/pages/new-task-page";
import { SettingsPage } from "@/pages/settings-page";

export function App() {
  const { settings, loading, saving, error, updateTheme } = useAppSettings();
  const taskRun = useTaskRun();

  if (loading || !settings) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={350}>
      <HashRouter>
        <div className="flex h-screen min-h-0 overflow-hidden bg-background text-foreground antialiased">
          <AppSidebar
            projects={taskRun.projects}
            tasks={taskRun.tasks}
            activeProjectId={taskRun.activeProjectId}
            activeTaskId={taskRun.task.id}
            loadingTaskId={taskRun.loadingTaskId}
            choosingProject={taskRun.choosingWorkspace}
            onAddProject={taskRun.addProject}
            onCreateProject={taskRun.createProject}
            onListGitHub={taskRun.listGitHubRepositories}
            onCloneGitHub={taskRun.cloneGitHubProject}
            onSelectRecentProject={taskRun.selectRecentProject}
            onNewConversation={taskRun.newConversation}
            onOpenProject={taskRun.openProject}
            onOpenTask={taskRun.openTask}
          />
          <Routes>
            <Route path="/" element={<NewTaskPage taskRun={taskRun} />} />
            <Route
              path="/settings"
              element={
                <SettingsPage
                  theme={settings.theme}
                  saving={saving}
                  error={error}
                  onThemeChange={(theme) => void updateTheme(theme)}
                />
              }
            />
          </Routes>
        </div>
      </HashRouter>
    </TooltipProvider>
  );
}
