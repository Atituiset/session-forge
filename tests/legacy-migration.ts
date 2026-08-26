// Legacy-schema migration test: the 0.1.6 incident. Seeds a v0.1.4-era
// cache.db (no tags/token_source/has_error columns), then opens it with the
// current Store — must migrate in place, not crash.
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "sf-legacy-"));
const dbPath = path.join(dir, "cache.db");

const seed = new Database(dbPath, { create: true });
seed.exec(`
  CREATE TABLE sessions (
    source TEXT NOT NULL,
    id TEXT NOT NULL,
    rev INTEGER NOT NULL DEFAULT 0,
    project_path TEXT,
    started_at TEXT,
    ended_at TEXT,
    model TEXT,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cost REAL,
    rounds INTEGER NOT NULL DEFAULT 0,
    files_json TEXT NOT NULL DEFAULT '[]',
    additions INTEGER NOT NULL DEFAULT 0,
    deletions INTEGER NOT NULL DEFAULT 0,
    raw TEXT NOT NULL,
    scanned_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (source, id)
  );
  INSERT INTO sessions (source, id, rev, project_path, raw) VALUES
    ('claude-code', 'legacy-1', 1, '/old/project',
     '{"id":"legacy-1","source":"claude-code","sourceVersion":null,"projectPath":"/old/project","startedAt":null,"endedAt":null,"messages":[],"rawMeta":{}}');
`);
seed.close();

// Current Store must open the legacy db without throwing.
const { Store } = await import("../src/store.ts");
const store = new Store(dbPath);
const rows = store.listSessions();
if (rows.length !== 1) throw new Error(`expected 1 legacy session, got ${rows.length}`);
if (rows[0]?.id !== "legacy-1") throw new Error("legacy session data lost");

// New writes on the migrated schema must work.
store.upsert(
  {
    id: "fresh-1",
    source: "claude-code",
    sourceVersion: null,
    projectPath: "/new",
    startedAt: "2026-08-26T00:00:00Z",
    endedAt: null,
    messages: [],
    rawMeta: {},
  },
  "x",
  Date.now(),
);
if (store.listSessions().length !== 2) throw new Error("post-migration upsert failed");
store.close();

console.log("legacy-migration PASSED (in-place migrate + write ok)");
