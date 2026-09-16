import type { NirSession } from "../nir/schema.ts";
import type { Transport } from "../transport/types.ts";

// Parsing helpers (makeMsg/buildSession/extractTokens/collectPatchFiles/…)
// moved to the shared `agent-session-format` package; readers here keep only
// the scan contract and the file/transport I/O around the pure parsers.

export type ScanEvent =
  | { kind: "session"; sourceFile: string; rev: number; session: NirSession }
  | { kind: "issue"; path: string; error: string };

export interface FileGroup {
  toolId: string;
  files: string[];
}

export interface Reader {
  readonly family: string;
  scan(transport: Transport, group: FileGroup): AsyncGenerator<ScanEvent>;
}

export async function readTextVia(transport: Transport, filePath: string): Promise<string> {
  if (transport.kind === "local") {
    return Bun.file(filePath).text();
  }
  return transport.readTextFile(filePath);
}

// Stable change-detection value: mtime for local files. On stat failure return
// Date.now() rather than 0 — a forced refresh is safer than a permanent skip
// (rev 0 would pin the session as "unchanged" forever after its first insert).
export async function stableRev(transport: Transport, file: string): Promise<number> {
  if (transport.kind === "local") {
    try {
      const mtime = await Bun.file(file).lastModified;
      return mtime || Date.now();
    } catch {
      return Date.now();
    }
  }
  try {
    if (transport.exec) {
      const r = await transport.exec(["stat", "-c", "%Y", file]);
      const mtime = Number.parseInt(r.stdout.trim(), 10);
      if (r.exitCode === 0 && Number.isFinite(mtime)) return mtime * 1000;
    }
  } catch {}
  return Date.now();
}
