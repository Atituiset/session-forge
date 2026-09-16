import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { NirSession } from "./nir/schema.ts";
import type { Transport } from "./transport/types.ts";
import { toClaudeCode } from "./writers/claude_code.ts";
import type { ConvertReport } from "./writers/codex_rollout.ts";
import { toCodexRollout } from "./writers/codex_rollout.ts";

/**
 * 接力（relay / projection）：把一个会话投影进另一个 Agent CLI 的原生存储，
 * 让目标 CLI 能直接 resume 继续工作 —— 覆盖“token 耗尽，换 CLI 接力”的场景。
 *
 * 机器路由：投影装到**源会话所在的机器**（relaySessionToMachine）——
 *  - 本地源（source 无 @后缀）→ 本机 ~/.<tool>（同步 relaySession 同理）
 *  - @wsl-<distro>（Windows 引擎扫到的 WSL 会话）→ 经 UNC 写进该 distro 的用户家目录
 *  - @windows-host（WSL 引擎扫到的 Windows 会话）→ 经 /mnt/<drive> 写回 Windows 用户目录
 *  - @<label>（SSH 远程）→ 经 sftp/scp 写到远程 $HOME 下
 * 这样“接力到 claude”生成的 resume 命令在源机器上直接可用。
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
  /** Machine tag the projection was installed to ("local" = the engine itself). */
  machine: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Projection {
  spec: RelayTargetSpec;
  sessionId: string;
  report: ConvertReport;
}

/** Pure part of a relay: pick the writer, mint ids, render the target files. */
function projectSession(session: NirSession, targetId: string, opts: RelayOptions): Projection {
  const spec = RELAY_TARGETS.find((t) => t.id === targetId);
  if (!spec) {
    throw new Error(
      `不支持的接力目标: ${targetId} (可选: ${RELAY_TARGETS.map((t) => t.id).join(", ")})`,
    );
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
          toolCallId: null,
          model: null,
          thinking: null,
          agent: null,
          agentLabel: null,
        },
      ],
    };
  }

  const report = spec.writer === "codex" ? toCodexRollout(projected) : toClaudeCode(projected);
  return { spec, sessionId: projected.id, report };
}

function assembleResult(
  p: Projection,
  written: string[],
  resumeHint: string,
  machine: string,
): RelayResult {
  return {
    target: p.spec.id,
    sessionId: p.sessionId,
    files: written,
    fidelity: p.report.fidelity,
    messagesConverted: p.report.messagesConverted,
    resumeHint,
    notes: p.report.notes,
    machine,
  };
}

/**
 * Synchronous local relay: the projection lands in THIS machine's tool homes
 * regardless of where the source session lives. The panel / CLI prefer the
 * machine-aware relaySessionToMachine; this stays for direct local use.
 */
export function relaySession(
  session: NirSession,
  targetId: string,
  opts: RelayOptions = {},
): RelayResult {
  // Target validity first — an unknown target must outrank the same-tool guard.
  const p = projectSession(session, targetId, opts);
  if (session.source.split("@")[0] === targetId) {
    throw new Error(`会话本就属于 ${targetId}，无需接力`);
  }

  // Engine tests point SESSION_FORGE_RELAY_HOME at a sandbox so a relay never
  // dirties the runner's real ~/.codex etc.
  const home = opts.homeDir ?? process.env.SESSION_FORGE_RELAY_HOME ?? homedir();
  const base = path.join(home, p.spec.homeDirLeaf);
  const written: string[] = [];
  for (const f of p.report.files) {
    const dest = path.join(base, f.path);
    if (existsSync(dest) && !opts.force) {
      throw new Error(`目标文件已存在: ${dest}（加 --force 覆盖）`);
    }
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, f.content);
    written.push(dest);
  }
  return assembleResult(p, written, p.spec.resumeHint(p.sessionId), "local");
}

/* ── 机器感知的接力：投影装到源会话所在的机器 ── */

export type RelayMachine =
  | { kind: "local" }
  | { kind: "wsl"; distro: string }
  | { kind: "windows-host" }
  | { kind: "ssh"; label: string };

/** Derive the machine a session lives on from its source ("codex@wsl-Ubuntu" → wsl:Ubuntu). */
export function relayMachineOfSource(source: string): RelayMachine {
  const at = source.indexOf("@");
  if (at < 0) return { kind: "local" };
  const machine = source.slice(at + 1);
  if (machine.startsWith("wsl-")) return { kind: "wsl", distro: machine.slice(4) };
  if (machine === "windows-host") return { kind: "windows-host" };
  return { kind: "ssh", label: machine };
}

export function relayMachineLabel(machine: RelayMachine): string {
  switch (machine.kind) {
    case "local":
      return "local";
    case "wsl":
      return `wsl-${machine.distro}`;
    case "windows-host":
      return "windows-host";
    case "ssh":
      return machine.label;
  }
}

/** Destination for projected files on one machine. relPath includes the tool
 *  home leaf (".claude/projects/<slug>/<id>.jsonl"). */
export interface RelaySink {
  exists(relPath: string): Promise<boolean>;
  /** Write the file; returns a human-readable absolute destination. */
  write(relPath: string, content: string): Promise<string>;
}

/** Local sink — same behavior as relaySession, async-shaped. */
export function localRelaySink(homeDir: string): RelaySink {
  return {
    exists: async (rel) => existsSync(path.join(homeDir, rel)),
    write: async (rel, content) => {
      const dest = path.join(homeDir, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, content);
      return dest;
    },
  };
}

/**
 * WSL guest sink for a Windows engine: resolve the guest $HOME through
 * wsl.exe, then write over UNC (//wsl.localhost/<distro>/…) with plain fs —
 * command-line length limits rule out piping content through wsl.exe.
 */
export function wslRelaySink(
  distro: string,
  transport: Transport,
  opts?: { uncRoot?: string },
): RelaySink {
  const uncRoot = opts?.uncRoot ?? "//wsl.localhost";
  let cachedHome: string | null = null;
  const home = async (): Promise<string> => {
    if (cachedHome) return cachedHome;
    const r = await transport.exec?.(["wsl.exe", "-d", distro, "--", "printenv", "HOME"]);
    const out = r?.stdout.trim();
    if (r?.exitCode !== 0 || !out?.startsWith("/")) {
      throw new Error(`无法解析 wsl-${distro} 的用户家目录（wsl.exe printenv HOME 失败）`);
    }
    cachedHome = out;
    return out;
  };
  const full = async (rel: string): Promise<string> =>
    path.join(`${uncRoot}/${distro}${await home()}`, rel);
  return {
    exists: async (rel) => existsSync(await full(rel)),
    write: async (rel, content) => {
      const dest = await full(rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, content);
      return dest;
    },
  };
}

/** "C:\\Users\\x" → "/mnt/c/Users/x"（drvfs 挂载约定；非盘符路径返回 null）。 */
export function windowsProfileToMntDir(profile: string): string | null {
  const m = /^([A-Za-z]):[\\/](.+)$/.exec(profile.trim());
  if (!m) return null;
  return `/mnt/${(m[1] ?? "c").toLowerCase()}/${(m[2] ?? "").replace(/\\/g, "/")}`;
}

/**
 * Windows host sink for a WSL engine: resolve %USERPROFILE% via powershell.exe
 * and write through the /mnt/<drive> drvfs mount.
 */
export function windowsHostRelaySink(
  transport: Transport,
  opts?: { profileDir?: string },
): RelaySink {
  let cachedDir: string | null = opts?.profileDir ?? null;
  const profileDir = async (): Promise<string> => {
    if (cachedDir) return cachedDir;
    const r = await transport.exec?.([
      "powershell.exe",
      "-NoProfile",
      "-Command",
      "$env:USERPROFILE",
    ]);
    const dir = r?.exitCode === 0 ? windowsProfileToMntDir(r.stdout) : null;
    if (!dir) {
      throw new Error("无法解析 Windows 主机的用户目录（powershell.exe $env:USERPROFILE 失败）");
    }
    cachedDir = dir;
    return dir;
  };
  const full = async (rel: string): Promise<string> => path.join(await profileDir(), rel);
  return {
    exists: async (rel) => existsSync(await full(rel)),
    write: async (rel, content) => {
      const dest = await full(rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, content);
      return dest;
    },
  };
}

/** sh-quote a single path segment string for remote shells. */
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * SSH remote sink: stage content in a local temp file, push it (sftp via
 * deployFile on password transports, scp otherwise), then mkdir+mv into
 * $HOME guest-side. Large transcripts never cross an argv boundary.
 */
export function sshRelaySink(transport: Transport, opts?: { tmpDir?: string }): RelaySink {
  const stage = (content: string): string => {
    const tmp = path.join(opts?.tmpDir ?? tmpdir(), `sf-relay-${randomUUID()}.stage`);
    writeFileSync(tmp, content);
    return tmp;
  };
  const push = async (tmp: string): Promise<void> => {
    if (typeof (transport as { deployFile?: unknown }).deployFile === "function") {
      await (
        transport as unknown as { deployFile: (a: string, b: string) => Promise<void> }
      ).deployFile(tmp, ".session-forge-relay-stage");
      return;
    }
    const hostArg = transport.label.replace(/^ssh:/, "");
    const proc = Bun.spawn(
      [
        "scp",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        tmp,
        `${hostArg}:.session-forge-relay-stage`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if ((await proc.exited) !== 0) {
      throw new Error(`scp 接力文件失败: ${stderr.slice(0, 160)}`);
    }
  };
  const execOrThrow = async (argv: string[], what: string): Promise<void> => {
    const r = await transport.exec?.(argv);
    if (r?.exitCode !== 0) {
      throw new Error(`${what}失败: ${(r?.stderr ?? "transport cannot exec").slice(0, 160)}`);
    }
  };
  return {
    exists: async (rel) => {
      const r = await transport.exec?.(["sh", "-c", `test -e "$HOME"/${shq(rel)}`]);
      return r?.exitCode === 0;
    },
    write: async (rel, content) => {
      const tmp = stage(content);
      try {
        await push(tmp);
      } finally {
        rmSync(tmp, { force: true });
      }
      await execOrThrow(
        [
          "sh",
          "-c",
          `mkdir -p "$HOME"/${shq(path.dirname(rel))} && mv "$HOME/.session-forge-relay-stage" "$HOME"/${shq(rel)}`,
        ],
        "远程落盘",
      );
      return `${transport.label.replace(/^ssh:/, "")}:~/${rel}`;
    },
  };
}

export interface RelayToMachineOptions extends RelayOptions {
  /** Engine's own transport — drives wsl.exe / powershell.exe channels. */
  localTransport: Transport;
  /** Resolve an ssh machine label to a transport; return null when unknown. */
  sshTransportFor?: (label: string) => Transport | null;
  /** Test hook: bypass the built-in sink resolution. */
  sinkFor?: (machine: RelayMachine) => RelaySink | null | Promise<RelaySink | null>;
}

async function defaultSinkFor(
  machine: RelayMachine,
  opts: RelayToMachineOptions,
): Promise<RelaySink | null> {
  switch (machine.kind) {
    case "local":
      return localRelaySink(opts.homeDir ?? process.env.SESSION_FORGE_RELAY_HOME ?? homedir());
    case "wsl":
      return wslRelaySink(machine.distro, opts.localTransport);
    case "windows-host":
      return windowsHostRelaySink(opts.localTransport);
    case "ssh": {
      const t = opts.sshTransportFor?.(machine.label);
      return t ? sshRelaySink(t) : null;
    }
  }
}

/**
 * Machine-aware relay: the projection is installed on the machine where the
 * SOURCE session lives, so the resume command works there as printed.
 */
export async function relaySessionToMachine(
  session: NirSession,
  targetId: string,
  opts: RelayToMachineOptions,
): Promise<RelayResult> {
  const p = projectSession(session, targetId, opts);
  const machine = relayMachineOfSource(session.source);
  // 同机同工具才是无操作接力；跨机器搬到同一工具（codex@wsl-X → 本机 codex）是合法场景。
  if (machine.kind === "local" && session.source.split("@")[0] === targetId) {
    throw new Error(`会话本就属于 ${targetId}，无需接力`);
  }
  const label = relayMachineLabel(machine);
  const sink = (await opts.sinkFor?.(machine)) ?? (await defaultSinkFor(machine, opts));
  if (!sink) {
    throw new Error(
      `远程机器 ${label} 不在 remotes 列表中（或无法连接），接力文件无处安放；` +
        "可先在面板中添加/检查该远程机器",
    );
  }

  const written: string[] = [];
  for (const f of p.report.files) {
    const rel = `${p.spec.homeDirLeaf}/${f.path}`;
    if ((await sink.exists(rel)) && !opts.force) {
      throw new Error(`目标文件已存在: ${label} 的 ~/${rel}（加 --force 覆盖）`);
    }
    written.push(await sink.write(rel, f.content));
  }
  const hint =
    machine.kind === "local"
      ? p.spec.resumeHint(p.sessionId)
      : `（在 ${label} 上）${p.spec.resumeHint(p.sessionId)}`;
  return assembleResult(p, written, hint, label);
}
