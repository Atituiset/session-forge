import { Command } from "commander";
import {
  aggregateByProject,
  aggregateByTime,
  blackholes,
  byModel,
  topFiles,
  totals,
} from "./analytics/index.ts";
import { discoverAndIngest } from "./discovery.ts";
import type { IntentTag } from "./llm_enrich/intent.ts";
import { llmClassify, ruleClassify } from "./llm_enrich/intent.ts";
import { formatTokens, shortPath } from "./output/format.ts";
import { renderKnowledgeBase } from "./output/markdown.ts";
import { bar, renderTable } from "./output/terminal.ts";
import type { StoredSession } from "./store.ts";
import { defaultStorePath, Store } from "./store.ts";
import { LocalTransport } from "./transport/local.ts";
import { SshTransport } from "./transport/ssh.ts";
import { toClaudeCode } from "./writers/claude_code.ts";
import { toCodexRollout } from "./writers/codex_rollout.ts";
import { renderHandoff } from "./writers/handoff_md.ts";

const program = new Command();

program
  .name("session-forge")
  .description("Aggregate AI coding agent sessions into searchable, reusable knowledge assets")
  .version("0.1.0");

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
      let rows = store.allSessions();
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
    const store = new Store(opts.db);
    try {
      const rows = blackholes(store.allSessions(), Number.parseInt(opts.threshold, 10));
      if (rows.length === 0) {
        console.log(`No sessions with >= ${opts.threshold} rounds.`);
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
              "⚠",
            ]),
        ),
      );
      console.log(`\n${rows.length} blackhole sessions (>= ${opts.threshold} rounds)`);
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
    const store = new Store(opts.db);
    try {
      const rows = store.allSessions();
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
      await Bun.write(out, renderKnowledgeBase(rows, opts.granularity as "day" | "week" | "month"));
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
  .action(async (opts: { db: string; llm?: boolean; limit: string }) => {
    const store = new Store(opts.db);
    try {
      const rows = store.allSessions();
      const apiKey = process.env.ANTHROPIC_API_KEY;
      const useLlm = opts.llm === true && Boolean(apiKey);
      if (opts.llm && !apiKey) {
        console.error("ANTHROPIC_API_KEY not set, falling back to rule engine.");
      }
      const limit = Number.parseInt(opts.limit, 10);
      let done = 0;
      let llmOk = 0;
      const counts = new Map<string, number>();
      for (const row of rows.slice(0, limit)) {
        const session = JSON.parse(row.raw) as import("./nir/schema.ts").NirSession;
        const goal =
          session.messages.find((m) => m.role === "user" && m.content.trim().length > 0)?.content ??
          "";
        let tag: IntentTag = ruleClassify(goal);
        if (useLlm) {
          try {
            tag = await llmClassify(goal, { apiKey: apiKey as string });
            llmOk++;
          } catch {
            store.setTags(row.source, row.id, [tag]);
          }
        }
        store.setTags(row.source, row.id, [tag]);
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
        done++;
      }
      console.log(
        `Classified ${done} sessions (${useLlm ? `LLM ok=${llmOk}, fallback=${done - llmOk}` : "rule engine"}).`,
      );
      for (const [tag, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${tag.padEnd(15)} ${n}`);
      }
    } finally {
      store.close();
    }
  });

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

function safeParseFiles(json: string): string[] {
  try {
    return JSON.parse(json) as string[];
  } catch {
    return [];
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

function printReport(rows: StoredSession[], granularity: "day" | "week" | "month"): void {
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
