import { canonicalize, toCodexTool } from "../mapping/tools.ts";
import type { NirSession } from "../nir/schema.ts";

export interface ConvertReport {
  files: { path: string; content: string }[];
  fidelity: "L1" | "L2";
  messagesConverted: number;
  toolsMapped: number;
  toolsSkipped: number;
  notes: string[];
}

function ts(date: Date): string {
  return date.toISOString();
}

export function toCodexRollout(session: NirSession): ConvertReport {
  const lines: string[] = [];
  const notes: string[] = [];
  let toolsMapped = 0;
  let toolsSkipped = 0;
  let converted = 0;
  const start = session.startedAt ? new Date(session.startedAt) : new Date();

  lines.push(
    JSON.stringify({
      timestamp: ts(start),
      type: "session_meta",
      payload: {
        id: session.id,
        timestamp: ts(start),
        cwd: session.projectPath ?? "/tmp",
        originator: "session-forge",
        cli_version: "0.0.0-forge",
        source: "session-forge-convert",
      },
    }),
  );

  let callCounter = 0;
  for (const m of session.messages) {
    const when = m.timestamp ?? ts(start);
    if (m.role === "assistant" && m.thinking) {
      lines.push(
        JSON.stringify({
          timestamp: when,
          type: "response_item",
          payload: {
            type: "reasoning",
            summary: [{ type: "summary_text", text: m.thinking }],
          },
        }),
      );
      // A thinking-only message is fully represented by the reasoning item;
      // one with content/toolName is counted by its own branch below.
      if (!m.content && !m.toolName) converted++;
    }
    if (m.role === "user" || (m.role === "system" && m.content)) {
      converted++;
      lines.push(
        JSON.stringify({
          timestamp: when,
          type: "response_item",
          payload: {
            type: "message",
            role: m.role,
            content: [{ type: "input_text", text: m.content }],
          },
        }),
      );
    } else if (m.role === "assistant" && m.content) {
      converted++;
      lines.push(
        JSON.stringify({
          timestamp: when,
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: m.content }],
          },
        }),
      );
    } else if (m.role === "assistant" && m.toolName) {
      const canonical = canonicalize(m.toolName);
      callCounter++;
      const args = buildCodexArgs(canonical, m.toolName, m.toolInput);
      if (args === null) {
        toolsSkipped++;
        notes.push(`skipped unmappable tool: ${m.toolName}`);
        continue;
      }
      toolsMapped++;
      converted++;
      lines.push(
        JSON.stringify({
          timestamp: when,
          type: "response_item",
          payload: {
            type: "function_call",
            name: toCodexTool(canonical),
            arguments: JSON.stringify(args),
            call_id: `call_forge_${callCounter}`,
          },
        }),
      );
    } else if (m.role === "tool") {
      converted++;
      lines.push(
        JSON.stringify({
          timestamp: when,
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: `call_forge_${callCounter}`,
            output: m.content.slice(0, 10_000),
          },
        }),
      );
    }
  }

  const relPath = `sessions/${start.getFullYear()}/${String(start.getMonth() + 1).padStart(2, "0")}/${String(start.getDate()).padStart(2, "0")}/rollout-${start.toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${session.id}.jsonl`;

  return {
    files: [{ path: relPath, content: `${lines.join("\n")}\n` }],
    fidelity: "L2",
    messagesConverted: converted,
    toolsMapped,
    toolsSkipped,
    notes,
  };
}

function buildCodexArgs(
  canonical: string,
  originalName: string,
  toolInput: unknown,
): Record<string, unknown> | null {
  if (/^apply_patch$/i.test(originalName)) {
    const raw = (toolInput as Record<string, unknown> | null)?.raw;
    if (typeof raw === "string") return { input: raw };
    const patch = (toolInput as Record<string, unknown> | null)?.patch;
    if (typeof patch === "string") return { input: patch };
  }
  if (/^(exec_command|bash|shell|terminal)$/i.test(originalName)) {
    const input = toolInput as Record<string, unknown> | null;
    const cmd =
      typeof input?.cmd === "string"
        ? input.cmd
        : typeof input?.command === "string"
          ? input.command
          : null;
    if (cmd !== null) return { cmd };
  }
  switch (canonical) {
    case "edit":
    case "write": {
      const input = toolInput as Record<string, unknown> | null;
      const filePath = typeof input?.filePath === "string" ? input.filePath : input?.file_path;
      if (typeof filePath === "string") {
        return {
          input: `*** Begin Patch\n*** Update File: ${filePath}\n*** (content reconstructed by session-forge; verify manually)\n*** End Patch`,
        };
      }
      return null;
    }
    case "read":
    case "search":
    case "list": {
      const input = toolInput as Record<string, unknown> | null;
      const target =
        typeof input?.path === "string"
          ? input.path
          : typeof input?.filePath === "string"
            ? input.filePath
            : typeof input?.file_path === "string"
              ? input.file_path
              : ".";
      return {
        cmd: `${canonical === "read" ? "cat" : canonical === "list" ? "ls" : "rg"} ${target}`,
      };
    }
    default:
      return {};
  }
}
