import type { AgentUiEvent } from "../shared/agent-ui";
import type {
  TaskAccessMode,
  TaskInteractionMode,
  TaskPermissionRequest,
} from "../shared/task";
import type { AgentConnection } from "./task-controller";
import type { AgentCapability, DelegationRequest } from "../shared/agent";

export interface PrewarmableAgentConnection extends AgentConnection {
  setEventHandler(handler: (event: AgentUiEvent) => void): void;
  setPermissionHandler(handler: (request: TaskPermissionRequest) => void): void;
  setDelegationHandler?(handler: (request: DelegationRequest) => void): void;
}

// The identity-free half of host initialization. Two conversations whose
// profiles produce the same key can use the same booted sandbox worker.
export interface BootProfile {
  cwd: string;
  sessionDir: string;
  accessMode: TaskAccessMode;
  interactionMode: TaskInteractionMode;
  agentCapability: AgentCapability;
  apiKeys: Record<string, string>;
}

const DEFAULT_BOOTED_SPARE_TTL_MS = 5 * 60 * 1_000;

function bootProfileKey(profile: BootProfile): string {
  // Key on provider names, not secret values; credential rotations must
  // flush booted spares instead (see flushBooted).
  return JSON.stringify({
    cwd: profile.cwd,
    sessionDir: profile.sessionDir,
    accessMode: profile.accessMode,
    interactionMode: profile.interactionMode,
    agentCapability: profile.agentCapability,
    providers: Object.keys(profile.apiKeys).sort(),
  });
}

interface BootedSpare {
  key: string;
  connection: PrewarmableAgentConnection;
}

export class AgentHostPool {
  private spare: PrewarmableAgentConnection | undefined;
  private warmingConnection: PrewarmableAgentConnection | undefined;
  private warming: Promise<void> | undefined;
  private bootedSpare: BootedSpare | undefined;
  private bootedWarmingConnection: PrewarmableAgentConnection | undefined;
  private bootedWarming: Promise<void> | undefined;
  private bootedTtlTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly bootedSpareTtlMs: number;
  private stopped = false;

  constructor(
    private readonly createConnection: () => PrewarmableAgentConnection,
    options: { bootedSpareTtlMs?: number } = {},
  ) {
    this.bootedSpareTtlMs =
      options.bootedSpareTtlMs ?? DEFAULT_BOOTED_SPARE_TTL_MS;
  }

  prewarm(): Promise<void> {
    if (this.stopped || this.spare !== undefined) {
      return Promise.resolve();
    }
    if (this.warming !== undefined) {
      return this.warming;
    }

    const connection = this.createConnection();
    this.warmingConnection = connection;
    const warming = connection
      .start()
      .then(() => {
        if (this.stopped || this.spare !== undefined) {
          connection.terminate();
          return;
        }
        this.spare = connection;
      })
      .finally(() => {
        if (this.warmingConnection === connection) {
          this.warmingConnection = undefined;
        }
        if (this.warming === warming) {
          this.warming = undefined;
        }
      });
    this.warming = warming;
    return warming;
  }

  prewarmBooted(profile: BootProfile): Promise<void> {
    const key = bootProfileKey(profile);
    if (this.stopped || this.bootedSpare?.key === key) {
      return Promise.resolve();
    }
    if (this.bootedWarming !== undefined) {
      return this.bootedWarming;
    }

    const connection = this.spare ?? this.createConnection();
    if (connection === this.spare) {
      this.spare = undefined;
      void this.prewarm().catch(() => undefined);
    }
    this.bootedWarmingConnection = connection;
    const warming = connection
      .start()
      .then(() => connection.boot(profile))
      .then(() => {
        if (this.stopped || this.bootedSpare?.key === key) {
          connection.terminate();
          return;
        }
        this.replaceBootedSpare({ key, connection });
      })
      .catch(() => {
        connection.terminate();
      })
      .finally(() => {
        if (this.bootedWarmingConnection === connection) {
          this.bootedWarmingConnection = undefined;
        }
        if (this.bootedWarming === warming) {
          this.bootedWarming = undefined;
        }
      });
    this.bootedWarming = warming;
    return warming;
  }

  acquire(
    onEvent: (event: AgentUiEvent) => void,
    onPermissionRequest: (request: TaskPermissionRequest) => void,
    onDelegationRequest: (request: DelegationRequest) => void = () => undefined,
    bootProfile?: BootProfile,
  ): PrewarmableAgentConnection {
    const connection =
      this.claimBootedSpare(bootProfile) ?? this.spare ?? this.createConnection();
    if (connection === this.spare) {
      this.spare = undefined;
    }
    connection.setEventHandler(onEvent);
    connection.setPermissionHandler(onPermissionRequest);
    connection.setDelegationHandler?.(onDelegationRequest);
    void this.prewarm().catch(() => undefined);
    return connection;
  }

  flushBooted(): void {
    this.clearBootedTtl();
    this.bootedSpare?.connection.terminate();
    this.bootedSpare = undefined;
    this.bootedWarmingConnection?.terminate();
    this.bootedWarmingConnection = undefined;
  }

  terminate(): void {
    this.stopped = true;
    this.flushBooted();
    this.spare?.terminate();
    this.warmingConnection?.terminate();
    this.spare = undefined;
    this.warmingConnection = undefined;
  }

  private claimBootedSpare(
    profile: BootProfile | undefined,
  ): PrewarmableAgentConnection | undefined {
    if (profile === undefined || this.bootedSpare === undefined) {
      return undefined;
    }
    const spare = this.bootedSpare;
    if (!spare.connection.booted) {
      // The parked host died; discard it rather than handing out a corpse.
      this.clearBootedTtl();
      this.bootedSpare = undefined;
      spare.connection.terminate();
      return undefined;
    }
    if (spare.key !== bootProfileKey(profile)) {
      return undefined;
    }
    this.clearBootedTtl();
    this.bootedSpare = undefined;
    return spare.connection;
  }

  private replaceBootedSpare(spare: BootedSpare): void {
    this.clearBootedTtl();
    this.bootedSpare?.connection.terminate();
    this.bootedSpare = spare;
    const timer = setTimeout(() => {
      if (this.bootedSpare === spare) {
        this.bootedSpare = undefined;
        spare.connection.terminate();
      }
      this.bootedTtlTimer = undefined;
    }, this.bootedSpareTtlMs);
    timer.unref?.();
    this.bootedTtlTimer = timer;
  }

  private clearBootedTtl(): void {
    if (this.bootedTtlTimer !== undefined) {
      clearTimeout(this.bootedTtlTimer);
      this.bootedTtlTimer = undefined;
    }
  }
}
