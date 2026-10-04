import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { hermesSessionsFromDb } from "agent-session-format";
import type { Transport } from "../transport/types.ts";
import type { FileGroup, Reader, ScanEvent } from "./util.ts";

/**
 * Hermes keeps its conversation in `~/.hermes/state.db` (sessions + messages
 * tables). A real corpus measured 44 sessions / 14154 messages, none of which
 * the curated registry could reach: `~/.hermes` matched none of the three
 * heuristic directory signatures (session_index.jsonl / projects/<slug>/*.jsonl
 * / opencode.db), so it was silently skipped on every scan.
 *
 * The SQL → NIR mapping lives in the shared package, like every other reader.
 */
export class HermesSqliteReader implements Reader {
  readonly family = "hermes-sqlite";

  async *scan(_transport: Transport, group: FileGroup): AsyncGenerator<ScanEvent> {
    for (const file of group.files) {
      let db: Database | null = null;
      try {
        db = new Database(file, { readonly: true });
        const sessions = await hermesSessionsFromDb(db, { source: group.toolId });
        for (const session of sessions) {
          // started_at is normalized to ISO by the parser; fall back to the
          // database file's mtime so a session row with no usable timestamp
          // still gets a real watermark (rev 0 would pin it as unchanged
          // forever after the first insert).
          const rev = Date.parse(session.endedAt ?? session.startedAt ?? "") || mtimeOf(file);
          yield { kind: "session", sourceFile: `${file}#${session.id}`, rev, session };
        }
      } catch (err) {
        yield { kind: "issue", path: file, error: String(err) };
      } finally {
        db?.close();
      }
    }
  }
}

function mtimeOf(file: string): number {
  try {
    return Math.trunc(statSync(file).mtimeMs) || Date.now();
  } catch {
    return Date.now();
  }
}
