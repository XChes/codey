import { z } from "zod";

export const PROVIDERS = ["deepseek", "openai", "xai"] as const;

export const providerSchema = z.enum(PROVIDERS);

export const providerApiKeySchema = z.string().trim().min(1).max(4_096);

export const providerCredentialSetInputSchema = z
  .object({
    provider: providerSchema,
    apiKey: providerApiKeySchema,
  })
  .strict();

export const providerCredentialDeleteInputSchema = z
  .object({
    provider: providerSchema,
  })
  .strict();

export const providerCredentialStatusSchema = z
  .object({
    provider: providerSchema,
    configured: z.boolean(),
  })
  .strict();

export const providerCredentialStatusesSchema = z.array(
  providerCredentialStatusSchema,
);

export type Provider = z.infer<typeof providerSchema>;
export type ProviderCredentialSetInput = z.infer<
  typeof providerCredentialSetInputSchema
>;
export type ProviderCredentialDeleteInput = z.infer<
  typeof providerCredentialDeleteInputSchema
>;
export type ProviderCredentialStatus = z.infer<
  typeof providerCredentialStatusSchema
>;
