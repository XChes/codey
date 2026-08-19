import { memo, useState } from "react";
import {
  Ban,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  ListChecks,
  LoaderCircle,
  Plus,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type {
  ConversationTodoState,
  TodoEditOperation,
  TodoItem,
  TodoStatus,
} from "../../../shared/todo";

function StatusIcon({ status }: { status: TodoStatus }) {
  if (status === "completed") {
    return <CheckCircle2 aria-hidden="true" className="text-success" />;
  }
  if (status === "in_progress") {
    return <LoaderCircle aria-hidden="true" className="animate-spin" />;
  }
  if (status === "blocked") {
    return <Ban aria-hidden="true" className="text-destructive" />;
  }
  return <CircleDashed aria-hidden="true" />;
}

function TodoRow({
  item,
  disabled,
  onEdit,
}: {
  item: TodoItem;
  disabled: boolean;
  onEdit: (input: TodoEditOperation) => void;
}) {
  const [content, setContent] = useState(item.content);

  const saveContent = (): void => {
    const value = content.trim();
    if (value.length === 0) {
      setContent(item.content);
    } else if (value !== item.content) {
      onEdit({ action: "rename", itemId: item.id, content: value });
    }
  };

  const changeStatus = (status: TodoStatus): void => {
    if (status === "blocked") {
      const blockedReason = window.prompt(
        "Why is this todo blocked?",
        item.blockedReason ?? "",
      )?.trim();
      if (blockedReason === undefined || blockedReason.length === 0) return;
      onEdit({
        action: "set_status",
        itemId: item.id,
        status,
        blockedReason,
      });
      return;
    }
    onEdit({ action: "set_status", itemId: item.id, status });
  };

  return (
    <li className="group flex items-start gap-2.5 px-3 py-2">
      <Select
        value={item.status}
        disabled={disabled}
        onValueChange={(value) => changeStatus(value as TodoStatus)}
      >
        <SelectTrigger
          aria-label={`Status for ${item.content}`}
          className="mt-0.5 size-7 shrink-0 border-0 bg-transparent p-1 text-muted-foreground shadow-none [&>svg:last-child]:hidden"
        >
          <SelectValue>
            <StatusIcon status={item.status} />
          </SelectValue>
        </SelectTrigger>
        <SelectContent align="start">
          <SelectItem value="pending">Pending</SelectItem>
          <SelectItem value="in_progress">In progress</SelectItem>
          <SelectItem value="completed">Completed</SelectItem>
          <SelectItem value="blocked">Blocked</SelectItem>
        </SelectContent>
      </Select>
      <div className="min-w-0 flex-1">
        <input
          aria-label={`Todo: ${item.content}`}
          value={content}
          disabled={disabled}
          className={cn(
            "h-7 w-full rounded border border-transparent bg-transparent px-1 text-sm outline-none hover:border-border focus:border-ring",
            item.status === "completed" &&
              "text-muted-foreground line-through",
          )}
          onChange={(event) => setContent(event.target.value)}
          onBlur={saveContent}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setContent(item.content);
              event.currentTarget.blur();
            }
          }}
        />
        {item.status === "blocked" ? (
          <p className="px-1 text-xs leading-5 text-destructive">
            {item.blockedReason}
          </p>
        ) : null}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={disabled}
        aria-label={`Delete ${item.content}`}
        className="size-7 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100"
        onClick={() => onEdit({ action: "delete", itemId: item.id })}
      >
        <Trash2 />
      </Button>
    </li>
  );
}

export const ConversationTodoCard = memo(function ConversationTodoCard({
  todo,
  disabled,
  onEdit,
}: {
  todo: ConversationTodoState;
  disabled: boolean;
  onEdit: (input: TodoEditOperation) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [newItem, setNewItem] = useState("");
  const resolved = todo.items.filter(
    (item) => item.status === "completed" || item.status === "blocked",
  ).length;

  return (
    <section
      aria-label="Conversation todos"
      className="mx-auto w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-card shadow-xs"
    >
      <div className="flex items-center">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2.5 px-3.5 py-3 text-left"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <ListChecks aria-hidden="true" className="size-4 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {todo.title}
          </span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {resolved}/{todo.items.length}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-4 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
          />
        </button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="mr-2 text-muted-foreground"
          onClick={() => onEdit({ action: "archive" })}
        >
          Dismiss
        </Button>
      </div>
      {expanded ? (
        <div className="border-t border-border/70">
          <ul className="divide-y divide-border/50">
            {todo.items.map((item) => (
              <TodoRow
                key={item.id}
                item={item}
                disabled={disabled}
                onEdit={onEdit}
              />
            ))}
          </ul>
          <form
            className="flex items-center gap-2 border-t border-border/70 px-3 py-2"
            onSubmit={(event) => {
              event.preventDefault();
              const content = newItem.trim();
              if (content.length === 0) return;
              onEdit({ action: "add", content });
              setNewItem("");
            }}
          >
            <Plus aria-hidden="true" className="size-4 text-muted-foreground" />
            <input
              aria-label="Add todo"
              value={newItem}
              disabled={disabled}
              placeholder="Add a todo"
              className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              onChange={(event) => setNewItem(event.target.value)}
            />
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              disabled={disabled || newItem.trim().length === 0}
            >
              Add
            </Button>
          </form>
        </div>
      ) : null}
    </section>
  );
});
