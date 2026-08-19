import { expect, vi } from "vitest";
import { IPC_CHANNELS } from "../shared/ipc";
import { createDesktopBridge } from "./bridge";

describe("createDesktopBridge", () => {
  it("exposes file browsing and review without checkpoint recovery", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const subscribe = vi.fn(() => () => undefined);
    const bridge = createDesktopBridge(invoke, subscribe);

    expect(Object.keys(bridge)).toEqual([
      "workspace",
      "settings",
      "credentials",
      "task",
      "files",
      "review",
      "todo",
    ]);
    expect(Object.keys(bridge.workspace)).toEqual([
      "list",
      "choose",
      "create",
      "activate",
      "listGitHubRepositories",
      "cloneGitHub",
    ]);
    expect(Object.keys(bridge.credentials)).toEqual(["list", "set", "delete"]);
    expect(Object.keys(bridge.task)).not.toContain("editMessage");
    expect(Object.keys(bridge.files)).toEqual(["list", "read", "onChanged"]);
    expect(Object.keys(bridge.review)).toEqual([
      "snapshot",
      "file",
      "keep",
      "undo",
      "onChanged",
    ]);

    await bridge.files.list({ taskId: "task-1" });
    await bridge.files.read({ taskId: "task-1", path: "src/index.ts" });
    await bridge.review.snapshot({ taskId: "task-1" });
    await bridge.review.file({
      taskId: "task-1",
      fileId: "file-1",
      expectedRevision: 1,
    });
    await bridge.review.keep({
      taskId: "task-1",
      fileId: "file-1",
      expectedRevision: 1,
      expectedSignature: "signature-1",
    });
    await bridge.review.undo({
      taskId: "task-1",
      fileId: "file-1",
      expectedRevision: 1,
      expectedSignature: "signature-1",
    });
    await bridge.task.updateAccessMode({
      taskId: "task-1",
      accessMode: "ask",
    });
    await bridge.task.updateInteractionMode({
      taskId: "task-1",
      interactionMode: "plan",
    });
    await bridge.workspace.create({ name: "new-project" });
    await bridge.workspace.activate({ workspaceId: "workspace-1" });
    await bridge.workspace.listGitHubRepositories();
    await bridge.workspace.cloneGitHub({ nameWithOwner: "octo/repository" });
    await bridge.task.decidePermission({
      taskId: "task-1",
      requestId: "permission-1",
      allowed: true,
    });
    bridge.files.onChanged(() => undefined);
    bridge.review.onChanged(() => undefined);
    bridge.task.onPermissionRequest(() => undefined);

    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.filesList, { taskId: "task-1" });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.filesRead, {
      taskId: "task-1",
      path: "src/index.ts",
    });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.reviewSnapshot, { taskId: "task-1" });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.reviewFile, {
      taskId: "task-1",
      fileId: "file-1",
      expectedRevision: 1,
    });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.taskAccessModeUpdate, {
      taskId: "task-1",
      accessMode: "ask",
    });
    expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.taskInteractionModeUpdate,
      {
        taskId: "task-1",
        interactionMode: "plan",
      },
    );
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.taskPermissionDecide, {
      taskId: "task-1",
      requestId: "permission-1",
      allowed: true,
    });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.workspaceCreate, {
      name: "new-project",
    });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.workspaceActivate, {
      workspaceId: "workspace-1",
    });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.workspaceGitHubList);
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.workspaceGitHubClone, {
      nameWithOwner: "octo/repository",
    });
    expect(subscribe).toHaveBeenCalledWith(IPC_CHANNELS.filesChanged, expect.any(Function));
    expect(subscribe).toHaveBeenCalledWith(IPC_CHANNELS.reviewChanged, expect.any(Function));
    expect(subscribe).toHaveBeenCalledWith(
      IPC_CHANNELS.taskPermissionRequest,
      expect.any(Function),
    );
  });

  it("validates the narrow provider credential contract", async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC_CHANNELS.credentialsList) {
        return [
          { provider: "deepseek", configured: false },
          { provider: "openai", configured: true },
          { provider: "xai", configured: false },
        ];
      }
      return { provider: "openai", configured: true };
    });
    const bridge = createDesktopBridge(invoke, vi.fn(() => () => undefined));

    await expect(bridge.credentials.list()).resolves.toEqual([
      { provider: "deepseek", configured: false },
      { provider: "openai", configured: true },
      { provider: "xai", configured: false },
    ]);
    await bridge.credentials.set({ provider: "openai", apiKey: "sk-test" });
    await bridge.credentials.delete({ provider: "openai" });

    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.credentialsSet, {
      provider: "openai",
      apiKey: "sk-test",
    });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.credentialsDelete, {
      provider: "openai",
    });
    await expect(
      bridge.credentials.set({
        provider: "unsupported",
        apiKey: "test",
      } as never),
    ).rejects.toThrow();
  });
});
