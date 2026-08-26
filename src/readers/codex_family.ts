import type { NirMessage } from "../nir/schema.ts";
import type { Transport } from "../transport/types.ts";
import { stableRev } from "./antigravity.ts";
import type { FileGroup, Reader, ScanEvent } from "./util.ts";
import {
  buildSession,
  collectPatchFiles,
  estTokens,
  extractTokens,
  makeMsg,
  readTextVia,
  safeJsonParse,
} from "./util.ts";

const MAX_TOOL_CONTENT = 20_000;

export class CodexFamilyReader implements Reader {
  readonly family = "codex-family";

  async *scan(transport: Transport, group: FileGroup): AsyncGenerator<ScanEvent> {
    for (const file of group.files) {
      try {
        if (file.endsWith(".json")) {
          yield* scanCodewhale(transport, file, group.toolId);
        } else if (file.endsWith("wire.jsonl")) {
          yield* scanKimi(transport, file, group.toolId);
        } else {
          yield* scanRollout(transport, file, group.toolId);
        }
      } catch (err) {
        yield { kind: "issue", path: file, error: String(err) };
      }
    }
  }
}

async function* scanRollout(
  transport: Transport,
  file: string,
  toolId: string,
): AsyncGenerator<ScanEvent> {
  const text = await readTextVia(transport, file);
  const lines = text.split("\n");
  let id =
    file
      .replace(/\.jsonl$/, "")
      .split("/")
      .pop() ?? file;
  let projectPath: string | null = null;
  let sourceVersion: string | null = null;
  let model: string | null = null;
  const messages: NirMessage[] = [];
  const patchFiles = new Set<string>();

  for (const line of lines) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = typeof row.timestamp === "string" ? row.timestamp : null;
    if (row.type === "session_meta") {
      const p = (row.payload ?? {}) as Record<string, unknown>;
      if (typeof p.id === "string") id = p.id;
      if (typeof p.cwd === "string") projectPath = p.cwd;
      if (typeof p.cli_version === "string") sourceVersion = p.cli_version;
      continue;
    }
    if (row.type === "turn_context") {
      const p = (row.payload ?? {}) as Record<string, unknown>;
      if (typeof p.model === "string") model = p.model;
      continue;
    }
    if (row.type !== "response_item") continue;
    const p = (row.payload ?? {}) as Record<string, unknown>;
    const pt = p.type as string | undefined;
    if (pt === "message") {
      const role = p.role as string;
      if (role !== "user" && role !== "assistant" && role !== "system") continue;
      const content = flattenContent(p.content).text;
      if (!content) continue;
      messages.push(
        makeMsg({ role: role === "assistant" ? "assistant" : role, content, timestamp: ts, model }),
      );
    } else if (pt === "reasoning") {
      // Encrypted reasoning without a summary carries no text and yields nothing.
      const summary = Array.isArray(p.summary) ? p.summary : [];
      const thinking = summary
        .map((s) =>
          s && typeof s === "object" ? String((s as Record<string, unknown>).text ?? "") : "",
        )
        .filter((t) => t.length > 0)
        .join("\n")
        .trim();
      if (thinking) {
        messages.push(makeMsg({ role: "assistant", content: "", thinking, timestamp: ts, model }));
      }
    } else if (pt === "function_call" || pt === "custom_tool_call") {
      const name = typeof p.name === "string" ? p.name : "unknown";
      const rawArgs = (p.arguments ?? p.input) as unknown;
      const input =
        typeof rawArgs === "string"
          ? (safeJsonParse(rawArgs) ?? { raw: rawArgs })
          : (rawArgs ?? null);
      messages.push(
        makeMsg({
          role: "assistant",
          content: "",
          toolName: name,
          toolInput: input,
          timestamp: ts,
          model,
        }),
      );
      if (name === "apply_patch" && typeof rawArgs === "string") {
        collectPatchFiles(rawArgs, patchFiles);
      }
    } else if (pt === "function_call_output" || pt === "custom_tool_call_output") {
      const output =
        typeof p.output === "string"
          ? p.output.slice(0, MAX_TOOL_CONTENT)
          : JSON.stringify(p.output ?? null);
      messages.push(
        makeMsg({
          role: "tool",
          content: output,
          toolName: callName(messages, p.call_id),
          timestamp: ts,
        }),
      );
    }
  }

  if (messages.length === 0) return;
  const session = buildSession({
    id,
    source: toolId,
    sourceVersion,
    projectPath,
    messages,
    rawMeta: patchFiles.size > 0 ? { patchFiles: [...patchFiles] } : {},
  });
  const rev = await revFor(transport, file);
  yield { kind: "session", sourceFile: file, rev, session };
}

async function* scanKimi(
  transport: Transport,
  file: string,
  toolId: string,
): AsyncGenerator<ScanEvent> {
  const text = await readTextVia(transport, file);
  const parts = file.split("/");
  const sessionDir = parts.find((p) => p.startsWith("session_")) ?? "";
  const workspaceDir = parts.find((p) => p.startsWith("wd_")) ?? "";
  const agentsIdx = parts.indexOf("agents");
  const agentName = agentsIdx >= 0 ? (parts[agentsIdx + 1] ?? "main") : "main";
  const id = `${sessionDir.replace(/^session_/, "") || file}/${agentName}`;
  const projectHint = workspaceDir.replace(/^wd_/, "").replace(/_[0-9a-f]+$/, "");
  let model: string | null = null;
  let startedAtMs: number | undefined;
  const messages: NirMessage[] = [];
  const tokenTotals = { input: 0, output: 0 };
  let durationMs: number | undefined;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const t = typeof row.time === "number" ? row.time : undefined;
    if (t && startedAtMs === undefined) startedAtMs = t;
    switch (row.type) {
      case "profile.bind": {
        if (typeof row.modelAlias === "string") model = row.modelAlias;
        break;
      }
      case "context.append_message": {
        const m = (row.message ?? {}) as Record<string, unknown>;
        const role = m.role as string;
        if (role !== "user" && role !== "assistant" && role !== "system") break;
        const { text, thinking } = flattenContent(m.content);
        const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
        if (thinking) {
          messages.push(
            makeMsg({
              role: "assistant",
              content: "",
              thinking,
              timestamp: isoFromMsLocal(t),
              model,
            }),
          );
        }
        if (text) {
          messages.push(
            makeMsg({
              role,
              content: text,
              timestamp: isoFromMsLocal(t),
              model,
            }),
          );
        }
        for (const tc of calls) {
          const c = tc as Record<string, unknown>;
          const argsRaw = c.arguments ?? c.input ?? c.args;
          const parsed =
            typeof argsRaw === "string"
              ? (safeJsonParse(argsRaw) ?? { raw: argsRaw })
              : (argsRaw ?? null);
          messages.push(
            makeMsg({
              role: "assistant",
              content: "",
              toolName: (c.name as string) ?? (c.toolName as string) ?? "unknown",
              toolInput: parsed,
              timestamp: isoFromMsLocal(t),
              model,
            }),
          );
        }
        break;
      }
      case "usage.record": {
        const u = extractTokens((row.usage ?? row) as unknown);
        if (u) {
          tokenTotals.input += u.input;
          tokenTotals.output += u.output;
        }
        break;
      }
      case "turn.ended": {
        if (typeof row.durationMs === "number") durationMs = (durationMs ?? 0) + row.durationMs;
        break;
      }
    }
  }

  if (messages.length === 0) return;
  // Estimated tokens must NOT be attached as message.tokens — enrich would
  // misreport them as "reported" usage. Keep the estimate in rawMeta instead.
  const rawMeta: Record<string, unknown> = projectHint
    ? { projectHint, agent: agentName }
    : { agent: agentName };
  if (durationMs !== undefined) rawMeta.durationMs = durationMs;
  rawMeta.estimatedTokens = [...messages].reduce((sum, m) => sum + estTokens(m.content), 0);
  const session = buildSession({
    id,
    source: toolId,
    projectPath: null,
    startedAt: isoFromMsLocal(startedAtMs),
    messages,
    rawMeta,
  });
  if (tokenTotals.input + tokenTotals.output > 0) {
    const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant");
    if (lastAssistant) lastAssistant.tokens = { ...tokenTotals, cacheRead: 0, cacheWrite: 0 };
  }
  const rev = await revFor(transport, file);
  yield { kind: "session", sourceFile: file, rev, session };
}

async function* scanCodewhale(
  transport: Transport,
  file: string,
  toolId: string,
): AsyncGenerator<ScanEvent> {
  const id =
    file
      .replace(/\.json$/, "")
      .split("/")
      .pop() ?? file;
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(await readTextVia(transport, file));
  } catch (err) {
    yield { kind: "issue", path: file, error: String(err) };
    return;
  }
  const meta = (doc.metadata ?? {}) as Record<string, unknown>;
  const projectPath =
    firstString(meta, ["cwd", "workdir", "working_directory", "project_path", "path"]) ?? null;
  const model = firstString(meta, ["model", "model_id"]) ?? null;
  const rawMessages = Array.isArray(doc.messages) ? doc.messages : [];
  const messages: NirMessage[] = [];
  for (const rm of rawMessages) {
    const m = rm as Record<string, unknown>;
    const role = m.role as string;
    if (role !== "user" && role !== "assistant" && role !== "tool" && role !== "system") continue;
    const { text, thinking } = flattenContent(m.content);
    if (thinking) {
      messages.push(
        makeMsg({
          role: "assistant",
          content: "",
          thinking,
          timestamp: isoFromMsLocal(m.timestamp),
          model,
        }),
      );
    }
    if (text) {
      messages.push(
        makeMsg({ role, content: text, timestamp: isoFromMsLocal(m.timestamp), model }),
      );
    }
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    for (const tc of calls) {
      const c = tc as Record<string, unknown>;
      const fn = (c.function ?? c) as Record<string, unknown>;
      const argsRaw = fn.arguments;
      const parsed =
        typeof argsRaw === "string"
          ? (safeJsonParse(argsRaw) ?? { raw: argsRaw })
          : (argsRaw ?? null);
      messages.push(
        makeMsg({
          role: "assistant",
          content: "",
          toolName: (fn.name as string) ?? "unknown",
          toolInput: parsed,
          timestamp: isoFromMsLocal(m.timestamp),
          model,
        }),
      );
    }
  }
  if (messages.length === 0) return;
  const session = buildSession({ id, source: toolId, projectPath, messages });
  const rev = await revFor(transport, file);
  yield { kind: "session", sourceFile: file, rev, session };
}

function callName(messages: NirMessage[], callId: unknown): string | null {
  if (typeof callId !== "string") return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "assistant" && m.toolName) {
      const input = m.toolInput as Record<string, unknown> | null;
      const cid = input?.call_id ?? input?.id;
      if (cid === callId || !cid) return m.toolName;
    }
  }
  return null;
}

function flattenContent(content: unknown): { text: string; thinking: string } {
  if (typeof content === "string") return { text: content, thinking: "" };
  if (!Array.isArray(content)) return { text: "", thinking: "" };
  const out: string[] = [];
  const thoughts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      out.push(block);
    } else if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") out.push(b.text);
      else if (b.type === "input_text" && typeof b.text === "string") out.push(b.text);
      else if (b.type === "output_text" && typeof b.text === "string") out.push(b.text);
      else if (b.type === "thinking" && typeof b.thinking === "string") thoughts.push(b.thinking);
      else if (b.type === "reasoning") {
        const t =
          typeof b.text === "string" ? b.text : typeof b.summary === "string" ? b.summary : "";
        if (t) thoughts.push(t);
      }
    }
  }
  return { text: out.join("\n").trim(), thinking: thoughts.join("\n").trim() };
}

function isoFromMsLocal(ms: unknown): string | null {
  return typeof ms === "number" ? new Date(ms < 1e12 ? ms * 1000 : ms).toISOString() : null;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

async function revFor(transport: Transport, file: string): Promise<number> {
  return stableRev(transport, file);
}
