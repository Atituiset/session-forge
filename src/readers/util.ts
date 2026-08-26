import type { NirMessage, NirSession } from "../nir/schema.ts";
import type { Transport } from "../transport/types.ts";

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

export function isoFromMs(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

export async function readTextVia(transport: Transport, filePath: string): Promise<string> {
  if (transport.kind === "local") {
    return Bun.file(filePath).text();
  }
  return transport.readTextFile(filePath);
}

export function estTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Shared with enrich: extract `*** Update/Add/Delete File:` names from an
// apply_patch body.
export function collectPatchFiles(patch: string, out: Set<string>): void {
  const re = /\*\*\* (Update|Add|Delete) File: (.+)/g;
  for (const m of patch.matchAll(re)) {
    const name = m[2];
    if (name) out.add(name.trim());
  }
}

export function makeMsg(partial: Partial<NirMessage> & { role: NirMessage["role"] }): NirMessage {
  // Spread partial FIRST so explicitly-passed defaults win; then re-apply the
  // fallbacks only for keys that are still undefined.
  return {
    ...partial,
    content: partial.content ?? "",
    timestamp: partial.timestamp ?? null,
    toolName: partial.toolName ?? null,
    toolInput: partial.toolInput ?? null,
    model: partial.model ?? null,
  };
}

export function buildSession(partial: {
  id: string;
  source: string;
  sourceVersion?: string | null;
  projectPath?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  messages: NirMessage[];
  rawMeta?: Record<string, unknown>;
}): NirSession {
  const times = partial.messages
    .map((m) => m.timestamp)
    .filter((t): t is string => typeof t === "string");
  const sorted = [...times].sort();
  return {
    id: partial.id,
    source: partial.source,
    sourceVersion: partial.sourceVersion ?? null,
    projectPath: partial.projectPath ?? null,
    startedAt: partial.startedAt ?? sorted[0] ?? null,
    endedAt: partial.endedAt ?? sorted[sorted.length - 1] ?? null,
    messages: partial.messages,
    rawMeta: partial.rawMeta ?? {},
  };
}

export function extractTokens(obj: unknown): { input: number; output: number } | undefined {
  if (typeof obj !== "object" || obj === null) return undefined;
  const o = obj as Record<string, unknown>;
  const pick = (...keys: string[]): number => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "number") return v;
    }
    return 0;
  };
  if (o.input_tokens !== undefined || o.output_tokens !== undefined) {
    return {
      input: pick("input_tokens", "prompt_tokens"),
      output: pick("output_tokens", "completion_tokens"),
    };
  }
  if (o.prompt_tokens !== undefined || o.completion_tokens !== undefined) {
    return {
      input: pick("prompt_tokens", "input_tokens"),
      output: pick("completion_tokens", "output_tokens"),
    };
  }
  if (o.input !== undefined || o.output !== undefined) {
    return { input: pick("input"), output: pick("output") };
  }
  return undefined;
}
