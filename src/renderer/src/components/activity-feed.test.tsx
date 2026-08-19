import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { ActivityFeed } from "./activity-feed";
import type { ActivityItem, TaskStatus } from "@/models";
import type { ReviewSnapshot } from "../../../shared/review";

const items: ActivityItem[] = [
  { id: "u1", kind: "user-message", text: "Update the settings view" },
  {
    id: "a1",
    kind: "assistant-message",
    text: "## Update\n\nThe change is **ready**.\n\n```ts\nconst ready = true;\n```",
    streaming: true,
  },
  {
    id: "r1",
    kind: "reasoning",
    text: "I’ll inspect the current structure.",
    streaming: false,
  },
  { id: "s1", kind: "status", text: "Reading files" },
  { id: "t1", kind: "tool", title: "rg --files", status: "pending" },
  { id: "t2", kind: "tool", title: "pnpm test", status: "running" },
  { id: "t3", kind: "tool", title: "pnpm build", status: "succeeded" },
  {
    id: "t4",
    kind: "tool",
    title: "pnpm lint",
    status: "failed",
    input: '{"fix":false}',
    output: "One rule failed",
  },
];

describe("ActivityFeed", () => {
  it("renders formatted assistant content and every activity status", () => {
    render(<ActivityFeed items={items} status="running" />);

    expect(screen.getByText("Update the settings view")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Update", level: 2 }),
    ).toBeVisible();
    expect(screen.getByText("ready", { selector: "strong" })).toBeVisible();
    expect(screen.getByText("Reading files")).toBeVisible();
    for (const label of ["Pending", "Running", "Completed", "Failed"]) {
      expect(screen.getByText(label)).toBeVisible();
    }
  });

  it("keeps reasoning and tool details folded until independently expanded", async () => {
    const user = userEvent.setup();
    render(<ActivityFeed items={items} status="running" />);

    const reasoning = screen.getByText("Thinking").closest("details");
    const tool = screen.getByText("pnpm lint").closest("details");
    expect(reasoning).not.toHaveAttribute("open");
    expect(tool).not.toHaveAttribute("open");
    expect(screen.queryByText("I’ll inspect the current structure.")).not.toBeInTheDocument();
    expect(screen.queryByText("One rule failed")).not.toBeInTheDocument();

    await user.click(within(reasoning!).getByText("Thinking"));
    expect(reasoning).toHaveAttribute("open");
    expect(tool).not.toHaveAttribute("open");
    expect(screen.getByText("I’ll inspect the current structure.")).toBeVisible();

    await user.click(within(tool!).getByText("pnpm lint"));
    expect(tool).toHaveAttribute("open");
    expect(within(tool!).getByText(/"fix": false/)).toBeVisible();
    expect(within(tool!).getByText("One rule failed")).toBeVisible();
  });

  it("does not mount large folded payloads", () => {
    const payload = "large payload ".repeat(20_000);
    render(
      <ActivityFeed
        status="running"
        items={[
          { id: "reasoning", kind: "reasoning", text: payload, streaming: false },
          { id: "tool", kind: "tool", title: "large tool", status: "succeeded", output: payload },
        ]}
      />,
    );

    expect(document.body.textContent).not.toContain(payload);
    expect(document.querySelectorAll("pre")).toHaveLength(0);
  });

  it("copies fenced code from an assistant message", async () => {
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();
    render(<ActivityFeed items={items} status="running" />);

    await user.click(screen.getByRole("button", { name: "Copy code" }));

    expect(writeText).toHaveBeenCalledWith("const ready = true;");
    expect(screen.getByRole("button", { name: "Copy code" })).toHaveTextContent(
      "Copied",
    );
  });

  it("summarizes the current changed files and opens review", async () => {
    const user = userEvent.setup();
    const onReview = vi.fn();
    const review: ReviewSnapshot = {
      taskId: "task-1",
      revision: 4,
      baselineTree: "base",
      files: Array.from({ length: 6 }, (_, index) => ({
        id: `file-${index}`,
        path: `src/file-${index}.ts`,
        previousPath: null,
        status: "modified" as const,
        additions: index + 1,
        deletions: 1,
        isBinary: false,
        currentSignature: `signature-${index}`,
      })),
    };
    render(
      <ActivityFeed
        items={items}
        status="completed"
        review={review}
        onReview={onReview}
      />,
    );

    const summary = screen.getByRole("region", { name: "Changed files summary" });
    expect(summary).toHaveTextContent("6 Files Changed");
    expect(summary).toHaveTextContent("+21");
    expect(summary).toHaveTextContent("−6");
    expect(within(summary).getByText("Show 2 more")).toBeVisible();
    expect(within(summary).queryByText("src/file-4.ts")).not.toBeInTheDocument();
    await user.click(within(summary).getByRole("button", { name: "Review" }));
    expect(onReview).toHaveBeenCalledOnce();
  });

  it.each<TaskStatus>(["completed", "cancelled", "interrupted", "failed"])(
    "renders the %s terminal state",
    (status) => {
      render(<ActivityFeed items={[]} status={status} />);
      expect(screen.getByText(status)).toBeVisible();
    },
  );
});
