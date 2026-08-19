// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { AgentUiEvent } from "../shared/agent-ui";
import type { TaskPermissionRequest } from "../shared/task";
import {
  AgentHostPool,
  type BootProfile,
  type PrewarmableAgentConnection,
} from "./agent-host-pool";

class FakeConnection implements PrewarmableAgentConnection {
  started = false;
  terminated = false;
  booted = false;
  bootedWith: BootProfile | undefined;
  eventHandler: ((event: AgentUiEvent) => void) | undefined;
  permissionHandler: ((request: TaskPermissionRequest) => void) | undefined;

  start(): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }

  setEventHandler(handler: (event: AgentUiEvent) => void): void {
    this.eventHandler = handler;
  }

  setPermissionHandler(handler: (request: TaskPermissionRequest) => void): void {
    this.permissionHandler = handler;
  }

  setExitHandler(): void {}

  boot(profile: BootProfile): Promise<{ booted: true }> {
    this.bootedWith = profile;
    this.booted = true;
    return Promise.resolve({ booted: true });
  }

  attach(): never {
    throw new Error("Not used");
  }

  prompt(): never {
    throw new Error("Not used");
  }

  snapshot(): never {
    throw new Error("Not used");
  }

  steer(): never {
    throw new Error("Not used");
  }

  followUp(): never {
    throw new Error("Not used");
  }

  editTodo(): never {
    throw new Error("Not used");
  }

  clearQueue(): never {
    throw new Error("Not used");
  }

  cancel(): never {
    throw new Error("Not used");
  }

  resolvePermission(): never {
    throw new Error("Not used");
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe("AgentHostPool", () => {
  it("assigns a pre-warmed worker and replenishes the spare", async () => {
    const created: FakeConnection[] = [];
    const pool = new AgentHostPool(() => {
      const connection = new FakeConnection();
      created.push(connection);
      return connection;
    });
    await pool.prewarm();
    const onEvent = vi.fn();
    const onPermissionRequest = vi.fn();

    const acquired = pool.acquire(onEvent, onPermissionRequest);

    expect(acquired).toBe(created[0]);
    expect(created[0]?.started).toBe(true);
    expect(created[0]?.eventHandler).toBe(onEvent);
    expect(created[0]?.permissionHandler).toBe(onPermissionRequest);
    await vi.waitFor(() => expect(created).toHaveLength(2));
    expect(created[1]?.started).toBe(true);

    pool.terminate();
    expect(created[1]?.terminated).toBe(true);
  });

  it("claims a booted spare only for a matching profile", async () => {
    const created: FakeConnection[] = [];
    const pool = new AgentHostPool(() => {
      const connection = new FakeConnection();
      created.push(connection);
      return connection;
    });
    const profile: BootProfile = {
      cwd: "/tmp/project",
      sessionDir: "/tmp/pi-sessions",
      accessMode: "full",
      interactionMode: "agent",
      agentCapability: "write",
      apiKeys: { deepseek: "key" },
    };
    await pool.prewarmBooted(profile);
    const bootedSpare = created.find((connection) => connection.booted);
    expect(bootedSpare?.bootedWith).toEqual(profile);

    const mismatched = pool.acquire(
      vi.fn(),
      vi.fn(),
      undefined,
      { ...profile, interactionMode: "plan" },
    );
    expect(mismatched).not.toBe(bootedSpare);

    const claimed = pool.acquire(vi.fn(), vi.fn(), undefined, {
      ...profile,
      apiKeys: { deepseek: "rotated-but-same-provider" },
    });
    expect(claimed).toBe(bootedSpare);

    pool.terminate();
  });

  it("flushes the booted spare on credential changes", async () => {
    const created: FakeConnection[] = [];
    const pool = new AgentHostPool(() => {
      const connection = new FakeConnection();
      created.push(connection);
      return connection;
    });
    const profile: BootProfile = {
      cwd: "/tmp/project",
      sessionDir: "/tmp/pi-sessions",
      accessMode: "full",
      interactionMode: "agent",
      agentCapability: "write",
      apiKeys: { deepseek: "key" },
    };
    await pool.prewarmBooted(profile);
    const bootedSpare = created.find((connection) => connection.booted)!;

    pool.flushBooted();
    expect(bootedSpare.terminated).toBe(true);

    const acquired = pool.acquire(vi.fn(), vi.fn(), undefined, profile);
    expect(acquired).not.toBe(bootedSpare);
    pool.terminate();
  });

  it("expires an unclaimed booted spare after its TTL", async () => {
    const created: FakeConnection[] = [];
    const pool = new AgentHostPool(
      () => {
        const connection = new FakeConnection();
        created.push(connection);
        return connection;
      },
      { bootedSpareTtlMs: 20 },
    );
    const profile: BootProfile = {
      cwd: "/tmp/project",
      sessionDir: "/tmp/pi-sessions",
      accessMode: "full",
      interactionMode: "agent",
      agentCapability: "write",
      apiKeys: { deepseek: "key" },
    };
    await pool.prewarmBooted(profile);
    const bootedSpare = created.find((connection) => connection.booted)!;

    await vi.waitFor(() => expect(bootedSpare.terminated).toBe(true));
    const acquired = pool.acquire(vi.fn(), vi.fn(), undefined, profile);
    expect(acquired).not.toBe(bootedSpare);
    pool.terminate();
  });
});
