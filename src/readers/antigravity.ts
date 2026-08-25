import type { NirMessage } from "../nir/schema.ts";
import type { Transport } from "../transport/types.ts";
import type { FileGroup, Reader, ScanEvent } from "./util.ts";
import { buildSession, makeMsg, readTextVia } from "./util.ts";

const MAX_CONTENT = 30_000;

export class AntigravityReader implements Reader {
  readonly family = "antigravity-transcript";

  async *scan(transport: Transport, group: FileGroup): AsyncGenerator<ScanEvent> {
    for (const file of group.files) {
      try {
        const text = await readTextVia(transport, file);
        const session = parseTranscript(file, group.toolId, text);
        if (session) yield session;
      } catch (err) {
        yield { kind: "issue", path: file, error: String(err) };
      }
    }
  }
}

function parseTranscript(
  file: string,
  toolId: string,
  text: string,
): Extract<ScanEvent, { kind: "session" }> | null {
  const brainId = file.includes("/brain/")
    ? (file.split("/brain/")[1]?.split("/")[0] ?? file)
    : file;
  const messages: NirMessage[] = [];

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const type = row.type as string | undefined;
    const ts = typeof row.created_at === "string" ? row.created_at : null;
    const content = typeof row.content === "string" ? row.content.slice(0, MAX_CONTENT) : "";

    switch (type) {
      case "USER_INPUT":
        if (content) messages.push(makeMsg({ role: "user", content, timestamp: ts }));
        break;
      case "PLANNER_RESPONSE":
      case "CONVERSATION_HISTORY":
        if (content) messages.push(makeMsg({ role: "assistant", content, timestamp: ts }));
        break;
      case "CODE_ACTION":
        messages.push(
          makeMsg({
            role: "assistant",
            content: "",
            toolName: "edit",
            toolInput: extractTarget(row),
            timestamp: ts,
          }),
        );
        break;
      case "VIEW_FILE":
        messages.push(
          makeMsg({
            role: "assistant",
            content: "",
            toolName: "read",
            toolInput: extractTarget(row),
            timestamp: ts,
          }),
        );
        break;
      case "RUN_COMMAND": {
        const cmd = extractString(row, "command") || content;
        messages.push(
          makeMsg({
            role: "assistant",
            content: "",
            toolName: "bash",
            toolInput: { command: cmd },
            timestamp: ts,
          }),
        );
        const output = extractString(row, "output");
        if (output) {
          messages.push(
            makeMsg({
              role: "tool",
              content: output.slice(0, MAX_CONTENT),
              toolName: "bash",
              timestamp: ts,
            }),
          );
        }
        break;
      }
      case "GREP_SEARCH":
        messages.push(
          makeMsg({
            role: "assistant",
            content: "",
            toolName: "search",
            toolInput: extractTarget(row),
            timestamp: ts,
          }),
        );
        break;
      case "LIST_DIRECTORY":
        messages.push(
          makeMsg({
            role: "assistant",
            content: "",
            toolName: "list",
            toolInput: extractTarget(row),
            timestamp: ts,
          }),
        );
        break;
      default:
        break;
    }
  }

  if (messages.length === 0) return null;
  const session = buildSession({
    id: brainId,
    source: toolId,
    projectPath: null,
    messages,
  });
  const rev = Date.now();
  return { kind: "session", sourceFile: file, rev, session };
}

function extractString(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function extractTarget(row: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["file_path", "filePath", "path", "target", "query", "directory"]) {
    const v = row[key];
    if (typeof v === "string") return { path: v };
  }
  return {};
}
