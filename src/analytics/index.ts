import type { SessionSummary } from "../store.ts";

export interface Totals {
  sessions: number;
  projects: number;
  additions: number;
  deletions: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  rounds: number;
}

export interface ProjectAgg {
  project: string;
  source: string;
  sessions: number;
  additions: number;
  deletions: number;
  tokensIn: number;
  rounds: number;
}

export interface TimeAgg {
  bucket: string;
  sessions: number;
  tokensIn: number;
  additions: number;
}

export function totals(rows: SessionSummary[]): Totals {
  const t: Totals = {
    sessions: rows.length,
    projects: 0,
    additions: 0,
    deletions: 0,
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
    rounds: 0,
  };
  const projects = new Set<string>();
  for (const r of rows) {
    if (r.projectPath) projects.add(r.projectPath);
    t.additions += r.additions;
    t.deletions += r.deletions;
    t.tokensIn += r.tokensIn;
    t.tokensOut += r.tokensOut;
    t.cost += r.cost ?? 0;
    t.rounds += r.rounds;
  }
  t.projects = projects.size;
  return t;
}

function normProject(p: string | null): string {
  if (!p) return "(unknown)";
  return p.replace(/\/$/, "").split("/").pop() || p;
}

export function aggregateByProject(rows: SessionSummary[], limit = 15): ProjectAgg[] {
  const map = new Map<string, ProjectAgg>();
  for (const r of rows) {
    const key = `${normProject(r.projectPath)}\t${r.source}`;
    let agg = map.get(key);
    if (!agg) {
      agg = {
        project: normProject(r.projectPath),
        source: r.source,
        sessions: 0,
        additions: 0,
        deletions: 0,
        tokensIn: 0,
        rounds: 0,
      };
      map.set(key, agg);
    }
    agg.sessions++;
    agg.additions += r.additions;
    agg.deletions += r.deletions;
    agg.tokensIn += r.tokensIn;
    agg.rounds += r.rounds;
  }
  return [...map.values()].sort((a, b) => b.tokensIn - a.tokensIn).slice(0, limit);
}

export function aggregateByTime(
  rows: SessionSummary[],
  granularity: "day" | "week" | "month",
  limit = 30,
): TimeAgg[] {
  const map = new Map<string, TimeAgg>();
  for (const r of rows) {
    if (!r.startedAt) continue;
    const d = new Date(r.startedAt);
    if (Number.isNaN(d.getTime())) continue;
    const bucket =
      granularity === "month"
        ? r.startedAt.slice(0, 7)
        : granularity === "week"
          ? weekKey(d)
          : r.startedAt.slice(0, 10);
    let agg = map.get(bucket);
    if (!agg) {
      agg = { bucket, sessions: 0, tokensIn: 0, additions: 0 };
      map.set(bucket, agg);
    }
    agg.sessions++;
    agg.tokensIn += r.tokensIn;
    agg.additions += r.additions;
  }
  return [...map.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)).slice(-limit);
}

export function topFiles(rows: SessionSummary[], limit = 10): { file: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    let files: string[];
    try {
      files = JSON.parse(r.filesJson) as string[];
    } catch {
      continue;
    }
    for (const f of files) {
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([file, count]) => ({ file, count }));
}

export function blackholes(rows: SessionSummary[], threshold: number): SessionSummary[] {
  return rows.filter((r) => r.rounds >= threshold).sort((a, b) => b.rounds - a.rounds);
}

export function byModel(
  rows: SessionSummary[],
): { model: string; sessions: number; tokensIn: number }[] {
  const map = new Map<string, { model: string; sessions: number; tokensIn: number }>();
  for (const r of rows) {
    const key = r.model ?? "(unknown)";
    let agg = map.get(key);
    if (!agg) {
      agg = { model: key, sessions: 0, tokensIn: 0 };
      map.set(key, agg);
    }
    agg.sessions++;
    agg.tokensIn += r.tokensIn;
  }
  return [...map.values()].sort((a, b) => b.tokensIn - a.tokensIn).slice(0, 8);
}

function weekKey(d: Date): string {
  const day = (d.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}
