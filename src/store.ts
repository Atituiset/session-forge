import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { enrichSession } from "./enrich/index.ts";
import type { NirSession } from "./nir/schema.ts";

export interface UpsertResult {
  status: "inserted" | "updated" | "skipped";
}

export class Store {
  private db: Database;
  private upsertStmt: ReturnType<Database["prepare"]>;
  private getRevStmt: ReturnType<Database["prepare"]>;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
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
        tags TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (source, id)
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);
      CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
    `);
    this.upsertStmt = this.db.prepare(
      `INSERT INTO sessions (source, id, rev, project_path, started_at, ended_at, model,
         tokens_in, tokens_out, cost, rounds, files_json, additions, deletions, raw, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, id) DO UPDATE SET
         rev=excluded.rev, project_path=excluded.project_path, started_at=excluded.started_at,
         ended_at=excluded.ended_at, model=excluded.model, tokens_in=excluded.tokens_in,
         tokens_out=excluded.tokens_out, cost=excluded.cost, rounds=excluded.rounds,
         files_json=excluded.files_json, additions=excluded.additions,
         deletions=excluded.deletions, raw=excluded.raw, scanned_at=excluded.scanned_at`,
    );
    this.getRevStmt = this.db.prepare("SELECT rev FROM sessions WHERE source = ? AND id = ?");
    try {
      this.db.exec("ALTER TABLE sessions ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
    } catch {
      // column already exists
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  upsert(session: NirSession, _sourceFile: string, rev: number): UpsertResult {
    const existing = this.getRevStmt.get(session.source, session.id) as { rev: number } | null;
    if (existing && existing.rev >= rev) return { status: "skipped" };
    const stats = enrichSession(session);
    this.upsertStmt.run(
      session.source,
      session.id,
      rev,
      session.projectPath,
      session.startedAt,
      session.endedAt,
      lastModel(session),
      stats.tokensIn,
      stats.tokensOut,
      typeof session.rawMeta.cost === "number" ? session.rawMeta.cost : null,
      stats.rounds,
      JSON.stringify(stats.filesTouched),
      stats.additions,
      stats.deletions,
      JSON.stringify(session),
      Date.now(),
    );
    return { status: existing ? "updated" : "inserted" };
  }

  pruneOtherSessions(source: string, keepIds: Set<string>): number {
    const rows = this.db.prepare("SELECT id FROM sessions WHERE source = ?").all(source) as {
      id: string;
    }[];
    const stale = rows.filter((r) => !keepIds.has(r.id)).map((r) => r.id);
    if (stale.length === 0) return 0;
    const del = this.db.prepare("DELETE FROM sessions WHERE source = ? AND id = ?");
    for (const id of stale) del.run(source, id);
    return stale.length;
  }

  setTags(source: string, id: string, tags: string[]): void {
    this.db
      .prepare("UPDATE sessions SET tags = ? WHERE source = ? AND id = ?")
      .run(JSON.stringify(tags), source, id);
  }

  allSessions(): StoredSession[] {
    return this.db
      .prepare(
        "SELECT source, id, project_path AS projectPath, started_at AS startedAt, ended_at AS endedAt," +
          " model, tokens_in AS tokensIn, tokens_out AS tokensOut, cost, rounds," +
          " files_json AS filesJson, additions, deletions, raw FROM sessions",
      )
      .all() as StoredSession[];
  }

  getSession(source: string, id: string): NirSession | null {
    const row = this.db
      .prepare("SELECT raw FROM sessions WHERE source = ? AND id = ?")
      .get(source, id) as { raw: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.raw) as NirSession;
  }

  findSession(idOrPrefix: string): NirSession | null {
    const row = this.db
      .prepare("SELECT raw FROM sessions WHERE id = ? OR id LIKE ? LIMIT 1")
      .get(idOrPrefix, `${idOrPrefix}%`) as { raw: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.raw) as NirSession;
  }

  close(): void {
    this.db.close();
  }
}

export interface StoredSession {
  source: string;
  id: string;
  projectPath: string | null;
  startedAt: string | null;
  endedAt: string | null;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  cost: number | null;
  rounds: number;
  filesJson: string;
  additions: number;
  deletions: number;
  raw: string;
}

export function defaultStorePath(): string {
  const root = process.env.SESSION_FORGE_HOME ?? path.join(homedir(), ".session-forge");
  return path.join(root, "cache.db");
}

function lastModel(session: NirSession): string | null {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m?.model) return m.model;
  }
  return null;
}

function _numOrZero(v: unknown): number {
  return typeof v === "number" ? v : 0;
}
