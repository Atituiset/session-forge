import { Database } from "bun:sqlite";
import { createReadStream, createWriteStream, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { opencodeSessionsFromDb } from "agent-session-format";
import type { Transport } from "../transport/types.ts";
import type { FileGroup, Reader, ScanEvent } from "./util.ts";

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
          // SQL → NIR mapping lives in the shared package; bun:sqlite
          // satisfies its injected SqliteDb interface directly.
          const sessions = await opencodeSessionsFromDb(db, { source: group.toolId });
          for (const session of sessions) {
            // endedAt/startedAt are the row's time_updated/time_created as
            // ISO strings; parse back to ms for the rev watermark.
            const rev = Date.parse(session.endedAt ?? session.startedAt ?? "") || 0;
            yield { kind: "session", sourceFile: `${file}#${session.id}`, rev, session };
          }
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
