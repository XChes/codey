import { describe, expect, it } from "vitest";

import {
  clampThinkingLevel,
  thinkingLevelsForModel,
} from "./models";

describe("model thinking levels", () => {
  it("exposes only levels supported by each model", () => {
    expect(
      thinkingLevelsForModel({
        provider: "deepseek",
        id: "deepseek-v4-flash",
      }),
    ).toEqual(["off", "low", "high", "max"]);
    expect(
      thinkingLevelsForModel({ provider: "openai", id: "gpt-5.6-sol" }),
    ).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
    expect(
      thinkingLevelsForModel({ provider: "xai", id: "grok-4.6" }),
    ).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("clamps unsupported levels using Pi ordering", () => {
    expect(
      clampThinkingLevel(
        { provider: "deepseek", id: "deepseek-v4-flash" },
        "medium",
      ),
    ).toBe("high");
    expect(
      clampThinkingLevel(
        { provider: "xai", id: "grok-4.6" },
        "xhigh",
      ),
    ).toBe("high");
  });
});
