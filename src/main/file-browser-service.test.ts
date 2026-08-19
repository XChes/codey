// @vitest-environment node

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppStore } from "./app-store";
import { FileBrowserService } from "./file-browser-service";

const directories: string[] = [];

function directory(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  directories.push(value);
  return value;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveResult) => setTimeout(resolveResult, milliseconds));
}

function taskFixture(root: string, taskId = "task-a"): { browser: FileBrowserService; store: AppStore } {
  const store = new AppStore(join(directory("codey-file-browser-db-"), "app.sqlite"));
  const workspace = store.saveWorkspace(root);
  store.createTask({ id: taskId, title: taskId, status: "idle", workspaceId: workspace.id });
  return { browser: new FileBrowserService(store), store };
}

function internals(browser: FileBrowserService): {
  listGitFiles(root: string): Promise<string[]>;
  listRipgrepFiles(root: string): Promise<string[]>;
  watchers: Map<string, unknown>;
} {
  return browser as unknown as {
    listGitFiles(root: string): Promise<string[]>;
    listRipgrepFiles(root: string): Promise<string[]>;
    watchers: Map<string, unknown>;
  };
}

afterEach(() => {
  for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("FileBrowserService", () => {
  it("lists the first file created in an initially empty non-Git workspace", async () => {
    const root = directory("codey-file-browser-project-");
    const { browser } = taskFixture(root);
    const events: Array<{ taskId: string; revision: number }> = [];
    browser.subscribe((taskId, revision) => events.push({ taskId, revision }));

    const initial = await browser.list({ taskId: "task-a" });
    expect(initial.files).toEqual([]);

    await delay(250);
    writeFileSync(join(root, "hello.py"), "print('Hello, World!')\n");
    await delay(350);
    expect(events).toHaveLength(1);

    const refreshed = await browser.list({ taskId: "task-a" });
    expect(refreshed.files).toEqual(["hello.py"]);
    browser.close();
  });

  it("excludes a large Git-ignored virtualenv from listing and watching", async () => {
    const root = directory("codey-file-browser-project-");
    git(root, ["init", "-b", "main"]);
    writeFileSync(join(root, ".gitignore"), ".venv/\n");
    writeFileSync(join(root, "app.py"), "print('ok')\n");
    const virtualenv = join(root, ".venv");
    mkdirSync(virtualenv);
    for (let index = 0; index < 1_000; index += 1) {
      writeFileSync(join(virtualenv, `entry-${index}.txt`), "ignored\n", { flag: "w" });
    }

    const { browser } = taskFixture(root);
    const service = internals(browser);
    const listGitFiles = service.listGitFiles.bind(browser);
    let scans = 0;
    service.listGitFiles = async (path) => {
      scans += 1;
      return listGitFiles(path);
    };
    const events: Array<{ taskId: string; revision: number }> = [];
    browser.subscribe((taskId, revision) => events.push({ taskId, revision }));

    const listed = await browser.list({ taskId: "task-a" });
    expect(listed.files).toEqual([".gitignore", "app.py"]);
    expect(service.watchers).toHaveLength(1);
    expect(scans).toBe(1);

    await delay(250);
    writeFileSync(join(virtualenv, "entry-0.txt"), "changed\n");
    await delay(350);
    expect(events).toEqual([]);
    expect(scans).toBe(1);

    writeFileSync(join(root, "app.py"), "print('changed')\n");
    await delay(350);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ taskId: "task-a", revision: 2 });
    expect(scans).toBe(1);
    const refreshed = await browser.list({ taskId: "task-a" });
    expect(refreshed.revision).toBe(events[0]!.revision);
    expect(scans).toBe(2);
    browser.close();
  });

  it("keeps only the most recently listed task watcher", async () => {
    const firstRoot = directory("codey-file-browser-first-");
    const secondRoot = directory("codey-file-browser-second-");
    writeFileSync(join(firstRoot, "first.txt"), "first\n");
    writeFileSync(join(secondRoot, "second.txt"), "second\n");
    const store = new AppStore(join(directory("codey-file-browser-db-"), "app.sqlite"));
    const firstWorkspace = store.saveWorkspace(firstRoot);
    const secondWorkspace = store.saveWorkspace(secondRoot);
    store.createTask({ id: "first", title: "first", status: "idle", workspaceId: firstWorkspace.id });
    store.createTask({ id: "second", title: "second", status: "idle", workspaceId: secondWorkspace.id });
    const browser = new FileBrowserService(store);
    const events: string[] = [];
    browser.subscribe((taskId) => events.push(taskId));

    await browser.list({ taskId: "first" });
    await browser.list({ taskId: "second" });
    expect(internals(browser).watchers).toEqual(expect.any(Map));
    expect([...internals(browser).watchers.keys()]).toEqual(["second"]);

    await delay(250);
    writeFileSync(join(firstRoot, "first.txt"), "changed\n");
    await delay(350);
    expect(events).toEqual([]);

    writeFileSync(join(secondRoot, "second.txt"), "changed\n");
    await delay(350);
    expect(events).toEqual(["second"]);
    browser.close();
  });

  it("coalesces concurrent scans and reports listing failures instead of walking the tree", async () => {
    const root = directory("codey-file-browser-project-");
    writeFileSync(join(root, "visible.txt"), "visible\n");
    const { browser } = taskFixture(root);
    const service = internals(browser);
    const originalListGitFiles = service.listGitFiles.bind(browser);
    let scans = 0;
    service.listGitFiles = async (path) => {
      scans += 1;
      await delay(50);
      return originalListGitFiles(path);
    };

    const [first, second] = await Promise.all([
      browser.list({ taskId: "task-a" }),
      browser.list({ taskId: "task-a" }),
    ]);
    expect(scans).toBe(1);
    expect(second).toEqual(first);
    browser.close();

    const failure = taskFixture(root, "task-b");
    const failedService = internals(failure.browser);
    failedService.listGitFiles = async () => { throw new Error("Git unavailable"); };
    failedService.listRipgrepFiles = async () => { throw new Error("ripgrep unavailable"); };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(failure.browser.list({ taskId: "task-b" })).rejects.toThrow("Git and ripgrep listing both failed");
    expect(error).toHaveBeenCalledWith(
      "Unable to list workspace files with Git or ripgrep",
      expect.objectContaining({ root: expect.any(String) }),
    );
    error.mockRestore();
    failure.browser.close();
  });
});
