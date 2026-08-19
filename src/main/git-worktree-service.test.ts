// @vitest-environment node

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GitWorktreeService } from "./git-worktree-service";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function committedRepository(): string {
  const project = temporaryDirectory("codey-git-project-");
  git(project, ["init", "-b", "main"]);
  writeFileSync(join(project, "shared.txt"), "main\n");
  git(project, ["add", "shared.txt"]);
  git(project, [
    "-c",
    "user.name=Codey Tests",
    "-c",
    "user.email=codey@example.com",
    "commit",
    "-m",
    "Initial commit",
  ]);
  return project;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("GitWorktreeService", () => {
  it("keeps an ordinary folder available without worktrees", async () => {
    const project = temporaryDirectory("codey-local-project-");
    const service = new GitWorktreeService(
      temporaryDirectory("codey-worktrees-"),
    );

    await expect(service.probeProject(project)).resolves.toEqual({
      path: realpathSync(project),
      checkoutBranch: null,
    });
  });

  it("enables worktrees after an unborn repository receives its first commit", async () => {
    const project = temporaryDirectory("codey-unborn-project-");
    const service = new GitWorktreeService(
      temporaryDirectory("codey-worktrees-"),
    );
    git(project, ["init", "-b", "main"]);

    await expect(service.probeProject(project)).resolves.toEqual({
      path: realpathSync(project),
      checkoutBranch: "main",
    });

    writeFileSync(join(project, "README.md"), "# Project\n");
    git(project, ["add", "README.md"]);
    git(project, [
      "-c",
      "user.name=Codey Tests",
      "-c",
      "user.email=codey@example.com",
      "commit",
      "-m",
      "Initial commit",
    ]);
    await expect(service.probeProject(project)).resolves.toEqual({
      path: realpathSync(project),
      checkoutBranch: "main",
      repository: {
        commonDirectory: realpathSync(join(project, ".git")),
        integrationBranch: "main",
      },
    });
  });

  it("reports the checkout branch separately from the worktree base", async () => {
    const project = committedRepository();
    const service = new GitWorktreeService(
      temporaryDirectory("codey-worktrees-"),
    );
    git(project, ["switch", "--quiet", "-c", "feature"]);

    await expect(service.probeProject(project)).resolves.toEqual({
      path: realpathSync(project),
      checkoutBranch: "feature",
      repository: {
        commonDirectory: realpathSync(join(project, ".git")),
        integrationBranch: "main",
      },
    });
  });

  it("creates isolated worktrees for concurrent conversations", async () => {
    const project = committedRepository();
    const service = new GitWorktreeService(
      temporaryDirectory("codey-worktrees-"),
    );
    const capability = await service.probeProject(project);
    expect(capability.repository).toEqual({
      commonDirectory: realpathSync(join(project, ".git")),
      integrationBranch: "main",
    });

    const repository = capability.repository!;
    const [first, second] = await Promise.all([
      service.createWorktree({
        projectId: "project-1",
        taskId: "task-1",
        projectPath: capability.path,
        repository,
      }),
      service.createWorktree({
        projectId: "project-1",
        taskId: "task-2",
        projectPath: capability.path,
        repository,
      }),
    ]);

    writeFileSync(join(first.path, "shared.txt"), "first\n");
    writeFileSync(join(second.path, "shared.txt"), "second\n");
    expect(readFileSync(join(first.path, "shared.txt"), "utf8")).toBe("first\n");
    expect(readFileSync(join(second.path, "shared.txt"), "utf8")).toBe(
      "second\n",
    );
    expect(readFileSync(join(project, "shared.txt"), "utf8")).toBe("main\n");
    expect(first.branch).toBe("codey/task-1");
    expect(second.branch).toBe("codey/task-2");
  });

  it("fails closed when a persisted worktree changes branch", async () => {
    const project = committedRepository();
    const service = new GitWorktreeService(
      temporaryDirectory("codey-worktrees-"),
    );
    const capability = await service.probeProject(project);
    const repository = capability.repository!;
    const input = {
      projectId: "project-1",
      taskId: "task-1",
      projectPath: capability.path,
      repository,
    };
    const descriptor = await service.createWorktree(input);
    git(descriptor.path, ["switch", "--quiet", "-c", "unexpected"]);

    await expect(
      service.validateWorktree(input, descriptor),
    ).rejects.toThrow("branch changed");
  });
});
