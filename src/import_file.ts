import path from "node:path";
import { readerFor } from "./readers/index.ts";
import type { ScanEvent } from "./readers/util.ts";
import type { ReaderFamily } from "./registry.ts";
import type { Store } from "./store.ts";
import { LocalTransport } from "./transport/local.ts";

export const IMPORT_FORMATS = [
  "claude-code",
  "codex",
  "kimi",
  "codewhale",
  "opencode",
  "antigravity",
] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

export function isImportFormat(value: string): value is ImportFormat {
  return (IMPORT_FORMATS as readonly string[]).includes(value);
}

// --from value -> registry toolId (the session's `source` key) + reader family.
const FORMAT_ROUTES: Record<ImportFormat, { toolId: string; family: ReaderFamily }> = {
  "claude-code": { toolId: "claude-code", family: "claude-code" },
  codex: { toolId: "codex", family: "codex-family" },
  kimi: { toolId: "kimi-code", family: "codex-family" },
  codewhale: { toolId: "codewhale", family: "codex-family" },
  opencode: { toolId: "opencode", family: "opencode-sqlite" },
  antigravity: { toolId: "gemini-antigravity", family: "antigravity-transcript" },
};

export interface ImportedSession {
  source: string;
  id: string;
  messages: number;
  status: "inserted" | "updated" | "skipped";
}

export interface ImportResult {
  sessions: ImportedSession[];
  inserted: number;
  updated: number;
  skipped: number;
  issues: string[];
}

export async function importFile(
  store: Store,
  filePath: string,
  format: ImportFormat,
): Promise<ImportResult> {
  const resolved = path.resolve(filePath);
  if (!(await Bun.file(resolved).exists())) {
    throw new Error(`File not found: ${filePath}`);
  }
  const shapeError = shapeMismatch(format, resolved);
  if (shapeError) throw new Error(shapeError);

  const route = FORMAT_ROUTES[format];
  const reader = readerFor(route.family);
  const result: ImportResult = { sessions: [], inserted: 0, updated: 0, skipped: 0, issues: [] };
  const events: Extract<ScanEvent, { kind: "session" }>[] = [];
  for await (const event of reader.scan(new LocalTransport(), {
    toolId: route.toolId,
    files: [resolved],
  })) {
    if (event.kind === "issue") {
      result.issues.push(`${event.path}: ${event.error}`);
      continue;
    }
    events.push(event);
  }
  store.transaction(() => {
    for (const event of events) {
      const r = store.upsert(event.session, event.sourceFile, event.rev);
      result[r.status]++;
      result.sessions.push({
        source: event.session.source,
        id: event.session.id,
        messages: event.session.messages.length,
        status: r.status,
      });
    }
  });
  return result;
}

// CodexFamilyReader dispatches sub-formats by file NAME (.json -> codewhale,
// *wire.jsonl -> kimi, anything else -> codex rollout). Reject combinations
// where --from disagrees with the name, since the file would be parsed by the
// wrong sub-reader and silently yield garbage or nothing.
function shapeMismatch(format: ImportFormat, file: string): string | null {
  if (format === "kimi" && !file.endsWith("wire.jsonl")) {
    return `--from kimi expects a wire.jsonl file (got: ${file})`;
  }
  if (format === "codewhale" && !file.endsWith(".json")) {
    return `--from codewhale expects a .json file (got: ${file})`;
  }
  if (format === "codex" && (!file.endsWith(".jsonl") || file.endsWith("wire.jsonl"))) {
    return `--from codex expects a rollout .jsonl file (got: ${file})`;
  }
  return null;
}
