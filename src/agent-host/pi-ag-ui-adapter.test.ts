// @vitest-environment node

import { EventType } from "@ag-ui/core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { AGENT_UI_CUSTOM_EVENT } from "../shared/agent-ui";
import { PiToAgUiEventAdapter } from "./pi-ag-ui-adapter";

describe("PiToAgUiEventAdapter todos", () => {
  it("projects todo result details without a generic tool activity row", () => {
    const adapter = new PiToAgUiEventAdapter("session-1");
    const todo = {
      revision: 1,
      title: "Build",
      items: [{ id: "todo-1", content: "Implement", status: "pending" }],
    };

    expect(
      adapter.map({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "todo_write",
        args: {},
      } as AgentSessionEvent),
    ).toEqual([]);
    expect(
      adapter.map({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "todo_write",
        result: { content: [], details: { todo } },
        isError: false,
      } as AgentSessionEvent),
    ).toEqual([
      {
        type: EventType.CUSTOM,
        name: AGENT_UI_CUSTOM_EVENT.TODO_UPDATED,
        value: { todo },
      },
    ]);
  });
});
