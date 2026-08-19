import { z } from "zod";

export const TODO_TOOL_NAME = "todo_write";

const nonEmptyText = z.string().trim().min(1);

export const todoStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "blocked",
]);

export const todoItemSchema = z
  .object({
    id: z.string().min(1),
    content: nonEmptyText,
    status: todoStatusSchema,
    blockedReason: nonEmptyText.optional(),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.status === "blocked" && item.blockedReason === undefined) {
      context.addIssue({
        code: "custom",
        path: ["blockedReason"],
        message: "Blocked todos require a reason",
      });
    }
    if (item.status !== "blocked" && item.blockedReason !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["blockedReason"],
        message: "Only blocked todos may have a blocked reason",
      });
    }
  });

export const conversationTodoStateSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    title: nonEmptyText,
    items: z.array(todoItemSchema),
  })
  .strict();

const todoWriteItemSchema = z
  .object({
    id: z.string().min(1).optional(),
    content: nonEmptyText,
    status: todoStatusSchema,
    blockedReason: nonEmptyText.optional(),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.status === "blocked" && item.blockedReason === undefined) {
      context.addIssue({
        code: "custom",
        path: ["blockedReason"],
        message: "Blocked todos require a reason",
      });
    }
    if (item.status !== "blocked" && item.blockedReason !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["blockedReason"],
        message: "Only blocked todos may have a blocked reason",
      });
    }
  });

export const todoWriteInputSchema = z
  .object({
    title: nonEmptyText,
    todos: z.array(todoWriteItemSchema),
  })
  .strict();

export const todoToolDetailsSchema = z
  .object({
    todo: conversationTodoStateSchema.nullable(),
  })
  .strict();

const todoAddFields = {
  action: z.literal("add"),
  content: nonEmptyText,
};
const todoRenameFields = {
  action: z.literal("rename"),
  itemId: z.string().min(1),
  content: nonEmptyText,
};
const todoDeleteFields = {
  action: z.literal("delete"),
  itemId: z.string().min(1),
};
const todoArchiveFields = {
  action: z.literal("archive"),
};
const todoStatusEditFields = {
  action: z.literal("set_status"),
  itemId: z.string().min(1),
  status: todoStatusSchema,
  blockedReason: nonEmptyText.optional(),
};

function validateStatusEdit(
  input: z.infer<z.ZodObject<typeof todoStatusEditFields>>,
  context: z.RefinementCtx,
): void {
  if (input.status === "blocked" && input.blockedReason === undefined) {
    context.addIssue({
      code: "custom",
      path: ["blockedReason"],
      message: "Blocked todos require a reason",
    });
  }
  if (input.status !== "blocked" && input.blockedReason !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["blockedReason"],
      message: "Only blocked todos may have a blocked reason",
    });
  }
}

const todoStatusEditSchema = z
  .object(todoStatusEditFields)
  .strict()
  .superRefine(validateStatusEdit);

export const todoEditOperationSchema = z.discriminatedUnion("action", [
  z
    .object(todoAddFields)
    .strict(),
  z
    .object(todoRenameFields)
    .strict(),
  z
    .object(todoDeleteFields)
    .strict(),
  z
    .object(todoArchiveFields)
    .strict(),
  todoStatusEditSchema,
]);

const taskIdField = { taskId: z.string().min(1) };

export const todoEditInputSchema = z.union([
  z.object({ ...taskIdField, ...todoAddFields }).strict(),
  z.object({ ...taskIdField, ...todoRenameFields }).strict(),
  z.object({ ...taskIdField, ...todoDeleteFields }).strict(),
  z.object({ ...taskIdField, ...todoArchiveFields }).strict(),
  z
    .object({ ...taskIdField, ...todoStatusEditFields })
    .strict()
    .superRefine(validateStatusEdit),
]);

export const todoEditResultSchema = z
  .object({
    todo: conversationTodoStateSchema.nullable(),
  })
  .strict();

export type TodoStatus = z.infer<typeof todoStatusSchema>;
export type TodoItem = z.infer<typeof todoItemSchema>;
export type ConversationTodoState = z.infer<
  typeof conversationTodoStateSchema
>;
export type TodoWriteInput = z.infer<typeof todoWriteInputSchema>;
export type TodoToolDetails = z.infer<typeof todoToolDetailsSchema>;
export type TodoEditOperation = z.infer<typeof todoEditOperationSchema>;
export type TodoEditInput = z.infer<typeof todoEditInputSchema>;
export type TodoEditResult = z.infer<typeof todoEditResultSchema>;
