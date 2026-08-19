import { z } from "zod";

const taskIdSchema = z.string().min(1);
const reviewIdSchema = z.string().min(1);
const revisionSchema = z.number().int().nonnegative();
const signatureSchema = z.string().min(1);
const relativePathSchema = z.string().min(1);

export const reviewFileStatusSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "type-changed",
]);

export const reviewFileSchema = z
  .object({
    id: reviewIdSchema,
    path: relativePathSchema,
    previousPath: relativePathSchema.nullable(),
    status: reviewFileStatusSchema,
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    isBinary: z.boolean(),
    currentSignature: signatureSchema,
  })
  .strict();

export const reviewSnapshotSchema = z
  .object({
    taskId: taskIdSchema,
    revision: revisionSchema,
    baselineTree: z.string().min(1),
    files: z.array(reviewFileSchema),
  })
  .strict();

export const reviewSnapshotInputSchema = z
  .object({ taskId: taskIdSchema })
  .strict();

const reviewFileRequestFields = {
  taskId: taskIdSchema,
  fileId: reviewIdSchema,
  expectedRevision: revisionSchema,
};

export const reviewFileInputSchema = z.object(reviewFileRequestFields).strict();

export const reviewActionInputSchema = z
  .object({
    ...reviewFileRequestFields,
    expectedSignature: signatureSchema,
  })
  .strict();

export const reviewFileDetailSchema = z
  .object({
    file: reviewFileSchema,
    oldContent: z.string().nullable(),
    newContent: z.string().nullable(),
    truncated: z.boolean(),
  })
  .strict();

export const reviewChangeEnvelopeSchema = z
  .object({ taskId: taskIdSchema, revision: revisionSchema })
  .strict();

export type ReviewFileStatus = z.infer<typeof reviewFileStatusSchema>;
export type ReviewFile = z.infer<typeof reviewFileSchema>;
export type ReviewSnapshot = z.infer<typeof reviewSnapshotSchema>;
export type ReviewSnapshotInput = z.infer<typeof reviewSnapshotInputSchema>;
export type ReviewFileInput = z.infer<typeof reviewFileInputSchema>;
export type ReviewActionInput = z.infer<typeof reviewActionInputSchema>;
export type ReviewFileDetail = z.infer<typeof reviewFileDetailSchema>;
export type ReviewChangeEnvelope = z.infer<typeof reviewChangeEnvelopeSchema>;
