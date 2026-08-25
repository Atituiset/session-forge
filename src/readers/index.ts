import type { ReaderFamily } from "../registry.ts";
import { AntigravityReader } from "./antigravity.ts";
import { ClaudeCodeReader } from "./claude_code.ts";
import { CodexFamilyReader } from "./codex_family.ts";
import { OpencodeSqliteReader } from "./opencode_sqlite.ts";
import type { Reader } from "./util.ts";

const READERS: Record<ReaderFamily, Reader> = {
  "codex-family": new CodexFamilyReader(),
  "claude-code": new ClaudeCodeReader(),
  "opencode-sqlite": new OpencodeSqliteReader(),
  "antigravity-transcript": new AntigravityReader(),
};

export function readerFor(family: ReaderFamily): Reader {
  return READERS[family];
}
