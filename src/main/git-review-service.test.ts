// @vitest-environment node

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AppStore, type StoredTask } from "./app-store";
import { FileBrowserService } from "./file-browser-service";
import { GitReviewService } from "./git-review-service";
import { GitWorktreeService } from "./git-worktree-service";

const directories: string[] = [];

function directory(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  directories.push(value);
  return value;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function taskFixture(taskId = "task-a"): Promise<{ task: StoredTask; store: AppStore; review: GitReviewService; root: string; worktrees: GitWorktreeService; indexRoot: string }> {
  const project = directory("codey-review-project-");
  git(project, ["init", "-b", "main"]);
  writeFileSync(join(project, "hello.txt"), "before\n");
  git(project, ["add", "hello.txt"]);
  git(project, ["-c", "user.name=Codey", "-c", "user.email=codey@example.com", "commit", "-m", "init"]);
  const worktrees = new GitWorktreeService(directory("codey-review-worktrees-"));
  const capability = await worktrees.probeProject(project);
  if (capability.repository === undefined) throw new Error("Expected repository");
  const store = new AppStore(join(directory("codey-review-db-"), "app.sqlite"));
  const workspace = store.saveWorkspace(capability.path, capability.repository, capability.checkoutBranch);
  const descriptor = await worktrees.createWorktree({ projectId: workspace.id, taskId, projectPath: project, repository: capability.repository });
  const task = store.createTask({ id: taskId, title: taskId, status: "idle", workspaceId: workspace.id, executionTarget: "worktree", worktree: descriptor });
  const indexRoot = directory("codey-review-index-");
  return { task, store, root: descriptor.path, worktrees, indexRoot, review: new GitReviewService(store, worktrees, indexRoot) };
}

afterEach(() => {
  for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("GitReviewService", () => {
  it("keeps a file then undoes a later edit without touching the worktree index", async () => {
    const { task, root, review } = await taskFixture();
    writeFileSync(join(root, "hello.txt"), "kept\n");
    const first = await review.snapshot({ taskId: task.id });
    const changed = first.files[0]!;
    const indexBefore = git(root, ["write-tree"]);
    await review.keep({ taskId: task.id, fileId: changed.id, expectedRevision: first.revision, expectedSignature: changed.currentSignature });
    expect(git(root, ["write-tree"])).toBe(indexBefore);
    writeFileSync(join(root, "hello.txt"), "later\n");
    const later = await review.snapshot({ taskId: task.id });
    const laterFile = later.files[0]!;
    await review.undo({ taskId: task.id, fileId: laterFile.id, expectedRevision: later.revision, expectedSignature: laterFile.currentSignature });
    expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("kept\n");
  });

  it("handles new, deleted, and renamed files and rejects stale actions", async () => {
    const { task, root, review } = await taskFixture();
    writeFileSync(join(root, "new.txt"), "new\n");
    let snapshot = await review.snapshot({ taskId: task.id });
    let file = snapshot.files.find((entry) => entry.path === "new.txt")!;
    await review.undo({ taskId: task.id, fileId: file.id, expectedRevision: snapshot.revision, expectedSignature: file.currentSignature });
    expect(() => readFileSync(join(root, "new.txt"))).toThrow();

    git(root, ["rm", "hello.txt"]);
    snapshot = await review.snapshot({ taskId: task.id });
    file = snapshot.files[0]!;
    await review.undo({ taskId: task.id, fileId: file.id, expectedRevision: snapshot.revision, expectedSignature: file.currentSignature });
    expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("before\n");

    renameSync(join(root, "hello.txt"), join(root, "renamed.txt"));
    snapshot = await review.snapshot({ taskId: task.id });
    file = snapshot.files[0]!;
    expect(snapshot.files).toHaveLength(1);
    expect(file).toMatchObject({ status: "renamed", previousPath: "hello.txt", path: "renamed.txt" });
    await expect(review.undo({ taskId: task.id, fileId: file.id, expectedRevision: snapshot.revision - 1, expectedSignature: file.currentSignature })).rejects.toThrow("Review changed");
    await review.undo({ taskId: task.id, fileId: file.id, expectedRevision: snapshot.revision, expectedSignature: file.currentSignature });
    expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("before\n");
    expect(() => readFileSync(join(root, "renamed.txt"))).toThrow();

    renameSync(join(root, "hello.txt"), join(root, "renamed.txt"));
    snapshot = await review.snapshot({ taskId: task.id });
    file = snapshot.files[0]!;
    await review.keep({ taskId: task.id, fileId: file.id, expectedRevision: snapshot.revision, expectedSignature: file.currentSignature });
    expect(readFileSync(join(root, "renamed.txt"), "utf8")).toBe("before\n");
    expect(() => readFileSync(join(root, "hello.txt"))).toThrow();
    expect((await review.snapshot({ taskId: task.id })).files).toHaveLength(0);
  });

  it("browses execution files and rejects traversal", async () => {
    const { task, store, review } = await taskFixture();
    const browser = new FileBrowserService(store);
    const first = await browser.list({ taskId: task.id });
    expect(first.files).toContain("hello.txt");
    writeFileSync(join(task.executionPath, "hello.txt"), "changed through browser\n");
    const next = await browser.list({ taskId: task.id });
    expect(next.revision).toBeGreaterThan(first.revision);
    await expect(browser.read({ taskId: task.id, path: "../outside" })).rejects.toThrow("safe repository-relative");
    await expect(review.snapshot({ taskId: task.id })).resolves.toMatchObject({ taskId: task.id });
    browser.close();
  });

  it("does not traverse an external directory reached through an execution-root symlink", async () => {
    const { task, store, root } = await taskFixture();
    const external = directory("codey-external-large-");
    for (let index = 0; index < 40; index += 1) {
      writeFileSync(join(external, `entry-${index}.txt`), "outside\n");
    }
    symlinkSync(external, join(root, "external-large"));
    const browser = new FileBrowserService(store);
    await browser.list({ taskId: task.id });
    await new Promise((resolveResult) => setTimeout(resolveResult, 350));
    const notifications: string[] = [];
    const unsubscribe = browser.subscribe((taskId) => notifications.push(taskId));
    writeFileSync(join(external, "entry-0.txt"), "changed outside\n");
    await new Promise((resolveResult) => setTimeout(resolveResult, 350));
    expect(notifications).toEqual([]);
    unsubscribe();
    browser.close();
  });

  it("rebuilds a corrupt private index from the durable baseline ref after restart", async () => {
    const { task, store, root, worktrees, indexRoot, review } = await taskFixture();
    writeFileSync(join(root, "hello.txt"), "kept\n");
    const first = await review.snapshot({ taskId: task.id });
    const file = first.files[0]!;
    await review.keep({ taskId: task.id, fileId: file.id, expectedRevision: first.revision, expectedSignature: file.currentSignature });
    writeFileSync(join(indexRoot, `${task.id}.index`), "corrupt private index");
    writeFileSync(join(root, "hello.txt"), "second\n");
    const restarted = new GitReviewService(store, worktrees, indexRoot);
    const snapshot = await restarted.snapshot({ taskId: task.id });
    const changed = snapshot.files[0]!;
    await restarted.keep({ taskId: task.id, fileId: changed.id, expectedRevision: snapshot.revision, expectedSignature: changed.currentSignature });
    writeFileSync(join(root, "hello.txt"), "later\n");
    const later = await restarted.snapshot({ taskId: task.id });
    const laterFile = later.files[0]!;
    await restarted.undo({ taskId: task.id, fileId: laterFile.id, expectedRevision: later.revision, expectedSignature: laterFile.currentSignature });
    expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("second\n");
  });

  it("reviews Local Git changes from a baseline captured before the run", async () => {
    const { task, store, review } = await taskFixture();
    const local = store.createTask({ id: "local-task", title: "local", status: "idle", workspaceId: task.workspace.id, executionTarget: "local" });
    const root = local.executionPath;
    writeFileSync(join(root, "hello.txt"), "pre-existing local change\n");
    const indexBefore = git(root, ["write-tree"]);
    await review.ensureBaseline(local.id);
    expect((await review.snapshot({ taskId: local.id })).files).toHaveLength(0);

    writeFileSync(join(root, "hello.txt"), "agent change\n");
    const first = await review.snapshot({ taskId: local.id });
    const stale = first.files[0]!;
    expect(stale).toMatchObject({ path: "hello.txt", status: "modified" });
    writeFileSync(join(root, "hello.txt"), "accepted agent change\n");
    await expect(review.keep({ taskId: local.id, fileId: stale.id, expectedRevision: first.revision, expectedSignature: stale.currentSignature })).rejects.toThrow("Review changed");
    const refreshed = await review.snapshot({ taskId: local.id });
    const changed = refreshed.files[0]!;
    await review.keep({ taskId: local.id, fileId: changed.id, expectedRevision: refreshed.revision, expectedSignature: changed.currentSignature });
    expect(git(root, ["write-tree"])).toBe(indexBefore);

    writeFileSync(join(root, "hello.txt"), "later change\n");
    const later = await review.snapshot({ taskId: local.id });
    const laterFile = later.files[0]!;
    await review.undo({ taskId: local.id, fileId: laterFile.id, expectedRevision: later.revision, expectedSignature: laterFile.currentSignature });
    expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("accepted agent change\n");
  });

  it("reviews Local non-Git folders with an app-owned durable object store", async () => {
    const root = directory("codey-review-local-");
    writeFileSync(join(root, "hello.txt"), "before\n");
    const store = new AppStore(join(directory("codey-review-local-db-"), "app.sqlite"));
    const workspace = store.saveWorkspace(root);
    const task = store.createTask({ id: "local-folder", title: "local", status: "idle", workspaceId: workspace.id, executionTarget: "local" });
    const indexRoot = directory("codey-review-local-index-");
    const worktrees = { validateWorktree: async () => undefined };
    const review = new GitReviewService(store, worktrees, indexRoot);

    await review.ensureBaseline(task.id);
    expect(() => readFileSync(join(root, ".git", "HEAD"))).toThrow();
    writeFileSync(join(root, "hello.txt"), "changed\n");
    writeFileSync(join(root, "new.txt"), "new\n");
    const first = await review.snapshot({ taskId: task.id });
    expect(first.files.map((file) => file.path)).toEqual(["hello.txt", "new.txt"]);
    const detail = await review.file({ taskId: task.id, fileId: first.files[0]!.id, expectedRevision: first.revision });
    expect(detail).toMatchObject({ oldContent: "before\n", newContent: "changed\n" });

    const changed = first.files.find((file) => file.path === "hello.txt")!;
    await review.keep({ taskId: task.id, fileId: changed.id, expectedRevision: first.revision, expectedSignature: changed.currentSignature });
    writeFileSync(join(root, "hello.txt"), "later\n");
    const restarted = new GitReviewService(store, worktrees, indexRoot);
    const later = await restarted.snapshot({ taskId: task.id });
    const laterFile = later.files.find((file) => file.path === "hello.txt")!;
    await restarted.undo({ taskId: task.id, fileId: laterFile.id, expectedRevision: later.revision, expectedSignature: laterFile.currentSignature });
    expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("changed\n");
  });

  it("treats executable modes and symlink targets as stale-sensitive Git entries", async () => {
    const { task, root, review } = await taskFixture();
    chmodSync(join(root, "hello.txt"), 0o755);
    const executable = await review.snapshot({ taskId: task.id });
    const executableFile = executable.files[0]!;
    expect(executableFile.status).toBe("modified");
    chmodSync(join(root, "hello.txt"), 0o644);
    await expect(review.undo({ taskId: task.id, fileId: executableFile.id, expectedRevision: executable.revision, expectedSignature: executableFile.currentSignature })).rejects.toThrow("Review changed");

    writeFileSync(join(root, "one.txt"), "one\n");
    unlinkSync(join(root, "hello.txt"));
    symlinkSync("one.txt", join(root, "hello.txt"));
    const linked = await review.snapshot({ taskId: task.id });
    const linkFile = linked.files.find((entry) => entry.path === "hello.txt")!;
    expect(linkFile.status).toBe("type-changed");
    const detail = await review.file({ taskId: task.id, fileId: linkFile.id, expectedRevision: linked.revision });
    expect(detail.newContent).toBe("one.txt");
    unlinkSync(join(root, "hello.txt"));
    symlinkSync("two.txt", join(root, "hello.txt"));
    const movedLink = await review.snapshot({ taskId: task.id });
    await expect(review.undo({ taskId: task.id, fileId: linkFile.id, expectedRevision: linked.revision, expectedSignature: linkFile.currentSignature })).rejects.toThrow("Review changed");
    expect(movedLink.revision).toBeGreaterThan(linked.revision);
  });
});
