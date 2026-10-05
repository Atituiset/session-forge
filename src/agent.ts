import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
// Imported (not read from disk) so `bun build --compile` inlines the version
// into the binary. A runtime read would fail inside a compiled single-file
// executable, which is exactly where the staleness check below matters most.
import pkg from "../package.json";
import type { Transport } from "./transport/types.ts";

/** Version of this engine/agent build — the yardstick for target staleness. */
export const ENGINE_VERSION: string = typeof pkg.version === "string" ? pkg.version : "0.0.0";

/**
 * Remote agent scanning: when the engine cannot (or must not) read a
 * session store directly — SQLite over UNC (no locks) or over SSH (multi-GB
 * snapshots crash the runtime) — the query runs on the SOURCE machine via
 * our own linux binary (`session-forge scan-jsonl`) and streams back.
 *
 * The agent binary is auto-deployed when missing: the desktop bundle ships a
 * linux-x64 agent as a tauri resource; this module pushes it to the target
 * (~/.local/bin/session-forge) and continues — no manual install step.
 */

export interface AgentChannelApi {
  /** Run a command line on the target, buffered (short outputs). */
  exec(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Stream a command's stdout line-by-line (gigabyte-safe). */
  execStream(
    argv: string[],
    onLine: (line: string) => Promise<void> | void,
  ): Promise<{ exitCode: number; stderr: string }>;
  /** Push the agent binary (local path on the engine machine) to the target. */
  deployAgentBin(localPath: string): Promise<void>;
}

/** Candidate agent locations on the target; $HOME expands guest-side. */
const AGENT_BIN = "$HOME/.local/bin/session-forge";
const AGENT_BIN_ABS = "/.local/bin/session-forge";

export interface WslChannel {
  kind: "wsl";
  distro: string;
}
export interface SshChannel {
  kind: "ssh";
  hostArg: string;
}
export type AgentChannel = WslChannel | SshChannel;

/** Channel for a UNC candidate path (windows engine → WSL guest). */
export function wslChannelFromUnc(uncPath: string): WslChannel | null {
  const m = /^\/\/wsl(?:\.localhost|\$)\/([^/]+)\//.exec(uncPath);
  return m?.[1] ? { kind: "wsl", distro: m[1] } : null;
}

export function channelApi(channel: AgentChannel, transport: Transport): AgentChannelApi {
  if (channel.kind === "wsl") {
    const wsl = (argv: string[]) => ["wsl.exe", "-d", channel.distro, "--", ...argv];
    return {
      exec: async (argv) => {
        const r = await transport.exec?.(wsl(argv));
        return r ?? { exitCode: -1, stdout: "", stderr: "transport cannot exec" };
      },
      execStream: async (argv, onLine) => {
        if (!transport.execStream) return { exitCode: -1, stderr: "transport cannot execStream" };
        return transport.execStream(wsl(argv), onLine);
      },
      deployAgentBin: async (localPath) => {
        // Guest $HOME → UNC copy + chmod. Plain unquoted commands only: the
        // wsl.exe argument forwarder mangles nested quotes (verified on
        // real hardware).
        const home = (await transport.exec?.(wsl(["printenv", "HOME"])))?.stdout.trim();
        if (!home?.startsWith("/")) throw new Error("wsl-agent: cannot resolve guest $HOME");
        const dest = `//wsl.localhost/${channel.distro}${home}${AGENT_BIN_ABS}`;
        mkdirSync(path.dirname(dest), { recursive: true });
        copyFileSync(localPath, dest);
        const chmod = await transport.exec?.(wsl(["chmod", "755", `${home}${AGENT_BIN_ABS}`]));
        if (chmod?.exitCode !== 0) throw new Error("wsl-agent: chmod failed");
      },
    };
  }
  // SSH channel: reuse the transport's own ssh plumbing. Key-auth transports
  // scp the agent; password transports (ssh2) use sftp on the live client.
  const ssh = transport as import("./transport/ssh.ts").SshTransport;
  return {
    exec: async (argv) => {
      const r = await ssh.exec?.(argv);
      return r ?? { exitCode: -1, stdout: "", stderr: "transport cannot exec" };
    },
    execStream: async (argv, onLine) => {
      if (!ssh.execStream) return { exitCode: -1, stderr: "transport cannot execStream" };
      return ssh.execStream(argv, onLine);
    },
    deployAgentBin: async (localPath) => {
      if (typeof (transport as { deployFile?: unknown }).deployFile === "function") {
        // ssh2 password transport
        await (
          transport as unknown as { deployFile: (a: string, b: string) => Promise<void> }
        ).deployFile(localPath, ".local/bin-tmp-session-forge");
      } else {
        const proc = Bun.spawn(
          [
            "scp",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=8",
            localPath,
            `${channel.hostArg}:.session-forge-agent-tmp`,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        const code = await proc.exited;
        if (code !== 0) throw new Error(`scp agent failed (exit ${code})`);
      }
      const mv = await ssh.exec?.([
        "sh",
        "-c",
        "mkdir -p $HOME/.local/bin && mv $HOME/.session-forge-agent-tmp $HOME/.local/bin/session-forge && chmod 755 $HOME/.local/bin/session-forge",
      ]);
      if (mv?.exitCode !== 0) throw new Error("agent install on remote failed");
    },
  };
}

/** Probe the agent on the target; returns the absolute binary path or null. */
export async function probeAgent(api: AgentChannelApi): Promise<string | null> {
  const r = await api.exec(["sh", "-c", `test -x ${AGENT_BIN} && echo ${AGENT_BIN}`]);
  const out = r.stdout.trim();
  return r.exitCode === 0 && out.startsWith("/") ? (out.split("\n")[0] ?? null) : null;
}

/**
 * Version the agent reports on the target, or null if it cannot answer.
 *
 * This exists because `probeAgent` alone is not a sufficient staleness test.
 * A binary from any version satisfies "exists and is executable", so a
 * months-old deployment looked healthy forever: this machine carried agent
 * 0.1.24 since Sep 5 while the desktop app moved to 0.3.0, and because the
 * agent does the actual parsing, its stale agent-session-format produced the
 * numbers the desktop then displayed. The UI showed 4.90 B where the native
 * WSL engine reported 8.73 B — same sessions, old parser.
 */
export async function probeAgentVersion(api: AgentChannelApi): Promise<string | null> {
  const r = await api.exec([AGENT_BIN, "--version"]);
  if (r.exitCode !== 0) return null;
  const m = /(\d+\.\d+\.\d+)/.exec(r.stdout) ?? /(\d+\.\d+\.\d+)/.exec(r.stderr);
  return m?.[1] ?? null;
}

/** Semver-ish compare: >0 when a is newer than b, <0 when older, 0 when equal. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Locate the shipped linux agent binary from the engine's own install. */
export function findBundledLinuxAgent(): string | null {
  const here = path.dirname(process.execPath);
  const candidates = [
    // tauri resource layouts (bundled beside the app binary / in resources)
    path.join(here, "session-forge-linux-x64-agent"),
    path.join(here, "resources", "session-forge-linux-x64-agent"),
    path.join(here, "..", "Resources", "session-forge-linux-x64-agent"),
    // dev checkout / CLI deployments keep cross builds in dist/
    path.join(here, "session-forge-linux-x64"),
    path.join(process.cwd(), "dist", "session-forge-linux-x64"),
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).size > 10_000_000) return c;
    } catch {
      // unreadable — try the next candidate
    }
  }
  return null;
}

/**
 * Ensure the agent is present on the target, auto-deploying from the
 * bundled resource when missing. Returns the absolute agent path or an
 * error message suitable for the scan issues list.
 */
export async function ensureAgent(
  api: AgentChannelApi,
): Promise<{ ok: true; bin: string } | { ok: false; error: string }> {
  const probed = await probeAgent(api);
  // Existence is not enough: a months-old agent parses with whatever
  // agent-session-format it was built against, and the desktop stores those
  // numbers as fact. Redeploy whenever the target is behind us.
  //
  // An unreadable version is NOT treated as stale. A hand-built or truncated
  // agent that works but cannot answer `--version` should keep being used;
  // replacing it with our bundled binary could break a setup we do not
  // understand, and a stale parse is a smaller harm than no scan at all.
  if (probed) {
    const target = await probeAgentVersion(api);
    if (target === null || compareVersions(ENGINE_VERSION, target) <= 0) {
      return { ok: true, bin: probed };
    }
    // Older on the target — fall through and redeploy.
  }
  const bundled = findBundledLinuxAgent();
  if (!bundled) {
    return {
      ok: false,
      error:
        "agent: 目标机没有 session-forge，且本引擎未打包 linux agent 资源（需 ≥0.1.25 的桌面安装包）",
    };
  }
  try {
    await api.deployAgentBin(bundled);
  } catch (err) {
    return { ok: false, error: `agent 自动部署失败: ${String(err).slice(0, 160)}` };
  }
  const again = await probeAgent(api);
  if (!again) return { ok: false, error: "agent: 部署后探测仍失败" };
  return { ok: true, bin: again };
}
