import type { PlatformId, Transport } from "./transport/types.ts";

/**
 * Cross-boundary path plumbing.
 *
 * Session projectPath is always the NATIVE path on the machine where the
 * agent ran ("/home/x/proj" inside WSL, "C:\\Users\\x\\proj" on Windows) —
 * that's what the panel displays ("显示 wsl 内部的目录"). When the engine
 * sits on the OTHER side of a WSL/Windows boundary, an adapter additionally
 * derives the locally reachable form ("带着 windows 目录"):
 *   engine win32, source @wsl-<distro>  → //wsl.localhost/<distro>/home/…
 *   engine linux, source @windows-host  → /mnt/c/Users/…
 */

export interface PathAdapter {
  /** Filesystem path usable by THIS engine's transport to probe a native
   *  path of the source machine (for .git root detection). */
  probe(nativePath: string): string | null;
  /** Locally reachable form of a native path, or null when identical /
   *  unreachable (plain local or ssh-remote sources). */
  local(nativePath: string): string | null;
}

export const IDENTITY_ADAPTER: PathAdapter = {
  probe: (p) => p,
  local: () => null,
};

export function adapterForSource(sourceToolId: string, platform: PlatformId): PathAdapter {
  const at = sourceToolId.indexOf("@");
  const suffix = at >= 0 ? sourceToolId.slice(at + 1) : null;
  if (platform === "win32" && suffix?.startsWith("wsl-")) {
    const prefix = `//wsl.localhost/${suffix.slice(4)}`;
    return {
      probe: (p) => (p.startsWith("//") ? p : `${prefix}${p}`),
      local: (p) => (p.startsWith("//") ? p : `${prefix}${p}`),
    };
  }
  if (platform === "linux" && suffix === "windows-host") {
    return {
      probe: (p) => tomnt(p) ?? p,
      local: (p) => tomnt(p),
    };
  }
  return IDENTITY_ADAPTER;
}

/** "C:\\Users\\x" → "/mnt/c/Users/x"; null when not a Windows drive path. */
export function tomnt(p: string): string | null {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return null;
  const [, drive, rest] = m;
  if (!drive || rest === undefined) return null;
  return `/mnt/${drive.toLowerCase()}/${rest.replaceAll("\\", "/")}`;
}

/** Parent directory that works for both posix and windows drive paths. */
export function parentDir(p: string): string | null {
  const drive = /^([A-Za-z]:)[\\/](.*)$/.exec(p);
  if (drive) {
    const [, prefix, rest0] = drive;
    if (!prefix || rest0 === undefined) return null;
    const rest = rest0.replaceAll("\\", "/").replace(/\/+$/, "");
    if (rest === "") return null; // drive root reached
    const cut = rest.lastIndexOf("/");
    if (cut < 0) return `${prefix}/`;
    return `${prefix}/${rest.slice(0, cut)}`;
  }
  const dir = p.replace(/\/+$/, "");
  if (!dir.includes("/")) return null;
  if (dir.startsWith("/") && !dir.slice(1).includes("/")) return "/";
  return dir.slice(0, dir.lastIndexOf("/")) || "/";
}

/**
 * Resolve a session's cwd to its repository root by walking up until a
 * `.git` entry exists (closest wins — nested repos take the inner root).
 * Falls back to the input when no .git is found or the path isn't probeable.
 */
const rootCache = new Map<string, string>();

export async function resolveProjectRoot(
  transport: Transport,
  adapter: PathAdapter,
  nativePath: string,
): Promise<string> {
  if (!nativePath) return nativePath;
  const cached = rootCache.get(nativePath);
  if (cached !== undefined) return cached;

  let dir = nativePath;
  let root: string | null = null;
  for (let i = 0; i < 16; i++) {
    const probe = adapter.probe(dir);
    if (probe === null) break;
    if (await transport.exists(`${probe}/.git`)) {
      root = dir;
      break;
    }
    const parent = parentDir(dir);
    if (parent === null || parent === dir) break;
    dir = parent;
  }
  const resolved = root ?? nativePath;
  if (rootCache.size > 4000) rootCache.clear();
  rootCache.set(nativePath, resolved);
  return resolved;
}
