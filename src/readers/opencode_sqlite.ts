import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NirMessage } from "../nir/schema.ts";
import type { Transport } from "../transport/types.ts";
import type { FileGroup, Reader, ScanEvent } from "./util.ts";
import { buildSession, isoFromMs, makeMsg } from "./util.ts";

const MAX_TEXT = 30_000;

interface SessionRow {
  id: string;
  directory: string | null;
  title: string | null;
  version: string | null;
  summary_additions: number | null;
  summary_deletions: number | null;
  summary_files: number | null;
  time_created: number | null;
  time_updated: number | null;
  model: string | null;
  cost: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  worktree: string | null;
}

export class OpencodeSqliteReader implements Reader {
  readonly family = "opencode-sqlite";

  async *scan(transport: Transport, group: FileGroup): AsyncGenerator<ScanEvent> {
    for (const file of group.files) {
      let dbFile = file;
      let tempDir: string | null = null;
      try {
        if (transport.kind !== "local") {
          tempDir = mkdtempSync(path.join(tmpdir(), "sf-remote-db-"));
          dbFile = path.join(tempDir, "snapshot.db");
          const bytes = await transport.readBinaryFile(file);
          await Bun.write(dbFile, bytes);
        }
        const db = new Database(dbFile, { readonly: true });
        try {
          yield* scanDb(db, file, group.toolId);
        } finally {
          db.close();
        }
      } catch (err) {
        yield { kind: "issue", path: file, error: String(err) };
      } finally {
        if (tempDir) rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }
}

function* scanDb(db: Database, file: string, toolId: string): Generator<ScanEvent> {
  const sessions = db
    .prepare(
      `SELECT s.id, s.directory, s.title, s.version, s.summary_additions, s.summary_deletions,
              s.summary_files, s.time_created, s.time_updated, s.model, s.cost,
              s.tokens_input, s.tokens_output, p.worktree
       FROM session s LEFT JOIN project p ON p.id = s.project_id`,
    )
    .all() as SessionRow[];

  const msgsBySession = new Map<string, { id: string; data: string; time_created: number }[]>();
  for (const r of db
    .prepare("SELECT id, session_id AS sid, data, time_created FROM message ORDER BY time_created")
    .all() as { id: string; sid: string; data: string; time_created: number }[]) {
    const list = msgsBySession.get(r.sid) ?? [];
    list.push({ id: r.id, data: r.data, time_created: r.time_created });
    msgsBySession.set(r.sid, list);
  }
  const partsByMessage = new Map<string, { data: string }[]>();
  for (const r of db
    .prepare("SELECT data, message_id AS mid FROM part ORDER BY time_created")
    .all() as { data: string; mid: string }[]) {
    const list = partsByMessage.get(r.mid) ?? [];
    list.push({ data: r.data });
    partsByMessage.set(r.mid, list);
  }

  for (const row of sessions) {
    const messages: NirMessage[] = [];
    const patchFiles = new Set<string>();
    const msgRows = msgsBySession.get(row.id) ?? [];
    let model = row.model;

    for (const mr of msgRows) {
      let md: Record<string, unknown>;
      try {
        md = JSON.parse(mr.data);
      } catch {
        continue;
      }
      const role = md.role as string;
      if (role !== "user" && role !== "assistant" && role !== "system") continue;
      const modelField = md.model as Record<string, unknown> | undefined;
      const mModel =
        typeof modelField?.modelID === "string" ? (modelField.modelID as string) : model;
      if (typeof mModel === "string") model = mModel;
      const tsMs =
        typeof md.time === "object" && md.time !== null
          ? (md.time as Record<string, unknown>).created
          : mr.time_created;
      const ts = isoFromMs(tsMs as number);
      const tokensRaw = extractOpencodeTokens(md.tokens);

      let textContent = "";
      const partRows = partsByMessage.get(mr.id) ?? [];
      for (const pr of partRows) {
        let pd: Record<string, unknown>;
        try {
          pd = JSON.parse(pr.data);
        } catch {
          continue;
        }
        const pt = pd.type as string;
        if (pt === "text" && typeof pd.text === "string") {
          textContent += (textContent ? "\n" : "") + pd.text;
        } else if (pt === "tool" && typeof pd.tool === "string") {
          const state = (pd.state ?? {}) as Record<string, unknown>;
          messages.push(
            makeMsg({
              role: "assistant",
              content: "",
              toolName: pd.tool,
              toolInput: state.input ?? null,
              timestamp: ts,
              model: mModel,
            }),
          );
          const output = state.output;
          if (typeof output === "string") {
            messages.push(
              makeMsg({
                role: "tool",
                content: output.slice(0, MAX_TEXT),
                toolName: pd.tool,
                timestamp: ts,
              }),
            );
          }
        } else if (pt === "patch" && Array.isArray(pd.files)) {
          for (const f of pd.files) {
            if (typeof f === "string") patchFiles.add(f);
          }
        }
      }
      textContent = textContent.trim().slice(0, MAX_TEXT);
      if (!textContent && role === "assistant") continue;
      if (!textContent) continue;
      const msg = makeMsg({ role, content: textContent, timestamp: ts, model: mModel });
      if (tokensRaw) msg.tokens = { ...tokensRaw, cacheRead: 0, cacheWrite: 0 };
      messages.push(msg);
    }

    if (messages.length === 0) continue;
    const session = buildSession({
      id: row.id,
      source: toolId,
      sourceVersion: row.version,
      projectPath: row.worktree ?? row.directory,
      startedAt: isoFromMs(row.time_created),
      endedAt: isoFromMs(row.time_updated),
      messages,
      rawMeta: {
        title: row.title,
        cost: row.cost,
        additions: row.summary_additions,
        deletions: row.summary_deletions,
        filesChanged: row.summary_files,
        ...(patchFiles.size > 0 ? { patchFiles: [...patchFiles] } : {}),
      },
    });
    if ((row.tokens_input || row.tokens_output) && model) {
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      if (lastAssistant && !lastAssistant.tokens) {
        lastAssistant.tokens = {
          input: row.tokens_input ?? 0,
          output: row.tokens_output ?? 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }
    }
    yield {
      kind: "session",
      sourceFile: `${file}#${row.id}`,
      rev: Number(row.time_updated ?? row.time_created ?? 0),
      session,
    };
  }
}

function extractOpencodeTokens(v: unknown): { input: number; output: number } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const input = o.input ?? o.inputs;
  const output = o.output ?? o.outputs;
  if (typeof input === "number" || typeof output === "number") {
    return {
      input: typeof input === "number" ? input : 0,
      output: typeof output === "number" ? output : 0,
    };
  }
  return undefined;
}
