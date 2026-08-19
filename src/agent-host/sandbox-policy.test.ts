// @vitest-environment node

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createWorkerSandboxConfig,
  isPermanentlyDeniedNetworkHost,
  nodeCommandWithSandboxProxy,
} from "./sandbox-policy";

const baseInput = {
  workspace: "/tmp/project",
  sessionDir: "/tmp/sessions/task-1",
  workerTemp: "/tmp/worker",
  workerPath: "/Applications/Codey.app/Contents/Resources/worker.mjs",
  executablePath: process.execPath,
  ripgrepPath: "/usr/bin/rg",
  interactionMode: "agent" as const,
  allowedDomains: ["api.openai.com"],
  credentials: { envVars: [] },
};

describe("whole-worker sandbox policy", () => {
  it("scopes Ask and Approve workers to the execution root", () => {
    for (const accessMode of ["ask", "auto"] as const) {
      const config = createWorkerSandboxConfig({ ...baseInput, accessMode });

      expect(config.filesystem.denyRead).toContain("/");
      expect(config.filesystem.allowRead).toContain(baseInput.workspace);
      expect(config.filesystem.allowWrite).toContain(baseInput.workspace);
      expect(config.filesystem.allowWrite).toContain(baseInput.sessionDir);
      expect(config.network.allowedDomains).toEqual(["api.openai.com"]);
    }
  });

  it("adds approved run-scoped paths to the worker profile", () => {
    const config = createWorkerSandboxConfig({
      ...baseInput,
      accessMode: "ask",
      grants: [
        { path: "/tmp/reference", access: "read" },
        { path: "/tmp/output", access: "write" },
      ],
    });

    expect(config.filesystem.allowRead).toEqual(
      expect.arrayContaining(["/tmp/reference", "/tmp/output"]),
    );
    expect(config.filesystem.allowWrite).toContain("/tmp/output");
    expect(config.filesystem.allowWrite).not.toContain("/tmp/reference");
  });

  it("keeps Plan workers OS-enforced read-only for project files", () => {
    const config = createWorkerSandboxConfig({
      ...baseInput,
      accessMode: "full",
      interactionMode: "plan",
    });

    expect(config.filesystem.allowRead).toContain(baseInput.workspace);
    expect(config.filesystem.allowWrite).toEqual([
      baseInput.sessionDir,
      baseInput.workerTemp,
    ]);
  });

  it("broadens Full without exposing credentials or local services", () => {
    const config = createWorkerSandboxConfig({
      ...baseInput,
      accessMode: "full",
    });

    expect(config.filesystem.denyRead).not.toContain("/");
    expect(config.filesystem.denyRead).toContain(join(homedir(), ".ssh"));
    expect(config.filesystem.allowWrite).not.toContain("/");
    expect(config.filesystem.allowWrite).toContain(baseInput.workspace);
    expect(config.filesystem.allowWrite).not.toContain(
      join(homedir(), "Library"),
    );
    expect(config.filesystem.denyWrite).toContain(join(homedir(), ".ssh"));
    expect(config.filesystem.denyWrite).toContain("/System");
    expect(config.network.deniedDomains).toEqual(
      expect.arrayContaining(["localhost", "127.0.0.1", "169.254.169.254"]),
    );
    expect(config.network.allowUnixSockets).toEqual([]);
    expect(config.allowAppleEvents).toBe(false);
    expect(config.allowPty).toBe(false);
  });

  it("routes Node requests through the numeric sandbox proxy", () => {
    const output = execFileSync(
      "/bin/bash",
      ["-c", nodeCommandWithSandboxProxy("/usr/bin/env")],
      {
        encoding: "utf8",
        env: {
          HTTP_PROXY: "http://user:pass@localhost:1234",
          HTTPS_PROXY: "http://user:pass@localhost:1234",
          http_proxy: "http://user:pass@localhost:1234",
          https_proxy: "http://user:pass@localhost:1234",
        },
      },
    );

    expect(output).toContain("NODE_USE_ENV_PROXY=1");
    expect(output).not.toContain("@localhost:1234");
    expect(output).toContain("@127.0.0.1:1234");
  });

  it.each([
    "localhost",
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "fd00::1",
    "fe80::1",
  ])("permanently denies local endpoint %s", (host) => {
    expect(isPermanentlyDeniedNetworkHost(host)).toBe(true);
  });

  it("does not classify public provider hosts as local", () => {
    expect(isPermanentlyDeniedNetworkHost("api.x.ai")).toBe(false);
    expect(isPermanentlyDeniedNetworkHost("8.8.8.8")).toBe(false);
  });
});
