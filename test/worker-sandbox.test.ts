// @vitest-environment node

import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { afterEach, describe, expect, it } from "vitest";

import {
  createWorkerSandboxConfig,
  shellQuote,
} from "../src/agent-host/sandbox-policy.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await SandboxManager.reset().catch(() => undefined);
  delete process.env.XAI_API_KEY;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("single worker Sandbox Runtime", () => {
  it.skipIf(process.platform !== "darwin")(
    "lets Full workers persist sessions in Application Support",
    async () => {
      const workspace = await temporaryDirectory("codey-worker-workspace-");
      const workerTemp = await temporaryDirectory("codey-worker-temp-");
      const sessionDir = await realpath(
        await mkdtemp(
          join(
            homedir(),
            "Library/Application Support/codey-worker-session-",
          ),
        ),
      );
      temporaryDirectories.push(sessionDir);

      await SandboxManager.initialize(
        createWorkerSandboxConfig({
          workspace,
          sessionDir,
          workerTemp,
          workerPath: process.execPath,
          executablePath: process.execPath,
          ripgrepPath: "/usr/bin/grep",
          accessMode: "full",
          interactionMode: "agent",
          allowedDomains: [],
          credentials: { envVars: [] },
        }),
        async () => false,
        true,
      );

      const sessionFile = join(sessionDir, "session.jsonl");
      const command = [
        shellQuote(process.execPath),
        "-e",
        shellQuote(
          `require("node:fs").writeFileSync(${JSON.stringify(sessionFile)}, "session")`,
        ),
      ].join(" ");
      const wrapped = await SandboxManager.wrapWithSandboxArgv(
        command,
        "/bin/bash",
        undefined,
        undefined,
        workerTemp,
      );
      const executable = wrapped.argv[0];
      if (executable === undefined) throw new Error("Missing wrapped command");
      const result = spawnSync(executable, wrapped.argv.slice(1), {
        cwd: workerTemp,
        env: {
          ...wrapped.env,
          HOME: workerTemp,
          TMPDIR: workerTemp,
        },
        encoding: "utf8",
      });

      expect(result.status, result.stderr).toBe(0);
      await expect(readFile(sessionFile, "utf8")).resolves.toBe("session");
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "confines direct filesystem calls and inherited Bash children in one profile",
    async () => {
      const workspace = await temporaryDirectory("codey-worker-workspace-");
      const sessionDir = await temporaryDirectory("codey-worker-session-");
      const workerTemp = await temporaryDirectory("codey-worker-temp-");
      const outside = await temporaryDirectory("codey-worker-outside-");
      await mkdir(join(workspace, ".git"), { recursive: true });
      const gitHeadPath = join(workspace, ".git", "HEAD");
      await writeFile(gitHeadPath, "ref: refs/heads/main\n", "utf8");

      await SandboxManager.initialize(
        createWorkerSandboxConfig({
          workspace,
          sessionDir,
          workerTemp,
          workerPath: process.execPath,
          executablePath: process.execPath,
          ripgrepPath: "/usr/bin/grep",
          accessMode: "ask",
          interactionMode: "agent",
          allowedDomains: [],
          credentials: { envVars: [] },
        }),
        async () => false,
        true,
      );

      const directPath = join(workspace, "direct.txt");
      const childPath = join(workspace, "child.txt");
      const outsidePath = join(outside, "blocked.txt");
      const gitConfigPath = join(workspace, ".git", "config");
      const script = [
        'const fs = require("node:fs");',
        'const { spawnSync } = require("node:child_process");',
        `fs.writeFileSync(${JSON.stringify(directPath)}, "direct");`,
        `fs.readFileSync(${JSON.stringify(gitHeadPath)}, "utf8");`,
        `const child = spawnSync("/bin/bash", ["-c", ${JSON.stringify(
          `printf child > ${shellQuote(childPath)}`,
        )}]);`,
        'if (child.status !== 0) process.exit(child.status ?? 1);',
        `for (const path of ${JSON.stringify([
          outsidePath,
          gitConfigPath,
        ])}) {`,
        "  try { fs.writeFileSync(path, \"blocked\"); process.exit(2); }",
        '  catch { process.stdout.write("denied\\n"); }',
        "}",
      ].join("\n");
      const command = [
        shellQuote(process.execPath),
        "-e",
        shellQuote(script),
      ].join(" ");
      const wrapped = await SandboxManager.wrapWithSandboxArgv(
        command,
        "/bin/bash",
        undefined,
        undefined,
        workerTemp,
      );
      const executable = wrapped.argv[0];
      if (executable === undefined) throw new Error("Missing wrapped command");
      const result = spawnSync(executable, wrapped.argv.slice(1), {
        cwd: workerTemp,
        env: {
          ...wrapped.env,
          HOME: workerTemp,
          TMPDIR: workerTemp,
          TMP: workerTemp,
          TEMP: workerTemp,
        },
        encoding: "utf8",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.match(/denied/g)).toHaveLength(2);
      await expect(readFile(directPath, "utf8")).resolves.toBe("direct");
      await expect(readFile(childPath, "utf8")).resolves.toBe("child");
      await expect(readFile(outsidePath, "utf8")).rejects.toThrow();
      await expect(readFile(gitConfigPath, "utf8")).rejects.toThrow();
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "replaces provider credentials with a scoped sentinel",
    async () => {
      const workspace = await temporaryDirectory("codey-mask-workspace-");
      const sessionDir = await temporaryDirectory("codey-mask-session-");
      const workerTemp = await temporaryDirectory("codey-mask-temp-");
      process.env.XAI_API_KEY = "plaintext-test-secret";

      await SandboxManager.initialize(
        createWorkerSandboxConfig({
          workspace,
          sessionDir,
          workerTemp,
          workerPath: process.execPath,
          executablePath: process.execPath,
          ripgrepPath: "/usr/bin/grep",
          accessMode: "full",
          interactionMode: "agent",
          allowedDomains: ["api.x.ai"],
          credentials: {
            envVars: [
              {
                name: "XAI_API_KEY",
                mode: "mask",
                injectHosts: ["api.x.ai"],
              },
            ],
          },
        }),
        async () => true,
        true,
      );
      const command = [
        shellQuote(process.execPath),
        "-e",
        shellQuote('process.stdout.write(process.env.XAI_API_KEY ?? "")'),
      ].join(" ");
      const wrapped = await SandboxManager.wrapWithSandboxArgv(
        command,
        "/bin/bash",
        undefined,
        undefined,
        workerTemp,
      );
      const executable = wrapped.argv[0];
      if (executable === undefined) throw new Error("Missing wrapped command");
      const result = spawnSync(executable, wrapped.argv.slice(1), {
        cwd: workerTemp,
        env: {
          ...wrapped.env,
          XAI_API_KEY: "CODEY_CREDENTIAL_MASK_PENDING",
          HOME: workerTemp,
          TMPDIR: workerTemp,
        },
        encoding: "utf8",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toBe("plaintext-test-secret");
      expect(result.stdout).not.toBe("CODEY_CREDENTIAL_MASK_PENDING");
      expect(result.stdout.length).toBeGreaterThan(16);
    },
  );
});
