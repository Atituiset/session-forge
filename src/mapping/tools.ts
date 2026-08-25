export type CanonicalTool =
  | "read"
  | "write"
  | "edit"
  | "bash"
  | "search"
  | "list"
  | "web"
  | "other";

const CANONICAL_MAP: [RegExp, CanonicalTool][] = [
  [/^(edit|multiedit|notebookedit|apply_patch)$/i, "edit"],
  [/^(write|create_file)$/i, "write"],
  [/^(read|read_file|view)$/i, "read"],
  [/^(bash|shell|exec_command|terminal|run_command)$/i, "bash"],
  [/^(grep|search|rg|find)$/i, "search"],
  [/^(glob|ls|list_dir|list)$/i, "list"],
  [/^(webfetch|web_search|browser)$/i, "web"],
];

export function canonicalize(toolName: string): CanonicalTool {
  for (const [re, tool] of CANONICAL_MAP) {
    if (re.test(toolName)) return tool;
  }
  return "other";
}

const CODEX_NAMES: Record<CanonicalTool, string> = {
  read: "exec_command",
  write: "apply_patch",
  edit: "apply_patch",
  bash: "exec_command",
  search: "exec_command",
  list: "exec_command",
  web: "exec_command",
  other: "exec_command",
};

const CLAUDE_NAMES: Record<CanonicalTool, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  search: "Grep",
  list: "Glob",
  web: "WebFetch",
  other: "Bash",
};

export function toCodexTool(canonical: CanonicalTool): string {
  return CODEX_NAMES[canonical];
}

export function toClaudeTool(canonical: CanonicalTool): string {
  return CLAUDE_NAMES[canonical];
}
