import { readerFor } from "./readers/index.ts";
import type { Candidate, ReaderFamily } from "./registry.ts";
import { resolveCandidates } from "./registry.ts";
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
  const report: DiscoveryReport = {
    host,
    wslWindowsHostDetected: wslDetected,
    tools: [],
    durationMs: 0,
  };

  for (const [key, group] of grouped) {
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
    if (group.length === 0) {
      report.tools.push(summary);
      continue;
    }
    if (process.env.DEBUG_SCAN) {
      console.error(`[scan] ${sourceKey} (${family}): ${group.length} files`);
    }
    const reader = readerFor(family);
    const seenIds = new Set<string>();
    try {
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
        events.push(event);
        seenIds.add(event.session.id);
        summary.sessions++;
      }
      store.transaction(() => {
        for (const event of events) {
          const result = store.upsert(event.session, event.sourceFile, event.rev);
          summary[result.status]++;
        }
      });
      const pruned = store.pruneOtherSessions(sourceKey, seenIds);
      if (pruned > 0) summary.issues.push(`pruned ${pruned} stale sessions`);
    } catch (err) {
      summary.issues.push(`reader failed: ${String(err)}`);
    }
    report.tools.push(summary);
  }

  report.durationMs = Date.now() - start;
  return report;
}

async function groupCandidates(
  transport: Transport,
  candidates: Candidate[],
): Promise<Map<string, string[]>> {
  const grouped = new Map<string, string[]>();
  const seenFiles = new Set<string>();
  for (const cand of candidates) {
    const key = `${cand.toolId}|${cand.family}`;
    let matched: string[];
    try {
      matched = await transport.glob(cand.pattern);
    } catch {
      matched = [];
    }
    for (const f of matched) {
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
  const wslRoot = await detectWslHostUsersRoot(transport, host);
  if (!wslRoot) {
    return resolveCandidates(host.platform, { homeDir: host.homeDir });
  }
  const entries = await transport.listDir(wslRoot);
  const userDirs = (entries ?? [])
    .filter((e) => !e.name.includes("."))
    .map((e) => `${wslRoot}/${e.name}`);
  return resolveCandidates(host.platform, {
    homeDir: host.homeDir,
    wslHostUserDirs: userDirs,
  });
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
