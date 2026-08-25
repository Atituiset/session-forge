import type { NirMessage, NirSession } from "../nir/schema.ts";

export interface EnrichedStats {
  rounds: number;
  filesTouched: string[];
  additions: number;
  deletions: number;
  tokensIn: number;
  tokensOut: number;
  tokenSource: "reported" | "estimated" | "none";
  durationMs: number | null;
  hasError: boolean;
  errorTypes: string[];
}

const FILE_KEYS = ["filePath", "file_path", "path", "file", "notebook_path"];

const ERROR_PATTERNS: [string, RegExp][] = [
  ["ENOENT", /\bENOENT\b/],
  ["EACCES", /\bEACCES\b|\bEPERM\b/],
  ["TypeError", /\bTypeError\b/],
  ["SyntaxError", /\bSyntaxError\b/],
  ["ReferenceError", /\bReferenceError\b/],
  ["panic", /\bpanic:/],
  ["Traceback", /Traceback \(most recent call last\)/],
  ["compile_error", /\berror\[E\d+\]|compilation (failed|error)/i],
  ["test_failure", /\bFAILED\b|\d+ failing|AssertionError/],
  ["nonzero_exit", /[Ee]xit code: [1-9]|Process exited with code [1-9]/],
];

export function enrichSession(session: NirSession): EnrichedStats {
  let rounds = 0;
  let additions = 0;
  let deletions = 0;
  const files = new Set<string>();
  const errors = new Set<string>();
  let reportedIn = 0;
  let reportedOut = 0;

  collectPatchFilesFromMeta(session, files);
  if (typeof session.rawMeta.additions === "number") additions += session.rawMeta.additions;
  if (typeof session.rawMeta.deletions === "number") deletions += session.rawMeta.deletions;

  for (const m of session.messages) {
    if (m.role === "user") rounds++;
    reportedIn += m.tokens?.input ?? 0;
    reportedOut += m.tokens?.output ?? 0;
    scanErrors(m, errors);
    collectFiles(m.toolName, m.toolInput, files);
    countDiff(m, (add, del) => {
      additions += add;
      deletions += del;
    });
  }

  const tokenSource =
    reportedIn + reportedOut > 0 ? "reported" : estimateTokens(session) > 0 ? "estimated" : "none";
  const tokensIn = tokenSource === "reported" ? reportedIn : estimateTokens(session);
  const tokensOut = tokenSource === "reported" ? reportedOut : 0;

  return {
    rounds,
    filesTouched: [...files].sort(),
    additions,
    deletions,
    tokensIn,
    tokensOut,
    tokenSource,
    durationMs: computeDuration(session),
    hasError: errors.size > 0,
    errorTypes: [...errors],
  };
}

function countDiff(m: NirMessage, emit: (add: number, del: number) => void): void {
  if (!m.toolName || !m.toolInput || typeof m.toolInput !== "object") return;
  const input = m.toolInput as Record<string, unknown>;
  if (/edit/i.test(m.toolName)) {
    const oldStr = typeof input.old_string === "string" ? input.old_string : null;
    const newStr = typeof input.new_string === "string" ? input.new_string : null;
    if (oldStr !== null || newStr !== null) {
      emit(countLines(newStr), countLines(oldStr));
    }
    return;
  }
  if (/^write$|^notebookedit$/i.test(m.toolName)) {
    const content = typeof input.content === "string" ? input.content : "";
    emit(countLines(content), 0);
    return;
  }
  if (typeof input.raw === "string" && input.raw.includes("*** Begin Patch")) {
    countPatchHunks(input.raw, emit);
  } else if (
    typeof input.command === "string" &&
    (input.command.includes("apply_patch") || input.command.includes("<<<"))
  ) {
    const patchMatch = input.command.match(/\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch/);
    if (patchMatch) countPatchHunks(patchMatch[0], emit);
  }
}

function countPatchHunks(patch: string, emit: (add: number, del: number) => void): void {
  let add = 0;
  let del = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) add++;
    else if (line.startsWith("-") && !line.startsWith("---")) del++;
  }
  emit(add, del);
}

function countLines(text: string | null): number {
  if (!text || text === "") return 0;
  return text.split("\n").length;
}

function collectFiles(toolName: string | null, toolInput: unknown, out: Set<string>): void {
  if (!toolName || !toolInput || typeof toolInput !== "object") return;
  const input = toolInput as Record<string, unknown>;
  if (/edit|write|read|multiedit|notebook/i.test(toolName)) {
    for (const k of FILE_KEYS) {
      const v = input[k];
      if (typeof v === "string") {
        out.add(v);
        break;
      }
    }
  }
  if (typeof input.raw === "string") collectPatchFiles(input.raw, out);
  if (typeof input.patch === "string") collectPatchFiles(input.patch, out);
}

function collectPatchFilesFromMeta(session: NirSession, out: Set<string>): void {
  const patch = session.rawMeta.patchFiles;
  if (Array.isArray(patch)) {
    for (const f of patch) {
      if (typeof f === "string") out.add(f);
    }
  }
}

function collectPatchFiles(patch: string, out: Set<string>): void {
  const re = /\*\*\* (Update|Add|Delete) File: (.+)/g;
  for (const m of patch.matchAll(re)) {
    const name = m[2];
    if (name) out.add(name.trim());
  }
}

function scanErrors(m: NirMessage, out: Set<string>): void {
  if (m.role !== "tool" && m.role !== "user") return;
  if (m.content.length > 50_000) return;
  for (const [name, re] of ERROR_PATTERNS) {
    if (re.test(m.content)) out.add(name);
  }
}

function estimateTokens(session: NirSession): number {
  let total = 0;
  for (const m of session.messages) {
    total += Math.ceil((m.content.length + JSON.stringify(m.toolInput ?? "").length) / 4);
  }
  return total;
}

function computeDuration(session: NirSession): number | null {
  const metaDuration = session.rawMeta.durationMs;
  if (typeof metaDuration === "number") return metaDuration;
  if (!session.startedAt || !session.endedAt) return null;
  const start = Date.parse(session.startedAt);
  const end = Date.parse(session.endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}
