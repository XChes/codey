import {
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  FileCode2,
  GitCompareArrows,
  LoaderCircle,
  TerminalSquare,
  XCircle,
} from "lucide-react";
import { memo, useState } from "react";
import { MarkdownContent } from "@/components/markdown-content";
import { cn } from "@/lib/utils";
import type {
  ActivityItem,
  AgentStatus,
  TaskStatus,
  ToolStatus,
} from "@/models";
import type { ReviewSnapshot } from "../../../shared/review";

const toolStatusLabel: Record<ToolStatus, string> = {
  pending: "Pending",
  running: "Running",
  succeeded: "Completed",
  failed: "Failed",
};

function ToolStatusIcon({ status }: { status: ToolStatus }) {
  if (status === "succeeded") return <CheckCircle2 aria-hidden="true" />;
  if (status === "failed") return <XCircle aria-hidden="true" />;
  if (status === "running") {
    return <LoaderCircle aria-hidden="true" className="animate-spin" />;
  }
  return <CircleDashed aria-hidden="true" />;
}

function ToolPayload({ label, value }: { label: string; value: string }) {
  let content = value;
  try {
    content = JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    // Tool output is often plain text rather than JSON.
  }
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-2.5 font-mono text-xs leading-5">
        {content}
      </pre>
    </div>
  );
}

function FileChangesSummary({
  snapshot,
  onReview,
}: {
  snapshot: ReviewSnapshot;
  onReview(): void;
}) {
  const visibleFiles = snapshot.files.slice(0, 4);
  const remaining = snapshot.files.length - visibleFiles.length;
  const additions = snapshot.files.reduce((total, file) => total + file.additions, 0);
  const deletions = snapshot.files.reduce((total, file) => total + file.deletions, 0);

  return (
    <section
      aria-label="Changed files summary"
      className="overflow-hidden rounded-xl border border-border/70 bg-card px-4 py-3 text-sm shadow-xs"
    >
      <div className="mb-2.5 flex items-center gap-2">
        <GitCompareArrows aria-hidden="true" className="size-4 text-muted-foreground" />
        <span className="font-medium">
          {snapshot.files.length} {snapshot.files.length === 1 ? "File" : "Files"} Changed
        </span>
        <span className="ml-auto text-xs">
          <span className="text-success">+{additions}</span>
          {" "}
          <span className="text-destructive">−{deletions}</span>
        </span>
        <button
          type="button"
          className="ml-2 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onReview}
        >
          Review
        </button>
      </div>
      <div className="space-y-1.5">
        {visibleFiles.map((file) => (
          <div
            key={file.id}
            className="flex w-full min-w-0 items-center gap-2 px-1 py-0.5 text-xs"
          >
            <FileCode2 aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>{file.path}</span>
            <span className="shrink-0 text-success">+{file.additions}</span>
            <span className="shrink-0 text-destructive">−{file.deletions}</span>
          </div>
        ))}
        {remaining > 0 ? (
          <button
            type="button"
            className="rounded px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onReview}
          >
            Show {remaining} more
          </button>
        ) : null}
      </div>
    </section>
  );
}

function ReasoningRow({
  item,
}: {
  item: Extract<ActivityItem, { kind: "reasoning" }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="group"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 border-b border-border/70 py-3 text-[15px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
        <span>{item.streaming ? "Thinking…" : "Thinking"}</span>
        <ChevronRight
          aria-hidden="true"
          className="size-4 text-muted-foreground transition-transform group-open:rotate-90"
        />
      </summary>
      {open ? (
        <div className="py-3">
          <MarkdownContent
            className="text-[13px] leading-6 text-muted-foreground [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm"
          >
            {item.text}
          </MarkdownContent>
        </div>
      ) : null}
    </details>
  );
}

function ToolRow({
  item,
}: {
  item: Extract<ActivityItem, { kind: "tool" }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="group overflow-hidden rounded-lg border border-border/70 bg-card text-sm"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2.5 outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
        <span
          className={cn(
            "text-muted-foreground [&_svg]:size-4",
            item.status === "failed" && "text-destructive",
            item.status === "succeeded" && "text-success",
          )}
        >
          <ToolStatusIcon status={item.status} />
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">
          {item.title}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {toolStatusLabel[item.status]}
        </span>
        <ChevronRight
          aria-hidden="true"
          className="size-4 text-muted-foreground transition-transform group-open:rotate-90"
        />
      </summary>
      {open ? (
        <div className="space-y-3 border-t border-border/70 px-3 py-3">
          {item.input !== undefined ? (
            <ToolPayload label="Input" value={item.input} />
          ) : null}
          {item.output !== undefined ? (
            <ToolPayload label="Output" value={item.output} />
          ) : null}
          {item.input === undefined && item.output === undefined ? (
            <p className="text-xs text-muted-foreground">No details available.</p>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

const ActivityRow = memo(function ActivityRow({
  item,
}: {
  item: ActivityItem;
}) {
  if (item.kind === "user-message") {
    return (
      <div className="group ml-auto max-w-[82%]">
        <div className="rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-sm leading-6">
          {item.text}
        </div>
      </div>
    );
  }

  if (item.kind === "assistant-message") {
    return (
      <div
        className="max-w-none text-foreground"
        aria-live="polite"
        aria-busy={item.streaming}
      >
        <MarkdownContent>{item.text}</MarkdownContent>
        {item.streaming && (
          <span
            aria-label="Generating response"
            className="mt-1 inline-block size-1.5 animate-pulse rounded-full bg-muted-foreground"
          />
        )}
      </div>
    );
  }

  if (item.kind === "reasoning") {
    return <ReasoningRow item={item} />;
  }

  if (item.kind === "status") {
    return <p className="text-xs text-muted-foreground">{item.text}</p>;
  }

  return <ToolRow item={item} />;
});

export const ActivityFeed = memo(function ActivityFeed({
  items,
  status,
  review,
  onReview,
}: {
  items: ActivityItem[];
  status: TaskStatus | AgentStatus;
  review?: ReviewSnapshot | null;
  onReview?(): void;
}) {
  return (
    <section
      aria-label="Conversation activity"
      className="mx-auto flex w-full max-w-3xl flex-col gap-5"
    >
      {items.map((item) => (
        <div
          key={item.id}
          style={{ contentVisibility: "auto", containIntrinsicSize: "auto 80px" }}
        >
          <ActivityRow item={item} />
        </div>
      ))}
      {review !== undefined && review !== null && review.files.length > 0 && onReview !== undefined ? (
        <FileChangesSummary snapshot={review} onReview={onReview} />
      ) : null}
      {status !== "idle" && status !== "running" && (
        <div className="flex items-center gap-2 text-xs capitalize text-muted-foreground">
          <TerminalSquare aria-hidden="true" className="size-3.5" />
          {status}
        </div>
      )}
    </section>
  );
});
