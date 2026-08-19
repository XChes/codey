import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import type {
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcSuccess,
} from "../shared/agent-host-protocol.js";
import type { AgentSessionFactory } from "./session.js";
import { AgentHostRequestError, AgentHostService } from "./service.js";

interface ParsedRequest {
  id: JsonRpcId;
  method: string;
  params: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequest(value: unknown): ParsedRequest {
  if (
    !isRecord(value) ||
    value.jsonrpc !== "2.0" ||
    (typeof value.id !== "string" && typeof value.id !== "number") ||
    typeof value.method !== "string" ||
    !("params" in value)
  ) {
    throw new AgentHostRequestError(-32600, "Invalid Request");
  }
  return { id: value.id, method: value.method, params: value.params };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Internal error";
}

export class JsonRpcLineServer {
  private readonly service: AgentHostService;
  private readonly pending = new Set<Promise<void>>();

  constructor(
    sessionFactory: AgentSessionFactory,
    private readonly output: Writable,
  ) {
    this.service = new AgentHostService(sessionFactory, (notification) => {
      this.write(notification);
    });
  }

  async run(input: Readable): Promise<void> {
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      const task = this.handleLine(line).finally(() => this.pending.delete(task));
      this.pending.add(task);
    }

    await this.service.close();
    await Promise.allSettled([...this.pending]);
  }

  async close(): Promise<void> {
    await this.service.close();
  }

  private async handleLine(line: string): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      this.writeError(null, -32700, "Parse error");
      return;
    }

    let request: ParsedRequest;
    try {
      request = parseRequest(value);
    } catch (error) {
      this.writeError(null, -32600, errorMessage(error));
      return;
    }

    try {
      const result = await this.service.handle(request.method, request.params);
      const response: JsonRpcSuccess = {
        jsonrpc: "2.0",
        id: request.id,
        result,
      };
      this.write(response);
    } catch (error) {
      const code = error instanceof AgentHostRequestError ? error.code : -32000;
      this.writeError(request.id, code, errorMessage(error));
    }
  }

  private writeError(id: JsonRpcId | null, code: number, message: string): void {
    const response: JsonRpcFailure = {
      jsonrpc: "2.0",
      id,
      error: { code, message },
    };
    this.write(response);
  }

  private write(value: unknown): void {
    this.output.write(`${JSON.stringify(value)}\n`);
  }
}
