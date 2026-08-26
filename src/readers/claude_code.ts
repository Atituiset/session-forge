import type { NirMessage } from "../nir/schema.ts";
import type { Transport } from "../transport/types.ts";
import { stableRev } from "./antigravity.ts";
import type { FileGroup, Reader, ScanEvent } from "./util.ts";
import { buildSession, extractTokens, makeMsg, readTextVia } from "./util.ts";

const MAX_TOOL_CONTENT = 20_000;

export class ClaudeCodeReader implements Reader {
  readonly family = "claude-code";

  async *scan(transport: Transport, group: FileGroup): AsyncGenerator<ScanEvent> {
    for (const file of group.files) {
      try {
        yield* scanFile(transport, file, group.toolId);
      } catch (err) {
        yield { kind: "issue", path: file, error: String(err) };
      }
    }
  }
}

async function* scanFile(
  transport: Transport,
  file: string,
  toolId: string,
): AsyncGenerator<ScanEvent> {
  const text = await readTextVia(transport, file);
  const id =
    file
      .replace(/\.jsonl$/, "")
      .split("/")
      .pop() ?? file;
  const projectPath = decodeProjectSlug(file);
  const messages: NirMessage[] = [];
  let model: string | null = null;
  let sourceVersion: string | null = null;
  let cwd: string | null = projectPath;
  let sidechainCount = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.isSidechain === true) {
      sidechainCount++;
      continue;
    }
    if (row.type !== "user" && row.type !== "assistant") continue;
    const message = row.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") continue;
    const ts = typeof row.timestamp === "string" ? row.timestamp : null;
    const role = row.type as "user" | "assistant";
    if (typeof row.version === "string") sourceVersion = row.version;
    if (typeof row.cwd === "string") cwd = row.cwd;

    if (role === "assistant") {
      if (typeof message.model === "string") model = message.model;
      const usage = extractTokens(message.usage);
      if (usage) {
        tokens.input += usage.input;
        tokens.output += usage.output;
        const u = message.usage as Record<string, unknown>;
        tokens.cacheRead += num(u.cache_read_input_tokens);
        tokens.cacheWrite += num(u.cache_creation_input_tokens);
      }
    }

    const content = message.content;
    if (typeof content === "string") {
      if (content.trim()) messages.push(makeMsg({ role, content, timestamp: ts, model }));
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        if (b.text.trim()) messages.push(makeMsg({ role, content: b.text, timestamp: ts, model }));
      } else if (b.type === "tool_use") {
        messages.push(
          makeMsg({
            role: "assistant",
            content: "",
            toolName: typeof b.name === "string" ? b.name : "unknown",
            toolInput: b.input ?? null,
            timestamp: ts,
            model,
          }),
        );
      } else if (b.type === "tool_result") {
        const inner = b.content;
        let text = "";
        if (typeof inner === "string") text = inner;
        else if (Array.isArray(inner)) {
          text = inner
            .map((x) =>
              x && typeof x === "object" && (x as Record<string, unknown>).type === "text"
                ? String((x as Record<string, unknown>).text ?? "")
                : "",
            )
            .join("\n");
        }
        messages.push(
          makeMsg({
            role: "tool",
            content: text.slice(0, MAX_TOOL_CONTENT),
            toolName: toolUseId(b),
            timestamp: ts,
          }),
        );
      }
    }
  }

  if (messages.length === 0) return;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (lastAssistant && tokens.input + tokens.output > 0) {
    lastAssistant.tokens = { ...tokens };
  }
  const session = buildSession({
    id,
    source: toolId,
    sourceVersion,
    projectPath: cwd,
    messages,
    rawMeta: {
      slugProject: projectPath,
      ...(sidechainCount > 0 ? { sidechainMessages: sidechainCount } : {}),
    },
  });
  const rev = await stableRev(transport, file);
  yield { kind: "session", sourceFile: file, rev, session };
}

// Claude Code encodes the project dir as a flat slug (`-home-me-my-project`).
// Dashes are ambiguous (path separators vs. hyphens in names like `my-app`),
// so only split on dashes that follow known root prefixes; otherwise leave the
// project path null rather than guess a mangled path.
function decodeProjectSlug(file: string): string | null {
  const dir = file.split("/").slice(0, -1).pop();
  if (!dir?.startsWith("-")) return null;
  const slug = dir.slice(1);
  for (const prefix of ["home-", "Users-", "mnt-c-Users-"]) {
    if (slug.startsWith(prefix)) {
      return `/${slug.slice(prefix.length).replace(/-/g, "/")}`;
    }
  }
  return null;
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

function toolUseId(block: Record<string, unknown>): string | null {
  const id = block.tool_use_id;
  return typeof id === "string" ? `toolu:${id}` : null;
}
