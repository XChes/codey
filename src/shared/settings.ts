import { z } from "zod";

export const themePreferenceSchema = z.enum(["system", "light", "dark"]);

export const appSettingsSchema = z.object({
  theme: themePreferenceSchema,
  window: z.object({
    width: z.number().int().min(720).max(10_000),
    height: z.number().int().min(560).max(10_000),
    maximized: z.boolean(),
  }),
});

export const settingsUpdateSchema = z
  .object({
    theme: themePreferenceSchema.optional(),
  })
  .strict();

export type ThemePreference = z.infer<typeof themePreferenceSchema>;
export type AppSettings = z.infer<typeof appSettingsSchema>;
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: "system",
  window: {
    width: 1180,
    height: 760,
    maximized: false,
  },
};

