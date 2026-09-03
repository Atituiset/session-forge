import { Database } from "bun:sqlite";
import { createReadStream, createWriteStream, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { NirMessage } from "../nir/schema.ts";
import type { Transport } from "../transport/types.ts";
import type { FileGroup, Reader, ScanEvent } from "./util.ts";
import { buildSession, isoFromMs, makeMsg } from "./util.ts";

const MAX_TEXT = 30_000;

// Per-source-file snapshot bookkeeping (module scope: persists across scans
// within one engine process).
const dbSnapshots = new Map<string, { sig: string }>();

async function signatureOf(transport: Transport, file: string): Promise<string | null> {
  if (transport.kind === "local") {
    try {
      const st = statSync(file);
      return `${st.size}:${Math.trunc(st.mtimeMs)}`;
    } catch {
      return null;
    }
  }
  return null; // remote transports: no cheap stat — always re-copy
}

async function copyDbWithSidecars(transport: Transport, src: string, dest: string): Promise<void> {
  if (transport.kind === "local") {
    // UNC paths are directly fs-accessible for local transports — stream the
    // copy. Buffering a 2.2 GB opencode.db in memory crashed the engine's
    // Bun runtime outright (observed in the Windows→WSL overlay).
    await pipeline(createReadStream(src), createWriteStream(dest));
    for (const suffix of ["-wal", "-shm"]) {
      try {
        await pipeline(createReadStream(src + suffix), createWriteStream(dest + suffix));
      } catch {
        // sidecar absent — fine
      }
    }
    return;
  }
  const bytes = await transport.readBinaryFile(src);
  await Bun.write(dest, bytes);
  for (const suffix of ["-wal", "-shm"]) {
    try {
      await Bun.write(dest + suffix, await transport.readBinaryFile(src + suffix));
    } catch {
      // sidecar absent — fine
    }
  }
}

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
        // Snapshot instead of opening in place when (a) the file is remote,
        // or (b) it is a UNC path (\\wsl.localhost\…, reached by the Windows
        // engine for WSL guests): SQLite needs working file locks, which 9P
        // shares do not provide (observed: "database is locked").
        if (transport.kind !== "local" || /^[\\/]{2}/.test(file)) {
          // Change detection: these databases can be multi-GB; skip the copy
          // when nothing moved since the last successful ingest.
          const sig = await signatureOf(transport, file);
          const prev = dbSnapshots.get(file);
          if (prev && sig && prev.sig === sig) continue;
          tempDir = mkdtempSync(path.join(tmpdir(), "sf-remote-db-"));
          dbFile = path.join(tempDir, "snapshot.db");
          await copyDbWithSidecars(transport, file, dbFile);
          if (sig) dbSnapshots.set(file, { sig });
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
        if (tempDir) {
          // Windows keeps the snapshot file locked briefly after db.close()
          // (SQLite mmap teardown) — rmSync then fails EBUSY, and a throw here
          // would mask any earlier error and abort the whole scan. Retry, then
          // leave the temp dir for the OS rather than poison the ingest.
          for (let i = 0; i < 3; i++) {
            try {
              rmSync(tempDir, { recursive: true, force: true });
              break;
            } catch {
              if (i < 2) await new Promise((r) => setTimeout(r, 150 * (i + 1)));
            }
          }
        }
      }
    }
  }
}

function* scanDb(db: Database, file: string, toolId: string): Generator<ScanEvent> {
  // Stream per-session instead of preloading every message+part into maps:
  // real databases reach multiple GB and the old Map-based accumulation
  // pushed the Bun runtime past its limits (observed: segfault at ~1.7 GB
  // RSS ingesting a 2.2 GB opencode.db snapshot).
  const sessions = db
    .prepare(
      `SELECT s.id, s.directory, s.title, s.version, s.summary_additions, s.summary_deletions,
              s.summary_files, s.time_created, s.time_updated, s.model, s.cost,
              s.tokens_input, s.tokens_output, p.worktree
       FROM session s LEFT JOIN project p ON p.id = s.project_id`,
    )
    .all() as SessionRow[];
  const msgStmt = db.prepare(
    "SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created",
  );
  const partStmt = db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY time_created");

  for (const row of sessions) {
    const messages: NirMessage[] = [];
    const patchFiles = new Set<string>();
    const msgRows = msgStmt.all(row.id) as { id: string; data: string; time_created: number }[];
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
      const partRows = partStmt.all(mr.id) as { data: string }[];
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
        } else if (pt === "reasoning" && typeof pd.text === "string") {
          const thinking = pd.text.trim();
          if (thinking) {
            messages.push(
              makeMsg({
                role: role as NirMessage["role"],
                content: "",
                thinking,
                timestamp: ts,
                model: mModel,
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
