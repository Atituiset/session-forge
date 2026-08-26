import { describe, expect, test } from "bun:test";
import type { CanonicalTool } from "../../src/mapping/tools.ts";
import { canonicalize, toClaudeTool, toCodexTool } from "../../src/mapping/tools.ts";

// Vendor tool names the readers actually produce (NIR toolName), with evidence:
// - codex rollout function_call/custom_tool_call: tests/fixtures/codex/rollout.jsonl
// - kimi wire toolCalls: tests/fixtures/kimi/wire.jsonl
// - codewhale tool_calls[].function: tests/fixtures/codewhale/session.json
// - claude-code tool_use: tests/fixtures/claude/session.jsonl
// - antigravity transcript actions: src/readers/antigravity.ts
// - opencode tool parts: tests/unit/opencode_store.test.ts
const VENDOR_TO_CANONICAL: [string, CanonicalTool][] = [
  // codex rollout
  ["apply_patch", "edit"],
  ["exec_command", "bash"],
  // kimi toolCalls (OpenAI-compatible function names)
  ["exec_command", "bash"],
  // codewhale tool_calls[].function
  ["read_file", "read"],
  // claude-code tool_use (PascalCase)
  ["Read", "read"],
  ["Write", "write"],
  ["Edit", "edit"],
  ["MultiEdit", "edit"],
  ["NotebookEdit", "edit"],
  ["Bash", "bash"],
  ["Grep", "search"],
  ["Glob", "list"],
  ["WebFetch", "web"],
  // antigravity transcript action names
  ["CODE_ACTION", "edit"],
  ["VIEW_FILE", "read"],
  ["RUN_COMMAND", "bash"],
  ["GREP_SEARCH", "search"],
  ["LIST_DIRECTORY", "list"],
  // opencode tool parts (lowercase)
  ["edit", "edit"],
  ["bash", "bash"],
  // anything unrecognized falls through
  ["unknown", "other"],
  ["some_vendor_tool", "other"],
];

describe("canonicalize", () => {
  for (const [vendor, canonical] of VENDOR_TO_CANONICAL) {
    test(`${vendor} -> ${canonical}`, () => {
      expect(canonicalize(vendor)).toBe(canonical);
    });
  }
});

const CANONICAL_TO_CODEX: [CanonicalTool, string][] = [
  ["read", "exec_command"],
  ["write", "apply_patch"],
  ["edit", "apply_patch"],
  ["bash", "exec_command"],
  ["search", "exec_command"],
  ["list", "exec_command"],
  ["web", "exec_command"],
  ["other", "exec_command"],
];

const CANONICAL_TO_CLAUDE: [CanonicalTool, string][] = [
  ["read", "Read"],
  ["write", "Write"],
  ["edit", "Edit"],
  ["bash", "Bash"],
  ["search", "Grep"],
  ["list", "Glob"],
  ["web", "WebFetch"],
  ["other", "Bash"],
];

describe("toCodexTool", () => {
  for (const [canonical, name] of CANONICAL_TO_CODEX) {
    test(`${canonical} -> ${name}`, () => {
      expect(toCodexTool(canonical)).toBe(name);
    });
  }
});

describe("toClaudeTool", () => {
  for (const [canonical, name] of CANONICAL_TO_CLAUDE) {
    test(`${canonical} -> ${name}`, () => {
      expect(toClaudeTool(canonical)).toBe(name);
    });
  }
});
