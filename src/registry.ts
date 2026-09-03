export type PlatformId = "linux" | "darwin" | "win32";

export type ReaderFamily =
  | "codex-family"
  | "claude-code"
  | "opencode-sqlite"
  | "antigravity-transcript";

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
        // SQLite over a UNC 9P share can't lock ("database is locked"), and
        // snapshotting multi-GB opencode.db files destabilizes the Windows
        // runtime. JSONL families over UNC are proven fine; opencode via
        // this overlay is deferred — run the WSL-side engine instead.
        if (spec.family === "opencode-sqlite") continue;
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

// Glob shape each reader expects under the fixture root (mirrors the real
// layouts' tail segments).
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
  }
}
