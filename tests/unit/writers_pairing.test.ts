import { describe, expect, test } from "bun:test";
import type { NirMessage, NirSession } from "../../src/nir/schema.ts";
import { toClaudeCode } from "../../src/writers/claude_code.ts";
import { toCodexRollout } from "../../src/writers/codex_rollout.ts";

function msg(partial: Partial<NirMessage> & { role: NirMessage["role"] }): NirMessage {
  return {
    content: "",
    timestamp: "2026-05-01T10:00:00.000Z",
    toolName: null,
    toolInput: null,
    toolCallId: null,
    model: null,
    thinking: null,
    agent: null,
    agentLabel: null,
    ...partial,
  };
}

// Two tool calls with a text message between call 1 and its result: pairing
// must follow toolCallId, not message adjacency.
const session: NirSession = {
  id: "pair-1",
  source: "test",
  sourceVersion: null,
  title: null,
  model: null,
  cost: null,
  projectPath: "/home/u/proj",
  startedAt: "2026-05-01T10:00:00.000Z",
  endedAt: null,
  messages: [
    msg({ role: "user", content: "do two things" }),
    msg({
      role: "assistant",
      toolName: "Read",
      toolInput: { file_path: "/a" },
      toolCallId: "call-A",
    }),
    msg({
      role: "assistant",
      toolName: "Read",
      toolInput: { file_path: "/b" },
      toolCallId: "call-B",
    }),
    msg({ role: "assistant", content: "both read, here are the results" }),
    msg({ role: "tool", content: "contents of a", toolCallId: "call-A" }),
    msg({ role: "tool", content: "contents of b", toolCallId: "call-B" }),
  ],
  rawMeta: {},
};

describe("writers pair tool results via toolCallId", () => {
  test("claude-code writer: tool_result links to its own tool_use id", () => {
    const report = toClaudeCode(session);
    const rows = report.files[0]?.content
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    if (!rows) throw new Error("expected output rows");
    const useIds: string[] = [];
    const resultIds: string[] = [];
    for (const r of rows) {
      const content = (r.message as Record<string, unknown>)?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content as Record<string, unknown>[]) {
        if (b.type === "tool_use") useIds.push(String(b.id));
        if (b.type === "tool_result") resultIds.push(String(b.tool_use_id));
      }
    }
    expect(useIds).toHaveLength(2);
    expect(resultIds).toEqual(useIds);
    // Not the broken adjacency pairing (result 1 → call 2).
    expect(resultIds[0]).not.toBe(useIds[1]);
  });

  test("codex rollout writer: function_call_output links to its own call_id", () => {
    const report = toCodexRollout(session);
    const rows = report.files[0]?.content
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    if (!rows) throw new Error("expected output rows");
    const callIds: string[] = [];
    const outputIds: string[] = [];
    for (const r of rows) {
      const p = r.payload as Record<string, unknown> | undefined;
      if (p?.type === "function_call") callIds.push(String(p.call_id));
      if (p?.type === "function_call_output") outputIds.push(String(p.call_id));
    }
    expect(callIds).toHaveLength(2);
    expect(outputIds).toEqual(callIds);
    expect(outputIds[0]).not.toBe(callIds[1]);
  });
});
