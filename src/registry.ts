export type PlatformId = "linux" | "darwin" | "win32";

export type ReaderFamily =
  | "codex-family"
  | "claude-code"
  | "opencode-sqlite"
  | "antigravity-transcript"
  | "hermes-sqlite";

export interface ToolSpec {
  id: string;
  family: ReaderFamily;
  paths: Partial<Record<PlatformId, string[]>>;
}

export interface Candidate {
  toolId: string;
  family: ReaderFamily;
  pattern: string;
}

export interface ResolveOptions {
  homeDir: string;
  wslHostUserDirs?: string[];
  /**
   * The reverse direction: engine runs on Windows and reaches INTO WSL
   * distros via UNC (\\wsl.localhost\<distro>\home\<user>). Each entry's
   * label becomes the machine suffix: `${toolId}@wsl-<distro>`.
   */
  wslGuestUserDirs?: { label: string; dir: string }[];
}

const everyPlatform = (patterns: string[]): Partial<Record<PlatformId, string[]>> => ({
  linux: patterns,
  darwin: patterns,
  win32: patterns,
});

export const TOOLS: ToolSpec[] = [
  {
    id: "claude-code",
    family: "claude-code",
    paths: everyPlatform(["~/.claude/projects/*/*.jsonl"]),
  },
  {
    id: "codex",
    family: "codex-family",
    paths: everyPlatform(["~/.codex/session_index.jsonl", "~/.codex/sessions/**/*.jsonl"]),
  },
  {
    id: "kimi-code",
    family: "codex-family",
    paths: everyPlatform(["~/.kimi-code/session_index.jsonl", "~/.kimi-code/sessions/**/*.jsonl"]),
  },
  {
    id: "deepseek",
    family: "codex-family",
    paths: everyPlatform(["~/.deepseek/sessions/**/*.jsonl"]),
  },
  {
    id: "codewhale",
    family: "codex-family",
    paths: everyPlatform(["~/.codewhale/sessions/*.json"]),
  },
  {
    id: "opencode",
    family: "opencode-sqlite",
    paths: {
      linux: ["~/.local/share/opencode/opencode.db"],
      darwin: ["~/.local/share/opencode/opencode.db"],
      win32: ["~/.local/share/opencode/opencode.db", "~/AppData/Local/opencode/opencode.db"],
    },
  },
  {
    id: "gemini-antigravity",
    family: "antigravity-transcript",
    paths: everyPlatform([
      "~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript.jsonl",
    ]),
  },
  {
    id: "hermes",
    family: "hermes-sqlite",
    paths: {
      linux: ["~/.hermes/state.db"],
      darwin: ["~/.hermes/state.db"],
      win32: ["~/.hermes/state.db"],
    },
  },
];

export function expandHome(pattern: string, homeDir: string): string {
  const base = homeDir.replace(/\/+$/, "");
  if (pattern === "~") return base;
  if (pattern.startsWith("~/")) return `${base}/${pattern.slice(2)}`;
  return pattern;
}

function candidatesFor(spec: ToolSpec, platform: PlatformId, opts: ResolveOptions): Candidate[] {
  const out: Candidate[] = [];
  for (const raw of spec.paths[platform] ?? []) {
    out.push({ toolId: spec.id, family: spec.family, pattern: expandHome(raw, opts.homeDir) });
  }
  if (opts.wslHostUserDirs) {
    for (const dir of opts.wslHostUserDirs) {
      for (const raw of spec.paths.linux ?? []) {
        if (raw.startsWith("~/")) {
          out.push({
            toolId: `${spec.id}@windows-host`,
            family: spec.family,
            pattern: `${dir}/${raw.slice(2)}`,
          });
        }
      }
    }
  }
  if (opts.wslGuestUserDirs) {
    // WSL guests run the linux variants of every tool — reuse the linux
    // path table against each distro user directory.
    for (const { label, dir } of opts.wslGuestUserDirs) {
      for (const raw of spec.paths.linux ?? []) {
        if (!raw.startsWith("~/")) continue;
        // sqlite families (opencode, hermes) over UNC can't lock and must not
        // snapshot-copy: discovery routes them to the wsl-agent scan (wsl.exe
        // + scan-jsonl) instead of the plain reader. The candidate stays so
        // the agent path knows the db location/machine label.
        out.push({
          toolId: `${spec.id}@${label}`,
          family: spec.family,
          pattern: `${dir}/${raw.slice(2)}`,
        });
      }
    }
  }
  return out;
}

export function resolveCandidates(platform: PlatformId, opts: ResolveOptions): Candidate[] {
  // CI/test hook: repoint every pattern at a fixture directory so scans are
  // deterministic and never touch the runner's real home.
  const fixtureRoot = process.env.SESSION_FORGE_TEST_FIXTURES;
  if (fixtureRoot) {
    const out: Candidate[] = [];
    for (const spec of TOOLS) {
      out.push({
        toolId: spec.id,
        family: spec.family,
        pattern: `${fixtureRoot}/${spec.id}${patternSuffixFor(spec.family)}`,
      });
    }
    return out;
  }
  const out: Candidate[] = [];
  for (const spec of TOOLS) {
    out.push(...candidatesFor(spec, platform, opts));
  }
  return out;
}

/** Directories covered by the curated TOOLS list (top-level dot dirs). */
export function knownToolDirs(): Set<string> {
  const dirs = new Set<string>();
  for (const spec of TOOLS) {
    for (const raw of spec.paths.linux ?? []) {
      const m = /^~\/(\.[^/]+)\//.exec(raw);
      if (m?.[1]) dirs.add(m[1]);
    }
  }
  return dirs;
}

export interface CandidateProbe {
  exists(path: string): Promise<boolean>;
  listDir(path: string): Promise<{ name: string; isDirectory: boolean }[] | null>;
}

/**
 * Adaptive discovery: scan a home directory for UNKNOWN agent-cli data
 * directories by signature, instead of relying on the curated TOOLS list
 * alone. Signatures (deliberately strict to avoid false positives):
 *   ~/.x/session_index.jsonl                 → codex-family rollout layout
 *   ~/.x/projects/<slug>/*.jsonl             → claude-code layout
 *   ~/.x/opencode.db                         → opencode sqlite
 * `suffix` carries the machine label for overlays (e.g. "@wsl-Ubuntu").
 */
export async function heuristicCandidatesFor(
  homeDir: string,
  suffix: string,
  probe: CandidateProbe,
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const entries = await probe.listDir(homeDir);
  if (!entries) return out;
  const known = knownToolDirs();
  let inspected = 0;
  for (const e of entries) {
    if (!e.isDirectory || !/^\.[a-z0-9][a-z0-9_-]*$/i.test(e.name)) continue;
    if (known.has(e.name)) continue;
    if (++inspected > 40) break; // pathological homes (hundreds of dotdirs) stay cheap
    const base = `${homeDir}/${e.name}`;
    const toolId = `${e.name.slice(1)}${suffix}`;
    if (await probe.exists(`${base}/session_index.jsonl`)) {
      out.push(
        { toolId, family: "codex-family", pattern: `${base}/session_index.jsonl` },
        { toolId, family: "codex-family", pattern: `${base}/sessions/**/*.jsonl` },
      );
      continue;
    }
    const projects = await probe.listDir(`${base}/projects`);
    if (projects?.some((p) => p.isDirectory)) {
      out.push({ toolId, family: "claude-code", pattern: `${base}/projects/*/*.jsonl` });
      continue;
    }
    if (await probe.exists(`${base}/opencode.db`)) {
      out.push({ toolId, family: "opencode-sqlite", pattern: `${base}/opencode.db` });
      continue;
    }
    // Generic SQLite agent stores. `state.db` with sessions+messages is the
    // shape Hermes uses; it matched none of the three signatures above, so a
    // real corpus lost 44 sessions / 14154 messages to a silently skipped
    // directory. Probing by filename alone would misfire on unrelated state
    // databases, so require the table shape too — a cheap schema check on a
    // local file, and the only way to tell an agent store from a mail cache.
    if (await probe.exists(`${base}/state.db`)) {
      if (await looksLikeAgentStore(`${base}/state.db`)) {
        out.push({ toolId, family: "hermes-sqlite", pattern: `${base}/state.db` });
      }
    }
  }
  return out;
}

/**
 * Does this SQLite file actually hold agent conversations? Reads
 * sqlite_master only — no session rows — so it stays cheap on large stores.
 * Requires both `sessions` and `messages`: that pair is what every
 * conversation-shaped agent DB has, and what a config/state DB lacks.
 */
async function looksLikeAgentStore(file: string): Promise<boolean> {
  const { Database } = await import("bun:sqlite");
  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(file, { readonly: true });
    const rows = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sessions','messages')",
      )
      .all() as { name: string }[];
    return rows.length === 2;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
function patternSuffixFor(family: ReaderFamily): string {
  switch (family) {
    case "claude-code":
      return "/projects/*/*.jsonl";
    case "codex-family":
      return "/sessions/**/*.jsonl";
    case "opencode-sqlite":
      return "/opencode.db";
    case "antigravity-transcript":
      return "/brain/*/.system_generated/logs/transcript.jsonl";
    case "hermes-sqlite":
      return "/state.db";
  }
}
