// @vitest-environment node

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SubagentConfigService } from "./subagent-config-service";

const temporaryDirectories: string[] = [];

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "desktop-agent-subagents-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeConfig(root: string, value: unknown): void {
  mkdirSync(join(root, ".codey"), { recursive: true });
  writeFileSync(
    join(root, ".codey", "agents.json"),
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SubagentConfigService", () => {
  it("returns the built-in coding profile when no config exists", async () => {
    const config = await new SubagentConfigService().load(workspace());
    expect(config.agents.map((agent) => agent.id)).toEqual(["coding"]);
    expect(config.agents[0]?.capability).toBe("write");
  });

  it("prepends the coding profile to configured agents", async () => {
    const root = workspace();
    writeConfig(root, {
      version: 1,
      agents: [
        {
          id: "reviewer",
          description: "Reviews changes",
          instructions: "Review the diff and report issues.",
          capability: "read",
        },
      ],
    });
    const config = await new SubagentConfigService().load(root);
    expect(config.agents.map((agent) => agent.id)).toEqual([
      "coding",
      "reviewer",
    ]);
  });

  it("keeps a repository-defined coding profile", async () => {
    const root = workspace();
    writeConfig(root, {
      version: 1,
      agents: [
        {
          id: "coding",
          description: "Custom coding agent",
          instructions: "Use the repository conventions.",
          capability: "write",
        },
      ],
    });
    const config = await new SubagentConfigService().load(root);
    expect(config.agents).toHaveLength(1);
    expect(config.agents[0]?.description).toBe("Custom coding agent");
  });

  it("rejects invalid JSON", async () => {
    const root = workspace();
    writeConfig(root, "{not json");
    await expect(new SubagentConfigService().load(root)).rejects.toThrow(
      "not valid JSON",
    );
  });

  it("rejects duplicate subagent ids", async () => {
    const root = workspace();
    const profile = {
      id: "reviewer",
      description: "Reviews changes",
      instructions: "Review the diff.",
      capability: "read",
    };
    writeConfig(root, { version: 1, agents: [profile, profile] });
    await expect(new SubagentConfigService().load(root)).rejects.toThrow(
      "Duplicate subagent id",
    );
  });
});
