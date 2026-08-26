import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Client } from "ssh2";
import type { DirEntry, ExecResult, HostInfo, PlatformId, Transport } from "./types.ts";

export interface SshAuth {
  host: string;
  username?: string;
  password?: string;
}

// Pure-JS SSH transport (ssh2). Used when the remote entry carries an explicit
// username/password; unlike spawning the OpenSSH client it works on Windows
// without sshpass and does not depend on pre-configured key auth.
export class SshLibTransport implements Transport {
  readonly kind = "ssh" as const;
  readonly label: string;
  readonly canExec = true;
  private cachedHost: HostInfo | null = null;

  private static readonly TIMEOUT_MS = 30_000;

  constructor(private readonly auth: SshAuth) {
    const userPrefix = auth.username ? `${auth.username}@` : "";
    this.label = `ssh:${userPrefix}${auth.host}`;
  }

  /** Run fn with a connected, ready client; always cleans up. */
  private async withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client();
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        client.end();
        reject(
          new Error(`ssh ${this.auth.host}: timed out after ${SshLibTransport.TIMEOUT_MS / 1000}s`),
        );
      }, SshLibTransport.TIMEOUT_MS);
      client
        .on("ready", () => {
          fn(client)
            .then((v) => {
              clearTimeout(timer);
              client.end();
              resolve(v);
            })
            .catch((err: unknown) => {
              clearTimeout(timer);
              client.end();
              reject(err);
            });
        })
        .on("error", (err: Error) => {
          clearTimeout(timer);
          reject(err);
        })
        .connect({
          host: this.auth.host,
          username: this.auth.username,
          password: this.auth.password,
          tryKeyboard: Boolean(this.auth.password),
          readyTimeout: SshLibTransport.TIMEOUT_MS,
          // Fall back to default key locations when no password is given.
          privateKey: this.auth.password ? undefined : tryReadPrivateKey(),
        });
    });
  }

  private execOne(client: Client, command: string): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) return reject(err);
        let stdout = "";
        let stderr = "";
        stream.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        stream.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        stream.on("close", (code: number | undefined) => {
          resolve({ exitCode: code ?? 1, stdout, stderr });
        });
      });
    });
  }

  async exec(argv: string[]): Promise<ExecResult> {
    const command = argv.map(shellQuote).join(" ");
    return this.withClient((client) => this.execOne(client, command));
  }

  async host(): Promise<HostInfo> {
    if (this.cachedHost) return this.cachedHost;
    this.cachedHost = await this.withClient(async (client) => {
      const kernel = await this.execOne(client, "uname -s");
      const home = await this.execOne(client, "printenv HOME");
      const kernelName = kernel.stdout.trim();
      let platform: PlatformId = "linux";
      if (kernelName === "Darwin") platform = "darwin";
      else if (/^(Windows|MINGW|CYGWIN)/i.test(kernelName)) platform = "win32";
      return { platform, homeDir: home.stdout.trim() || "/", env: {} };
    });
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
    return this.withClient(
      (client) =>
        new Promise<Uint8Array>((resolve, reject) => {
          client.sftp((err, sftp) => {
            if (err) return reject(err);
            const chunks: Buffer[] = [];
            const stream = sftp.createReadStream(filePath);
            stream.on("data", (c: Buffer) => chunks.push(c));
            stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
            stream.on("error", reject);
          });
        }),
    );
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
      if (r.stderr.includes("No such file")) return [];
      throw new Error(`remote find failed: ${r.stderr.trim().slice(0, 200)}`);
    }
    return r.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .sort();
  }

  async globMany(patterns: string[]): Promise<string[][]> {
    const normalized = patterns.map((p) => p.replaceAll("\\", "/"));
    const groups = normalized.map(() => new Set<string>());
    type Spec = { base: string; wholename: string; maxdepth: number; group: number };
    const specs: Spec[] = normalized.map((pattern, i) => ({ ...globToFind(pattern), group: i }));
    const byBase = new Map<string, Spec[]>();
    for (const spec of specs) {
      const list = byBase.get(spec.base) ?? [];
      list.push(spec);
      byBase.set(spec.base, list);
    }
    const commands: string[] = [];
    for (const [base, baseSpecs] of byBase) {
      const maxdepth = Math.max(...baseSpecs.map((s) => s.maxdepth));
      const clauses = baseSpecs.map((s) => `-wholename ${shellQuote(s.wholename)}`).join(" -o ");
      commands.push(`find ${shellQuote(base)} -maxdepth ${maxdepth} -type f \\( ${clauses} \\)`);
    }
    const results = await this.withClient(async (client) =>
      Promise.all(commands.map((cmd) => this.execOne(client, cmd))),
    );
    for (const r of results) {
      for (const line of r.stdout.split("\n")) {
        if (!line) continue;
        for (const spec of specs) {
          if (findWholenameToRegex(spec.wholename).test(line)) groups[spec.group]?.add(line);
        }
      }
    }
    return groups.map((set) => [...set].sort());
  }
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function tryReadPrivateKey(): string | undefined {
  for (const p of [`${homedir()}/.ssh/id_ed25519`, `${homedir()}/.ssh/id_rsa`]) {
    try {
      return readFileSync(p, "utf8");
    } catch {}
  }
  return undefined;
}

function findWholenameToRegex(wholename: string): RegExp {
  let out = "";
  for (let i = 0; i < wholename.length; i++) {
    const ch = wholename[i];
    if (ch === undefined) break;
    if (ch === "*")
      out += ".*"; // fnmatch WITHOUT FNM_PATHNAME: * crosses "/"
    else if (ch === "?") out += "[^/]";
    else if (ch === "[") {
      const end = wholename.indexOf("]", i + 1);
      if (end === -1) out += "\\[";
      else {
        let expr = wholename.slice(i, end + 1);
        if (expr.startsWith("[!")) expr = `[^${expr.slice(2)}`;
        out += expr;
        i = end;
      }
    } else out += ch.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function globToFind(pattern: string): { base: string; wholename: string; maxdepth: number } {
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
    return { base, wholename: normalized, maxdepth: 0 };
  }
  const translated = rest
    .map((seg) => (seg === "**" ? "*" : seg.replaceAll("*", "[!/]*")))
    .join("/");
  const MAX_GLOB_DEPTH = 12;
  const maxdepth = rest.some((s) => s === "**") ? MAX_GLOB_DEPTH : rest.length;
  return { base, wholename: `${prefix}/${translated}`, maxdepth };
}
