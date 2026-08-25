import { describe, expect, test } from "bun:test";
import type { NirSession } from "../src/nir/schema.ts";
import { ClaudeCodeReader } from "../src/readers/claude_code.ts";
import { CodexFamilyReader } from "../src/readers/codex_family.ts";
import type { ScanEvent } from "../src/readers/util.ts";
import { LocalTransport } from "../src/transport/local.ts";

async function collect(gen: AsyncGenerator<ScanEvent>): Promise<{
  sessions: NirSession[];
  issues: ScanEvent[];
}> {
  const sessions: NirSession[] = [];
  const issues: ScanEvent[] = [];
  for await (const e of gen) {
    if (e.kind === "session") sessions.push(e.session);
    else issues.push(e);
  }
  return { sessions, issues };
}

function first(sessions: NirSession[]): NirSession {
  const s = sessions[0];
  if (!s) throw new Error("expected at least one session");
  return s;
}

describe("codex-family reader", () => {
  test("parses codex rollout", async () => {
    const r = new CodexFamilyReader();
    const { sessions, issues } = await collect(
      r.scan(new LocalTransport(), {
        toolId: "codex",
        files: ["tests/fixtures/codex/rollout.jsonl"],
      }),
    );
    expect(issues).toHaveLength(0);
    expect(sessions).toHaveLength(1);
    const s = first(sessions);
    expect(s.id).toBe("019d5918-test");
    expect(s.projectPath).toBe("/home/u/proj");
    expect(s.sourceVersion).toBe("0.118.0");
    const roles = s.messages.map((m) => m.role);
    expect(roles.filter((x) => x === "user")).toHaveLength(1);
    expect(roles.filter((x) => x === "assistant")).toHaveLength(3);
    expect(roles.filter((x) => x === "tool")).toHaveLength(1);
    const toolMsg = s.messages.find((m) => m.toolName === "exec_command");
    expect(toolMsg?.toolInput).toEqual({ cmd: "rg login src" });
    expect(s.rawMeta.patchFiles).toEqual(["src/auth.ts"]);
    const lastAssistant = s.messages.filter((m) => m.role === "assistant").at(-1);
    expect(lastAssistant?.content).toContain("Fixed the login");
  });

  test("parses kimi wire.jsonl with agent-scoped id and tokens", async () => {
    const r = new CodexFamilyReader();
    const { sessions } = await collect(
      r.scan(new LocalTransport(), {
        toolId: "kimi-code",
        files: ["tests/fixtures/kimi/wire.jsonl"],
      }),
    );
    expect(sessions).toHaveLength(1);
    const s = first(sessions);
    expect(s.id.endsWith("/main")).toBe(true);
    expect(s.messages[0]?.content).toBe("deploy docs to gh pages");
    expect(s.messages[0]?.role).toBe("user");
    const assistantWithTool = s.messages.find((m) => m.toolName === "exec_command");
    expect(assistantWithTool?.toolInput).toEqual({ cmd: "mkdocs gh-deploy" });
    expect(s.rawMeta.projectHint).toBeUndefined();
  });

  test("parses codewhale single-file json", async () => {
    const r = new CodexFamilyReader();
    const { sessions } = await collect(
      r.scan(new LocalTransport(), {
        toolId: "codewhale",
        files: ["tests/fixtures/codewhale/session.json"],
      }),
    );
    const s = first(sessions);
    expect(s.id).toBe("session");
    expect(s.projectPath).toBe("/home/u/webapp");
    expect(s.messages).toHaveLength(3);
    const toolMsg = s.messages.find((m) => m.toolName === "read_file");
    expect(toolMsg?.toolInput).toEqual({ path: "package.json" });
  });

  test("tolerates corrupt file without throwing", async () => {
    const r = new CodexFamilyReader();
    const { sessions, issues } = await collect(
      r.scan(new LocalTransport(), { toolId: "codewhale", files: ["/nonexistent/x.json"] }),
    );
    expect(sessions).toHaveLength(0);
    expect(issues).toHaveLength(1);
  });
});

describe("claude-code reader", () => {
  test("parses messages, tokens, sidechain skip", async () => {
    const r = new ClaudeCodeReader();
    const { sessions } = await collect(
      r.scan(new LocalTransport(), {
        toolId: "claude-code",
        files: ["tests/fixtures/claude/session.jsonl"],
      }),
    );
    expect(sessions).toHaveLength(1);
    const s = first(sessions);
    expect(s.id).toBe("session");
    expect(s.projectPath).toBe("/home/u/api");
    expect(s.sourceVersion).toBe("2.1.0");
    expect(s.startedAt).toBe("2026-05-01T10:00:00.000Z");
    const roles = s.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "assistant", "tool"]);
    expect(s.rawMeta.sidechainMessages).toBe(1);
    expect(s.projectPath).toBe("/home/u/api");
    const editMsg = s.messages.find((m) => m.toolName === "Edit");
    expect(editMsg?.toolInput).toEqual({
      filePath: "/home/u/api/src/app.ts",
      old_string: "a",
      new_string: "b",
    });
    const assistant = s.messages.find((m) => m.role === "assistant" && m.tokens);
    expect(assistant?.tokens).toEqual({ input: 5000, output: 120, cacheRead: 800, cacheWrite: 0 });
  });

  test("decodes project slug from path", async () => {
    const r = new ClaudeCodeReader();
    const { sessions } = await collect(
      r.scan(new LocalTransport(), {
        toolId: "claude-code",
        files: ["tests/fixtures/claude/session.jsonl"],
      }),
    );
    expect(sessions[0]?.rawMeta.slugProject).toBeNull();
  });
});
