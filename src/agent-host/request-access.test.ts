// @vitest-environment node

import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  AccessRestartController,
  createRequestAccessTool,
} from "./request-access";

function createTool(input?: {
  accessMode?: "ask" | "auto" | "full";
  interactionMode?: "agent" | "plan";
}) {
  const requestPermission = vi.fn(async () => true);
  const restartController = new AccessRestartController();
  const tool = createRequestAccessTool({
    workspace: "/project",
    accessMode: input?.accessMode ?? "ask",
    interactionMode: input?.interactionMode ?? "agent",
    requestPermission,
    restartController,
  });
  return { requestPermission, restartController, tool };
}

async function execute(
  tool: ReturnType<typeof createRequestAccessTool>,
  input: { path: string; access: "read" | "write"; reason: string },
) {
  return tool.execute(
    "tool-1",
    input,
    undefined,
    undefined,
    {} as never,
  );
}

describe("request_access", () => {
  it("requests a canonical external path and schedules an approved restart", async () => {
    const { requestPermission, restartController, tool } = createTool();

    const result = await execute(tool, {
      path: "~/Documents/reference",
      access: "write",
      reason: "Update the referenced project",
    });

    expect(requestPermission).toHaveBeenCalledWith({
      kind: "file-write",
      resource: join(homedir(), "Documents/reference"),
      reason: "Update the referenced project",
    });
    expect(result.details).toMatchObject({
      allowed: true,
      restartRequired: true,
    });
    expect(restartController.consumeApproved("tool-1")).toBe(true);
    expect(restartController.consumeRestartRequest()).toBe(true);
  });

  it("does not prompt when Full already covers the requested path", async () => {
    const { requestPermission, tool } = createTool({ accessMode: "full" });

    const result = await execute(tool, {
      path: "/tmp/reference",
      access: "read",
      reason: "Inspect it",
    });

    expect(requestPermission).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ restartRequired: false });
  });

  it.each([
    "~/.ssh",
    "~",
    "~/Library/Application Support",
    "/project/.git/config",
    "/System",
  ])(
    "rejects protected path %s before prompting",
    async (path) => {
      const { requestPermission, tool } = createTool();

      await expect(
        execute(tool, {
          path,
          access: "read",
          reason: "Inspect protected data",
        }),
      ).rejects.toThrow("protected path");
      expect(requestPermission).not.toHaveBeenCalled();
    },
  );

  it("rejects write requests in Plan mode", async () => {
    const { requestPermission, tool } = createTool({
      interactionMode: "plan",
    });

    await expect(
      execute(tool, {
        path: "/tmp/reference",
        access: "write",
        reason: "Change it",
      }),
    ).rejects.toThrow("Plan mode cannot request write access");
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
