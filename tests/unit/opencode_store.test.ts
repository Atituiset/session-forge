import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NirSession } from "../../src/nir/schema.ts";
import { OpencodeSqliteReader } from "../../src/readers/opencode_sqlite.ts";
import type { ScanEvent } from "../../src/readers/util.ts";
import { Store } from "../../src/store.ts";
import { LocalTransport } from "../../src/transport/local.ts";

const dir = mkdtempSync(path.join(tmpdir(), "sf-test-"));
const dbPath = path.join(dir, "opencode.db");

function seedOpencodeDb(): void {
  const db = new Database(dbPath, { create: true });
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT,
      title TEXT, version TEXT, share_url TEXT, summary_additions INTEGER,
      summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT, revert TEXT,
      permission TEXT, time_created INTEGER, time_updated INTEGER, time_compacting INTEGER,
      time_archived INTEGER, workspace_id TEXT, path TEXT, agent TEXT, model TEXT, cost REAL,
      tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
      tokens_cache_read INTEGER, tokens_cache_write INTEGER, metadata TEXT
    );
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  `);
  db.prepare("INSERT INTO project (id, worktree) VALUES (?, ?)").run("p1", "/home/u/mono");
  db.prepare(
    "INSERT INTO session (id, project_id, title, version, summary_additions, summary_deletions, summary_files, time_created, time_updated, model, cost, tokens_input, tokens_output) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run("ses_1", "p1", "Fix bug", "1.14.0", 42, 7, 2, 1000, 2000, null, 0.5, 900, 300);
  db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)").run(
    "m1",
    "ses_1",
    1000,
    JSON.stringify({ role: "user", time: { created: 1000 } }),
  );
  db.prepare("INSERT INTO part (id, message_id, session_id, data) VALUES (?,?,?,?)").run(
    "pt1",
    "m1",
    "ses_1",
    JSON.stringify({ type: "text", text: "please fix" }),
  );
  db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)").run(
    "m2",
    "ses_1",
    1500,
    JSON.stringify({
      role: "assistant",
      model: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
      tokens: { input: 900, output: 300 },
      cost: 0.4,
      time: { created: 1500 },
    }),
  );
  db.prepare("INSERT INTO part (id, message_id, session_id, data) VALUES (?,?,?,?)").run(
    "pt2",
    "m2",
    "ses_1",
    JSON.stringify({
      type: "tool",
      tool: "edit",
      callID: "c1",
      state: { status: "completed", input: { filePath: "/home/u/mono/a.py" }, output: "ok" },
    }),
  );
  db.prepare("INSERT INTO part (id, message_id, session_id, data) VALUES (?,?,?,?)").run(
    "pt3",
    "m2",
    "ses_1",
    JSON.stringify({ type: "patch", hash: "h", files: ["/home/u/mono/a.py", "/home/u/mono/b.py"] }),
  );
  db.prepare("INSERT INTO part (id, message_id, session_id, data) VALUES (?,?,?,?)").run(
    "pt4",
    "m2",
    "ses_1",
    JSON.stringify({ type: "reasoning", text: "The file only needs a small edit." }),
  );
  db.close();
}

seedOpencodeDb();

async function collect(gen: AsyncGenerator<ScanEvent>): Promise<NirSession[]> {
  const out: NirSession[] = [];
  for await (const e of gen) {
    if (e.kind === "session") out.push(e.session);
  }
  return out;
}

afterAll(() => {
  try {
    require("node:fs").rmSync(dir, { recursive: true, force: true });
  } catch {}
});

function first(sessions: NirSession[]): NirSession {
  const s = sessions[0];
  if (!s) throw new Error("expected at least one session");
  return s;
}

describe("opencode reader", () => {
  test("parses sessions with aggregates and parts", async () => {
    const r = new OpencodeSqliteReader();
    const sessions = await collect(
      r.scan(new LocalTransport(), { toolId: "opencode", files: [dbPath] }),
    );
    expect(sessions).toHaveLength(1);
    const s = first(sessions);
    expect(s.id).toBe("ses_1");
    expect(s.projectPath).toBe("/home/u/mono");
    expect(s.sourceVersion).toBe("1.14.0");
    expect(s.rawMeta.title).toBe("Fix bug");
    expect(s.rawMeta.cost).toBe(0.5);
    expect(s.rawMeta.additions).toBe(42);
    expect(s.rawMeta.patchFiles).toEqual(["/home/u/mono/a.py", "/home/u/mono/b.py"]);
    const userMsg = s.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toBe("please fix");
    const toolMsg = s.messages.find((m) => m.toolName === "edit");
    expect(toolMsg?.toolInput).toEqual({ filePath: "/home/u/mono/a.py" });
    const thinking = s.messages.find((m) => m.thinking);
    expect(thinking?.role).toBe("assistant");
    expect(thinking?.content).toBe("");
    expect(thinking?.thinking).toBe("The file only needs a small edit.");
    const assistant = s.messages.filter((m) => m.role === "assistant").at(-1);
    void assistant;
    const withTokens = s.messages.find((m) => m.tokens);
    expect(withTokens?.tokens?.input).toBe(900);
    expect(withTokens?.model).toBe("deepseek-v4-pro");
  });

  test("flags missing database as issue without throwing", async () => {
    const r = new OpencodeSqliteReader();
    let sawIssue = false;
    for await (const e of r.scan(new LocalTransport(), {
      toolId: "x",
      files: ["/nope/missing.db"],
    })) {
      if (e.kind === "issue") sawIssue = true;
    }
    expect(sawIssue).toBe(true);
  });
});

describe("store", () => {
  test("ingest-format upgrade resets revs once so old data re-ingests", () => {
    const dbPath = path.join(dir, "cache-fmt.db");
    const session: NirSession = {
      id: "fmt1",
      source: "t",
      sourceVersion: null,
      projectPath: null,
      startedAt: null,
      endedAt: null,
      messages: [
        {
          role: "user",
          content: "x",
          timestamp: null,
          toolName: null,
          toolInput: null,
          model: null,
          thinking: null,
        },
      ],
      rawMeta: {},
    };
    const seed = (rev: number, userVersion: number): void => {
      const raw = new Database(dbPath, { create: true });
      raw.exec("PRAGMA journal_mode = WAL");
      const store = new Store(dbPath);
      store.upsert(session, "f", rev);
      store.close();
      raw.exec(`PRAGMA user_version = ${userVersion}`);
      raw.close();
    };
    // Simulate a pre-upgrade database: high rev, no format version recorded.
    seed(99, 0);
    const upgraded = new Store(dbPath);
    // rev was reset → a lower file rev still wins and refreshes the row.
    expect(upgraded.upsert(session, "f", 1).status).toBe("updated");
    upgraded.close();
    const check = new Database(dbPath, { readonly: true });
    expect(
      (check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(2);
    check.close();
    // Second open: format already current → no reset, rev dedup works again.
    const again = new Store(dbPath);
    expect(again.upsert(session, "f", 1).status).toBe("skipped");
    again.close();
  });

  test("upsert dedups by rev and prunes stale", async () => {
    const store = new Store(path.join(dir, "cache.db"));
    const session: NirSession = {
      id: "s1",
      source: "test",
      sourceVersion: null,
      projectPath: "/p",
      startedAt: null,
      endedAt: null,
      messages: [
        {
          role: "user",
          content: "hi",
          timestamp: null,
          toolName: null,
          toolInput: null,
          model: null,
          thinking: null,
        },
      ],
      rawMeta: {},
    };
    expect(store.upsert(session, "f", 1).status).toBe("inserted");
    expect(store.upsert(session, "f", 1).status).toBe("skipped");
    expect(store.upsert(session, "f", 2).status).toBe("updated");
    store.pruneOtherSessions("test", new Set(["other"]));
    expect(store.allSessions()).toHaveLength(0);
    store.close();
  });

  test("findSession resolves by exact id or prefix", async () => {
    const store = new Store(path.join(dir, "cache2.db"));
    const session: NirSession = {
      id: "abc123",
      source: "t",
      sourceVersion: null,
      projectPath: null,
      startedAt: null,
      endedAt: null,
      messages: [
        {
          role: "user",
          content: "x",
          timestamp: null,
          toolName: null,
          toolInput: null,
          model: null,
          thinking: null,
        },
      ],
      rawMeta: {},
    };
    store.upsert(session, "f", 1);
    expect(store.getSession("t", "abc123")?.id).toBe("abc123");
    expect(store.findSession("abc")?.id).toBe("abc123");
    expect(store.findSession("zzz")).toBeNull();
    store.close();
  });
});
