import { homedir } from "node:os";
import path from "node:path";

export interface SshConfigHost {
  /** Host alias from the config (used as the remote name / ssh target). */
  name: string;
  /** HostName value, defaults to the alias. */
  host: string;
  /** User value, if any. Port/IdentityFile are not captured on purpose:
   *  scans connect via `ssh <alias>` and OpenSSH applies them itself. */
  username?: string;
}

// Mirrors the name rule enforced by POST /api/remotes.
const VALID_NAME = /^[A-Za-z0-9_.@-]+$/;

/**
 * Parse ~/.ssh/config into concrete host entries. Wildcard (`*`, `?`) and
 * negated (`!`) Host patterns are skipped — they are not dialable targets.
 * `Include` directives are not followed (single-file parse).
 */
export function parseSshConfigHosts(text: string): SshConfigHost[] {
  const hosts: SshConfigHost[] = [];
  let current: SshConfigHost[] = [];
  const flush = (): void => {
    hosts.push(...current);
    current = [];
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^(\S+)\s+(.+)$/);
    if (!m) continue;
    const key = (m[1] ?? "").toLowerCase();
    const value = (m[2] ?? "").trim();
    if (key === "host") {
      flush();
      for (const alias of value.split(/\s+/)) {
        if (/[*?!]/.test(alias) || !VALID_NAME.test(alias)) continue;
        current.push({ name: alias, host: alias });
      }
    } else if (current.length > 0) {
      if (key === "hostname") for (const h of current) h.host = value;
      else if (key === "user") for (const h of current) h.username = value;
    }
  }
  flush();
  return hosts;
}

export function sshConfigPath(): string {
  return path.join(homedir(), ".ssh", "config");
}

/** Hosts from the ssh config that are not already tracked (by name, or by
 *  same host+username pair) and not duplicated within the config itself. */
export function filterNewHosts(
  existing: { name: string; host: string; username?: string }[],
  parsed: SshConfigHost[],
): SshConfigHost[] {
  const seenNames = new Set(existing.map((r) => r.name));
  const seenPairs = new Set(existing.map((r) => `${r.username ?? ""}@${r.host}`));
  const out: SshConfigHost[] = [];
  for (const h of parsed) {
    const pair = `${h.username ?? ""}@${h.host}`;
    if (seenNames.has(h.name) || seenPairs.has(pair)) continue;
    seenNames.add(h.name);
    seenPairs.add(pair);
    out.push(h);
  }
  return out;
}
