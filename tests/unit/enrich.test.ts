import { describe, expect, test } from "bun:test";
import { enrichSession } from "../../src/enrich/index.ts";
import type { NirSession } from "../../src/nir/schema.ts";

function sessionWith(
  messages: NirSession["messages"],
  rawMeta: NirSession["rawMeta"] = {},
): NirSession {
  return {
    id: "t",
    source: "test",
    sourceVersion: null,
    projectPath: null,
    startedAt: "2026-01-01T10:00:00Z",
    endedAt: "2026-01-01T10:10:00Z",
    messages,
    rawMeta,
  };
}

const base = {
  timestamp: null,
  model: null,
  tokens: undefined,
  toolName: null,
  toolInput: null,
};

describe("enrich", () => {
  test("counts rounds and estimates tokens when unreported", () => {
    const s = sessionWith([
      { ...base, role: "user", content: "fix it" },
      { ...base, role: "assistant", content: "done" },
      { ...base, role: "user", content: "thanks" },
    ]);
    const stats = enrichSession(s);
    expect(stats.rounds).toBe(2);
    expect(stats.tokenSource).toBe("estimated");
    expect(stats.tokensIn).toBeGreaterThan(0);
    expect(stats.durationMs).toBe(600_000);
  });

  test("uses reported tokens when available", () => {
    const s = sessionWith([
      {
        ...base,
        role: "assistant",
        content: "x",
        tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0 },
      },
    ]);
    const stats = enrichSession(s);
    expect(stats.tokenSource).toBe("reported");
    expect(stats.tokensIn).toBe(100);
    expect(stats.tokensOut).toBe(20);
  });

  test("extracts files from Edit/Write inputs", () => {
    const s = sessionWith([
      {
        ...base,
        role: "assistant",
        toolName: "Edit",
        toolInput: { filePath: "/a/b.ts", old_string: "x", new_string: "y" },
        content: "",
      },
      {
        ...base,
        role: "assistant",
        toolName: "Write",
        toolInput: { filePath: "/c/d.py", content: "line1\nline2" },
        content: "",
      },
    ]);
    const stats = enrichSession(s);
    expect(stats.filesTouched.sort()).toEqual(["/a/b.ts", "/c/d.py"]);
    expect(stats.additions).toBe(3);
    expect(stats.deletions).toBe(1);
  });

  test("extracts files and diff from apply_patch raw", () => {
    const patch =
      "*** Begin Patch\n*** Update File: src/a.md\n@@\n-old line\n+new line\n+newer\n*** End Patch";
    const s = sessionWith([
      {
        ...base,
        role: "assistant",
        toolName: "apply_patch",
        toolInput: { raw: patch },
        content: "",
      },
    ]);
    const stats = enrichSession(s);
    expect(stats.filesTouched).toEqual(["src/a.md"]);
    expect(stats.additions).toBe(2);
    expect(stats.deletions).toBe(1);
  });

  test("prefers authoritative rawMeta additions (opencode)", () => {
    const s = sessionWith([{ ...base, role: "user", content: "hi" }], {
      additions: 42,
      deletions: 7,
      patchFiles: ["/p/x.go"],
    });
    const stats = enrichSession(s);
    expect(stats.additions).toBe(42);
    expect(stats.deletions).toBe(7);
    expect(stats.filesTouched).toEqual(["/p/x.go"]);
  });

  test("detects error patterns in tool outputs", () => {
    const s = sessionWith([
      { ...base, role: "tool", content: "ENOENT: no such file or directory, open '/x'" },
      { ...base, role: "tool", content: "Process exited with code 1" },
    ]);
    const stats = enrichSession(s);
    expect(stats.hasError).toBe(true);
    expect(stats.errorTypes).toContain("ENOENT");
    expect(stats.errorTypes).toContain("nonzero_exit");
  });
});

describe("intent rules", () => {
  test("classifies by keywords", async () => {
    const { ruleClassify } = await import("../../src/llm_enrich/intent.ts");
    expect(ruleClassify("fix the login crash")).toBe("bug_fix");
    expect(ruleClassify("update the README docs")).toBe("documentation");
    expect(ruleClassify("refactor the auth module")).toBe("refactor");
    expect(ruleClassify("what is this function doing?")).toBe("question");
    expect(ruleClassify("add a new export button")).toBe("feature_add");
    expect(ruleClassify("修复登录报错")).toBe("bug_fix");
  });
});
