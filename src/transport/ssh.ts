import type { DirEntry, ExecResult, HostInfo, PlatformId, Transport } from "./types.ts";

export class SshTransport implements Transport {
  readonly kind = "ssh" as const;
  readonly label: string;
  readonly canExec = true;
  private cachedHost: HostInfo | null = null;

  constructor(private readonly hostArg: string) {
    this.label = `ssh:${hostArg}`;
  }

  private baseArgs(extra: string[]): string[] {
    const cmPath = `${process.env.HOME}/.ssh/session-forge-cm-%r@%h-%p`;
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
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
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
    const buf = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    const code = await proc.exited;
    if (code !== 0) throw new Error(`ssh binary fetch failed (exit ${code})`);
    return buf;
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
  const translated = rest
    .map((seg) => (seg === "**" ? "*" : seg.replaceAll("*", "[!/]*")))
    .join("/");
  const maxdepth = rest.some((s) => s === "**") ? 12 : rest.length;
  return { base, wholename: `${prefix}/${translated}`, maxdepth };
}
