import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  subagentConfigSchema,
  type SubagentConfig,
  type SubagentProfile,
} from "../shared/agent";

const DEFAULT_CODING_PROFILE: SubagentProfile = {
  id: "coding",
  description: "General-purpose coding agent",
  instructions:
    "Complete the assigned coding subtask. Inspect the relevant code, keep changes scoped, verify the result, and return a concise summary.",
  capability: "write",
};

function withCodingProfile(config: SubagentConfig): SubagentConfig {
  return config.agents.some((agent) => agent.id === DEFAULT_CODING_PROFILE.id)
    ? config
    : {
        ...config,
        agents: [DEFAULT_CODING_PROFILE, ...config.agents],
      };
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export class SubagentConfigService {
  async load(executionRoot: string): Promise<SubagentConfig> {
    const path = join(executionRoot, ".codey", "agents.json");
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return { version: 1, agents: [DEFAULT_CODING_PROFILE] };
      }
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(source) as unknown;
    } catch {
      throw new Error(`Subagent configuration is not valid JSON: ${path}`);
    }
    const parsed = subagentConfigSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        `Subagent configuration is invalid: ${parsed.error.issues[0]?.message ?? path}`,
      );
    }
    return withCodingProfile(parsed.data);
  }
}
