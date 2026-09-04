import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Glob } from "bun";
import type { DirEntry, ExecResult, HostInfo, PlatformId, Transport } from "./types.ts";

export class LocalTransport implements Transport {
  readonly kind = "local" as const;
  readonly label = "local";
  readonly canExec = true;

  async host(): Promise<HostInfo> {
    return {
      platform: normalizePlatform(process.platform),
      homeDir: homedir(),
      env: process.env,
    };
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async readTextFile(filePath: string): Promise<string> {
    return readFile(filePath, "utf8");
  }

  async readBinaryFile(filePath: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(filePath));
  }

  async listDir(dirPath: string): Promise<DirEntry[] | null> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
    } catch {
      return null;
    }
  }

  async glob(pattern: string): Promise<string[]> {
    const normalized = pattern.replaceAll("\\", "/");
    if (!normalized.includes("*")) {
      return (await this.exists(normalized)) ? [normalized] : [];
    }
    const base = staticBase(normalized);
    const rel = path.posix.relative(base, normalized);
    const g = new Glob(rel);
    const out: string[] = [];
    try {
      for await (const p of g.scan({ cwd: base, absolute: true, dot: true, onlyFiles: true })) {
        out.push(p);
      }
    } catch {
      return out;
    }
    return out.sort();
  }

  async exec(argv: string[]): Promise<ExecResult> {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  }

  /** Line-streaming exec: keeps memory flat for gigabyte-scale outputs
   *  (wsl-agent scan-jsonl pipes). */
  async execStream(
    argv: string[],
    onLine: (line: string) => Promise<void> | void,
  ): Promise<{ exitCode: number; stderr: string }> {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const stderrChunks: string[] = [];
    const drainErr = (async () => {
      const reader = proc.stderr.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrChunks.push(dec.decode(value));
        if (stderrChunks.join("").length > 64_000) break;
      }
    })();
    let buf = "";
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    const pending: Promise<void>[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      if (done) {
        buf += dec.decode();
        if (buf.length > 0) await onLine(buf);
        break;
      }
      let nl = buf.indexOf("\n");
      // Drain every complete line; cap backpressure at a few lines so a slow
      // consumer doesn't stall the pipe.
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        const p = onLine(line);
        if (p && typeof p.then === "function") {
          pending.push(p);
          if (pending.length > 8) {
            await Promise.all(pending);
            pending.length = 0;
          }
        }
      }
    }
    await Promise.all(pending);
    await drainErr;
    const exitCode = await proc.exited;
    return { exitCode, stderr: stderrChunks.join("") };
  }
}

function normalizePlatform(p: string): PlatformId {
  if (p === "win32") return "win32";
  if (p === "darwin") return "darwin";
  return "linux";
}

function staticBase(pattern: string): string {
  const segments = pattern.split("/");
  const base: string[] = [];
  for (const seg of segments) {
    if (seg.includes("*")) break;
    base.push(seg);
  }
  if (base.length === 0) return "/";
  const joined = base.join("/");
  return joined.startsWith("/") || /^[A-Za-z]:/.test(joined) ? joined : `/${joined}`;
}
