import { describe, expect, it } from "vitest";
import { AppSidebar } from "@/components/app-sidebar";
import { ActivityFeed } from "@/components/activity-feed";
import { ConversationTodoCard } from "@/components/conversation-todo-card";
import { FileReviewWorkspace } from "@/components/file-review-workspace";

const REACT_MEMO_TYPE = Symbol.for("react.memo");

describe("expensive renderer boundaries", () => {
  it.each([
    ["sidebar", AppSidebar],
    ["activity feed", ActivityFeed],
    ["todo card", ConversationTodoCard],
    ["file workspace", FileReviewWorkspace],
  ])("keeps the %s behind a memo boundary", (_name, component) => {
    expect(component).toHaveProperty("$$typeof", REACT_MEMO_TYPE);
  });
});
