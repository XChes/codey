import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ReviewFile,
  ReviewSnapshot,
} from "../../../shared/review";

type ReviewAction = "keep" | "undo";

function isStaleError(error: unknown): boolean {
  return error instanceof Error && /stale|changed|revision|signature/i.test(error.message);
}

export interface ReviewStateController {
  snapshot: ReviewSnapshot | null;
  error: string | null;
  mutating: boolean;
  refresh(): Promise<void>;
  apply(file: ReviewFile, action: ReviewAction): Promise<ReviewSnapshot | null>;
}

export function useReviewState(taskId: string | null): ReviewStateController {
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (taskId === null) {
      setSnapshot(null);
      setError(null);
      return;
    }
    try {
      const next = await window.desktop.review.snapshot({ taskId });
      if (requestId !== requestRef.current) return;
      setSnapshot(next);
      setError(null);
    } catch (caught) {
      if (requestId !== requestRef.current) return;
      setError(caught instanceof Error ? caught.message : "Could not load review");
    }
  }, [taskId]);

  useEffect(() => {
    setSnapshot(null);
    setError(null);
    setMutating(false);
    void refresh();
    if (taskId === null) return;
    return window.desktop.review.onChanged((event) => {
      if (event.taskId === taskId) void refresh();
    });
  }, [refresh, taskId]);

  const apply = useCallback(
    async (file: ReviewFile, action: ReviewAction) => {
      if (taskId === null || snapshot === null || mutating) return null;
      const requestId = ++requestRef.current;
      setMutating(true);
      setError(null);
      try {
        const next = await window.desktop.review[action]({
          taskId,
          fileId: file.id,
          expectedRevision: snapshot.revision,
          expectedSignature: file.currentSignature,
        });
        if (requestId === requestRef.current) setSnapshot(next);
        return next;
      } catch (caught) {
        setError(
          isStaleError(caught)
            ? "This file changed before the action. Review refreshed."
            : caught instanceof Error
              ? caught.message
              : `Could not ${action === "keep" ? "accept" : "reject"} file`,
        );
        await refresh();
        return null;
      } finally {
        setMutating(false);
      }
    },
    [mutating, refresh, snapshot, taskId],
  );

  return { snapshot, error, mutating, refresh, apply };
}
