import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { NirSession } from "./nir/schema.ts";
import { toClaudeCode } from "./writers/claude_code.ts";
import type { ConvertReport } from "./writers/codex_rollout.ts";
import { toCodexRollout } from "./writers/codex_rollout.ts";

/**
 * 接力（relay / projection）：把一个会话投影进另一个 Agent CLI 的原生存储，
 * 让目标 CLI 能直接 resume 继续工作 —— 覆盖“token 耗尽，换 CLI 接力”的场景。
 *
 * 目标支持矩阵：
 *  - codex / kimi-code / deepseek 共用 Codex rollout 布局（一个 writer 覆盖三家）
 *  - claude-code 用 projects/<slug>/<sessionId>.jsonl（sessionId 必须是 UUID，
 *    否则 `claude --resume` 找不到；非 UUID 的源会话在投影时换新 UUID）
 *  刻意不含：
 *  - opencode（SQLite 直写有锁库风险，后续单独做）
 *  - codewhale（`sessions/*.json` 不是 rollout JSONL，需要独立 writer）
 *  - gemini-antigravity（主对话是 Protobuf，无法可靠写入）
 */

export type RelayWriter = "codex" | "claude-code";

export interface RelayTargetSpec {
  id: string;
  writer: RelayWriter;
  /** Tool data dir relative to the user's home (e.g. ".codex"). */
  homeDirLeaf: string;
  resumeHint: (sessionId: string) => string;
}

export const RELAY_TARGETS: RelayTargetSpec[] = [
  {
    id: "codex",
    writer: "codex",
    homeDirLeaf: ".codex",
    resumeHint: (id) => `codex resume  (在列表中选择以 ${id.slice(0, 8)} 开头的会话)`,
  },
  {
    id: "kimi-code",
    writer: "codex",
    homeDirLeaf: ".kimi-code",
    resumeHint: (id) => `kimi 的 resume/会话列表中选择会话 ${id}`,
  },
  {
    id: "deepseek",
    writer: "codex",
    homeDirLeaf: ".deepseek",
    resumeHint: (id) => `deepseek 的 resume/会话列表中选择会话 ${id}`,
  },
  {
    id: "claude-code",
    writer: "claude-code",
    homeDirLeaf: ".claude",
    resumeHint: (id) => `cd <项目目录> && claude --resume ${id}`,
  },
];

export interface RelayOptions {
  /** Override the user home (tests / engine env hook). */
  homeDir?: string;
  /** Overwrite an already-relayed file. */
  force?: boolean;
  /** Append a short handover note as the final user message (default true). */
  withNote?: boolean;
}

export interface RelayResult {
  target: string;
  /** Session id inside the target CLI (may be a fresh UUID for claude-code). */
  sessionId: string;
  files: string[];
  fidelity: ConvertReport["fidelity"];
  messagesConverted: number;
  resumeHint: string;
  notes: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function relaySession(
  session: NirSession,
  targetId: string,
  opts: RelayOptions = {},
): RelayResult {
  const spec = RELAY_TARGETS.find((t) => t.id === targetId);
  if (!spec) {
    throw new Error(
      `不支持的接力目标: ${targetId} (可选: ${RELAY_TARGETS.map((t) => t.id).join(", ")})`,
    );
  }
  if (session.source.split("@")[0] === targetId) {
    throw new Error(`会话本就属于 ${targetId}，无需接力`);
  }

  let projected = session;
  if (spec.writer === "claude-code" && !UUID_RE.test(session.id)) {
    // Claude Code keys sessions by UUID: `claude --resume <uuid>` only finds
    // <uuid>.jsonl. A foreign id (ses_…, rollout-…) must be re-minted.
    projected = { ...projected, id: randomUUID() };
  }
  if (opts.withNote !== false) {
    projected = {
      ...projected,
      messages: [
        ...projected.messages,
        {
          role: "user",
          content:
            `[SessionForge 接力] 本会话由「${session.source}」的会话 ${session.id} 迁移投影而来，` +
            "以上是该任务迄今为止的完整上下文。请在此基础上继续未完成的工作。",
          timestamp: new Date().toISOString(),
          toolName: null,
          toolInput: null,
          model: null,
          thinking: null,
        },
      ],
    };
  }

  const report = spec.writer === "codex" ? toCodexRollout(projected) : toClaudeCode(projected);

  // Engine tests point SESSION_FORGE_RELAY_HOME at a sandbox so a relay never
  // dirties the runner's real ~/.codex etc.
  const home = opts.homeDir ?? process.env.SESSION_FORGE_RELAY_HOME ?? homedir();
  const base = path.join(home, spec.homeDirLeaf);
  const written: string[] = [];
  for (const f of report.files) {
    const dest = path.join(base, f.path);
    if (existsSync(dest) && !opts.force) {
      throw new Error(`目标文件已存在: ${dest}（加 --force 覆盖）`);
    }
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, f.content);
    written.push(dest);
  }

  return {
    target: spec.id,
    sessionId: projected.id,
    files: written,
    fidelity: report.fidelity,
    messagesConverted: report.messagesConverted,
    resumeHint: spec.resumeHint(projected.id),
    notes: report.notes,
  };
}
