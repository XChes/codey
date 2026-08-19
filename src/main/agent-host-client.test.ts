// @vitest-environment node

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHostClient } from "./agent-host-client";

const temporaryDirectories: string[] = [];

function hostScript(source: string): { cwd: string; entryPath: string } {
  const cwd = mkdtempSync(join(tmpdir(), "desktop-agent-host-client-"));
  temporaryDirectories.push(cwd);
  const entryPath = join(cwd, "host.mjs");
  writeFileSync(entryPath, source);
  return { cwd, entryPath };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("AgentHostClient", () => {
  it("rejects pending work and reports an unexpected host exit once", async () => {
    const host = hostScript(`
      process.stdin.once("data", () => process.exit(17));
    `);
    const client = new AgentHostClient(host);
    const onExit = vi.fn();
    client.setExitHandler(onExit);
    await client.start();

    await expect(client.snapshot()).rejects.toThrow(
      "Agent Host exited unexpectedly",
    );
    expect(onExit).toHaveBeenCalledOnce();
  });

  it("disposes a healthy host without reporting a crash", async () => {
    const host = hostScript(`
      import { createInterface } from "node:readline";
      const lines = createInterface({ input: process.stdin });
      for await (const line of lines) {
        const request = JSON.parse(line);
        if (request.method === "agent.dispose") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { disposed: true }
          }) + "\\n");
        }
      }
    `);
    const client = new AgentHostClient(host);
    const onExit = vi.fn();
    client.setExitHandler(onExit);
    await client.start();

    await client.dispose();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(onExit).not.toHaveBeenCalled();
  });

  it("escalates an unanswered cancel to a host kill and reports cancelled", async () => {
    const host = hostScript(`
      import { createInterface } from "node:readline";
      const lines = createInterface({ input: process.stdin });
      for await (const line of lines) {
        const request = JSON.parse(line);
        if (request.method === "agent.prompt") {
          // Never answer: simulate a wedged worker mid-run.
        }
        // Swallow agent.cancel too.
      }
      setInterval(() => undefined, 1000);
    `);
    const client = new AgentHostClient({ ...host, cancelTimeoutMs: 100 });
    client.setExitHandler(() => undefined);
    await client.start();
    const prompt = client.prompt("hang forever");

    const result = await client.cancel();

    expect(result).toEqual({
      cancelled: true,
      queued: { steering: [], followUp: [] },
    });
    await expect(prompt).rejects.toThrow("Agent Host stopped");
  });

  it("kills a host that never answers dispose within the timeout", async () => {
    const host = hostScript(`
      import { createInterface } from "node:readline";
      const lines = createInterface({ input: process.stdin });
      for await (const line of lines) {
        // Swallow every request, including agent.dispose.
      }
      // Keep the process alive even after stdin closes.
      setInterval(() => undefined, 1000);
    `);
    const client = new AgentHostClient({ ...host, disposeTimeoutMs: 100 });
    const onExit = vi.fn();
    client.setExitHandler(onExit);
    await client.start();

    const startedAt = Date.now();
    await client.dispose();

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onExit).not.toHaveBeenCalled();
  });

  it("invalidates a host that emits malformed protocol output", async () => {
    const host = hostScript(`
      process.stdin.once("data", () => process.stdout.write("not-json\\n"));
    `);
    const client = new AgentHostClient(host);
    const onExit = vi.fn();
    client.setExitHandler(onExit);
    await client.start();

    await expect(client.snapshot()).rejects.toThrow(
      "Agent Host emitted invalid JSON",
    );
    expect(onExit).toHaveBeenCalledOnce();
  });
});
