import { z } from "zod";

export const thinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

const THINKING_LEVEL_ORDER = thinkingLevelSchema.options;

const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

export const SUPPORTED_MODELS = [
  {
    provider: "deepseek",
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    thinkingLevels: ["off", "low", "high", "max"],
  },
  {
    provider: "openai",
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
  },
  {
    provider: "xai",
    id: "grok-4.6",
    label: "Grok 4.6",
    thinkingLevels: ["off", "minimal", "low", "medium", "high"],
  },
] as const satisfies readonly {
  provider: string;
  id: string;
  label: string;
  thinkingLevels: readonly ThinkingLevel[];
}[];

export const supportedModelSelectionSchema = z.union([
  z.object({ provider: z.literal("deepseek"), id: z.literal("deepseek-v4-flash") }).strict(),
  z.object({ provider: z.literal("openai"), id: z.literal("gpt-5.6-sol") }).strict(),
  z.object({ provider: z.literal("xai"), id: z.literal("grok-4.6") }).strict(),
]);

export type SupportedModelSelection = z.infer<
  typeof supportedModelSelectionSchema
>;

export const DEFAULT_MODEL: SupportedModelSelection = {
  provider: "xai",
  id: "grok-4.6",
};

export function modelKey(model: SupportedModelSelection): string {
  return `${model.provider}/${model.id}`;
}

export function modelLabel(model: SupportedModelSelection): string {
  return (
    SUPPORTED_MODELS.find(
      (candidate) =>
        candidate.provider === model.provider && candidate.id === model.id,
    )?.label ?? model.id
  );
}

export function thinkingLevelsForModel(
  model: SupportedModelSelection,
): readonly ThinkingLevel[] {
  return (
    SUPPORTED_MODELS.find(
      (candidate) =>
        candidate.provider === model.provider && candidate.id === model.id,
    )?.thinkingLevels ?? ["off"]
  );
}

export function supportsThinking(model: SupportedModelSelection): boolean {
  const levels = thinkingLevelsForModel(model);
  return levels.length > 1 || levels[0] !== "off";
}

export function clampThinkingLevel(
  model: SupportedModelSelection,
  level: ThinkingLevel,
): ThinkingLevel {
  const available = thinkingLevelsForModel(model);
  if (available.includes(level)) return level;

  const requestedIndex = THINKING_LEVEL_ORDER.indexOf(level);
  for (let index = requestedIndex; index < THINKING_LEVEL_ORDER.length; index++) {
    const candidate = THINKING_LEVEL_ORDER[index];
    if (candidate !== undefined && available.includes(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index--) {
    const candidate = THINKING_LEVEL_ORDER[index];
    if (candidate !== undefined && available.includes(candidate)) return candidate;
  }
  return available[0] ?? "off";
}

export function defaultThinkingLevel(
  model: SupportedModelSelection,
): ThinkingLevel {
  return clampThinkingLevel(model, DEFAULT_THINKING_LEVEL);
}

export function thinkingLevelLabel(level: ThinkingLevel): string {
  return THINKING_LEVEL_LABELS[level];
}
