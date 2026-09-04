import { homedir } from "node:os";
import type { DirEntry, ExecResult, HostInfo, PlatformId, Transport } from "./types.ts";

export class SshTransport implements Transport {
  readonly kind = "ssh" as const;
  readonly label: string;
  readonly canExec = true;
  private cachedHost: HostInfo | null = null;

  // Hard ceiling on any single remote command. ConnectTimeout only covers the
  // TCP handshake — without this a hung remote `find`/`cat` would stall a scan
  // (and the serve loop) forever.
  private static readonly EXEC_TIMEOUT_MS = 30_000;

  constructor(
    private readonly hostArg: string,
    displayLabel?: string,
  ) {
    // displayLabel drives the machine suffix in stored sources; hostArg stays
    // the ssh config alias used for the actual connection.
    this.label = `ssh:${displayLabel?.trim() || hostArg}`;
  }

  private baseArgs(extra: string[]): string[] {
    const cmPath = `${homedir()}/.ssh/session-forge-cm-%r@%h-%p`;
    return [
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      "-o",
      "ControlMaster=auto",
      "-o",
      `ControlPath=${cmPath}`,
      "-o",
      "ControlPersist=10m",
      this.hostArg,
      "--",
      ...extra,
    ];
  }

  async exec(argv: string[]): Promise<ExecResult> {
    const proc = Bun.spawn(this.baseArgs(argv), { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), SshTransport.EXEC_TIMEOUT_MS);
    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      return { exitCode, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Line-streaming exec for agent scans: outputs can reach gigabytes, so
   *  nothing may buffer stdout whole. Timeout is generous (connect+scan). */
  async execStream(
    argv: string[],
    onLine: (line: string) => Promise<void> | void,
  ): Promise<{ exitCode: number; stderr: string }> {
    const proc = Bun.spawn(this.baseArgs(argv), { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), 10 * 60_000);
    let stderrTail = "";
    const drainErr = (async () => {
      const reader = proc.stderr.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrTail = (stderrTail + dec.decode(value)).slice(-8_000);
      }
    })();
    try {
      const reader = proc.stdout.getReader();
      const dec = new TextDecoder();
      let buf = "";
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
      return { exitCode, stderr: stderrTail };
    } finally {
      clearTimeout(timer);
    }
  }

  async host(): Promise<HostInfo> {
    if (this.cachedHost) return this.cachedHost;
    const kernel = await this.exec(["uname", "-s"]);
    const home = await this.exec(["printenv", "HOME"]);
    const kernelName = kernel.stdout.trim();
    let platform: PlatformId = "linux";
    if (kernelName === "Darwin") platform = "darwin";
    else if (/^(Windows|MINGW|CYGWIN)/i.test(kernelName)) platform = "win32";
    this.cachedHost = {
      platform,
      homeDir: home.stdout.trim() || "/",
      env: {},
    };
    return this.cachedHost;
  }

  async exists(filePath: string): Promise<boolean> {
    const r = await this.exec(["test", "-e", filePath]);
    return r.exitCode === 0;
  }

  async readTextFile(filePath: string): Promise<string> {
    const r = await this.exec(["cat", filePath]);
    if (r.exitCode !== 0) throw new Error(`ssh cat failed: ${r.stderr.trim().slice(0, 200)}`);
    return r.stdout;
  }

  async readBinaryFile(filePath: string): Promise<Uint8Array> {
    const proc = Bun.spawn(this.baseArgs(["cat", filePath]), {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), SshTransport.EXEC_TIMEOUT_MS);
    try {
      const buf = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
      const code = await proc.exited;
      if (code !== 0) throw new Error(`ssh binary fetch failed (exit ${code})`);
      return buf;
    } finally {
      clearTimeout(timer);
    }
  }

  async listDir(dirPath: string): Promise<DirEntry[] | null> {
    const r = await this.exec(["ls", "-1A", dirPath]);
    if (r.exitCode !== 0) return null;
    return r.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((name) => ({ name, isDirectory: false }));
  }

  async glob(pattern: string): Promise<string[]> {
    const normalized = pattern.replaceAll("\\", "/");
    if (!normalized.includes("*")) {
      return (await this.exists(normalized)) ? [normalized] : [];
    }
    const { base, wholename, maxdepth } = globToFind(normalized);
    const r = await this.exec([
      "find",
      base,
      "-maxdepth",
      String(maxdepth),
      "-type",
      "f",
      "-wholename",
      wholename,
    ]);
    if (r.exitCode !== 0 && r.stdout.trim() === "") {
      const missingBase = r.stderr.includes("No such file");
      if (missingBase) return [];
      throw new Error(`remote find failed: ${r.stderr.trim().slice(0, 200)}`);
    }
    return r.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .sort();
  }

  // One find(1) round trip for all patterns instead of one per pattern.
  async globMany(patterns: string[]): Promise<string[][]> {
    const normalized = patterns.map((p) => p.replaceAll("\\", "/"));
    const groups = normalized.map(() => new Set<string>());
    type Spec = { base: string; wholename: string; maxdepth: number; group: number };
    const specs: Spec[] = normalized.map((pattern, i) => ({
      ...globToFind(pattern),
      group: i,
    }));
    const findArgs: string[] = ["find"];
    const byBase = new Map<string, Spec[]>();
    for (const spec of specs) {
      const list = byBase.get(spec.base) ?? [];
      list.push(spec);
      byBase.set(spec.base, list);
    }
    let first = true;
    for (const [base, baseSpecs] of byBase) {
      const maxdepth = Math.max(...baseSpecs.map((s) => s.maxdepth));
      findArgs.push(first ? base : "-o", "(");
      first = false;
      findArgs.push(base, "-maxdepth", String(maxdepth), "-type", "f", "(");
      baseSpecs.forEach((spec, j) => {
        if (j > 0) findArgs.push("-o");
        findArgs.push("-wholename", spec.wholename);
      });
      findArgs.push(")");
    }
    const r = await this.exec(findArgs);
    if (r.exitCode !== 0 && r.stdout.trim() === "" && !r.stderr.includes("No such file")) {
      throw new Error(`remote find failed: ${r.stderr.trim().slice(0, 200)}`);
    }
    const found = r.stdout.split("\n").filter((line) => line.length > 0);
    for (const line of found) {
      for (const spec of specs) {
        if (wholenameMatches(spec, line)) groups[spec.group]?.add(line);
      }
    }
    return groups.map((set) => [...set].sort());
  }
}

// find(1)'s -wholename uses fnmatch semantics; replicate them client-side so a
// merged multi-pattern find can be attributed back to the right pattern group.
function wholenameMatches(spec: { base: string; wholename: string }, candidate: string): boolean {
  return findWholenameToRegex(spec.wholename).test(candidate);
}

export function findWholenameToRegex(wholename: string): RegExp {
  let out = "";
  for (let i = 0; i < wholename.length; i++) {
    const ch = wholename[i];
    if (ch === undefined) break;
    if (ch === "*")
      out += ".*"; // fnmatch WITHOUT FNM_PATHNAME: * crosses "/"
    else if (ch === "?") out += "[^/]";
    else if (ch === "[") {
      // Copy the bracket expression, translating find's `[!...]` negation to
      // JS `[^...]`.
      const end = wholename.indexOf("]", i + 1);
      if (end === -1) {
        out += "\\[";
      } else {
        let expr = wholename.slice(i, end + 1);
        if (expr.startsWith("[!")) expr = `[^${expr.slice(2)}`;
        out += expr;
        i = end;
      }
    } else out += ch.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function globToFind(pattern: string): { base: string; wholename: string; maxdepth: number } {
  const normalized = pattern.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const baseParts: string[] = [];
  for (const seg of segments) {
    if (seg.includes("*")) break;
    baseParts.push(seg);
  }
  const base = baseParts.join("/") || "/";
  const prefix = baseParts.join("/");
  const rest = segments.slice(baseParts.length);
  if (rest.length === 0) {
    // Literal path (no wildcard segment). Note: `${prefix}/` with an empty
    // rest would append a bogus trailing slash — return the path as-is.
    return { base, wholename: normalized, maxdepth: 0 };
  }
  // `[!/]*` per segment: fnmatch without FNM_PATHNAME would let a bare `*`
  // cross `/`, so the explicit class keeps glob semantics on the remote.
  const translated = rest
    .map((seg) => (seg === "**" ? "*" : seg.replaceAll("*", "[!/]*")))
    .join("/");
  // Cap on how deep a `**` segment will recurse when translated to find(1);
  // deeper layouts would need explicit patterns.
  const MAX_GLOB_DEPTH = 12;
  const maxdepth = rest.some((s) => s === "**") ? MAX_GLOB_DEPTH : rest.length;
  return { base, wholename: `${prefix}/${translated}`, maxdepth };
}
