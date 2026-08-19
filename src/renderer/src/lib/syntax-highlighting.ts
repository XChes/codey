import type { Token } from "prism-react-renderer";

export function syntaxTokenClassName(token: Token): string {
  const types = new Set(token.types);
  if (types.has("comment") || types.has("prolog") || types.has("doctype")) {
    return "text-muted-foreground italic";
  }
  if (
    types.has("string") ||
    types.has("char") ||
    types.has("attr-value") ||
    types.has("inserted")
  ) {
    return "text-success";
  }
  if (
    types.has("number") ||
    types.has("boolean") ||
    types.has("constant") ||
    types.has("deleted")
  ) {
    return "text-destructive";
  }
  if (
    types.has("keyword") ||
    types.has("operator") ||
    types.has("atrule") ||
    types.has("important")
  ) {
    return "text-accent-foreground";
  }
  if (
    types.has("function") ||
    types.has("class-name") ||
    types.has("builtin") ||
    types.has("selector") ||
    types.has("tag")
  ) {
    return "font-medium text-primary";
  }
  return "";
}
