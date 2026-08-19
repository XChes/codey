import { z } from "zod";

export const workspaceInfoSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    name: z.string().min(1),
    worktreeAvailable: z.boolean(),
    branch: z.string().min(1).nullable(),
  })
  .strict();

export type WorkspaceInfo = z.infer<typeof workspaceInfoSchema>;

export const workspaceTargetInputSchema = z
  .object({
    workspaceId: z.string().min(1),
  })
  .strict();

export const workspaceCreateInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine((name) => name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0"), {
        message: "Folder name is invalid.",
      }),
  })
  .strict();

export const githubRepositorySchema = z
  .object({
    nameWithOwner: z.string().min(3),
    name: z.string().min(1),
    description: z.string().nullable(),
    isPrivate: z.boolean(),
  })
  .strict();

export const githubCloneInputSchema = z
  .object({
    nameWithOwner: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "GitHub repository is invalid."),
  })
  .strict();

export type WorkspaceTargetInput = z.infer<typeof workspaceTargetInputSchema>;
export type WorkspaceCreateInput = z.infer<typeof workspaceCreateInputSchema>;
export type GitHubRepository = z.infer<typeof githubRepositorySchema>;
export type GitHubCloneInput = z.infer<typeof githubCloneInputSchema>;
