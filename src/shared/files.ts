import { z } from "zod";

const taskIdSchema = z.string().min(1);
const relativePathSchema = z.string().min(1);

export const fileListInputSchema = z
  .object({ taskId: taskIdSchema })
  .strict();

export const fileReadInputSchema = z
  .object({ taskId: taskIdSchema, path: relativePathSchema })
  .strict();

export const fileListResultSchema = z
  .object({
    taskId: taskIdSchema,
    revision: z.number().int().nonnegative(),
    files: z.array(relativePathSchema),
  })
  .strict();

export const fileContentSchema = z
  .object({
    path: relativePathSchema,
    content: z.string().nullable(),
    isBinary: z.boolean(),
    truncated: z.boolean(),
    size: z.number().int().nonnegative(),
  })
  .strict();

export const fileChangeEnvelopeSchema = z
  .object({ taskId: taskIdSchema, revision: z.number().int().nonnegative() })
  .strict();

export type FileListInput = z.infer<typeof fileListInputSchema>;
export type FileReadInput = z.infer<typeof fileReadInputSchema>;
export type FileListResult = z.infer<typeof fileListResultSchema>;
export type FileContent = z.infer<typeof fileContentSchema>;
export type FileChangeEnvelope = z.infer<typeof fileChangeEnvelopeSchema>;
