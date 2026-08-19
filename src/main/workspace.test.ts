// @vitest-environment node

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AppStore } from "./app-store";
import {
  createWorkspaceDirectory,
  registerWorkspace,
  requireAvailableWorkspace,
  requireEmptyWorkspace,
} from "./workspace";

const temporaryDirectories: string[] = [];

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), "desktop-agent-workspace-"));
  temporaryDirectories.push(root);
  return {
    root,
    store: new AppStore(join(root, "app.sqlite")),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("workspace validation", () => {
  it("canonicalizes a selected directory and reuses its stored identity", async () => {
    const { root, store } = createHarness();
    const project = join(root, "project");
    const link = join(root, "project-link");
    mkdirSync(project);
    symlinkSync(project, link);

    const first = await registerWorkspace(store, link);
    const second = await registerWorkspace(store, project);

    expect(first).toEqual({
      id: expect.any(String),
      path: realpathSync(project),
      name: "project",
      worktreeAvailable: false,
      branch: null,
    });
    expect(second).toEqual(first);
    await expect(requireAvailableWorkspace(store, first.id)).resolves.toEqual(first);
    store.close();
  });

  it("rejects files and workspaces removed after selection", async () => {
    const { root, store } = createHarness();
    const file = join(root, "not-a-directory.txt");
    writeFileSync(file, "test");
    await expect(registerWorkspace(store, file)).rejects.toThrow(
      "Selected workspace is not a directory",
    );

    const project = join(root, "project");
    mkdirSync(project);
    const workspace = await registerWorkspace(store, project);
    rmSync(project, { recursive: true });

    await expect(requireAvailableWorkspace(store, workspace.id)).rejects.toThrow(
      "Workspace is unavailable",
    );
    store.close();
  });

  it("creates one empty project folder beneath the selected parent", async () => {
    const { root, store } = createHarness();

    const project = await createWorkspaceDirectory(root, "new-project");

    await expect(requireEmptyWorkspace(project)).resolves.toBe(
      realpathSync(project),
    );
    await expect(
      createWorkspaceDirectory(root, "new-project"),
    ).rejects.toThrow("Could not create project folder");
    store.close();
  });

  it("rejects a non-empty GitHub clone destination", async () => {
    const { root, store } = createHarness();
    const destination = join(root, "destination");
    mkdirSync(destination);
    writeFileSync(join(destination, "README.md"), "existing");

    await expect(requireEmptyWorkspace(destination)).rejects.toThrow(
      "must be cloned into an empty folder",
    );
    store.close();
  });
});
