import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { byModel, totals } from "../analytics/index.ts";
import type { SessionSummary, Store } from "../store.ts";
import { formatTokens } from "./format.ts";

/**
 * Obsidian vault export: one file per project, one file per session, linked
 * with wikilinks. The vault directory is treated as generator-owned — every
 * file in it is rewritten on each run and stale generated files are removed
 * via a manifest, so hand edits do not survive. A footer in every file says
 * as much.
 */

/** A session row plus the bits that only exist in the (possibly huge) raw
 *  NIR payload, pre-extracted by the caller so memory stays bounded. */
export interface VaultRow extends SessionSummary {
  title?: string | null;
  goal?: string | null;
}

const MANIFEST = ".session-forge-manifest.json";
const UNKNOWN = "_unknown";

/** Title/goal digest from a NIR session, tolerating missing/malformed data. */
export function digestOf(session: unknown): { title: string | null; goal: string | null } {
  const out = { title: null as string | null, goal: null as string | null };
  if (!session || typeof session !== "object") return out;
  const s = session as { title?: unknown; messages?: unknown };
  if (typeof s.title === "string" && s.title.trim()) out.title = oneLine(s.title.trim(), 80);
  if (Array.isArray(s.messages)) {
    for (const m of s.messages) {
      if (
        m &&
        typeof m === "object" &&
        (m as { role?: unknown }).role === "user" &&
        typeof (m as { content?: unknown }).content === "string" &&
        ((m as { content: string }).content ?? "").trim()
      ) {
        out.goal = (m as { content: string }).content.trim();
        break;
      }
    }
  }
  return out;
}

/** Extract title/goal per row via the store's raw resolver (inline or
 *  externalized file), one session at a time so multi-MB raws never pile
 *  up in memory. */
export function attachDigests(store: Store, rows: SessionSummary[]): VaultRow[] {
  return rows.map((r) => {
    try {
      return { ...r, ...digestOf(store.getSession(r.source, r.id)) };
    } catch {
      return { ...r };
    }
  });
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return [...flat].length > max ? `${[...flat].slice(0, max).join("")}…` : flat;
}

function clip(s: string, max: number): string {
  return [...s].length > max ? `${[...s].slice(0, max).join("")}\n…(截断)` : s;
}

/** CJK-safe slug: keep unicode letters/numbers, collapse the rest to `-`. */
export function slugify(s: string, max = 40): string {
  const slug = [...s.replace(/[^\p{L}\p{N}]+/gu, "-")]
    .join("")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "session";
}

/** Basename for either path flavor; "" when the path has no usable tail
 *  (e.g. "/", "C:\"), which callers treat as "unknown project". */
function baseName(p: string): string {
  return (
    p
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? ""
  );
}

/** Obsidian vaults sync to Windows (and often OneDrive), so generated file
 *  names must satisfy the strictest common denominator. */
function sanitizeFileName(name: string): string {
  const clean = name
    .replace(/[<>:"|?*]/g, "-")
    .replace(/[. ]+$/, "")
    .trim();
  return clean || UNKNOWN;
}

function machineOf(source: string): string | null {
  const i = source.indexOf("@");
  return i >= 0 ? source.slice(i + 1) : null;
}

function baseTool(source: string): string {
  return source.split("@")[0] ?? source;
}

function idSuffix(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, "").slice(0, 6) || "000000";
}

function yamlValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return null;
    return `[${v.map((x) => JSON.stringify(String(x))).join(", ")}]`;
  }
  return JSON.stringify(String(v));
}

function frontmatter(fields: [string, unknown][]): string {
  const lines = ["---"];
  for (const [k, v] of fields) {
    const rendered = yamlValue(v);
    if (rendered !== null) lines.push(`${k}: ${rendered}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

function parseFiles(filesJson: string): string[] {
  try {
    const arr = JSON.parse(filesJson);
    return Array.isArray(arr) ? arr.filter((f): f is string => typeof f === "string") : [];
  } catch {
    return [];
  }
}

function parseTags(tagsJson: string): string[] {
  try {
    const arr = JSON.parse(tagsJson);
    return Array.isArray(arr) ? arr.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

const FOOTER =
  "\n---\n> 由 session-forge 生成;内容来自本地会话索引,重复导出会覆盖本文件,请勿手改。\n";

function renderSessionFile(row: VaultRow, projectLink: string): string {
  const machine = machineOf(row.source);
  const title = oneLine(row.title ?? row.goal ?? row.id, 80);
  const parts: string[] = [];
  parts.push(
    frontmatter([
      ["source", baseTool(row.source)],
      ["machine", machine],
      ["id", row.id],
      ["project", projectLink],
      ["project_path", row.projectPath],
      ["model", row.model],
      ["started", row.startedAt],
      ["ended", row.endedAt],
      ["tokens_in", row.tokensIn],
      ["tokens_out", row.tokensOut],
      ["tokens_cache", row.tokensCache],
      ["rounds", row.rounds],
      ["additions", row.additions],
      ["deletions", row.deletions],
      ["cost", row.cost],
      ["has_error", row.hasError !== 0],
      ["tags", parseTags(row.tagsJson)],
    ]),
  );
  parts.push(`# ${title}\n`);
  if (row.goal) {
    parts.push("## 目标\n");
    parts.push(`${clip(row.goal, 500)}\n`);
  }
  parts.push("## 统计\n");
  parts.push("| 指标 | 数值 |");
  parts.push("|:---|---:|");
  parts.push(`| Token(in/out) | ${formatTokens(row.tokensIn)} / ${formatTokens(row.tokensOut)} |`);
  if (row.tokensCache > 0) parts.push(`| 其中 cache | ${formatTokens(row.tokensCache)} |`);
  parts.push(`| 交互轮次 | ${row.rounds} |`);
  parts.push(`| 代码变更 | +${row.additions} / -${row.deletions} |`);
  if (row.cost !== null && row.cost > 0) parts.push(`| 费用估算 | $${row.cost.toFixed(4)} |`);
  parts.push("");
  const files = parseFiles(row.filesJson);
  if (files.length > 0) {
    parts.push("## 修改文件\n");
    for (const f of files.slice(0, 30)) parts.push(`- \`${f}\``);
    if (files.length > 30) parts.push(`- … 共 ${files.length} 个`);
    parts.push("");
  }
  return parts.join("\n") + FOOTER;
}

interface ProjectGroup {
  name: string;
  paths: Set<string>;
  rows: VaultRow[];
}

function groupByProject(rows: VaultRow[]): Map<string, ProjectGroup> {
  const byPath = new Map<string, VaultRow[]>();
  for (const r of rows) {
    // Paths with no usable tail ("/", "C:\") carry no project meaning; treat
    // them like a null projectPath so they don't become a file named "/".
    const key = r.projectPath && baseName(r.projectPath) ? r.projectPath : "";
    const list = byPath.get(key) ?? [];
    list.push(r);
    byPath.set(key, list);
  }
  // Deterministic naming: sort by path so collisions resolve the same way on
  // every run; later same-named paths get -2, -3, …
  const used = new Set<string>();
  const groups = new Map<string, ProjectGroup>();
  for (const key of [...byPath.keys()].sort()) {
    const list = byPath.get(key) ?? [];
    let name = key ? sanitizeFileName(baseName(key)) : UNKNOWN;
    if (used.has(name)) {
      let i = 2;
      while (used.has(`${name}-${i}`)) i++;
      name = `${name}-${i}`;
    }
    used.add(name);
    groups.set(key, { name, paths: new Set(key ? [key] : []), rows: list });
  }
  return groups;
}

function sessionFileBase(row: VaultRow): string {
  const date = (row.startedAt ?? row.endedAt ?? "").slice(0, 10) || "undated";
  const title = row.title ?? row.goal ?? "session";
  return `${date}_${slugify(oneLine(title, 40))}_${idSuffix(row.id)}`;
}

function renderProjectFile(group: ProjectGroup, links: { base: string; row: VaultRow }[]): string {
  const rows = group.rows;
  const tokensIn = rows.reduce((s, r) => s + r.tokensIn, 0);
  const tokensOut = rows.reduce((s, r) => s + r.tokensOut, 0);
  const additions = rows.reduce((s, r) => s + r.additions, 0);
  const deletions = rows.reduce((s, r) => s + r.deletions, 0);
  const dates = rows
    .map((r) => r.startedAt ?? r.endedAt)
    .filter((d): d is string => typeof d === "string" && d.length > 0)
    .sort();
  const sources = [...new Set(rows.map((r) => r.source))].sort();

  const parts: string[] = [];
  parts.push(
    frontmatter([
      ["path", group.paths.size ? [...group.paths][0] : null],
      ["sources", sources],
      ["sessions", rows.length],
      ["first_activity", dates[0] ?? null],
      ["last_activity", dates[dates.length - 1] ?? null],
      ["tokens_in", tokensIn],
      ["tokens_out", tokensOut],
      ["additions", additions],
      ["deletions", deletions],
    ]),
  );
  parts.push(`# ${group.name}\n`);
  parts.push("| 指标 | 数值 |");
  parts.push("|:---|---:|");
  parts.push(`| 会话数 | ${rows.length} |`);
  parts.push(`| Token(in/out) | ${formatTokens(tokensIn)} / ${formatTokens(tokensOut)} |`);
  parts.push(`| 代码变更 | +${additions} / -${deletions} |`);
  parts.push(`| 来源 | ${sources.map(baseTool).join(", ")} |`);
  parts.push("");
  parts.push("## 会话(按时间倒序)\n");
  const sorted = [...links].sort((a, b) =>
    (b.row.startedAt ?? b.row.endedAt ?? "").localeCompare(a.row.startedAt ?? a.row.endedAt ?? ""),
  );
  for (const { base, row } of sorted) {
    const label = row.title ?? row.goal?.slice(0, 50) ?? row.id.slice(0, 18);
    const when = (row.startedAt ?? row.endedAt ?? "").slice(0, 10) || "?";
    parts.push(
      `- [[${base}|${when} ${oneLine(label, 50)}]] — ${row.source} · ${row.rounds} 轮 · ${formatTokens(row.tokensIn)}`,
    );
  }
  parts.push("");
  return parts.join("\n") + FOOTER;
}

function renderHome(rows: VaultRow[], projectNames: Map<string, ProjectGroup>): string {
  const t = totals(rows);
  const parts: string[] = [];
  parts.push("# AI 开发历史知识库\n");
  parts.push(
    `> 由 session-forge 生成于 ${new Date().toISOString().slice(0, 10)},数据全部来自本地 Agent Session。\n`,
  );
  parts.push("## 总览\n");
  parts.push("| 指标 | 数值 |");
  parts.push("|:---|---:|");
  parts.push(`| 会话总数 | ${t.sessions} |`);
  parts.push(`| 项目数 | ${t.projects} |`);
  parts.push(`| 用户交互轮次 | ${t.rounds} |`);
  parts.push(`| 代码变更 | +${t.additions} / -${t.deletions} |`);
  parts.push(`| Token 消耗(in/out) | ${formatTokens(t.tokensIn)} / ${formatTokens(t.tokensOut)} |`);
  if (t.cost > 0) parts.push(`| 费用估算 | $${t.cost.toFixed(2)} |`);
  parts.push("");

  parts.push("## 项目\n");
  parts.push("| 项目 | 会话 | Token(in) |");
  parts.push("|:---|---:|---:|");
  const groups = [...projectNames.values()].sort(
    (a, b) =>
      b.rows.reduce((s, r) => s + r.tokensIn, 0) - a.rows.reduce((s, r) => s + r.tokensIn, 0),
  );
  for (const g of groups) {
    const tokensIn = g.rows.reduce((s, r) => s + r.tokensIn, 0);
    parts.push(`| [[${g.name}]] | ${g.rows.length} | ${formatTokens(tokensIn)} |`);
  }
  parts.push("");

  const models = byModel(rows);
  if (models.length > 0) {
    parts.push("## 模型使用\n");
    parts.push("| 模型 | 会话数 | Token(in) |");
    parts.push("|:---|---:|---:|");
    for (const m of models)
      parts.push(`| ${m.model} | ${m.sessions} | ${formatTokens(m.tokensIn)} |`);
    parts.push("");
  }
  return parts.join("\n") + FOOTER;
}

/** Render the whole vault as relative path → file content. Pure; the caller
 *  decides where to write it. */
export function renderVault(rows: VaultRow[]): Map<string, string> {
  const files = new Map<string, string>();
  const groups = groupByProject(rows);

  for (const [, group] of groups) {
    const links: { base: string; row: VaultRow }[] = [];
    for (const row of group.rows) {
      let base = sessionFileBase(row);
      let rel = `Sessions/${group.name}/${base}.md`;
      // id6 collisions are vanishingly rare but the map must not silently
      // drop a session; disambiguate deterministically.
      for (let i = 2; files.has(rel); i++) {
        base = `${sessionFileBase(row)}-${i}`;
        rel = `Sessions/${group.name}/${base}.md`;
      }
      files.set(rel, renderSessionFile(row, `[[${group.name}]]`));
      links.push({ base, row });
    }
    files.set(`Projects/${group.name}.md`, renderProjectFile(group, links));
  }
  files.set("Home.md", renderHome(rows, groups));
  return files;
}

export interface VaultWriteResult {
  dir: string;
  written: number;
  removed: number;
}

/** Write a rendered vault to disk and remove files that a previous run
 *  generated but this one did not (tracked via the manifest). Files that
 *  are not in any manifest are never touched. */
export async function writeVault(
  dir: string,
  files: Map<string, string>,
): Promise<VaultWriteResult> {
  let previous: string[] = [];
  try {
    const manifest = JSON.parse(await readFile(join(dir, MANIFEST), "utf8")) as {
      files?: string[];
    };
    previous = manifest.files ?? [];
  } catch {
    // no usable manifest — first run, nothing to clean
  }
  for (const [rel, content] of files) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  const current = new Set(files.keys());
  let removed = 0;
  for (const rel of previous) {
    if (!current.has(rel)) {
      try {
        await rm(join(dir, rel));
        removed++;
      } catch {
        // already gone — fine
      }
    }
  }
  await writeFile(
    join(dir, MANIFEST),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), files: [...current].sort() }, null, 2)}\n`,
  );
  return { dir, written: files.size, removed };
}
