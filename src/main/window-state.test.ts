// @vitest-environment node
import { constrainWindowState } from "./window-state";

describe("constrainWindowState", () => {
  it("keeps a restored window inside the available display", () => {
    expect(
      constrainWindowState(
        { width: 5000, height: 4000, maximized: false },
        { width: 1440, height: 900 },
      ),
    ).toEqual({ width: 1440, height: 900, maximized: false });
  });
});

