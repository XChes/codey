import { constants } from "node:fs";
import { access, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import type { WorkspaceInfo } from "../shared/workspace";
import type { AppStore } from "./app-store";
import type { GitWorktreeService } from "./git-worktree-service";

export async function canonicalizeWorkspace(path: string): Promise<string> {
  try {
    const canonicalPath = await realpath(path);
    const metadata = await stat(canonicalPath);
    if (!metadata.isDirectory()) {
      throw new Error("Selected workspace is not a directory.");
    }
    await access(canonicalPath, constants.R_OK);
    return canonicalPath;
  } catch (error) {
    if (error instanceof Error && error.message === "Selected workspace is not a directory.") {
      throw error;
    }
    throw new Error(`Workspace is unavailable: ${path}`);
  }
}

export async function registerWorkspace(
  store: AppStore,
  selectedPath: string,
  worktrees?: Pick<GitWorktreeService, "probeProject">,
): Promise<WorkspaceInfo> {
  const canonicalPath = await canonicalizeWorkspace(selectedPath);
  const capability =
    worktrees === undefined
      ? { path: canonicalPath, checkoutBranch: null }
      : await worktrees.probeProject(canonicalPath);
  return store.saveWorkspace(
    capability.path,
    capability.repository,
    capability.checkoutBranch,
  );
}

export async function createWorkspaceDirectory(
  parentPath: string,
  name: string,
): Promise<string> {
  const canonicalParent = await canonicalizeWorkspace(parentPath);
  await access(canonicalParent, constants.W_OK);
  const path = join(canonicalParent, name);
  try {
    await mkdir(path);
  } catch {
    throw new Error(`Could not create project folder: ${path}`);
  }
  return path;
}

export async function requireEmptyWorkspace(path: string): Promise<string> {
  const canonicalPath = await canonicalizeWorkspace(path);
  await access(canonicalPath, constants.W_OK);
  if ((await readdir(canonicalPath)).length > 0) {
    throw new Error("GitHub repositories must be cloned into an empty folder.");
  }
  return canonicalPath;
}

export async function requireAvailableWorkspace(
  store: AppStore,
  workspaceId: string,
): Promise<WorkspaceInfo> {
  const workspace = store.getWorkspace(workspaceId);
  if (workspace === undefined) {
    throw new Error(`Workspace does not exist: ${workspaceId}`);
  }
  const canonicalPath = await canonicalizeWorkspace(workspace.path);
  if (canonicalPath !== workspace.path) {
    throw new Error(`Workspace path changed: ${workspace.path}`);
  }
  return workspace;
}

export async function refreshWorkspaceCapability(
  store: AppStore,
  workspaceId: string,
  worktrees: Pick<GitWorktreeService, "probeProject">,
): Promise<WorkspaceInfo> {
  const workspace = await requireAvailableWorkspace(store, workspaceId);
  const capability = await worktrees.probeProject(workspace.path);
  if (capability.path !== workspace.path) {
    throw new Error("Project repository root changed; add the project again.");
  }
  return store.setWorkspaceRepository(
    workspace.id,
    capability.repository,
    capability.checkoutBranch,
  );
}
