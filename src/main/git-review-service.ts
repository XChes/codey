import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readlink, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { AppStore, StoredTask } from "./app-store";
import type { GitWorktreeService } from "./git-worktree-service";
import type {
  ReviewActionInput,
  ReviewFile,
  ReviewFileDetail,
  ReviewFileInput,
  ReviewFileStatus as ReviewStatus,
  ReviewSnapshot,
  ReviewSnapshotInput,
} from "../shared/review";

const MAX_PREVIEW_BYTES = 1024 * 1024;
const REVIEW_REF_PREFIX = "refs/codey/review/";

export type {
  ReviewActionInput,
  ReviewFile,
  ReviewFileDetail,
  ReviewFileInput,
  ReviewSnapshot,
  ReviewSnapshotInput,
} from "../shared/review";

interface GitOutput { stdout: string; stderr: string }
interface RevisionState { revision: number; fingerprint: string }
interface GitCommandOptions { indexPath?: string; gitDir?: string }
interface ReviewContext {
  task: StoredTask;
  root: string;
  indexPath: string;
  ref: string;
  gitDir?: string;
}

function runGit(cwd: string, args: string[], options: GitCommandOptions = {}): Promise<GitOutput> {
  return new Promise((resolveResult, reject) => {
    const env = options.indexPath === undefined && options.gitDir === undefined
      ? process.env
      : {
          ...process.env,
          ...(options.indexPath === undefined ? {} : { GIT_INDEX_FILE: options.indexPath }),
          ...(options.gitDir === undefined ? {} : { GIT_DIR: options.gitDir, GIT_WORK_TREE: cwd }),
        };
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        env,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(stderr.trim() || stdout.trim() || `Git command failed: git ${args.join(" ")}`));
          return;
        }
        resolveResult({ stdout, stderr });
      },
    );
  });
}

function runGitBuffer(cwd: string, args: string[], gitDir?: string): Promise<Buffer> {
  return new Promise((resolveResult, reject) => {
    const env = gitDir === undefined
      ? process.env
      : { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: cwd };
    execFile("git", args, { cwd, encoding: "buffer", maxBuffer: 32 * 1024 * 1024, env }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(Buffer.from(stderr).toString("utf8").trim() || "Git command failed."));
        return;
      }
      resolveResult(Buffer.from(stdout));
    });
  });
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isBinary(data: Buffer): boolean { return data.includes(0); }

function reviewId(status: ReviewStatus, previousPath: string | null, path: string): string {
  return Buffer.from(JSON.stringify([status, previousPath, path])).toString("base64url");
}

function parseReviewId(id: string): { status: ReviewStatus; previousPath: string | null; path: string } {
  try {
    const [status, previousPath, path] = JSON.parse(Buffer.from(id, "base64url").toString("utf8")) as unknown[];
    if (
      !["added", "modified", "deleted", "renamed", "type-changed"].includes(String(status)) ||
      (previousPath !== null && typeof previousPath !== "string") ||
      typeof path !== "string"
    ) throw new Error();
    return { status: status as ReviewStatus, previousPath: previousPath as string | null, path };
  } catch {
    throw new Error("Invalid review file identifier.");
  }
}

function safeRelativePath(path: string): boolean {
  return path.length > 0 && !path.includes("\0") && !isAbsolute(path) && !path.split(/[\\/]/).includes("..");
}

function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

/**
 * Maintains a private Git tree for the files the user has kept.  It never uses
 * the worktree's normal index, so review state cannot perturb agent Git work.
 */
export class GitReviewService {
  private readonly mutations = new Map<string, Promise<void>>();
  private readonly revisions = new Map<string, RevisionState>();

  constructor(
    private readonly store: AppStore,
    private readonly worktrees: Pick<GitWorktreeService, "validateWorktree">,
    private readonly storageRoot: string,
  ) {}

  async snapshot(input: ReviewSnapshotInput): Promise<ReviewSnapshot> {
    return this.serialize(input.taskId, async () => {
      const context = await this.context(input.taskId);
      return this.buildSnapshot(context);
    });
  }

  async ensureBaseline(taskId: string): Promise<void> {
    await this.serialize(taskId, async () => {
      const context = await this.context(taskId);
      await this.baseline(context);
    });
  }

  async file(input: ReviewFileInput): Promise<ReviewFileDetail> {
    return this.serialize(input.taskId, async () => {
      const context = await this.context(input.taskId);
      const snapshot = await this.buildSnapshot(context);
      this.requireRevision(snapshot, input.expectedRevision);
      const file = this.findFile(snapshot, input.fileId);
      const oldData = file.previousPath === null && file.status === "added"
        ? undefined
        : await this.readTreeFile(context, snapshot.baselineTree, file.previousPath ?? file.path);
      const newData = file.status === "deleted"
        ? undefined
        : await this.readCurrentFile(context.root, file.path);
      const oldPreview = this.preview(oldData);
      const newPreview = this.preview(newData);
      return {
        file,
        oldContent: oldPreview.content,
        newContent: newPreview.content,
        truncated: oldPreview.truncated || newPreview.truncated,
      };
    });
  }

  keep(input: ReviewActionInput): Promise<ReviewSnapshot> {
    return this.serialize(input.taskId, async () => {
      const context = await this.context(input.taskId);
      const snapshot = await this.buildSnapshot(context);
      this.requireMutation(snapshot, input);
      const file = this.findFile(snapshot, input.fileId);
      await this.resetPrivateIndex(context, snapshot.baselineTree);
      if (file.status === "deleted") {
        await this.git(context, ["update-index", "--force-remove", "--", file.path], context.indexPath);
      } else if (file.status === "renamed") {
        await this.git(context, ["update-index", "--force-remove", "--", file.previousPath!], context.indexPath);
        await this.git(context, ["add", "--", file.path], context.indexPath);
      } else {
        await this.git(context, ["add", "--", file.path], context.indexPath);
      }
      await this.requireCurrentSignature(
        context.root,
        file,
        input.expectedSignature,
      );
      const tree = (await this.git(context, ["write-tree"], context.indexPath)).stdout.trim();
      await this.advanceBaseline(context, tree, snapshot.baselineTree);
      const next = await this.buildSnapshot(context);
      return next;
    });
  }

  undo(input: ReviewActionInput): Promise<ReviewSnapshot> {
    return this.serialize(input.taskId, async () => {
      const context = await this.context(input.taskId);
      const snapshot = await this.buildSnapshot(context);
      this.requireMutation(snapshot, input);
      const file = this.findFile(snapshot, input.fileId);
      await this.requireCurrentSignature(
        context.root,
        file,
        input.expectedSignature,
      );
      if (file.status === "added") {
        await this.removeCurrentFile(context.root, file.path);
      } else if (file.status === "renamed") {
        await this.restore(context, snapshot.baselineTree, file.previousPath!);
        await this.removeCurrentFile(context.root, file.path);
      } else {
        await this.restore(context, snapshot.baselineTree, file.path);
      }
      const next = await this.buildSnapshot(context);
      return next;
    });
  }

  close(): void {
    this.revisions.clear();
  }

  private async context(taskId: string): Promise<ReviewContext> {
    const task = this.store.getTask(taskId);
    if (task === undefined) throw new Error(`Conversation does not exist: ${taskId}`);
    if (basename(taskId) !== taskId) throw new Error("Invalid conversation identifier.");
    await mkdir(this.storageRoot, { recursive: true });
    const common = {
      task,
      indexPath: join(this.storageRoot, `${taskId}.index`),
      ref: `${REVIEW_REF_PREFIX}${taskId}`,
    };
    if (task.executionTarget === "worktree") {
      if (task.worktree === undefined || task.repository === undefined) {
        throw new Error("Conversation worktree is unavailable.");
      }
      await this.worktrees.validateWorktree(
        { projectId: task.workspace.id, taskId, projectPath: task.workspace.path, repository: task.repository },
        task.worktree,
      );
      return { ...common, root: await realpath(task.worktree.path) };
    }

    const root = await realpath(task.executionPath);
    if (task.repository !== undefined) return { ...common, root };
    const gitDir = join(this.storageRoot, "repositories", taskId);
    await this.ensureShadowRepository(root, gitDir);
    return { ...common, root, gitDir };
  }

  private async ensureShadowRepository(root: string, gitDir: string): Promise<void> {
    try {
      await lstat(join(gitDir, "HEAD"));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(dirname(gitDir), { recursive: true });
      await runGit(root, ["init", "--bare", gitDir]);
    }
  }

  private async baseline(context: ReviewContext): Promise<string> {
    try {
      return (await this.git(context, ["rev-parse", "--verify", `${context.ref}^{tree}`])).stdout.trim();
    } catch {
      const base = context.task.executionTarget === "worktree"
        ? (await this.git(context, ["rev-parse", "--verify", `${context.task.worktree!.baseCommit}^{tree}`])).stdout.trim()
        : await this.captureCurrentTree(context);
      try {
        await this.git(context, ["update-ref", context.ref, base, "0000000000000000000000000000000000000000"]);
        return base;
      } catch {
        return (await this.git(context, ["rev-parse", "--verify", `${context.ref}^{tree}`])).stdout.trim();
      }
    }
  }

  private async captureCurrentTree(context: ReviewContext): Promise<string> {
    await mkdir(dirname(context.indexPath), { recursive: true });
    await rm(context.indexPath, { force: true });
    try {
      await this.git(context, ["read-tree", "--empty"], context.indexPath);
      await this.git(context, ["add", "-A"], context.indexPath);
      return (await this.git(context, ["write-tree"], context.indexPath)).stdout.trim();
    } finally {
      await rm(context.indexPath, { force: true });
    }
  }

  private async buildSnapshot(context: ReviewContext): Promise<ReviewSnapshot> {
    const baselineTree = await this.baseline(context);
    const files = await this.changedFiles(context, baselineTree);
    const fingerprint = sha256(JSON.stringify({ baselineTree, files: files.map(({ id, currentSignature }) => [id, currentSignature]) }));
    const state = this.revisions.get(context.task.id);
    const revision = state === undefined ? 1 : state.fingerprint === fingerprint ? state.revision : state.revision + 1;
    this.revisions.set(context.task.id, { revision, fingerprint });
    return { taskId: context.task.id, revision, baselineTree, files };
  }

  private async changedFiles(context: ReviewContext, baselineTree: string): Promise<ReviewFile[]> {
    const candidateTree = await this.candidateTree(context, baselineTree);
    const [names, numbers] = await Promise.all([
      this.git(context, ["diff-tree", "--no-commit-id", "-r", "--name-status", "-z", "-M", baselineTree, candidateTree]),
      this.git(context, ["diff-tree", "--no-commit-id", "-r", "--numstat", "-z", "-M", baselineTree, candidateTree]),
    ]);
    const counts = this.parseNumstat(numbers.stdout);
    const entries = this.parseNames(names.stdout).filter(({ path, previousPath }) => safeRelativePath(path) && (previousPath === null || safeRelativePath(previousPath)));
    const files: ReviewFile[] = [];
    for (const entry of entries) {
      const count = counts.get(`${entry.previousPath ?? ""}\0${entry.path}`) ?? counts.get(`\0${entry.path}`) ?? { additions: 0, deletions: 0, isBinary: false };
      const signature = await this.currentSignature(context.root, entry.status, entry.previousPath, entry.path);
      const binaryData = entry.status === "deleted"
        ? await this.readTreeFile(context, baselineTree, entry.previousPath ?? entry.path)
        : await this.readCurrentFile(context.root, entry.path);
      files.push({
        id: reviewId(entry.status, entry.previousPath, entry.path),
        ...entry,
        additions: count.additions,
        deletions: count.deletions,
        isBinary: count.isBinary || (binaryData !== undefined && isBinary(binaryData)),
        currentSignature: signature,
      });
    }
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  private async candidateTree(context: ReviewContext, baselineTree: string): Promise<string> {
    await this.resetPrivateIndex(context, baselineTree);
    try {
      await this.git(context, ["add", "-A"], context.indexPath);
      return (await this.git(context, ["write-tree"], context.indexPath)).stdout.trim();
    } finally {
      await this.resetPrivateIndex(context, baselineTree);
    }
  }

  private parseNames(output: string): Array<{ status: ReviewStatus; path: string; previousPath: string | null }> {
    const tokens = output.split("\0");
    const result: Array<{ status: ReviewStatus; path: string; previousPath: string | null }> = [];
    for (let index = 0; index < tokens.length - 1;) {
      const code = tokens[index++];
      if (!code) break;
      const kind = code[0];
      if (kind === "R" || kind === "C") {
        const previousPath = tokens[index++];
        const path = tokens[index++];
        if (path !== undefined && previousPath !== undefined) result.push({ status: "renamed", path, previousPath });
        continue;
      }
      const path = tokens[index++];
      if (path === undefined) break;
      const status: ReviewStatus = kind === "A" ? "added" : kind === "D" ? "deleted" : kind === "T" ? "type-changed" : "modified";
      result.push({ status, path, previousPath: null });
    }
    return result;
  }

  private parseNumstat(output: string): Map<string, { additions: number; deletions: number; isBinary: boolean }> {
    const result = new Map<string, { additions: number; deletions: number; isBinary: boolean }>();
    const tokens = output.split("\0");
    for (let index = 0; index < tokens.length - 1;) {
      const header = tokens[index++];
      if (!header) break;
      const [added, deleted, path] = header.split("\t");
      let previousPath = "";
      let currentPath = path;
      if (path === "") {
        previousPath = tokens[index++] ?? "";
        currentPath = tokens[index++] ?? "";
      }
      result.set(`${previousPath}\0${currentPath}`, {
        additions: added === "-" ? 0 : Number(added),
        deletions: deleted === "-" ? 0 : Number(deleted),
        isBinary: added === "-" || deleted === "-",
      });
    }
    return result;
  }

  private async currentSignature(root: string, status: ReviewStatus, previousPath: string | null, path: string): Promise<string> {
    const current = status === "deleted" ? undefined : await this.currentGitEntry(root, path);
    return sha256(Buffer.concat([
      Buffer.from(`${status}\0${previousPath ?? ""}\0${path}\0${current?.mode ?? "missing"}\0`),
      current?.content ?? Buffer.alloc(0),
    ]));
  }

  private async readCurrentFile(root: string, path: string): Promise<Buffer | undefined> {
    const entry = await this.currentGitEntry(root, path);
    return entry?.content;
  }

  private async currentGitEntry(root: string, path: string): Promise<{ mode: string; content: Buffer } | undefined> {
    const target = await this.pathInRoot(root, path, true);
    let stats;
    try { stats = await lstat(target); } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      return { mode: "120000", content: Buffer.from(await readlink(target), "utf8") };
    }
    if (!stats.isFile()) throw new Error(`Review path is not a file: ${path}`);
    return {
      mode: (stats.mode & 0o111) === 0 ? "100644" : "100755",
      content: await readFile(target),
    };
  }

  private async readTreeFile(context: ReviewContext, tree: string, path: string): Promise<Buffer | undefined> {
    try { return await runGitBuffer(context.root, ["show", `${tree}:${path}`], context.gitDir); } catch { return undefined; }
  }

  private preview(data: Buffer | undefined): { content: string | null; truncated: boolean } {
    if (data === undefined || isBinary(data)) return { content: null, truncated: false };
    return { content: data.subarray(0, MAX_PREVIEW_BYTES).toString("utf8"), truncated: data.byteLength > MAX_PREVIEW_BYTES };
  }

  private async resetPrivateIndex(context: ReviewContext, tree: string): Promise<void> {
    await mkdir(dirname(context.indexPath), { recursive: true });
    await rm(context.indexPath, { force: true });
    await this.git(context, ["read-tree", tree], context.indexPath);
  }

  private async advanceBaseline(context: ReviewContext, tree: string, expected: string): Promise<void> {
    try {
      await this.git(context, ["update-ref", context.ref, tree, expected]);
    } catch {
      throw new Error("Review baseline changed; refresh and try again.");
    }
  }

  private async restore(context: ReviewContext, tree: string, path: string): Promise<void> {
    await this.pathInRoot(context.root, path, true);
    await this.git(context, ["restore", `--source=${tree}`, "--worktree", "--", path]);
  }

  private git(context: ReviewContext, args: string[], indexPath?: string): Promise<GitOutput> {
    return runGit(context.root, args, { indexPath, gitDir: context.gitDir });
  }

  private async removeCurrentFile(root: string, path: string): Promise<void> {
    const target = await this.pathInRoot(root, path, true);
    const stat = await lstat(target).catch(() => undefined);
    if (stat === undefined) return;
    if (stat.isDirectory()) throw new Error("Review files cannot be directories.");
    await rm(target, { force: true });
  }

  private async pathInRoot(root: string, path: string, allowMissing: boolean): Promise<string> {
    if (!safeRelativePath(path)) throw new Error("Path must be a safe repository-relative path.");
    const target = resolve(root, path);
    if (!within(root, target)) throw new Error("Path escapes the conversation worktree.");
    let check = allowMissing ? dirname(target) : target;
    while (true) {
      try {
        const canonical = await realpath(check);
        if (!within(root, canonical)) throw new Error("Path resolves outside the conversation worktree.");
        break;
      } catch (error: unknown) {
        if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(check);
        if (parent === check) throw error;
        check = parent;
      }
    }
    return target;
  }

  private findFile(snapshot: ReviewSnapshot, fileId: string): ReviewFile {
    const parsed = parseReviewId(fileId);
    const file = snapshot.files.find((candidate) => candidate.id === fileId);
    if (file === undefined || file.path !== parsed.path || file.previousPath !== parsed.previousPath || file.status !== parsed.status) {
      throw new Error("Review file is no longer available; refresh and try again.");
    }
    return file;
  }

  private requireRevision(snapshot: ReviewSnapshot, expected: number): void {
    if (snapshot.revision !== expected) throw new Error("Review changed; refresh and try again.");
  }

  private requireMutation(snapshot: ReviewSnapshot, input: ReviewActionInput): void {
    this.requireRevision(snapshot, input.expectedRevision);
    const file = this.findFile(snapshot, input.fileId);
    if (file.currentSignature !== input.expectedSignature) throw new Error("File changed; refresh and try again.");
  }

  private async requireCurrentSignature(
    root: string,
    file: ReviewFile,
    expectedSignature: string,
  ): Promise<void> {
    const currentSignature = await this.currentSignature(
      root,
      file.status,
      file.previousPath,
      file.path,
    );
    if (currentSignature !== expectedSignature) {
      throw new Error("File changed; refresh and try again.");
    }
  }

  private serialize<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(taskId) ?? Promise.resolve();
    const running = previous.catch(() => undefined).then(operation);
    const settled = running.then(() => undefined, () => undefined);
    this.mutations.set(taskId, settled);
    void settled.then(() => {
      if (this.mutations.get(taskId) === settled) this.mutations.delete(taskId);
    });
    return running;
  }

}
