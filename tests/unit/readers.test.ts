import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NirSession } from "../../src/nir/schema.ts";
import { ClaudeCodeReader } from "../../src/readers/claude_code.ts";
import { CodexFamilyReader } from "../../src/readers/codex_family.ts";
import type { ScanEvent } from "../../src/readers/util.ts";
import { LocalTransport } from "../../src/transport/local.ts";

// These tests pin the ADAPTER contract (file I/O → package parser → ScanEvent):
// source stamping, filename dispatch, rev computation, issue reporting, and
// toolCallId pairing. Transcript-parsing details are covered by the
// agent-session-format package's own test suite.

async function collect(gen: AsyncGenerator<ScanEvent>): Promise<{
  sessions: Extract<ScanEvent, { kind: "session" }>[];
  issues: Extract<ScanEvent, { kind: "issue" }>[];
}> {
  const sessions: Extract<ScanEvent, { kind: "session" }>[] = [];
  const issues: Extract<ScanEvent, { kind: "issue" }>[] = [];
  for await (const e of gen) {
    if (e.kind === "session") sessions.push(e);
    else issues.push(e);
  }
  return { sessions, issues };
}

function first(sessions: Extract<ScanEvent, { kind: "session" }>[]): NirSession {
  const s = sessions[0];
  if (!s) throw new Error("expected at least one session");
  return s.session;
}

describe("codex-family adapter", () => {
  test("dispatches rollout .jsonl and stamps source/rev/sourceFile", async () => {
    const r = new CodexFamilyReader();
    const { sessions, issues } = await collect(
      r.scan(new LocalTransport(), {
        toolId: "codex",
        files: ["tests/fixtures/codex/rollout.jsonl"],
      }),
    );
    expect(issues).toHaveLength(0);
    expect(sessions).toHaveLength(1);
    const ev = sessions[0];
    if (!ev) throw new Error("expected a session event");
    expect(ev.sourceFile).toBe("tests/fixtures/codex/rollout.jsonl");
    expect(ev.rev).toBeGreaterThan(0);
    const s = ev.session;
    expect(s.source).toBe("codex");
    expect(s.id).toBe("019d5918-test");
    expect(s.projectPath).toBe("/home/u/proj");
    // Tool calls and their results pair via toolCallId.
    const call = s.messages.find((m) => m.role === "assistant" && m.toolName === "exec_command");
    expect(call?.toolCallId).toBe("call_01");
    const result = s.messages.find((m) => m.role === "tool");
    expect(result?.toolCallId).toBe(call?.toolCallId);
  });

  test("dispatches wire.jsonl to the kimi parser (agent-scoped id)", async () => {
    const r = new CodexFamilyReader();
    const { sessions, issues } = await collect(
      r.scan(new LocalTransport(), {
        toolId: "kimi-code",
        files: ["tests/fixtures/kimi/wire.jsonl"],
      }),
    );
    expect(issues).toHaveLength(0);
    const s = first(sessions);
    expect(s.source).toBe("kimi-code");
    expect(s.id.endsWith("/main")).toBe(true);
    expect(s.messages[0]?.content).toBe("deploy docs to gh pages");
  });

  test("dispatches .json to the session-document parser", async () => {
    const r = new CodexFamilyReader();
    const { sessions, issues } = await collect(
      r.scan(new LocalTransport(), {
        toolId: "codewhale",
        files: ["tests/fixtures/codewhale/session.json"],
      }),
    );
    expect(issues).toHaveLength(0);
    const s = first(sessions);
    expect(s.source).toBe("codewhale");
    expect(s.id).toBe("session");
    const call = s.messages.find((m) => m.toolName === "read_file");
    expect(call?.toolCallId).toBe("call_a");
  });

  test("unreadable file yields an issue event instead of throwing", async () => {
    const r = new CodexFamilyReader();
    const { sessions, issues } = await collect(
      r.scan(new LocalTransport(), { toolId: "codex", files: ["/nonexistent/x.jsonl"] }),
    );
    expect(sessions).toHaveLength(0);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("/nonexistent/x.jsonl");
  });

  test("corrupt .json document yields an issue event", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sf-reader-"));
    const bad = path.join(dir, "broken.json");
    writeFileSync(bad, "{ not json");
    const r = new CodexFamilyReader();
    const { sessions, issues } = await collect(
      r.scan(new LocalTransport(), { toolId: "codewhale", files: [bad] }),
    );
    expect(sessions).toHaveLength(0);
    expect(issues).toHaveLength(1);
  });
});

describe("claude-code adapter", () => {
  test("emits a session event with source, rev and decoded project path", async () => {
    const r = new ClaudeCodeReader();
    const { sessions, issues } = await collect(
      r.scan(new LocalTransport(), {
        toolId: "claude-code",
        files: ["tests/fixtures/claude/session.jsonl"],
      }),
    );
    expect(issues).toHaveLength(0);
    expect(sessions).toHaveLength(1);
    const ev = sessions[0];
    if (!ev) throw new Error("expected a session event");
    expect(ev.sourceFile).toBe("tests/fixtures/claude/session.jsonl");
    expect(ev.rev).toBeGreaterThan(0);
    const s = ev.session;
    expect(s.source).toBe("claude-code");
    expect(s.id).toBe("session");
    expect(s.projectPath).toBe("/home/u/api");
  });

  test("tool results pair via toolCallId, not a fake toolu: toolName", async () => {
    const r = new ClaudeCodeReader();
    const { sessions } = await collect(
      r.scan(new LocalTransport(), {
        toolId: "claude-code",
        files: ["tests/fixtures/claude/session.jsonl"],
      }),
    );
    const s = first(sessions);
    const call = s.messages.find((m) => m.role === "assistant" && m.toolName === "Edit");
    expect(call?.toolCallId).toBe("t1");
    const result = s.messages.find((m) => m.role === "tool");
    expect(result?.toolCallId).toBe("t1");
    // The old `toolu:<id>` encoding in toolName is gone.
    expect(result?.toolName).toBeNull();
    expect(s.messages.some((m) => m.toolName?.startsWith("toolu:"))).toBe(false);
  });
});
