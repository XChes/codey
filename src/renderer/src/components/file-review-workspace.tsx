import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Highlight,
  Prism,
  type Language,
} from "prism-react-renderer";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileCode2,
  FileText,
  Folder,
  GitCompareArrows,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
  X,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FileContent, FileListResult } from "../../../shared/files";
import type {
  ReviewFile,
  ReviewFileDetail,
} from "../../../shared/review";
import type { ReviewStateController } from "@/hooks/use-review-state";
import { cn } from "@/lib/utils";
import { syntaxTokenClassName } from "@/lib/syntax-highlighting";
import { Button } from "@/components/ui/button";

type OpenTab = { path: string; reviewFileId?: string };

const MIN_PANEL_WIDTH = 420;
const DEFAULT_PANEL_WIDTH = 560;
const MIN_CONVERSATION_WIDTH = 480;

function fileName(path: string) {
  return path.split("/").at(-1) ?? path;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  css: "css",
  go: "go",
  h: "c",
  hpp: "cpp",
  html: "markup",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  md: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  ts: "typescript",
  tsx: "tsx",
  xml: "markup",
  yaml: "yaml",
  yml: "yaml",
};

function languageForPath(path: string): Language {
  const extension = path.split(".").at(-1)?.toLowerCase();
  const language = extension === undefined ? undefined : LANGUAGE_BY_EXTENSION[extension];
  return language !== undefined &&
    Object.prototype.hasOwnProperty.call(Prism.languages, language)
    ? (language as Language)
    : "plain";
}

type FileTreeNode = {
  path: string;
  name: string;
  directory: boolean;
  children: FileTreeNode[];
};

type MutableFileTreeNode = {
  path: string;
  name: string;
  directory: boolean;
  children: Map<string, MutableFileTreeNode>;
};

function buildFileTree(files: string[]): FileTreeNode[] {
  const root = new Map<string, MutableFileTreeNode>();

  for (const path of files) {
    const parts = path.split("/");
    let children = root;
    let nodePath = "";
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      const directory = index < parts.length - 1;
      nodePath = nodePath.length === 0 ? part : `${nodePath}/${part}`;
      let node = children.get(part);
      if (node === undefined) {
        node = { path: nodePath, name: part, directory, children: new Map() };
        children.set(part, node);
      }
      if (directory) children = node.children;
    }
  }

  const freeze = (nodes: Map<string, MutableFileTreeNode>): FileTreeNode[] =>
    Array.from(nodes.values(), (node) => ({
      path: node.path,
      name: node.name,
      directory: node.directory,
      children: freeze(node.children),
    }));

  return freeze(root);
}

export function FileTree({
  files,
  selectedPath,
  onSelect,
}: {
  files: string[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  type VisibleFileTreeNode = { node: FileTreeNode; depth: number };
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const tree = useMemo(() => buildFileTree(files), [files]);
  const rows = useMemo(() => {
    const visible: VisibleFileTreeNode[] = [];
    const visit = (nodes: FileTreeNode[], depth: number) => {
      for (const node of nodes) {
        visible.push({ node, depth });
        if (node.directory && expanded.has(node.path)) visit(node.children, depth + 1);
      }
    };
    visit(tree, 0);
    return visible;
  }, [expanded, tree]);
  const scrollRef = useRef<HTMLElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    initialRect: { width: 320, height: 480 },
    overscan: 8,
  });

  const toggleDirectory = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const onRowKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, node: FileTreeNode) => {
      if (!node.directory) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        if (!expanded.has(node.path)) toggleDirectory(node.path);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (expanded.has(node.path)) toggleDirectory(node.path);
      }
    },
    [expanded, toggleDirectory],
  );

  const virtualItems = virtualizer.getVirtualItems();
  const renderedItems =
    virtualItems.length > 0 || rows.length > 100
      ? virtualItems.map((item) => ({
          index: item.index,
          start: item.start,
        }))
      : rows.map((_, index) => ({ index, start: index * 28 }));
  return (
    <nav
      ref={scrollRef}
      aria-label="Project files"
      role="tree"
      className="h-full min-w-0 overflow-y-auto py-1"
    >
      <div style={{ height: `${Math.max(virtualizer.getTotalSize(), rows.length * 28)}px`, position: "relative", width: "100%" }}>
        {renderedItems.map((item) => {
          const row = rows[item.index]!;
          const node = row.node;
          const isExpanded = node.directory && expanded.has(node.path);
          return (
            <button
              key={node.path}
              type="button"
              role="treeitem"
              aria-level={row.depth + 1}
              aria-expanded={node.directory ? isExpanded : undefined}
              aria-selected={!node.directory && selectedPath === node.path}
              onClick={() => node.directory ? toggleDirectory(node.path) : onSelect(node.path)}
              onKeyDown={(event) => onRowKeyDown(event, node)}
              className={cn(
                "absolute left-0 flex h-7 w-full min-w-0 items-center gap-1.5 pr-2 text-left text-xs hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
                !node.directory && selectedPath === node.path && "bg-muted text-foreground",
                node.directory && "font-medium text-muted-foreground",
              )}
              style={{
                paddingLeft: `${10 + row.depth * 12}px`,
                top: 0,
                transform: `translateY(${item.start}px)`,
              }}
              title={node.path}
            >
              {node.directory ? (
                isExpanded ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />
              ) : <span className="size-3 shrink-0" />}
              {node.directory ? <Folder className="size-3 shrink-0" /> : <FileText className="size-3 shrink-0 text-muted-foreground" />}
              <span className="truncate">{node.name}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export function FileViewer({ content }: { content: FileContent | null }) {
  if (content === null) {
    return <p className="p-4 text-xs text-muted-foreground">Select a file to preview it.</p>;
  }
  if (content.isBinary || content.content === null) {
    return (
      <p className="p-4 text-xs text-muted-foreground">
        Binary file · {content.size.toLocaleString()} bytes
      </p>
    );
  }
  return (
    <div aria-label="File preview" className="h-full min-h-0 overflow-auto overscroll-contain">
      {content.truncated ? (
        <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
          Preview truncated · {content.size.toLocaleString()} bytes
        </p>
      ) : null}
      <Highlight
        code={content.content}
        language={languageForPath(content.path)}
        theme={{ plain: {}, styles: [] }}
      >
        {({ tokens, getLineProps }) => (
          <pre className="m-0 min-h-full whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5 text-foreground">
            <code>
              {tokens.map((line, lineIndex) => (
                <span
                  {...getLineProps({ line })}
                  key={lineIndex}
                  className="block min-h-5"
                >
                  {line.map((token, tokenIndex) => (
                    <span
                      key={tokenIndex}
                      className={syntaxTokenClassName(token)}
                    >
                      {token.content}
                    </span>
                  ))}
                </span>
              ))}
            </code>
          </pre>
        )}
      </Highlight>
    </div>
  );
}

function ReviewDiff({ detail }: { detail: ReviewFileDetail | null }) {
  if (detail === null) return <p className="p-4 text-xs text-muted-foreground">Loading change…</p>;
  if (detail.file.isBinary || detail.truncated) {
    return (
      <p className="p-4 text-xs text-muted-foreground">
        {detail.file.isBinary ? "Binary file" : "Large file preview"} · {detail.file.status}
      </p>
    );
  }
  const fileDiff = parseDiffFromFile(
    detail.oldContent === null
      ? null
      : { name: detail.file.previousPath ?? detail.file.path, contents: detail.oldContent },
    detail.newContent === null
      ? null
      : { name: detail.file.path, contents: detail.newContent },
  );
  return (
    <div aria-label="Unified diff" className="h-full overflow-auto font-mono text-xs">
      <FileDiff
        fileDiff={fileDiff}
        disableWorkerPool
        options={{ diffStyle: "unified" }}
      />
    </div>
  );
}

function statusLabel(file: ReviewFile) {
  if (file.status === "renamed" && file.previousPath !== null) return `${file.previousPath} → ${file.path}`;
  return file.path;
}

function clampPanelWidth(width: number) {
  const max = Math.max(MIN_PANEL_WIDTH, window.innerWidth - MIN_CONVERSATION_WIDTH);
  return Math.max(MIN_PANEL_WIDTH, Math.min(max, width));
}

export const FileReviewWorkspace = memo(function FileReviewWorkspace({
  taskId,
  review,
  open,
  onOpenChange,
}: {
  taskId: string;
  review: ReviewStateController;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const [width, setWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [files, setFiles] = useState<string[]>([]);
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);
  const [reviewDetail, setReviewDetail] = useState<ReviewFileDetail | null>(null);
  const [mode, setMode] = useState<"diff" | "file">("diff");
  const [error, setError] = useState<string | null>(null);
  const filesRequestRef = useRef(0);
  const fileReadRequestRef = useRef(0);
  const reviewDetailRequestRef = useRef(0);
  const selectedPathRef = useRef(selectedPath);
  const selectedReviewIdRef = useRef(selectedReviewId);
  selectedPathRef.current = selectedPath;
  selectedReviewIdRef.current = selectedReviewId;

  const {
    snapshot,
    error: reviewError,
    mutating,
    apply: applyReviewAction,
  } = review;
  const selectedReview = snapshot?.files.find((file) => file.id === selectedReviewId) ?? null;

  const refreshFiles = useCallback(async () => {
    const requestId = ++filesRequestRef.current;
    const result: FileListResult = await window.desktop.files.list({ taskId });
    if (requestId !== filesRequestRef.current) return;
    setFiles((current) =>
      current.length === result.files.length && current.every((path, index) => path === result.files[index])
        ? current
        : result.files,
    );
  }, [taskId]);

  const selectFile = useCallback(
    async (path: string) => {
      const requestId = ++fileReadRequestRef.current;
      setSelectedPath(path);
      setSelectedReviewId(null);
      setMode("file");
      setTabs((current) =>
        current.some((tab) => tab.path === path) ? current : [...current, { path }],
      );
      try {
        const content = await window.desktop.files.read({ taskId, path });
        if (requestId === fileReadRequestRef.current) setFileContent(content);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not read file");
      }
    },
    [taskId],
  );

  const loadReview = useCallback(
    async (
      file: ReviewFile,
      revision: number,
      preferredMode: "diff" | "file" = "diff",
    ) => {
      const requestId = ++reviewDetailRequestRef.current;
      setSelectedReviewId(file.id);
      setSelectedPath(file.path);
      setMode(preferredMode);
      setTabs((current) =>
        current.some((tab) => tab.reviewFileId === file.id)
          ? current
          : [...current, { path: file.path, reviewFileId: file.id }],
      );
      try {
        setReviewDetail(null);
        const detail = await window.desktop.review.file({
          taskId,
          fileId: file.id,
          expectedRevision: revision,
        });
        if (requestId === reviewDetailRequestRef.current) setReviewDetail(detail);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not load change");
      }
    },
    [taskId],
  );

  const selectReview = useCallback(
    (file: ReviewFile, preferredMode: "diff" | "file" = "diff") => {
      if (snapshot === null) return;
      return loadReview(file, snapshot.revision, preferredMode);
    },
    [loadReview, snapshot],
  );

  const closeTab = useCallback(
    (tab: OpenTab) => {
      const closingSelected =
        tab.reviewFileId === undefined
          ? selectedReviewId === null && selectedPath === tab.path
          : selectedReviewId === tab.reviewFileId;
      const index = tabs.indexOf(tab);
      const remaining = tabs.filter((candidate) => candidate !== tab);
      setTabs(remaining);
      if (!closingSelected) return;

      const fallback = remaining[Math.min(Math.max(index, 0), remaining.length - 1)];
      if (fallback === undefined) {
        fileReadRequestRef.current += 1;
        reviewDetailRequestRef.current += 1;
        setSelectedPath(null);
        setSelectedReviewId(null);
        setFileContent(null);
        setReviewDetail(null);
        setMode("file");
        return;
      }

      const reviewFile = fallback.reviewFileId === undefined
        ? undefined
        : snapshot?.files.find((file) => file.id === fallback.reviewFileId);
      if (reviewFile !== undefined) void selectReview(reviewFile);
      else void selectFile(fallback.path);
    },
    [selectFile, selectReview, selectedPath, selectedReviewId, snapshot, tabs],
  );

  useEffect(() => {
    setError(null);
    void refreshFiles().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not list files"));
  }, [refreshFiles]);

  useEffect(() => {
    const unsubscribeFiles = window.desktop.files.onChanged((event) => {
      if (event.taskId !== taskId) return;
      void refreshFiles();
      const path = selectedPathRef.current;
      if (selectedReviewIdRef.current === null && path !== null) {
        void window.desktop.files
          .read({ taskId, path })
          .then((content) => {
            if (selectedReviewIdRef.current === null && selectedPathRef.current === path) {
              setFileContent(content);
            }
          })
          .catch((caught: unknown) =>
            setError(caught instanceof Error ? caught.message : "Could not refresh file"),
          );
      }
    });
    return () => {
      unsubscribeFiles();
    };
  }, [refreshFiles, taskId]);

  useEffect(() => {
    setTabs([]);
    setSelectedPath(null);
    setFileContent(null);
    setSelectedReviewId(null);
    setReviewDetail(null);
  }, [taskId]);

  useEffect(() => {
    if (snapshot === null) return;
    setSelectedReviewId((current) =>
      current !== null && snapshot.files.some((file) => file.id === current)
        ? current
        : (snapshot.files[0]?.id ?? null),
    );
  }, [snapshot]);

  useEffect(() => {
    if (!open || selectedReview === null || snapshot === null) return;
    void loadReview(selectedReview, snapshot.revision, mode);
  }, [loadReview, mode, open, selectedReview, snapshot]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onOpenChange, open]);

  const applyReview = useCallback(
    async (reviewed: ReviewFile, action: "keep" | "undo") => {
      if (snapshot === null || mutating) return;
      const oldIndex = snapshot.files.findIndex((file) => file.id === reviewed.id);
      setError(null);
      try {
        const next = await applyReviewAction(reviewed, action);
        if (next === null) return;
        if (action === "keep") {
          setTabs((current) => current.map((tab) =>
            tab.reviewFileId === reviewed.id ? { path: reviewed.path } : tab,
          ));
          if (selectedReviewId === reviewed.id) {
            setSelectedReviewId(null);
            setMode("file");
            await selectFile(reviewed.path);
          }
        } else {
          const listed = await window.desktop.files.list({ taskId });
          setFiles(listed.files);
          const exists = listed.files.includes(reviewed.path);
          setTabs((current) => current.flatMap((tab) => {
            if (tab.reviewFileId !== reviewed.id) return [tab];
            return exists ? [{ path: reviewed.path }] : [];
          }));
          const nextFile = next.files[Math.min(oldIndex, next.files.length - 1)] ?? null;
          if (nextFile !== null) await loadReview(nextFile, next.revision);
          else {
            setSelectedReviewId(null);
            setReviewDetail(null);
            if (exists) await selectFile(reviewed.path);
          }
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not update review");
      }
    },
    [applyReviewAction, loadReview, mutating, selectFile, selectedReviewId, snapshot, taskId],
  );

  const beginResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const initialWidth = width;
    const move = (moveEvent: MouseEvent) => setWidth(clampPanelWidth(initialWidth + startX - moveEvent.clientX));
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
  };

  const resizeKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setWidth((current) => clampPanelWidth(current + (event.key === "ArrowLeft" ? 32 : -32)));
  };

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" className="absolute right-5 top-3 z-10" onClick={() => onOpenChange(true)} aria-label="Open files">
        <PanelRightOpen /> Open files
      </Button>
    );
  }

  return (
    <aside style={{ width: clampPanelWidth(width) }} className="relative flex h-full min-h-0 min-w-[420px] shrink-0 overflow-hidden border-l border-border bg-card" aria-label="File workspace">
      <div role="separator" tabIndex={0} aria-label="Resize file workspace" aria-orientation="vertical" onMouseDown={beginResize} onKeyDown={resizeKeyboard} className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize focus-visible:bg-ring/50 focus-visible:outline-none" />
      <div className="flex min-h-0 min-w-40 shrink-0 flex-col border-r border-border" style={{ width: "38%" }}>
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-2">
          <span className="text-xs font-semibold">Files</span>
          <Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => onOpenChange(false)} aria-label="Close file workspace" title="Close files"><PanelRightClose /></Button>
        </div>
        <div className="min-h-0 flex-1">
          {files.length === 0 ? <p className="p-3 text-xs text-muted-foreground">No files to show.</p> : <FileTree key={taskId} files={files} selectedPath={selectedPath} onSelect={(path) => void selectFile(path)} />}
        </div>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-12 min-w-0 shrink-0 items-center gap-1 border-b border-border px-2">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {tabs.map((tab) => (
              <div key={`${tab.reviewFileId ?? "file"}:${tab.path}`} className={cn("flex h-7 max-w-36 shrink-0 items-center rounded text-xs hover:bg-muted", selectedPath === tab.path && "bg-muted")}> 
                <button type="button" aria-label={`Open tab ${tab.path}`} onClick={() => {
                  const file = tab.reviewFileId === undefined ? undefined : snapshot?.files.find((candidate) => candidate.id === tab.reviewFileId);
                  if (file !== undefined) void selectReview(file);
                  else if (tab.reviewFileId === undefined) void selectFile(tab.path);
                }} className="flex min-w-0 flex-1 items-center gap-1 pl-1.5 text-left">
                  <FileCode2 className="size-3 shrink-0" /><span className="truncate">{fileName(tab.path)}</span>
                </button>
                <button type="button" aria-label={`Close tab ${tab.path}`} className="mr-1 shrink-0 rounded p-0.5 hover:bg-background" onClick={() => closeTab(tab)}>
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <button type="button" className="flex min-w-0 items-center gap-1.5 text-left text-xs font-medium" onClick={() => selectedReview ? void selectReview(selectedReview) : undefined}>
                <GitCompareArrows className="size-3.5" /> Review <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{snapshot?.files.length ?? 0}</span>
              </button>
              {selectedReview !== null ? <div className="flex items-center gap-0.5"><Button type="button" variant="ghost" size="icon" className="size-7" aria-label="Previous changed file" disabled={(snapshot?.files.findIndex((file) => file.id === selectedReview.id) ?? 0) <= 0} onClick={() => { const index = snapshot?.files.findIndex((file) => file.id === selectedReview.id) ?? 0; const file = snapshot?.files[index - 1]; if (file) void selectReview(file); }}><ChevronLeft /></Button><Button type="button" variant="ghost" size="icon" className="size-7" aria-label="Next changed file" disabled={(snapshot?.files.findIndex((file) => file.id === selectedReview.id) ?? -1) >= (snapshot?.files.length ?? 1) - 1} onClick={() => { const index = snapshot?.files.findIndex((file) => file.id === selectedReview.id) ?? -1; const file = snapshot?.files[index + 1]; if (file) void selectReview(file); }}><ChevronRight /></Button></div> : null}
            </div>
            <div className="max-h-36 overflow-y-auto border-b border-border">
              {snapshot?.files.map((file) => <div key={file.id} className={cn("flex items-center gap-1 px-2 py-1.5", selectedReviewId === file.id && "bg-muted")}><button type="button" aria-label={`Review file ${file.path}`} className="min-w-0 flex-1 truncate text-left text-xs" title={statusLabel(file)} onClick={() => void selectReview(file)}><span className="mr-1 font-mono text-[10px] text-muted-foreground">{file.status[0]?.toUpperCase()}</span>{fileName(file.path)} <span className="text-muted-foreground">+{file.additions} −{file.deletions}</span></button><Button type="button" variant="ghost" size="icon" className="size-6" aria-label={`Accept ${file.path}`} title="Accept file" disabled={mutating} onClick={() => void applyReview(file, "keep")}><Check /></Button><Button type="button" variant="ghost" size="icon" className="size-6" aria-label={`Reject ${file.path}`} title="Reject file" disabled={mutating} onClick={() => void applyReview(file, "undo")}><RotateCcw /></Button></div>)}
              {snapshot !== null && snapshot.files.length === 0 ? <p className="px-3 py-2 text-xs text-muted-foreground">No changes to review.</p> : null}
            </div>
            {selectedReview !== null ? <div className="flex h-10 items-center justify-between border-b border-border px-3"><span className="min-w-0 truncate text-xs" title={statusLabel(selectedReview)}>{statusLabel(selectedReview)}</span><div className="flex shrink-0 items-center gap-1"><button type="button" className={cn("rounded px-2 py-1 text-[11px]", mode === "diff" && "bg-muted")} onClick={() => setMode("diff")}>Diff</button><button type="button" className={cn("rounded px-2 py-1 text-[11px]", mode === "file" && "bg-muted")} onClick={() => setMode("file")}>File</button><Button type="button" variant="ghost" size="sm" disabled={mutating} onClick={() => void applyReview(selectedReview, "keep")}><Check />Accept</Button><Button type="button" variant="ghost" size="sm" disabled={mutating} onClick={() => void applyReview(selectedReview, "undo")}><RotateCcw />Reject</Button></div></div> : null}
            <div className="min-h-0 flex-1 overflow-hidden">{selectedReview !== null && mode === "diff" ? <ReviewDiff detail={reviewDetail} /> : selectedReview !== null ? <FileViewer content={reviewDetail === null ? null : { path: selectedReview.path, content: reviewDetail.newContent, isBinary: selectedReview.isBinary, truncated: reviewDetail.truncated, size: 0 }} /> : <FileViewer content={fileContent} />}</div>
        </div>
        {(error ?? reviewError) !== null ? <p role="alert" className="border-t border-border px-3 py-2 text-xs text-destructive">{error ?? reviewError}</p> : null}
      </div>
    </aside>
  );
});
