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
        token_source TEXT NOT NULL DEFAULT 'none',
        cost REAL,
        rounds INTEGER NOT NULL DEFAULT 0,
        files_json TEXT NOT NULL DEFAULT '[]',
        additions INTEGER NOT NULL DEFAULT 0,
        deletions INTEGER NOT NULL DEFAULT 0,
        has_error INTEGER NOT NULL DEFAULT 0,
        raw TEXT NOT NULL,
        scanned_at INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (source, id)
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);
      CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
    `);
    // Migrations MUST run before any prepared statements reference the new
    // columns — databases created before these columns existed would crash
    // the engine at startup otherwise (seen in the wild on 0.1.4 → 0.1.6).
    for (const ddl of [
      "ALTER TABLE sessions ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE sessions ADD COLUMN token_source TEXT NOT NULL DEFAULT 'none'",
      "ALTER TABLE sessions ADD COLUMN has_error INTEGER NOT NULL DEFAULT 0",
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        // column already exists
      }
    }
    this.upsertStmt = this.db.prepare(
      `INSERT INTO sessions (source, id, rev, project_path, started_at, ended_at, model,
         tokens_in, tokens_out, token_source, cost, rounds, files_json, additions,
         deletions, has_error, raw, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, id) DO UPDATE SET
         rev=excluded.rev, project_path=excluded.project_path, started_at=excluded.started_at,
         ended_at=excluded.ended_at, model=excluded.model, tokens_in=excluded.tokens_in,
         tokens_out=excluded.tokens_out, token_source=excluded.token_source,
         cost=excluded.cost, rounds=excluded.rounds,
         files_json=excluded.files_json, additions=excluded.additions,
         deletions=excluded.deletions, has_error=excluded.has_error,
         raw=excluded.raw, scanned_at=excluded.scanned_at
       WHERE sessions.rev < excluded.rev`,
    );
    this.getRevStmt = this.db.prepare("SELECT rev FROM sessions WHERE source = ? AND id = ?");
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
      stats.tokenSource,
      typeof session.rawMeta.cost === "number" ? session.rawMeta.cost : null,
      stats.rounds,
      JSON.stringify(stats.filesTouched),
      stats.additions,
      stats.deletions,
      stats.hasError ? 1 : 0,
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
    let deleted = 0;
    this.transaction(() => {
      const del = this.db.prepare(
        `DELETE FROM sessions WHERE source = ? AND id IN (${stale.map(() => "?").join(",")})`,
      );
      // Chunk to stay well under SQLITE_MAX_VARIABLE_NUMBER.
      for (let i = 0; i < stale.length; i += 500) {
        deleted += del.run(source, ...stale.slice(i, i + 500)).changes;
      }
    });
    return deleted;
  }

  setTags(source: string, id: string, tags: string[]): void {
    this.db
      .prepare("UPDATE sessions SET tags = ? WHERE source = ? AND id = ?")
      .run(JSON.stringify(tags), source, id);
  }

  allSessions(): StoredSession[] {
    return this.selectSessions("raw") as StoredSession[];
  }

  // Statistics-only variant: skips the potentially huge raw JSON column.
  listSessions(): SessionSummary[] {
    return this.selectSessions("NULL AS raw");
  }

  private selectSessions(rawExpr: string): SessionSummary[] {
    return this.db
      .prepare(
        `SELECT source, id, project_path AS projectPath, started_at AS startedAt, ended_at AS endedAt,` +
          ` model, tokens_in AS tokensIn, tokens_out AS tokensOut, token_source AS tokenSource, cost, rounds,` +
          ` files_json AS filesJson, additions, deletions, has_error AS hasError, tags AS tagsJson, ${rawExpr} FROM sessions`,
      )
      .all() as SessionSummary[];
  }

  listSessionsPage(opts: { limit: number; offset: number; source?: string; q?: string }): {
    sessions: SessionSummary[];
    total: number;
  } {
    const where: string[] = [];
    const params: string[] = [];
    if (opts.source) {
      where.push("source = ?");
      params.push(opts.source);
    }
    if (opts.q) {
      // Escape LIKE wildcards so a query like "a%b" matches literally.
      const pattern = opts.q.replace(/([%_\\])/g, "\\$1");
      where.push("(id LIKE ? ESCAPE '\\' OR project_path LIKE ? ESCAPE '\\')");
      params.push(`%${pattern}%`, `%${pattern}%`);
    }
    const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    const sessions = this.db
      .prepare(
        `SELECT source, id, project_path AS projectPath, started_at AS startedAt, ended_at AS endedAt,` +
          ` model, tokens_in AS tokensIn, tokens_out AS tokensOut, token_source AS tokenSource, cost, rounds,` +
          ` files_json AS filesJson, additions, deletions, has_error AS hasError, tags AS tagsJson, NULL AS raw` +
          ` FROM sessions${whereSql} ORDER BY started_at IS NULL, started_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, opts.limit, opts.offset) as SessionSummary[];
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM sessions${whereSql}`).get(...params) as {
        n: number;
      }
    ).n;
    return { sessions, total };
  }

  getSession(source: string, id: string): NirSession | null {
    const row = this.db
      .prepare("SELECT raw FROM sessions WHERE source = ? AND id = ?")
      .get(source, id) as { raw: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.raw) as NirSession;
  }

  findSession(idOrPrefix: string): NirSession | null {
    // Escape LIKE wildcards so a prefix like "a%b" matches literally.
    const pattern = idOrPrefix.replace(/([%_\\])/g, "\\$1");
    const row = this.db
      .prepare("SELECT raw FROM sessions WHERE id = ? OR id LIKE ? ESCAPE '\\' LIMIT 1")
      .get(idOrPrefix, `${pattern}%`) as { raw: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.raw) as NirSession;
  }

  close(): void {
    this.db.close();
  }
}

export interface SessionSummary {
  source: string;
  id: string;
  projectPath: string | null;
  startedAt: string | null;
  endedAt: string | null;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  tokenSource: "reported" | "estimated" | "none";
  cost: number | null;
  rounds: number;
  filesJson: string;
  additions: number;
  deletions: number;
  hasError: number;
  tagsJson: string;
  raw: string | null;
}

export interface StoredSession extends SessionSummary {
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
