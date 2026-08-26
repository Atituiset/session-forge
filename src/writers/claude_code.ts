import { canonicalize, toClaudeTool } from "../mapping/tools.ts";
import type { NirSession } from "../nir/schema.ts";
import type { ConvertReport } from "./codex_rollout.ts";

export function toClaudeCode(session: NirSession): ConvertReport {
  const lines: string[] = [];
  const notes: string[] = [];
  let toolsMapped = 0;
  let toolsSkipped = 0;
  let converted = 0;
  const start = session.startedAt ? new Date(session.startedAt) : new Date();
  let parentUuid: string | null = null;
  const uuids = new Map<number, string>();

  const slug = session.projectPath
    ? `-${session.projectPath.replace(/^\//, "").replace(/\//g, "-")}`
    : "-tmp-session-forge";

  const mkRow = (uuid: string, row: Record<string, unknown>): string =>
    JSON.stringify({
      parentUuid,
      isSidechain: false,
      userType: "external",
      cwd: session.projectPath ?? "/tmp",
      sessionId: session.id,
      version: "session-forge",
      uuid,
      ...row,
    });

  let counter = 0;
  for (const m of session.messages) {
    counter++;
    const when = m.timestamp ?? start.toISOString();

    if (m.role === "user") {
      converted++;
      const uuid = `forge-u-${counter}`;
      lines.push(
        mkRow(uuid, {
          type: "user",
          timestamp: when,
          message: { role: "user", content: m.content },
        }),
      );
      parentUuid = uuid;
    } else if (m.role === "assistant" && m.content) {
      converted++;
      const uuid = `forge-a-${counter}`;
      const blocks: unknown[] = [];
      if (m.thinking) blocks.push({ type: "thinking", thinking: m.thinking });
      blocks.push({ type: "text", text: m.content });
      if (m.model) {
        lines.push(
          mkRow(uuid, {
            type: "assistant",
            timestamp: when,
            message: {
              role: "assistant",
              model: m.model,
              content: blocks,
            },
          }),
        );
      } else {
        lines.push(
          mkRow(uuid, {
            type: "assistant",
            timestamp: when,
            message: { role: "assistant", content: blocks },
          }),
        );
      }
      parentUuid = uuid;
    } else if (m.role === "assistant" && m.toolName) {
      const claudeName = toClaudeTool(canonicalize(m.toolName));
      if (!claudeName) {
        toolsSkipped++;
        notes.push(`skipped unmappable tool: ${m.toolName}`);
        continue;
      }
      toolsMapped++;
      converted++;
      const toolUseId = `forge-tu-${counter}`;
      const uuid = `forge-at-${counter}`;
      lines.push(
        mkRow(uuid, {
          type: "assistant",
          timestamp: when,
          message: {
            role: "assistant",
            content: [
              ...(m.thinking ? [{ type: "thinking", thinking: m.thinking }] : []),
              {
                type: "tool_use",
                id: toolUseId,
                name: claudeName,
                input: (m.toolInput as Record<string, unknown>) ?? {},
              },
            ],
          },
        }),
      );
      parentUuid = uuid;
      uuids.set(counter, toolUseId);
    } else if (m.role === "assistant" && m.thinking) {
      converted++;
      const uuid = `forge-a-${counter}`;
      const content = [{ type: "thinking", thinking: m.thinking }];
      lines.push(
        mkRow(uuid, {
          type: "assistant",
          timestamp: when,
          message: m.model
            ? { role: "assistant", model: m.model, content }
            : { role: "assistant", content },
        }),
      );
      parentUuid = uuid;
    } else if (m.role === "tool") {
      converted++;
      const toolUseId = `forge-tu-${counter - 1}`;
      const uuid = `forge-tr-${counter}`;
      lines.push(
        mkRow(uuid, {
          type: "user",
          timestamp: when,
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: toolUseId, content: m.content.slice(0, 10_000) },
            ],
          },
        }),
      );
      parentUuid = uuid;
    }
  }

  // Same sanitize as the codex writer: ids may contain path characters.
  const safeId = session.id.replace(/[^A-Za-z0-9_.-]/g, "_").slice(-80);
  return {
    files: [{ path: `projects/${slug}/${safeId}.jsonl`, content: `${lines.join("\n")}\n` }],
    fidelity: "L2",
    messagesConverted: converted,
    toolsMapped,
    toolsSkipped,
    notes,
  };
}
