import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
// Imported (not runtime-read) so the version is inlined by `bun build --compile`.
import pkg from "../package.json";
import {
  aggregateByProject,
  aggregateByTime,
  blackholes,
  byModel,
  topFiles,
  totals,
} from "./analytics/index.ts";
import { discoverAndIngest } from "./discovery.ts";
import { IMPORT_FORMATS, importFile, isImportFormat } from "./import_file.ts";
import type { IntentTag } from "./llm_enrich/intent.ts";
import { llmClassify, ruleClassify } from "./llm_enrich/intent.ts";
import { formatTokens, shortPath } from "./output/format.ts";
import { renderKnowledgeBase } from "./output/markdown.ts";
import { bar, renderTable } from "./output/terminal.ts";
import { filterNewHosts, parseSshConfigHosts, sshConfigPath } from "./ssh_config.ts";
import type { SessionSummary } from "./store.ts";
import { defaultStorePath, Store } from "./store.ts";
import { LocalTransport } from "./transport/local.ts";
import { SshTransport } from "./transport/ssh.ts";
import { SshLibTransport } from "./transport/ssh_lib.ts";
import type { Transport } from "./transport/types.ts";
import { toClaudeCode } from "./writers/claude_code.ts";
import { toCodexRollout } from "./writers/codex_rollout.ts";
import { renderHandoff } from "./writers/handoff_md.ts";

const program = new Command();

program
  .name("session-forge")
  .description("Aggregate AI coding agent sessions into searchable, reusable knowledge assets")
  .version(appVersion());

program
  .command("scan")
  .description("Discover and index AI agent sessions on this machine")
  .option("--db <path>", "cache database path", defaultStorePath())
  .option("--remote <host>", "scan a remote host over SSH instead of local machine")
  .action(async (opts: { db: string; remote?: string }) => {
    const transport = opts.remote ? new SshTransport(opts.remote) : new LocalTransport();
    const store = new Store(opts.db);
    try {
      const report = await discoverAndIngest(transport, store);
      const rows = report.tools.map((t) => [
        t.toolId,
        t.family,
        String(t.files),
        String(t.sessions),
        `+${t.inserted} ~${t.updated} =${t.skipped}`,
        t.issues.length > 0 ? (t.issues[0] ?? "").slice(0, 40) : "",
      ]);
      console.log(
        renderTable(
          [
            { header: "tool" },
            { header: "family" },
            { header: "files", align: "right" },
            { header: "sessions", align: "right" },
            { header: "delta" },
            { header: "notes" },
          ],
          rows,
        ),
      );
      console.log(
        `\nhost: ${report.host.platform} home=${report.host.homeDir}` +
          (report.wslWindowsHostDetected ? " [WSL detected: probing /mnt/c/Users]" : "") +
          `\nduration: ${(report.durationMs / 1000).toFixed(2)}s`,
      );
    } finally {
      store.close();
    }
  });

program
  .command("report")
  .description("Print an aggregated report in the terminal")
  .option("--db <path>", "cache database path", defaultStorePath())
  .option("--project <substr>", "filter sessions by project path substring")
  .option("--granularity <unit>", "day | week | month", "day")
  .action(async (opts: { db: string; project?: string; granularity: string }) => {
    const store = new Store(opts.db);
    try {
      let rows = store.listSessions();
      const filter = opts.project;
      if (filter) {
        rows = rows.filter((r) => (r.projectPath ?? "").includes(filter));
      }
      printReport(rows, opts.granularity as "day" | "week" | "month");
    } finally {
      store.close();
    }
  });

program
  .command("blackholes")
  .description("List sessions with unusually high iteration counts")
  .option("--db <path>", "cache database path", defaultStorePath())
  .option("--threshold <n>", "minimum user rounds", "5")
  .action(async (opts: { db: string; threshold: string }) => {
    const threshold = Number.parseInt(opts.threshold, 10);
    if (!Number.isFinite(threshold) || threshold < 1) {
      console.error(`Invalid --threshold: ${opts.threshold} (expected integer >= 1).`);
      process.exitCode = 1;
      return;
    }
    const store = new Store(opts.db);
    try {
      const rows = blackholes(store.listSessions(), threshold);
      if (rows.length === 0) {
        console.log(`No sessions with >= ${threshold} rounds.`);
        return;
      }
      console.log(
        renderTable(
          [
            { header: "source" },
            { header: "session" },
            { header: "project" },
            { header: "rounds", align: "right" },
            { header: "tokens_in", align: "right" },
            { header: "tokens_src" },
            { header: "errors" },
          ],
          rows
            .slice(0, 25)
            .map((r) => [
              r.source,
              r.id.length > 24 ? `${r.id.slice(0, 21)}…` : r.id,
              shortPath(r.projectPath),
              String(r.rounds),
              formatTokens(r.tokensIn),
              r.tokenSource === "reported"
                ? "reported"
                : r.tokenSource === "estimated"
                  ? "est"
                  : "-",
              r.hasError ? "⚠" : "",
            ]),
        ),
      );
      console.log(`\n${rows.length} blackhole sessions (>= ${threshold} rounds)`);
    } finally {
      store.close();
    }
  });

program
  .command("export")
  .description("Export analysis results as Markdown or JSON")
  .option("--db <path>", "cache database path", defaultStorePath())
  .option("--format <fmt>", "markdown | json", "markdown")
  .option("--out <path>", "output file path")
  .option("--granularity <unit>", "day | week | month", "day")
  .action(async (opts: { db: string; format: string; out?: string; granularity: string }) => {
    const granularity = opts.granularity as "day" | "week" | "month";
    if (granularity !== "day" && granularity !== "week" && granularity !== "month") {
      console.error(`Invalid --granularity: ${opts.granularity} (expected day | week | month).`);
      process.exitCode = 1;
      return;
    }
    const store = new Store(opts.db);
    try {
      const rows = store.listSessions();
      if (rows.length === 0) {
        console.log("No sessions indexed yet. Run `session-forge scan` first.");
        return;
      }
      if (opts.format === "json") {
        const out = opts.out ?? "session-forge-export.json";
        const data = rows.map((r) => ({
          ...r,
          raw: undefined,
          files: safeParseFiles(r.filesJson),
        }));
        await Bun.write(out, JSON.stringify(data, null, 2));
        console.log(`Exported ${rows.length} sessions to ${out}`);
        return;
      }
      const out = opts.out ?? "AI_DEV_HISTORY.md";
      await Bun.write(out, renderKnowledgeBase(rows, granularity));
      console.log(`Knowledge base written to ${out}`);
    } finally {
      store.close();
    }
  });

program
  .command("classify")
  .description("Tag sessions with intent labels (LLM if key available, rules otherwise)")
  .option("--db <path>", "cache database path", defaultStorePath())
  .option("--llm", "force LLM classification (requires ANTHROPIC_API_KEY)")
  .option("--limit <n>", "max sessions to classify", "500")
  .option("--concurrency <n>", "parallel LLM requests", "4")
  .option("--force", "re-classify sessions that already have tags")
  .action(
    async (opts: {
      db: string;
      llm?: boolean;
      limit: string;
      concurrency: string;
      force?: boolean;
    }) => {
      const limit = Number.parseInt(opts.limit, 10);
      if (!Number.isFinite(limit) || limit < 1) {
        console.error(`Invalid --limit: ${opts.limit} (expected integer >= 1).`);
        process.exitCode = 1;
        return;
      }
      const concurrency = Number.parseInt(opts.concurrency, 10);
      if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 32) {
        console.error(`Invalid --concurrency: ${opts.concurrency} (expected integer in [1, 32]).`);
        process.exitCode = 1;
        return;
      }
      const store = new Store(opts.db);
      try {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        const useLlm = opts.llm === true && Boolean(apiKey);
        if (opts.llm && !apiKey) {
          console.error("ANTHROPIC_API_KEY not set, falling back to rule engine.");
        }
        const pending = store
          .listSessions()
          .filter((r) => opts.force || safeParseTags(r.tagsJson ?? "[]").length === 0)
          .slice(0, limit);
        if (pending.length === 0) {
          console.log("Nothing to classify (all sessions already tagged; use --force to redo).");
          return;
        }

        let done = 0;
        let llmOk = 0;
        const counts = new Map<string, number>();
        const classifyRow = async (row: SessionSummary): Promise<void> => {
          let goal = "";
          try {
            // listSessions() does not carry the raw column — load it per row.
            const session = store.getSession(row.source, row.id);
            if (!session) return;
            goal =
              session.messages.find((m) => m.role === "user" && m.content.trim().length > 0)
                ?.content ?? "";
          } catch {
            return; // unreadable raw — leave untagged
          }
          let tag: IntentTag = ruleClassify(goal);
          if (useLlm) {
            try {
              tag = await llmClassify(goal, { apiKey: apiKey as string });
              llmOk++;
            } catch {
              // keep the rule-engine tag on LLM failure
            }
          }
          store.setTags(row.source, row.id, [tag]);
          counts.set(tag, (counts.get(tag) ?? 0) + 1);
          done++;
        };

        // Small worker pool: bounded parallelism without loading all raws at once.
        let cursor = 0;
        const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
          for (;;) {
            const index = cursor++;
            const row = pending[index];
            if (!row) return;
            await classifyRow(row);
          }
        });
        await Promise.all(workers);

        console.log(
          `Classified ${done} of ${pending.length} sessions (${useLlm ? `LLM ok=${llmOk}, fallback=${done - llmOk}` : "rule engine"}).`,
        );
        for (const [tag, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
          console.log(`  ${tag.padEnd(15)} ${n}`);
        }
      } finally {
        store.close();
      }
    },
  );

program
  .command("convert")
  .description("Convert a session into another agent's native format")
  .argument("<session>", "session id (or unique prefix)")
  .requiredOption("--to <target>", "target format: codex | claude-code")
  .option("--db <path>", "cache database path", defaultStorePath())
  .option("--out <dir>", "output directory", "./converted")
  .action(async (sessionId: string, opts: { to: string; db: string; out: string }) => {
    const store = new Store(opts.db);
    try {
      const session = store.findSession(sessionId);
      if (!session) {
        console.error(`Session not found: ${sessionId}`);
        process.exitCode = 1;
        return;
      }
      let report: import("./writers/codex_rollout.ts").ConvertReport;
      if (opts.to === "codex") {
        report = toCodexRollout(session);
      } else if (opts.to === "claude-code") {
        report = toClaudeCode(session);
      } else {
        console.error(`Unknown target: ${opts.to} (supported: codex, claude-code)`);
        process.exitCode = 1;
        return;
      }
      for (const f of report.files) {
        const outPath = `${opts.out.replace(/\/$/, "")}/${f.path}`;
        await Bun.write(outPath, f.content);
        console.log(`wrote ${outPath}`);
      }
      console.log(
        `\nfidelity: ${report.fidelity}` +
          `\nmessages converted: ${report.messagesConverted}` +
          ` (tools mapped: ${report.toolsMapped}, skipped: ${report.toolsSkipped})`,
      );
      for (const note of report.notes.slice(0, 5)) {
        console.log(`note: ${note}`);
      }
      if (opts.to === "codex") {
        console.log(`\ninstall: cp -r ${opts.out}/sessions/* ~/.codex/sessions/`);
      } else {
        console.log(`\ninstall: cp -r ${opts.out}/projects/* ~/.claude/projects/`);
      }
    } finally {
      store.close();
    }
  });

program
  .command("import")
  .description("Import an external agent session file into the store")
  .argument("<path>", "session file to import")
  .requiredOption(
    "--from <format>",
    "source format: claude-code | codex | kimi | codewhale | opencode | antigravity" +
      " (codex-family sub-formats dispatch by file name: kimi needs a wire.jsonl, codewhale a .json, codex a rollout .jsonl)",
  )
  .option("--db <path>", "cache database path", defaultStorePath())
  .action(async (filePath: string, opts: { from: string; db: string }) => {
    if (!isImportFormat(opts.from)) {
      console.error(`Unknown format: ${opts.from} (supported: ${IMPORT_FORMATS.join(", ")})`);
      process.exitCode = 1;
      return;
    }
    const store = new Store(opts.db);
    try {
      const result = await importFile(store, filePath, opts.from);
      for (const issue of result.issues) {
        console.error(`issue: ${issue}`);
      }
      for (const s of result.sessions) {
        console.log(`${s.status.padEnd(9)} ${s.source} ${s.id} (${s.messages} messages)`);
      }
      console.log(
        `\ninserted: ${result.inserted}  updated: ${result.updated}  skipped: ${result.skipped}`,
      );
      if (result.sessions.length === 0) {
        console.error(`No sessions imported from ${filePath}.`);
        process.exitCode = 1;
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      store.close();
    }
  });

program
  .command("serve")
  .description("Run the local data API server (used by desktop panel and ui command)")
  .option("--port <n>", "listen port", "4177")
  .option("--db <path>", "cache database path", defaultStorePath())
  .option("--headless", "suppress console banner")
  .action(async (opts: { port: string; db: string; headless?: boolean }) => {
    const store = new Store(opts.db);
    const transport = new LocalTransport();
    interface ScanJob {
      status: "running" | "ok" | "error";
      startedAt: number;
      finishedAt?: number;
      summary?: unknown;
      error?: string;
    }
    let localJob: ScanJob | null = null;
    const remoteJobs = new Map<string, ScanJob>();
    // Session-only password cache; never written to disk.
    const remotePasswords = new Map<string, string>();
    const setRemotePassword = (name: string, pw?: string): void => {
      if (pw) remotePasswords.set(name, pw);
      else remotePasswords.delete(name);
    };

    // Drop finished remote job entries older than an hour so the map cannot
    // grow without bound over a long-lived server.
    const pruneFinishedJobs = (): void => {
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const [name, job] of remoteJobs) {
        if (job.status !== "running" && (job.finishedAt ?? job.startedAt) < cutoff) {
          remoteJobs.delete(name);
        }
      }
    };

    const runScan = async (transport_: Transport, label: string): Promise<unknown> => {
      const summary = await discoverAndIngest(transport_, store);
      console.error(`[scan] ${label} finished: ${summary.tools.length} tools`);
      return summary;
    };

    // Kicks off the async local scan; the caller polls /api/scan/status.
    const startLocalScan = (): void => {
      localJob = { status: "running", startedAt: Date.now() };
      void runScan(transport, "local")
        .then((summary) => {
          if (localJob?.status === "running") {
            localJob = { ...localJob, status: "ok", finishedAt: Date.now(), summary };
          }
        })
        .catch((err: unknown) => {
          if (localJob?.status === "running") {
            localJob = {
              ...localJob,
              status: "error",
              finishedAt: Date.now(),
              error: String(err).slice(0, 300),
            };
          }
        });
    };

    const handleApi = async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      if (url.pathname === "/api/data") {
        return Response.json(buildDashboardData(store));
      }
      if (url.pathname === "/api/sessions" && req.method === "GET") {
        const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
        const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
        return Response.json(
          store.listSessionsPage({
            limit,
            offset,
            source: url.searchParams.get("source") ?? undefined,
            q: url.searchParams.get("q") ?? undefined,
          }),
        );
      }
      if (url.pathname === "/api/session" && req.method === "GET") {
        const source = url.searchParams.get("source");
        const id = url.searchParams.get("id");
        const session = source && id ? store.getSession(source, id) : null;
        if (!session) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json(session);
      }
      if (url.pathname === "/api/scan" && req.method === "POST") {
        if (localJob?.status === "running") {
          return Response.json({ status: "busy" }, { status: 409 });
        }
        startLocalScan();
        return Response.json({ status: "started" }, { status: 202 });
      }
      if (url.pathname === "/api/scan/status") {
        return Response.json({
          ...(localJob ?? { scanning: false }),
          elapsedMs: localJob?.status === "running" ? Date.now() - localJob.startedAt : 0,
        });
      }
      if (url.pathname === "/api/remotes") {
        if (req.method === "GET") {
          pruneFinishedJobs();
          return Response.json({
            remotes: loadRemotes().map((r) => ({
              name: r.name,
              host: r.host,
              username: r.username,
              hasPassword: remotePasswords.has(r.name),
              addedAt: r.addedAt,
              job: remoteJobs.get(r.name) ?? null,
            })),
          });
        }
        if (req.method === "POST") {
          const body = (await req.json()) as {
            name?: string;
            username?: string;
            password?: string;
          };
          const name = body.name?.trim();
          if (!name || !/^[A-Za-z0-9_.@-]+$/.test(name)) {
            return Response.json(
              { error: "invalid host (allowed: letters digits _ . @ -)" },
              { status: 400 },
            );
          }
          // Parse user@host form into explicit fields.
          let host = name;
          let username = body.username?.trim() || undefined;
          const at = host.lastIndexOf("@");
          if (at > 0) {
            username = username ?? host.slice(0, at);
            host = host.slice(at + 1);
          }
          const remotes = loadRemotes();
          const existing = remotes.find((r) => r.name === name);
          if (existing) {
            existing.username = username;
            existing.host = host;
            saveRemotes(remotes);
            setRemotePassword(name, body.password);
          } else {
            remotes.push({ name, host, username, addedAt: Date.now() });
            saveRemotes(remotes);
            setRemotePassword(name, body.password);
          }
          return Response.json({ ok: true });
        }
      }
      const remoteMatch = url.pathname.match(/^\/api\/remotes\/([^/]+?)(\/scan)?$/);
      if (url.pathname === "/api/remotes/import-ssh" && req.method === "POST") {
        return Response.json(await importSshConfigRemotes());
      }
      if (remoteMatch) {
        const name = decodeURIComponent(remoteMatch[1] ?? "");
        if (req.method === "DELETE") {
          saveRemotes(loadRemotes().filter((r) => r.name !== name));
          remoteJobs.delete(name);
          return Response.json({ ok: true });
        }
        if (url.pathname.endsWith("/scan") && req.method === "POST") {
          if (!loadRemotes().some((r) => r.name === name)) {
            return Response.json({ error: "unknown remote" }, { status: 404 });
          }
          const job = remoteJobs.get(name);
          if (job?.status === "running") {
            return Response.json({ status: "busy" }, { status: 409 });
          }
          remoteJobs.set(name, { status: "running", startedAt: Date.now() });
          void (async () => {
            const started = remoteJobs.get(name);
            try {
              const remote = loadRemotes().find((r) => r.name === name);
              const pw = remotePasswords.get(name);
              const sshTransport =
                pw && remote?.host
                  ? new SshLibTransport({
                      host: remote.host,
                      username: remote.username,
                      password: pw,
                    })
                  : new SshTransport(name);
              const summary = await discoverAndIngest(sshTransport, store);
              if (started?.status === "running") {
                remoteJobs.set(name, {
                  ...started,
                  status: "ok",
                  finishedAt: Date.now(),
                  summary: summary.tools.length,
                });
              }
            } catch (err) {
              if (started?.status === "running") {
                remoteJobs.set(name, {
                  ...started,
                  status: "error",
                  finishedAt: Date.now(),
                  error: String(err).slice(0, 300),
                });
              }
            }
          })();
          return Response.json({ ok: true });
        }
      }
      if (url.pathname === "/api/health") {
        return Response.json({ ok: true, scanning: localJob?.status === "running" });
      }
      return new Response("not found", { status: 404 });
    };

    const server = Bun.serve({
      port: Number.parseInt(opts.port, 10),
      async fetch(req) {
        const origin = req.headers.get("origin");
        if (req.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders(origin) });
        }
        const res = await handleApi(req);
        for (const [k, v] of Object.entries(corsHeaders(origin))) {
          res.headers.set(k, v);
        }
        return res;
      },
    });
    if (!opts.headless) {
      console.log(`SessionForge engine listening on http://127.0.0.1:${server.port}`);
    }
    // Auto-register concrete hosts from ~/.ssh/config as scannable remotes.
    const sshImport = await importSshConfigRemotes();
    if (sshImport.added > 0) {
      console.error(
        `[remotes] auto-imported ${sshImport.added} host(s) from ssh config: ${sshImport.names.join(", ")}`,
      );
    }
    // Periodic re-scan: each cycle re-parses candidates and the store dedups by
    // rev, so unchanged files are skipped; mtime pre-filtering is a future
    // optimization. No per-tick logging — only the usual "[scan] ... finished".
    const autoscanMs = Number(process.env.SESSION_FORGE_AUTOSCAN_MS ?? 90000) || 90000;
    let autoscan: ReturnType<typeof setInterval> | null = null;
    if (process.env.SESSION_FORGE_AUTOSCAN_MS !== "0") {
      autoscan = setInterval(() => {
        if (localJob?.status !== "running") startLocalScan();
      }, autoscanMs);
    }
    let closed = false;
    const shutdown = (): void => {
      if (closed) return;
      closed = true;
      if (autoscan) clearInterval(autoscan);
      try {
        store.close();
      } catch {}
      server.stop(true);
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

function appVersion(): string {
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}

function corsHeaders(origin: string | null): Record<string, string> {
  // Only the desktop webview and same-origin panel may read this API.
  const allowed = origin !== null && originAllowed(origin);
  return {
    "access-control-allow-origin": allowed ? origin : "null",
    vary: "origin",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type",
    // Chromium (WebView2 on Windows) treats http://tauri.localhost →
    // http://127.0.0.1 as a Private Network Access request and blocks it
    // unless the preflight opts in with this header. WebKit (macOS/Linux)
    // does not enforce PNA, which is why the panel only breaks on Windows.
    "access-control-allow-private-network": "true",
  };
}

const ALLOWED_HOSTS = new Set(["tauri.localhost", "ipc.localhost", "127.0.0.1", "localhost"]);

function originAllowed(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol === "tauri:") return true;
    return ALLOWED_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function remotesPath(): string {
  return path.join(path.dirname(defaultStorePath()), "remotes.json");
}

export interface RemoteEntry {
  name: string; // display name / ssh host (may be user@host)
  host: string;
  username?: string;
  /** Only kept in-memory for the running server; never persisted to disk. */
  password?: string;
  addedAt: number;
}

function loadRemotes(): RemoteEntry[] {
  try {
    return JSON.parse(readFileSync(remotesPath(), "utf8")) as RemoteEntry[];
  } catch {
    return [];
  }
}

function saveRemotes(remotes: RemoteEntry[]): void {
  mkdirSync(path.dirname(remotesPath()), { recursive: true });
  // Strip passwords — credentials must not hit the disk.
  writeFileSync(
    remotesPath(),
    JSON.stringify(
      remotes.map(({ password: _pw, ...rest }) => rest),
      null,
      2,
    ),
  );
}

/**
 * Merge concrete Host entries from ~/.ssh/config into the remotes list.
 * Scans connect via `ssh <alias>`, so OpenSSH applies HostName/User/Port/
 * IdentityFile from the config itself — we only register the alias.
 */
async function importSshConfigRemotes(): Promise<{ added: number; names: string[] }> {
  let text: string;
  try {
    text = await Bun.file(sshConfigPath()).text();
  } catch {
    return { added: 0, names: [] };
  }
  const fresh = filterNewHosts(loadRemotes(), parseSshConfigHosts(text));
  if (fresh.length === 0) return { added: 0, names: [] };
  const remotes = loadRemotes();
  for (const h of fresh) {
    remotes.push({ name: h.name, host: h.host, username: h.username, addedAt: Date.now() });
  }
  saveRemotes(remotes);
  return { added: fresh.length, names: fresh.map((h) => h.name) };
}

function buildDashboardData(store: Store): Record<string, unknown> {
  const rows = store.listSessions();
  return {
    generatedAt: new Date().toISOString(),
    totals: totals(rows),
    projects: aggregateByProject(rows, 12),
    activity: aggregateByTime(rows, "day", 42),
    topFiles: topFiles(rows, 12),
    models: byModel(rows),
    blackholes: blackholes(rows, 5)
      .slice(0, 10)
      .map((b) => ({
        source: b.source,
        id: b.id,
        project: b.projectPath,
        rounds: b.rounds,
        tokensIn: b.tokensIn,
      })),
  };
}

function safeParseFiles(json: string): string[] {
  try {
    return JSON.parse(json) as string[];
  } catch {
    return [];
  }
}

function safeParseTags(json: string): string[] {
  const parsed = safeJsonParseLoose(json);
  return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
}

function safeJsonParseLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

program
  .command("handoff")
  .description("Generate a universal Markdown handoff document from a session")
  .argument("<session>", "session id (or unique prefix)")
  .option("--db <path>", "cache database path", defaultStorePath())
  .option("-o, --out <path>", "output file path")
  .action(async (sessionId: string, opts: { db: string; out?: string }) => {
    const store = new Store(opts.db);
    try {
      const session = store.findSession(sessionId);
      if (!session) {
        console.error(`Session not found: ${sessionId}`);
        process.exitCode = 1;
        return;
      }
      const markdown = renderHandoff(session);
      if (opts.out) {
        await Bun.write(opts.out, markdown);
        console.log(`Handoff written to ${opts.out}`);
      } else {
        console.log(markdown);
      }
    } finally {
      store.close();
    }
  });

function printReport(rows: SessionSummary[], granularity: "day" | "week" | "month"): void {
  if (rows.length === 0) {
    console.log("No sessions indexed yet. Run `session-forge scan` first.");
    return;
  }
  const t = totals(rows);
  console.log("═".repeat(64));
  console.log(" SESSIONFORGE REPORT");
  console.log("═".repeat(64));
  console.log(
    ` sessions: ${t.sessions}   projects: ${t.projects}   rounds: ${t.rounds}\n` +
      ` diff: +${t.additions} / -${t.deletions}   tokens(in/out): ${formatTokens(t.tokensIn)} / ${formatTokens(t.tokensOut)}` +
      (t.cost > 0 ? `\n cost estimate: $${t.cost.toFixed(2)}` : ""),
  );

  const projects = aggregateByProject(rows);
  const maxProj = Math.max(...projects.map((p) => p.tokensIn), 1);
  console.log(`\n── TOP PROJECTS (by tokens) ${"─".repeat(24)}`);
  console.log(
    renderTable(
      [
        { header: "project" },
        { header: "source" },
        { header: "sess", align: "right" },
        { header: "+/-", align: "right" },
        { header: "tokens_in", align: "right" },
        { header: "", width: 20 },
      ],
      projects.map((p) => [
        p.project,
        p.source,
        String(p.sessions),
        `+${p.additions}/-${p.deletions}`,
        formatTokens(p.tokensIn),
        bar(p.tokensIn, maxProj, 20),
      ]),
    ),
  );

  const time = aggregateByTime(rows, granularity);
  if (time.length > 0) {
    const maxT = Math.max(...time.map((x) => x.sessions), 1);
    console.log(`\n── ACTIVITY (${granularity}) ${"─".repeat(31)}`);
    for (const b of time.slice(-14)) {
      console.log(`${b.bucket}  ${bar(b.sessions, maxT, 28)} ${b.sessions}`);
    }
  }

  const files = topFiles(rows);
  if (files.length > 0) {
    console.log(`\n── HOT FILES (most edited by AI) ${"─".repeat(21)}`);
    console.log(
      renderTable(
        [{ header: "file" }, { header: "sessions", align: "right" }],
        files.map((f) => [shortPath(f.file), String(f.count)]),
      ),
    );
  }

  const models = byModel(rows);
  if (models.length > 1 || models[0]?.model !== "(unknown)") {
    console.log(`\n── MODELS ${"─".repeat(44)}`);
    console.log(
      renderTable(
        [
          { header: "model" },
          { header: "sessions", align: "right" },
          { header: "tokens_in", align: "right" },
        ],
        models.map((m) => [m.model, String(m.sessions), formatTokens(m.tokensIn)]),
      ),
    );
  }
}

await program.parseAsync(process.argv);
