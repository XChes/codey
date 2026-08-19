import { execFile } from "node:child_process";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface GitRepositoryCapability {
  commonDirectory: string;
  integrationBranch: string;
}

export interface ProjectCapability {
  path: string;
  checkoutBranch: string | null;
  repository?: GitRepositoryCapability;
}

export interface WorktreeDescriptor {
  path: string;
  branch: string;
  baseCommit: string;
}

export interface WorktreeInput {
  projectId: string;
  taskId: string;
  projectPath: string;
  repository: GitRepositoryCapability;
}

interface GitResult {
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new Error(
              stderr.trim() ||
                stdout.trim() ||
                `Git command failed: git ${args.join(" ")}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function tryGit(cwd: string, args: string[]): Promise<GitResult | undefined> {
  try {
    return await runGit(cwd, args);
  } catch {
    return undefined;
  }
}

async function canonicalGitPath(cwd: string, flag: "--git-dir" | "--git-common-dir") {
  const result = await runGit(cwd, [
    "rev-parse",
    "--path-format=absolute",
    flag,
  ]);
  return realpath(result.stdout.trim());
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function localBranchExists(cwd: string, branch: string): Promise<boolean> {
  return (
    (await tryGit(cwd, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ])) !== undefined
  );
}

async function currentBranch(cwd: string): Promise<string | undefined> {
  const current = await tryGit(cwd, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  const branch = current?.stdout.trim();
  return branch === undefined || branch.length === 0 ? undefined : branch;
}

async function integrationBranch(cwd: string): Promise<string | undefined> {
  const remoteHead = await tryGit(cwd, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  const remoteBranch = remoteHead?.stdout.trim().replace(/^origin\//, "");
  if (
    remoteBranch !== undefined &&
    remoteBranch.length > 0 &&
    (await localBranchExists(cwd, remoteBranch))
  ) {
    return remoteBranch;
  }
  for (const candidate of ["main", "master"]) {
    if (await localBranchExists(cwd, candidate)) return candidate;
  }
  return currentBranch(cwd);
}

export class GitWorktreeService {
  private readonly mutations = new Map<string, Promise<void>>();

  constructor(private readonly storageRoot: string) {}

  async probeProject(selectedPath: string): Promise<ProjectCapability> {
    const selected = await realpath(selectedPath);
    const topLevel = await tryGit(selected, ["rev-parse", "--show-toplevel"]);
    if (topLevel === undefined) return { path: selected, checkoutBranch: null };

    const projectPath = await realpath(topLevel.stdout.trim());
    const bare = await tryGit(projectPath, ["rev-parse", "--is-bare-repository"]);
    if (bare?.stdout.trim() === "true") {
      return { path: selected, checkoutBranch: null };
    }

    const gitDirectory = await canonicalGitPath(projectPath, "--git-dir");
    const commonDirectory = await canonicalGitPath(
      projectPath,
      "--git-common-dir",
    );
    if (gitDirectory !== commonDirectory) {
      throw new Error("Select the repository's primary checkout, not a linked worktree.");
    }

    const checkoutBranch = (await currentBranch(projectPath)) ?? null;
    const head = await tryGit(projectPath, ["rev-parse", "--verify", "HEAD"]);
    const branch = await integrationBranch(projectPath);
    if (head === undefined || branch === undefined) {
      return { path: projectPath, checkoutBranch };
    }

    return {
      path: projectPath,
      checkoutBranch,
      repository: { commonDirectory, integrationBranch: branch },
    };
  }

  createWorktree(input: WorktreeInput): Promise<WorktreeDescriptor> {
    return this.serialize(input.repository.commonDirectory, async () => {
      const path = join(this.storageRoot, input.projectId, input.taskId);
      const branch = `codey/${input.taskId}`;
      if (await pathExists(path)) {
        throw new Error(`Worktree path already exists: ${path}`);
      }
      if (await localBranchExists(input.projectPath, branch)) {
        throw new Error(`Worktree branch already exists: ${branch}`);
      }

      const baseCommit = (
        await runGit(input.projectPath, [
          "rev-parse",
          "--verify",
          `refs/heads/${input.repository.integrationBranch}^{commit}`,
        ])
      ).stdout.trim();
      await mkdir(dirname(path), { recursive: true });
      try {
        await runGit(input.projectPath, [
          "worktree",
          "add",
          "--no-track",
          "-b",
          branch,
          path,
          baseCommit,
        ]);
        const descriptor = { path: await realpath(path), branch, baseCommit };
        await this.validateWorktree(input, descriptor);
        return descriptor;
      } catch (error) {
        await this.removeWorktreeUnlocked(input, { path, branch, baseCommit });
        throw error;
      }
    });
  }

  validateWorktree(
    input: WorktreeInput,
    descriptor: WorktreeDescriptor,
  ): Promise<void> {
    return this.validateWorktreeUnlocked(input, descriptor);
  }

  removeWorktree(
    input: WorktreeInput,
    descriptor: WorktreeDescriptor,
  ): Promise<void> {
    return this.serialize(input.repository.commonDirectory, () =>
      this.removeWorktreeUnlocked(input, descriptor),
    );
  }

  private async validateWorktreeUnlocked(
    input: WorktreeInput,
    descriptor: WorktreeDescriptor,
  ): Promise<void> {
    const canonicalPath = await realpath(descriptor.path).catch(() => undefined);
    if (canonicalPath !== descriptor.path) {
      throw new Error(`Conversation worktree is unavailable: ${descriptor.path}`);
    }
    const topLevel = (
      await runGit(descriptor.path, ["rev-parse", "--show-toplevel"])
    ).stdout.trim();
    if ((await realpath(topLevel)) !== descriptor.path) {
      throw new Error("Conversation worktree root changed.");
    }
    const commonDirectory = await canonicalGitPath(
      descriptor.path,
      "--git-common-dir",
    );
    if (commonDirectory !== input.repository.commonDirectory) {
      throw new Error("Conversation worktree belongs to another repository.");
    }
    const branch = (
      await runGit(descriptor.path, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ])
    ).stdout.trim();
    if (branch !== descriptor.branch) {
      throw new Error("Conversation worktree branch changed.");
    }
  }

  private async removeWorktreeUnlocked(
    input: WorktreeInput,
    descriptor: WorktreeDescriptor,
  ): Promise<void> {
    await tryGit(input.projectPath, [
      "worktree",
      "remove",
      "--force",
      descriptor.path,
    ]);
    await rm(descriptor.path, { recursive: true, force: true });
    await tryGit(input.projectPath, ["branch", "-D", descriptor.branch]);
  }

  private async serialize<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.mutations.get(key) ?? Promise.resolve();
    const running = previous.catch(() => undefined).then(operation);
    const settled = running.then(
      () => undefined,
      () => undefined,
    );
    this.mutations.set(key, settled);
    try {
      return await running;
    } finally {
      if (this.mutations.get(key) === settled) this.mutations.delete(key);
    }
  }
}
