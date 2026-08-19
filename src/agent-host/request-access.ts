import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type {
  TaskAccessMode,
  TaskInteractionMode,
} from "../shared/task.js";
import { isProtectedAccessPath } from "./sandbox-policy.js";
import type { AgentPermissionRequester } from "./session.js";

export const REQUEST_ACCESS_TOOL_NAME = "request_access";

const RequestAccessParameters = Type.Object({
  path: Type.String({
    minLength: 1,
    description:
      "Absolute path, workspace-relative path, or ~/ path that requires access",
  }),
  access: StringEnum(["read", "write"] as const),
  reason: Type.String({
    minLength: 1,
    description: "Why this path is required for the current task",
  }),
});

export class AccessRestartController {
  private readonly approvedToolCalls = new Set<string>();
  private restartRequested = false;

  markApproved(toolCallId: string): void {
    this.approvedToolCalls.add(toolCallId);
  }

  consumeApproved(toolCallId: string): boolean {
    const approved = this.approvedToolCalls.delete(toolCallId);
    if (approved) this.restartRequested = true;
    return approved;
  }

  get pending(): boolean {
    return this.restartRequested;
  }

  consumeRestartRequest(): boolean {
    const requested = this.restartRequested;
    this.restartRequested = false;
    return requested;
  }
}

function resolveAccessPath(workspace: string, path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(join(homedir(), path.slice(2)));
  return resolve(workspace, path);
}

function containsPath(root: string, path: string): boolean {
  const difference = relative(resolve(root), resolve(path));
  return (
    difference === "" ||
    (!isAbsolute(difference) &&
      difference !== ".." &&
      !difference.startsWith(`..${sep}`))
  );
}

function textResult(
  text: string,
  details: Record<string, unknown>,
): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  return { content: [{ type: "text", text }], details };
}

export function createRequestAccessTool(input: {
  workspace: string;
  accessMode: TaskAccessMode;
  interactionMode: TaskInteractionMode;
  requestPermission: AgentPermissionRequester;
  restartController: AccessRestartController;
}): ToolDefinition {
  return defineTool({
    name: REQUEST_ACCESS_TOOL_NAME,
    label: "Request access",
    description: [
      "Request filesystem access outside the current project before using read, write, edit, grep, find, ls, or bash there.",
      "Do not infer or parse Bash paths: call this tool explicitly with the external path first.",
      "Approved access restarts the isolated worker automatically and then continues the task.",
    ].join(" "),
    parameters: RequestAccessParameters,
    async execute(toolCallId, params) {
      const path = resolveAccessPath(input.workspace, params.path);
      if (params.access === "write" && input.interactionMode === "plan") {
        throw new Error("Plan mode cannot request write access");
      }
      if (isProtectedAccessPath(input.workspace, path)) {
        throw new Error(`Access is permanently denied for protected path: ${path}`);
      }
      if (containsPath(input.workspace, path) || input.accessMode === "full") {
        return textResult(`Access is already available for ${path}.`, {
          path,
          access: params.access,
          restartRequired: false,
        });
      }

      const allowed = await input.requestPermission({
        kind: params.access === "write" ? "file-write" : "file-read",
        resource: path,
        reason: params.reason,
      });
      if (!allowed) {
        return textResult(`Access was denied for ${path}.`, {
          path,
          access: params.access,
          allowed: false,
          restartRequired: false,
        });
      }

      input.restartController.markApproved(toolCallId);
      return textResult(
        `Access approved for ${path}. The isolated worker will restart and continue automatically.`,
        {
          path,
          access: params.access,
          allowed: true,
          restartRequired: true,
        },
      );
    },
  });
}
