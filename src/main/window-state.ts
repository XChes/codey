import type { AppSettings } from "../shared/settings";

export const MIN_WINDOW_WIDTH = 820;
export const MIN_WINDOW_HEIGHT = 620;

export function constrainWindowState(
  window: AppSettings["window"],
  workArea: { width: number; height: number },
): AppSettings["window"] {
  return {
    width: Math.min(Math.max(window.width, MIN_WINDOW_WIDTH), workArea.width),
    height: Math.min(
      Math.max(window.height, MIN_WINDOW_HEIGHT),
      workArea.height,
    ),
    maximized: window.maximized,
  };
}

