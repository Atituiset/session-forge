import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NirSession } from "../../src/nir/schema.ts";
import { relaySession } from "../../src/relay.ts";

function makeHome(): string {
  return mkdtempSync(path.join(tmpdir(), "sf-relay-"));
}

function makeSession(overrides: Partial<NirSession> = {}): NirSession {
  return {
    id: "ses_relaytest",
    source: "opencode",
    sourceVersion: null,
    projectPath: "/home/ci/proj-alpha",
    startedAt: "2026-08-20T10:00:00.000Z",
    endedAt: "2026-08-20T10:05:00.000Z",
    messages: [
      {
        role: "user",
        content: "fix the flaky test",
        timestamp: "2026-08-20T10:00:00.000Z",
        toolName: null,
        toolInput: null,
        model: null,
        thinking: null,
      },
      {
        role: "assistant",
        content: "done — the cause was a race in beforeEach",
        timestamp: "2026-08-20T10:01:00.000Z",
        toolName: null,
        toolInput: null,
        model: "kimi-k2",
        thinking: "let me look at the test setup",
      },
    ],
    rawMeta: {},
    ...overrides,
  };
}

function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// Repo lint forbids non-null assertions — fail loudly with a helper instead.
function firstFile(files: string[]): string {
  const f = files[0];
  if (!f) throw new Error("expected a written file");
  return f;
}

function readJsonLines(file: string): { payload?: Record<string, unknown>; type?: string }[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, never>);
}

describe("relaySession", () => {
  test("codex-family target: writes a rollout jsonl under ~/.codex with the original id", () => {
    const home = makeHome();
    const result = relaySession(makeSession(), "codex", { homeDir: home, withNote: false });
    expect(result.target).toBe("codex");
    expect(result.sessionId).toBe("ses_relaytest");
    expect(result.files).toHaveLength(1);
    const file = firstFile(result.files);
    expect(file.startsWith(path.join(home, ".codex", "sessions"))).toBe(true);
    expect(file.endsWith(".jsonl")).toBe(true);
    const meta = readJsonLines(file)[0];
    expect(meta?.type).toBe("session_meta");
    expect(meta?.payload?.id).toBe("ses_relaytest");
    expect(meta?.payload?.cwd).toBe("/home/ci/proj-alpha");
    expect(result.messagesConverted).toBe(2);
    expect(result.resumeHint).toContain("codex resume");
  });

  test("claude-code target: non-UUID source id is re-minted to a UUID everywhere", () => {
    const home = makeHome();
    const result = relaySession(makeSession(), "claude-code", { homeDir: home, withNote: false });
    expect(result.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    const file = firstFile(result.files);
    expect(file).toBe(
      path.join(home, ".claude", "projects", "-home-ci-proj-alpha", `${result.sessionId}.jsonl`),
    );
    for (const line of readFileSync(file, "utf8").trim().split("\n")) {
      expect(JSON.parse(line).sessionId).toBe(result.sessionId);
    }
    expect(result.resumeHint).toBe(`cd <项目目录> && claude --resume ${result.sessionId}`);
  });

  test("claude-code target: an already-UUID id is kept (idempotent re-relay)", () => {
    const home = makeHome();
    const id = "11111111-2222-4333-8444-555555555555";
    const result = relaySession(makeSession({ id }), "claude-code", {
      homeDir: home,
      withNote: false,
    });
    expect(result.sessionId).toBe(id);
  });

  test("handover note is appended by default and can be disabled", () => {
    const home = makeHome();
    const withNote = relaySession(makeSession(), "codex", { homeDir: home });
    const lines = readJsonLines(firstFile(withNote.files));
    const last = lines[lines.length - 1];
    const content = (last?.payload?.content as { text: string }[] | undefined)?.[0]?.text ?? "";
    expect(last?.payload?.role).toBe("user");
    expect(content).toContain("[SessionForge 接力]");
    expect(content).toContain("ses_relaytest");

    const home2 = makeHome();
    const without = relaySession(makeSession(), "codex", { homeDir: home2, withNote: false });
    const lines2 = readJsonLines(firstFile(without.files));
    expect(lines2[lines2.length - 1]?.payload?.role).toBe("assistant");
  });

  test("refuses to overwrite an existing projection unless forced", () => {
    const home = makeHome();
    relaySession(makeSession(), "codex", { homeDir: home });
    expect(() => relaySession(makeSession(), "codex", { homeDir: home })).toThrow(/目标文件已存在/);
    // With force the same destination is rewritten cleanly.
    const again = relaySession(makeSession(), "codex", { homeDir: home, force: true });
    expect(walk(path.join(home, ".codex"))).toEqual(again.files);
  });

  test("rejects unknown targets and relaying a tool onto itself", () => {
    const home = makeHome();
    expect(() => relaySession(makeSession(), "opencode", { homeDir: home })).toThrow(
      /不支持的接力目标/,
    );
    expect(() =>
      relaySession(makeSession({ source: "codex" }), "codex", { homeDir: home }),
    ).toThrow(/无需接力/);
  });
});
