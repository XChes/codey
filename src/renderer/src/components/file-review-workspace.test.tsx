import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileTree, FileViewer } from "./file-review-workspace";

describe("FileTree", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      value: 300,
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 300,
      height: 300,
      left: 0,
      right: 300,
      top: 0,
      toJSON: () => undefined,
      width: 300,
      x: 0,
      y: 0,
    });
    class ResizeObserverMock {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(window, "ResizeObserver", { configurable: true, value: ResizeObserverMock });
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: ResizeObserverMock });
  });

  it("keeps directories collapsed until explicitly expanded", async () => {
    const user = userEvent.setup();
    render(
      <FileTree
        files={["src/index.ts", "src/components/button.tsx", "README.md"]}
        selectedPath={null}
        onSelect={() => undefined}
      />,
    );

    expect(screen.getByRole("treeitem", { name: "src" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("index.ts")).not.toBeInTheDocument();
    await user.click(screen.getByRole("treeitem", { name: "src" }));
    expect(screen.getByRole("treeitem", { name: "src" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("index.ts")).toBeVisible();
    expect(screen.getByRole("treeitem", { name: "components" })).toHaveAttribute("aria-expanded", "false");
  });

  it("selects files and exposes selection accessibly", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<FileTree files={["README.md"]} selectedPath="README.md" onSelect={onSelect} />);

    const file = screen.getByRole("treeitem", { name: "README.md" });
    expect(file).toHaveAttribute("aria-selected", "true");
    await user.click(file);
    expect(onSelect).toHaveBeenCalledWith("README.md");
  });

  it("expands and collapses directories with arrow keys", () => {
    render(<FileTree files={["src/index.ts"]} selectedPath={null} onSelect={() => undefined} />);
    const directory = screen.getByRole("treeitem", { name: "src" });
    fireEvent.keyDown(directory, { key: "ArrowRight" });
    expect(directory).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(directory, { key: "ArrowLeft" });
    expect(directory).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps rendered rows bounded for very large file lists", () => {
    const files = Array.from({ length: 20_000 }, (_, index) => `file-${index}.ts`);
    render(<FileTree files={files} selectedPath={null} onSelect={() => undefined} />);

    expect(screen.getAllByRole("treeitem").length).toBeLessThan(100);
  });
});

describe("FileViewer", () => {
  it("syntax-highlights supported source files", () => {
    render(
      <FileViewer
        content={{
          path: "src/config.py",
          content: "from dataclasses import dataclass\nvalue = 42",
          isBinary: false,
          truncated: false,
          size: 51,
        }}
      />,
    );

    expect(screen.getByText("from")).toHaveClass("text-accent-foreground");
    expect(screen.getByText("42")).toHaveClass("text-destructive");
  });
});
