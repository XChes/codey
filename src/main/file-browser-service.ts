import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { watch, type FSWatcher } from "chokidar";

import type { AppStore, StoredTask } from "./app-store";
import type {
  FileContent,
  FileListInput,
  FileListResult,
  FileReadInput,
} from "../shared/files";

const MAX_PREVIEW_BYTES = 1024 * 1024;

export type { FileContent, FileListInput, FileListResult, FileReadInput } from "../shared/files";

export type FileChangeListener = (taskId: string, revision: number) => void;

const NON_GIT_IGNORED_DIRECTORIES = [
  ".venv",
  "venv",
  "node_modules",
  ".cache",
  "__pycache__",
  ".pytest_cache",
];

interface ScanState {
  pending?: Promise<FileListResult>;
}

interface RevisionState {
  revision: number;
  fingerprint: string;
  invalidated: boolean;
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolveResult, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(stderr.trim() || stdout.trim() || "Git command failed."));
          return;
        }
        resolveResult(stdout);
      },
    );
  });
}

function isBinary(data: Buffer): boolean {
  return data.includes(0);
}

/** Main-process-only filesystem access for a task's execution target. */
export class FileBrowserService {
  private readonly revisions = new Map<string, RevisionState>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly invalidations = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly scans = new Map<string, ScanState>();
  private readonly listeners = new Set<FileChangeListener>();
  private activeWatchTaskId: string | null = null;

  constructor(private readonly store: AppStore) {}

  async list(input: FileListInput): Promise<FileListResult> {
    const task = this.requireTask(input.taskId);
    this.activateWatchTask(task.id);
    const state = this.scans.get(task.id) ?? {};
    this.scans.set(task.id, state);
    if (state.pending !== undefined) return state.pending;

    const pending = this.listTask(task).finally(() => {
      if (state.pending === pending) state.pending = undefined;
    });
    state.pending = pending;
    return pending;
  }

  private async listTask(task: StoredTask): Promise<FileListResult> {
    const root = await realpath(task.executionPath);
    const files = await this.listFiles(root);
    const sorted = [...new Set(files)].sort();
    const fingerprint = await this.fingerprint(root, sorted);
    const previous = this.revisions.get(task.id);
    const revision = previous === undefined
      ? 1
      : previous.fingerprint === fingerprint || previous.invalidated
        ? previous.revision
        : previous.revision + 1;
    this.revisions.set(task.id, { revision, fingerprint, invalidated: false });
    await this.watch(task.id, root);
    return { taskId: task.id, revision, files: sorted };
  }

  async read(input: FileReadInput): Promise<FileContent> {
    const task = this.requireTask(input.taskId);
    const root = await realpath(task.executionPath);
    const target = await this.resolvePath(root, input.path);
    const stats = await lstat(target);
    if (!stats.isFile() && !stats.isSymbolicLink()) {
      throw new Error(`Path is not a file: ${input.path}`);
    }
    const data = await readFile(target);
    const binary = isBinary(data);
    const preview = data.subarray(0, MAX_PREVIEW_BYTES);
    return {
      path: input.path,
      content: binary ? null : preview.toString("utf8"),
      isBinary: binary,
      truncated: data.byteLength > MAX_PREVIEW_BYTES,
      size: data.byteLength,
    };
  }

  subscribe(listener: FileChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    for (const watcher of this.watchers.values()) {
      void watcher.close().catch((error: unknown) => {
        console.error("Failed to close file watcher", error);
      });
    }
    for (const timeout of this.invalidations.values()) clearTimeout(timeout);
    this.watchers.clear();
    this.invalidations.clear();
    this.scans.clear();
    this.listeners.clear();
    this.revisions.clear();
    this.activeWatchTaskId = null;
  }

  private requireTask(taskId: string): StoredTask {
    const task = this.store.getTask(taskId);
    if (task === undefined) throw new Error(`Conversation does not exist: ${taskId}`);
    return task;
  }

  private async listGitFiles(root: string): Promise<string[]> {
    const output = await runGit(root, ["ls-files", "-co", "--exclude-standard", "-z"]);
    return output
      .split("\0")
      .filter(Boolean)
      .filter((path) => this.isSafeRelativePath(path));
  }

  private async listFiles(root: string): Promise<string[]> {
    try {
      return await this.listGitFiles(root);
    } catch (gitError) {
      try {
        return await this.listRipgrepFiles(root);
      } catch (ripgrepError) {
        console.error("Unable to list workspace files with Git or ripgrep", {
          root,
          gitError,
          ripgrepError,
        });
        throw new Error("Could not list workspace files. Git and ripgrep listing both failed.");
      }
    }
  }

  private async listRipgrepFiles(root: string): Promise<string[]> {
    const output = await new Promise<string>((resolveResult, reject) => {
      execFile(
        rgPath,
        [
          "--files",
          "--hidden",
          "--glob",
          "!.git/**",
          ...NON_GIT_IGNORED_DIRECTORIES.flatMap((directory) => ["--glob", `!**/${directory}/**`]),
          "--null",
        ],
        { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error !== null && error.code !== 1) {
            reject(new Error(stderr.trim() || "File listing failed."));
            return;
          }
          resolveResult(stdout);
        },
      );
    });
    return output
      .split("\0")
      .filter(Boolean)
      .filter((path) => this.isSafeRelativePath(path));
  }

  private async fingerprint(root: string, paths: string[]): Promise<string> {
    const digest = createHash("sha256");
    for (const path of paths) {
      const target = await this.resolveListPath(root, path);
      const stats = await lstat(target, { bigint: true });
      digest
        .update(path)
        .update("\0")
        .update(String(stats.mode))
        .update("\0")
        .update(String(stats.size))
        .update("\0")
        .update(String(stats.mtimeNs))
        .update("\0");
      if (stats.isSymbolicLink()) {
        digest.update(await readlink(target)).update("\0");
      }
    }
    return digest.digest("hex");
  }

  private isSafeRelativePath(path: string): boolean {
    return path.length > 0 && !path.includes("\0") && !isAbsolute(path) && !path.split(/[\\/]/).includes("..");
  }

  private async resolvePath(root: string, requestedPath: string): Promise<string> {
    if (!this.isSafeRelativePath(requestedPath)) {
      throw new Error("Path must be a safe repository-relative path.");
    }
    const target = resolve(root, requestedPath);
    if (!this.isWithin(root, target)) throw new Error("Path escapes the execution root.");
    const resolvedTarget = await realpath(target);
    if (!this.isWithin(root, resolvedTarget)) throw new Error("Path resolves outside the execution root.");
    return resolvedTarget;
  }

  private async resolveListPath(root: string, requestedPath: string): Promise<string> {
    if (!this.isSafeRelativePath(requestedPath)) {
      throw new Error("Path must be a safe repository-relative path.");
    }
    const target = resolve(root, requestedPath);
    if (!this.isWithin(root, target)) throw new Error("Path escapes the execution root.");
    const parent = await realpath(join(target, ".."));
    if (!this.isWithin(root, parent)) throw new Error("Path resolves outside the execution root.");
    return target;
  }

  private isWithin(root: string, target: string): boolean {
    const path = relative(root, target);
    return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
  }

  private async ignoredDirectories(root: string): Promise<string[]> {
    try {
      const output = await runGit(root, [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
      ]);
      return output
        .split("\0")
        .filter((path) => path.endsWith("/"))
        .map((path) => path.slice(0, -1))
        .filter((path) => this.isSafeRelativePath(path))
        .map((path) => resolve(root, path));
    } catch {
      return NON_GIT_IGNORED_DIRECTORIES.map((path) => resolve(root, path));
    }
  }

  private closeWatcher(taskId: string): void {
    const watcher = this.watchers.get(taskId);
    this.watchers.delete(taskId);
    const timeout = this.invalidations.get(taskId);
    if (timeout !== undefined) clearTimeout(timeout);
    this.invalidations.delete(taskId);
    if (watcher !== undefined) {
      void watcher.close().catch((error: unknown) => {
        console.error("Failed to close file watcher", error);
      });
    }
  }

  private activateWatchTask(taskId: string): void {
    if (this.activeWatchTaskId === taskId) return;
    for (const watchedTaskId of this.watchers.keys()) this.closeWatcher(watchedTaskId);
    this.activeWatchTaskId = taskId;
  }

  private async watch(taskId: string, root: string): Promise<void> {
    if (this.activeWatchTaskId !== taskId) return;
    if (this.watchers.has(taskId)) return;
    const ignoredDirectories = await this.ignoredDirectories(root);
    if (this.activeWatchTaskId !== taskId || this.watchers.has(taskId)) return;
    const gitPath = join(root, ".git");
    const ignored = [gitPath, ...ignoredDirectories];
    let watcher: FSWatcher;
    try {
      watcher = watch(root, {
        followSymlinks: false,
        ignoreInitial: true,
        ignored: (path) => ignored.some((directory) => path === directory || path.startsWith(`${directory}${sep}`)),
      });
    } catch (error) {
      console.error("Failed to start file watcher", error);
      return;
    }
    watcher.on("error", (error: unknown) => {
      console.error("File watcher failed", error);
      if (this.watchers.get(taskId) === watcher) {
        this.watchers.delete(taskId);
        if (this.activeWatchTaskId === taskId) this.activeWatchTaskId = null;
        void watcher.close().catch((closeError: unknown) => {
          console.error("Failed to close file watcher", closeError);
        });
      }
    });
    watcher.on("all", () => {
      const previous = this.invalidations.get(taskId);
      if (previous !== undefined) clearTimeout(previous);
      this.invalidations.set(taskId, setTimeout(() => {
        this.invalidations.delete(taskId);
        const state = this.revisions.get(taskId);
        const revision = (state?.revision ?? 0) + 1;
        this.revisions.set(taskId, {
          revision,
          fingerprint: state?.fingerprint ?? "",
          invalidated: true,
        });
        for (const listener of this.listeners) listener(taskId, revision);
      }, 120));
    });
    this.watchers.set(taskId, watcher);
  }
}
