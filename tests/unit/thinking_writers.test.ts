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
    model: null,
    thinking: null,
    ...partial,
  };
}

const session: NirSession = {
  id: "think-1",
  source: "test",
  sourceVersion: null,
  projectPath: "/home/u/proj",
  startedAt: "2026-05-01T10:00:00.000Z",
  endedAt: null,
  messages: [
    msg({ role: "user", content: "fix the bug" }),
    msg({ role: "assistant", thinking: "The bug is a missing null check." }),
    msg({ role: "assistant", content: "Fixed it." }),
  ],
  rawMeta: {},
};

describe("convert writers emit thinking", () => {
  test("claude-code writer emits a thinking content block", () => {
    const report = toClaudeCode(session);
    const rows = report.files[0]?.content
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const thinkingRow = rows?.find((r) => {
      const content = (r.message as Record<string, unknown>)?.content;
      return Array.isArray(content) && content.some((b) => b.type === "thinking");
    });
    if (!thinkingRow) throw new Error("expected a row with a thinking block");
    const blocks = (thinkingRow.message as Record<string, unknown>).content as {
      type: string;
      thinking?: string;
    }[];
    expect(blocks[0]).toEqual({ type: "thinking", thinking: "The bug is a missing null check." });
    expect(report.messagesConverted).toBe(3);
  });

  test("codex rollout writer emits a reasoning response_item", () => {
    const report = toCodexRollout(session);
    const rows = report.files[0]?.content
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const reasoning = rows?.find(
      (r) => (r.payload as Record<string, unknown>)?.type === "reasoning",
    );
    if (!reasoning) throw new Error("expected a reasoning response_item");
    expect((reasoning.payload as Record<string, unknown>).summary).toEqual([
      { type: "summary_text", text: "The bug is a missing null check." },
    ]);
    // reasoning item comes before the assistant message item
    const reasoningIdx = rows?.indexOf(reasoning) ?? -1;
    const assistantIdx =
      rows?.findIndex(
        (r) =>
          (r.payload as Record<string, unknown>)?.type === "message" &&
          (r.payload as Record<string, unknown>)?.role === "assistant",
      ) ?? -1;
    expect(reasoningIdx).toBeGreaterThanOrEqual(0);
    expect(assistantIdx).toBeGreaterThan(reasoningIdx);
    expect(report.messagesConverted).toBe(3);
  });
});
