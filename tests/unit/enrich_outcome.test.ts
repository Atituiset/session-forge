import { describe, expect, test } from "bun:test";
import { enrichSession } from "../../src/enrich/index.ts";
import type { NirMessage, NirSession } from "../../src/nir/schema.ts";

function msg(partial: Partial<NirMessage> & { role: NirMessage["role"] }): NirMessage {
  return {
    content: "",
    timestamp: null,
    toolName: null,
    toolInput: null,
    toolCallId: null,
    model: null,
    thinking: null,
    agent: null,
    agentLabel: null,
    ...partial,
  } as NirMessage;
}

function session(messages: NirMessage[]): NirSession {
  return {
    id: "s1",
    source: "test",
    sourceVersion: null,
    title: null,
    model: null,
    cost: null,
    projectPath: "/p",
    startedAt: null,
    endedAt: null,
    messages,
    rawMeta: {},
  } as NirSession;
}

describe("enrichSession — error detection", () => {
  test("a source-reported error is authoritative", () => {
    const s = session([
      msg({
        role: "tool",
        content: "",
        toolCallId: "t1",
        toolResult: {
          status: "error",
          method: "source_status",
          errorText: "File not found",
          detail: {},
        },
      }),
    ]);
    const stats = enrichSession(s);
    expect(stats.hasError).toBe(true);
    expect(stats.errorTypes).toEqual(["source_source_status"]);
  });

  test("a source-reported SUCCESS wins over error-looking content", () => {
    // The regression this whole change exists for. Measured on real opencode
    // sessions: 206 regex hits, 0 confirmed by a source verdict, and every one
    // of those had the source saying `success`. Agent output quotes failure text
    // constantly — a file containing "# check if compilation failed", an enum
    // listing "FAILED", a Rust test harness printing its own name table.
    const s = session([
      msg({
        role: "tool",
        content:
          "test result: FAILED. 0 passed; 8 failed\n" +
          "enum { DONE, FAILED } description: Defaults to DONE. Return FAILED\n" +
          "# check if compilation failed\n" +
          "Traceback (most recent call last):\n" +
          "Process exited with code 1",
        toolCallId: "t1",
        toolResult: { status: "success", method: "source_status", errorText: null, detail: {} },
      }),
    ]);
    const stats = enrichSession(s);
    expect(stats.hasError).toBe(false);
    expect(stats.errorTypes).toEqual([]);
  });

  test("a user pasting a failure log is NOT an agent error", () => {
    const s = session([
      msg({
        role: "user",
        content: "here is my log:\nFAILED tests/test_x.py\nTraceback (most recent call last):",
      }),
    ]);
    expect(enrichSession(s).hasError).toBe(false);
  });

  test("the regex fallback still fires when the source says nothing", () => {
    // Codex and hermes expose no verdict at all; without this the fallback would
    // be dead code and those sources would report zero errors forever.
    const s = session([msg({ role: "tool", content: "FAILED tests/test_x.py", toolCallId: "t1" })]);
    const stats = enrichSession(s);
    expect(stats.hasError).toBe(true);
    expect(stats.errorTypes).toEqual(["test_failure"]);
  });

  test("oversized tool output is skipped by the fallback", () => {
    const s = session([msg({ role: "tool", content: "FAILED ".repeat(20_000) })]);
    expect(enrichSession(s).hasError).toBe(false);
  });
});
