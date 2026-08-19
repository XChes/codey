import { useState, type ComponentPropsWithoutRef } from "react";
import { Check, Copy } from "lucide-react";
import {
  Highlight,
  Prism,
  type Language,
} from "prism-react-renderer";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { syntaxTokenClassName } from "@/lib/syntax-highlighting";

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const supportedLanguage =
    language !== undefined &&
    Object.prototype.hasOwnProperty.call(Prism.languages, language)
      ? (language as Language)
      : "plain";

  const copy = async (): Promise<void> => {
    if (navigator.clipboard === undefined) return;
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <div className="my-4 overflow-hidden rounded-lg border border-border/80 bg-muted/45">
      <div className="flex h-9 items-center justify-between border-b border-border/70 px-3">
        <span className="font-mono text-[11px] text-muted-foreground">
          {language ?? "text"}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground"
          aria-label="Copy code"
          onClick={() => void copy()}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <Highlight
        code={code}
        language={supportedLanguage}
        theme={{ plain: {}, styles: [] }}
      >
        {({ tokens, getLineProps }) => (
          <pre className="overflow-x-auto p-3 font-mono text-[12px] leading-5">
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

const components: Components = {
  h1: ({ children }) => (
    <h1 className="mb-3 mt-7 text-xl font-semibold tracking-tight first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2.5 mt-6 text-lg font-semibold tracking-tight first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 mt-5 text-base font-semibold first:mt-0">{children}</h3>
  ),
  p: ({ children }) => (
    <p className="my-3 first:mt-0 last:mb-0">{children}</p>
  ),
  ul: ({ children, className }) => (
    <ul
      className={cn(
        "my-3 list-disc space-y-1 pl-6 marker:text-muted-foreground",
        className,
      )}
    >
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-3 list-decimal space-y-1 pl-6 marker:text-muted-foreground">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-2 border-border pl-4 text-muted-foreground">
      {children}
    </blockquote>
  ),
  a: ({ children, className, ...props }) => (
    <a
      {...props}
      className={cn(
        "font-medium text-accent-foreground underline decoration-border underline-offset-4 hover:decoration-current",
        className,
      )}
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-6 border-border/80" />,
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-lg border border-border/80">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/70">{children}</thead>,
  th: ({ children }) => (
    <th className="border-b border-border px-3 py-2 text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-border/60 px-3 py-2 align-top last:border-b-0">
      {children}
    </td>
  ),
  pre: ({ children }) => <>{children}</>,
  code: ({
    children,
    className,
    ...props
  }: ComponentPropsWithoutRef<"code">) => {
    const code = String(children).replace(/\n$/, "");
    const language = /language-([\w-]+)/.exec(className ?? "")?.[1];
    if (language !== undefined || String(children).includes("\n")) {
      return <CodeBlock code={code} language={language} />;
    }
    return (
      <code
        {...props}
        className={cn(
          "rounded bg-muted px-1.5 py-0.5 font-mono text-[0.875em]",
          className,
        )}
      >
        {children}
      </code>
    );
  },
};

export function MarkdownContent({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 text-[15px] leading-7", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
