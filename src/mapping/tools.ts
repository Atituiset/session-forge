export type CanonicalTool =
  | "read"
  | "write"
  | "edit"
  | "bash"
  | "search"
  | "list"
  | "web"
  | "other";

// Every variant is grounded in a name the readers actually emit or parse:
// apply_patch/exec_command (codex rollout, src/readers/codex_family.ts),
// read_file (codewhale tool_calls[].function), exec_command (kimi toolCalls),
// PascalCase Edit/Write/... (claude-code tool_use), lowercase bash/edit/...
// (opencode tool parts), and the CODE_ACTION/VIEW_FILE/... action names of
// antigravity transcripts (src/readers/antigravity.ts).
const CANONICAL_MAP: [RegExp, CanonicalTool][] = [
  [/^(edit|multiedit|notebookedit|apply_patch|code_action)$/i, "edit"],
  [/^(write|create_file)$/i, "write"],
  [/^(read|read_file|view|view_file)$/i, "read"],
  [/^(bash|shell|exec_command|terminal|run_command)$/i, "bash"],
  [/^(grep|search|rg|find|grep_search)$/i, "search"],
  [/^(glob|ls|list_dir|list|list_directory)$/i, "list"],
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
