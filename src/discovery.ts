import { type AgentChannel, channelApi, ensureAgent, wslChannelFromUnc } from "./agent.ts";
import { adapterForSource, resolveProjectRoot } from "./paths.ts";
import { readerFor } from "./readers/index.ts";
import type { Candidate, ReaderFamily } from "./registry.ts";
import { heuristicCandidatesFor, resolveCandidates } from "./registry.ts";
import type { Store } from "./store.ts";
import type { HostInfo, Transport } from "./transport/types.ts";

export interface ToolScanSummary {
  toolId: string;
  family: ReaderFamily;
  transport: string;
  files: number;
  sessions: number;
  inserted: number;
  updated: number;
  skipped: number;
  issues: string[];
}

export interface DiscoveryReport {
  host: HostInfo;
  wslWindowsHostDetected: boolean;
  tools: ToolScanSummary[];
  durationMs: number;
}

export async function discoverAndIngest(
  transport: Transport,
  store: Store,
): Promise<DiscoveryReport> {
  const start = Date.now();
  const host = await transport.host();
  const candidates = await buildCandidates(transport, host);
  const wslDetected = candidates.some((c) => c.toolId.endsWith("@windows-host"));

  const grouped = await groupCandidates(transport, candidates);

  // Groups are independent (store writes happen inside one transaction each);
  // scan them concurrently — biggest win over SSH where every file read is a
  // round trip.
  const entries = [...grouped.entries()];
  const summaries = await Promise.all(
    entries.map(([key, group]) => scanGroup(transport, store, key, group, host)),
  );
  const report: DiscoveryReport = {
    host,
    wslWindowsHostDetected: wslDetected,
    tools: summaries,
    durationMs: Date.now() - start,
  };
  return report;
}

/** Candidate building for streaming scans (scan-jsonl): optionally narrowed
 *  to specific tool ids. Exported for the CLI. */
export async function buildCandidatesFor(
  transport: Transport,
  host: HostInfo,
  only: Set<string> | null,
): Promise<Candidate[]> {
  const all = await buildCandidates(transport, host);
  if (!only) return all;
  return all.filter((c) => {
    const base = c.toolId.split("@")[0] ?? c.toolId;
    return only.has(base);
  });
}

export async function groupCandidatesFor(
  transport: Transport,
  candidates: Candidate[],
): Promise<Map<string, string[]>> {
  return groupCandidates(transport, candidates);
}

async function scanGroup(
  transport: Transport,
  store: Store,
  key: string,
  group: string[],
  host: HostInfo,
): Promise<ToolScanSummary> {
  const [toolId, family] = key.split("|") as [string, ReaderFamily];
  const sourceKey =
    transport.kind === "local" ? toolId : `${toolId}@${transport.label.replace(/^[^:]+:/, "")}`;
  const summary: ToolScanSummary = {
    toolId: sourceKey,
    family,
    transport: transport.label,
    files: group.length,
    sessions: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    issues: [],
  };
  if (group.length === 0) return summary;
  if (process.env.DEBUG_SCAN) {
    console.error(`[scan] ${sourceKey} (${family}): ${group.length} files`);
  }
  const reader = readerFor(family);
  const seenIds = new Set<string>();
  try {
    // SQLite stores cannot be read across the wire: UNC shares give no
    // locks and multi-GB ssh snapshots crash the runtime. Both WSL guests
    // and ssh remotes instead run our agent binary on the source machine
    // (auto-deployed) and stream JSONL back — no cross-machine copying.
    if (family === "opencode-sqlite" && group[0]) {
      const channel = agentChannelForCandidate(transport, group[0]);
      if (channel) {
        return scanGroupViaAgent(transport, store, key, group, channel);
      }
    }
    const events: Extract<import("./readers/util.ts").ScanEvent, { kind: "session" }>[] = [];
    let debugCount = 0;
    for await (const event of reader.scan(transport, { toolId: sourceKey, files: group })) {
      debugCount++;
      if (process.env.DEBUG_SCAN && event.kind === "session" && debugCount % 100 === 0) {
        console.error(`[scan] ${sourceKey}: ${debugCount} events`);
      }
      if (event.kind === "issue") {
        summary.issues.push(`${event.path}: ${event.error}`);
        continue;
      }
      // Aggregate by project ROOT: walk up to the nearest .git so sessions
      // started in subdirs of the same repo land on one card row, and derive
      // the locally reachable twin path for cross-WSL/Windows sources.
      if (event.session.projectPath) {
        const adapter = adapterForSource(sourceKey, host.platform);
        const root = await resolveProjectRoot(transport, adapter, event.session.projectPath);
        const local = adapter.local(root);
        if (root !== event.session.projectPath || (local && local !== root)) {
          event.session = {
            ...event.session,
            projectPath: root,
            rawMeta: {
              ...event.session.rawMeta,
              ...(local && local !== root ? { localPath: local } : {}),
            },
          };
        }
      }
      events.push(event);
      seenIds.add(event.session.id);
      summary.sessions++;
    }
    // Chunked transactions: one giant transaction holding hundreds of
    // sessions (each with potentially MBs of raw JSON) destabilizes the
    // runtime on Windows (observed: bun segfault at ~0.9 GB RSS upserting a
    // 1176-session opencode snapshot). 50 per commit keeps the journal small;
    // a crash mid-ingest still leaves earlier batches committed and the rev
    // dedupe makes a rescan skip them.
    const BATCH = 50;
    for (let i = 0; i < events.length; i += BATCH) {
      const chunk = events.slice(i, i + BATCH);
      store.transaction(() => {
        for (const event of chunk) {
          const result = store.upsert(event.session, event.sourceFile, event.rev);
          summary[result.status]++;
        }
      });
    }
    const pruned = store.pruneOtherSessions(sourceKey, seenIds);
    if (pruned > 0) summary.issues.push(`pruned ${pruned} stale sessions`);
  } catch (err) {
    summary.issues.push(`reader failed: ${String(err)}`);
  }
  return summary;
}

async function groupCandidates(
  transport: Transport,
  candidates: Candidate[],
): Promise<Map<string, string[]>> {
  const grouped = new Map<string, string[]>();
  const seenFiles = new Set<string>();
  const patterns = candidates.map((c) => c.pattern);

  // Batched globbing: one round trip on remote transports, parallel otherwise.
  let results: string[][];
  if (transport.globMany) {
    try {
      results = await transport.globMany(patterns);
    } catch {
      results = await Promise.all(
        patterns.map(async (p) => {
          try {
            return await transport.glob(p);
          } catch {
            return [];
          }
        }),
      );
    }
  } else {
    results = await Promise.all(
      patterns.map(async (p) => {
        try {
          return await transport.glob(p);
        } catch {
          return [];
        }
      }),
    );
  }

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    if (!cand) continue;
    const key = `${cand.toolId}|${cand.family}`;
    for (const f of results[i] ?? []) {
      if (seenFiles.has(f)) continue;
      seenFiles.add(f);
      const list = grouped.get(key) ?? [];
      list.push(f);
      grouped.set(key, list);
    }
    if (!grouped.has(key)) grouped.set(key, []);
  }
  return grouped;
}

async function buildCandidates(transport: Transport, host: HostInfo): Promise<Candidate[]> {
  // Fixture mode must stay deterministic — no self-discovery against the
  // runner's real home directory.
  const adaptive = !process.env.SESSION_FORGE_TEST_FIXTURES;
  const heurScopes: { dir: string; suffix: string }[] = [{ dir: host.homeDir, suffix: "" }];

  let candidates: Candidate[];
  if (host.platform === "win32") {
    // Windows engine: also scan WSL distros over UNC — the reverse of the
    // linux-side /mnt/c overlay. Sources become "<tool>@wsl-<distro>".
    const wslGuestUserDirs = await listWslGuestUsers(transport);
    if (adaptive) {
      for (const g of wslGuestUserDirs) heurScopes.push({ dir: g.dir, suffix: `@${g.label}` });
    }
    candidates = resolveCandidates(host.platform, {
      homeDir: host.homeDir,
      wslGuestUserDirs,
    });
  } else {
    const wslRoot = await detectWslHostUsersRoot(transport, host);
    if (!wslRoot) {
      candidates = resolveCandidates(host.platform, { homeDir: host.homeDir });
    } else {
      const entries = await transport.listDir(wslRoot);
      const userDirs = (entries ?? [])
        .filter((e) => !e.name.includes("."))
        .map((e) => `${wslRoot}/${e.name}`);
      if (adaptive) {
        for (const dir of userDirs) heurScopes.push({ dir, suffix: "@windows-host" });
      }
      candidates = resolveCandidates(host.platform, {
        homeDir: host.homeDir,
        wslHostUserDirs: userDirs,
      });
    }
  }
  if (!adaptive) return candidates;

  const existing = new Set(candidates.map((c) => c.pattern));
  for (const { dir, suffix } of heurScopes) {
    for (const c of await heuristicCandidatesFor(dir, suffix, transport)) {
      if (!existing.has(c.pattern)) {
        existing.add(c.pattern);
        candidates.push(c);
      }
    }
  }
  return candidates;
}

/**
 * Enumerate WSL distro user homes from a Windows host:
 * \\wsl.localhost\<distro>\home\<user>.
 *
 * NOTE: listing the UNC root itself is unreliable (observed ECONNRESET /
 * ENOENT on real machines — the 9P namespace root hangs when the WSL VM is
 * busy), while direct subdir access always works. So the distro list comes
 * from `wsl.exe -l -q` (UTF-16LE output, hence the decode dance) and only
 * per-distro subdirs are listed over UNC.
 */
async function listWslGuestUsers(transport: Transport): Promise<{ label: string; dir: string }[]> {
  const distros = await listWslDistros(transport);
  const out: { label: string; dir: string }[] = [];
  for (const name of distros) {
    const home = `//wsl.localhost/${name}/home`;
    const users = await transport.listDir(home);
    for (const u of users ?? []) {
      if (u.isDirectory && !u.name.startsWith(".")) {
        out.push({ label: `wsl-${name}`, dir: `${home}/${u.name}` });
      }
    }
  }
  return out;
}

/** Which agent channel (if any) a candidate path needs: UNC paths on the
 *  local transport mean WSL guests; ssh transports mean remote machines. */
function agentChannelForCandidate(transport: Transport, firstFile: string): AgentChannel | null {
  if (transport.kind === "local" && /^[\\/]{2}/.test(firstFile)) {
    return wslChannelFromUnc(firstFile);
  }
  if (transport.kind === "ssh") {
    const hostArg = transport.label.replace(/^ssh:/, "");
    return hostArg ? { kind: "ssh", hostArg } : null;
  }
  return null;
}

async function scanGroupViaAgent(
  transport: Transport,
  store: Store,
  key: string,
  group: string[],
  channel: AgentChannel,
): Promise<ToolScanSummary> {
  const [toolId, family] = key.split("|") as [string, ReaderFamily];
  const summary: ToolScanSummary = {
    toolId,
    family,
    transport: channel.kind === "wsl" ? "wsl-agent" : "ssh-agent",
    files: group.length,
    sessions: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    issues: [],
  };
  if (!transport.exec) {
    summary.issues.push("agent: transport cannot exec");
    return summary;
  }

  // Probe; auto-deploy the bundled linux agent when missing.
  const api = channelApi(channel, transport);
  const ensured = await ensureAgent(api);
  if (!ensured.ok) {
    summary.issues.push(ensured.error);
    return summary;
  }

  // Stream the agent's JSONL output line by line — never buffered whole.
  const maxRev = store.maxRevFor(toolId);
  const seenIds = new Set<string>();
  const adapter = adapterForSource(toolId, (await transport.host()).platform);
  const BATCH = 50;
  let batch: { session: NirSessionLike; rev: number }[] = [];
  const flush = () => {
    if (!batch.length) return;
    store.transaction(() => {
      for (const b of batch) {
        const result = store.upsert(b.session, "agent", b.rev);
        summary[result.status]++;
      }
    });
    batch = [];
  };
  const stream = await api.execStream(
    [
      ensured.bin,
      "scan-jsonl",
      "--tools",
      "opencode",
      ...(maxRev > 0 ? ["--since", String(maxRev)] : []),
    ],
    async (line) => {
      const t = line.trim();
      if (!t) return;
      let parsed: { rev?: number; session?: NirSessionLike };
      try {
        parsed = JSON.parse(t);
      } catch {
        summary.issues.push("agent: unparsable line");
        return;
      }
      if (!parsed.session) return;
      summary.sessions++;
      seenIds.add(parsed.session.id);
      // The agent runs on the source machine and stamps sessions with its
      // local source ("opencode"); rebrand to the overlay toolId so rows land
      // under opencode@wsl-<distro> / opencode@<remote> (machine card, rev
      // watermark and prune all key on it).
      if (parsed.session.source !== toolId) {
        parsed.session = { ...parsed.session, source: toolId };
      }
      // Same root/localPath plumbing as the normal scan path. SSH remotes
      // stay native-only (no local twin); WSL guests get the UNC twin.
      if (parsed.session.projectPath) {
        const root = await resolveProjectRoot(transport, adapter, parsed.session.projectPath);
        const local = adapter.local(root);
        if (root !== parsed.session.projectPath || (local && local !== root)) {
          parsed.session = {
            ...parsed.session,
            projectPath: root,
            rawMeta: {
              ...parsed.session.rawMeta,
              ...(local && local !== root ? { localPath: local } : {}),
            },
          };
        }
      }
      batch.push({ session: parsed.session, rev: parsed.rev ?? 0 });
      if (batch.length >= BATCH) flush();
    },
  );
  flush();
  if (stream.exitCode !== 0 && summary.sessions === 0) {
    summary.issues.push(`agent: ${stream.stderr.slice(0, 200) || `exit ${stream.exitCode}`}`);
    return summary;
  }
  // Prune ONLY on full scans: an incremental pass (--since watermark) sees a
  // subset, and pruning to it would wipe every unchanged session.
  if (maxRev === 0) {
    const pruned = store.pruneOtherSessions(toolId, seenIds);
    if (pruned > 0) summary.issues.push(`pruned ${pruned} stale sessions`);
  }
  return summary;
}

type NirSessionLike = import("./nir/schema.ts").NirSession;
const WSL_INFRA_DISTROS = /^docker-desktop(-data)?$/i;

async function listWslDistros(transport: Transport): Promise<string[]> {
  if (!transport.exec) return [];
  try {
    const r = await transport.exec(["wsl.exe", "-l", "-q"]);
    if (r.exitCode !== 0) return [];
    return parseWslDistroList(r.stdout);
  } catch {
    return [];
  }
}

/** Exported for unit tests. wsl.exe prints UTF-16LE on Windows; when piped
 *  through layers that decoded as UTF-8 the NULs survive, which we use to
 *  detect and repair the encoding. */
export function parseWslDistroList(stdout: string): string[] {
  const text = stdout.includes("\0")
    ? new TextDecoder("utf-16le").decode(Uint8Array.from(stdout, (c) => c.charCodeAt(0)))
    : stdout;
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\0/g, "").trim())
    .filter((l) => /^[A-Za-z0-9._-]+$/.test(l) && !WSL_INFRA_DISTROS.test(l));
}

async function detectWslHostUsersRoot(
  transport: Transport,
  host: HostInfo,
): Promise<string | undefined> {
  if (host.platform !== "linux") return undefined;
  const inWsl =
    (host.env.WSL_DISTRO_NAME !== undefined && host.env.WSL_DISTRO_NAME !== "") ||
    (await hasMicrosoftMarker(transport));
  if (!inWsl) return undefined;
  const root = "/mnt/c/Users";
  const entries = await transport.listDir(root);
  if (entries === null) return undefined;
  return root;
}

async function hasMicrosoftMarker(transport: Transport): Promise<boolean> {
  try {
    const version = await transport.readTextFile("/proc/sys/kernel/osrelease");
    return /microsoft/i.test(version);
  } catch {
    return false;
  }
}
