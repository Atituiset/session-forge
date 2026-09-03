import { describe, expect, test } from "bun:test";
import { expandHome, resolveCandidates, TOOLS } from "../../src/registry.ts";

describe("registry", () => {
  test("expands ~ to injected home dir", () => {
    expect(expandHome("~/.claude/projects/*/*.jsonl", "/home/tester")).toBe(
      "/home/tester/.claude/projects/*/*.jsonl",
    );
    expect(expandHome("/absolute/path", "/home/tester")).toBe("/absolute/path");
  });

  test("resolves candidates for linux platform", () => {
    const candidates = resolveCandidates("linux", { homeDir: "/home/tester" });
    const byTool = new Map(candidates.map((c) => [c.toolId, c]));
    expect(byTool.get("opencode")?.pattern).toBe("/home/tester/.local/share/opencode/opencode.db");
    expect(byTool.get("codex")?.family).toBe("codex-family");
  });

  test("windows platform includes win32-only opencode path", () => {
    const candidates = resolveCandidates("win32", { homeDir: "C:\\Users\\tester" });
    const patterns = candidates.filter((c) => c.toolId === "opencode").map((c) => c.pattern);
    expect(patterns).toContain("C:\\Users\\tester/AppData/Local/opencode/opencode.db");
  });

  test("wsl overlay emits windows-host candidates per user dir", () => {
    const candidates = resolveCandidates("linux", {
      homeDir: "/home/tester",
      wslHostUserDirs: ["/mnt/c/Users/atituiset"],
    });
    const hostCandidates = candidates.filter((c) => c.toolId.endsWith("@windows-host"));
    expect(hostCandidates.length).toBeGreaterThan(0);
    expect(
      hostCandidates.some((c) => c.pattern === "/mnt/c/Users/atituiset/.claude/projects/*/*.jsonl"),
    ).toBe(true);
    expect(
      hostCandidates.some((c) => c.pattern === "/mnt/c/Users/atituiset/.codex/sessions/**/*.jsonl"),
    ).toBe(true);
  });

  test("wsl guest overlay emits @wsl-<distro> candidates with linux paths", () => {
    const candidates = resolveCandidates("win32", {
      homeDir: "C:\\Users\\tester",
      wslGuestUserDirs: [{ label: "wsl-Ubuntu", dir: "//wsl.localhost/Ubuntu/home/atituiset" }],
    });
    const guest = candidates.filter((c) => c.toolId.endsWith("@wsl-Ubuntu"));
    expect(guest.length).toBeGreaterThan(0);
    expect(
      guest.some(
        (c) => c.pattern === "//wsl.localhost/Ubuntu/home/atituiset/.claude/projects/*/*.jsonl",
      ),
    ).toBe(true);
    // opencode (SQLite) is intentionally skipped over UNC: file locking does
    // not work on 9P shares and multi-GB snapshots destabilize the runtime.
    expect(guest.some((c) => c.family === "opencode-sqlite")).toBe(false);
  });

  test("every tool spec declares at least one linux path", () => {
    for (const spec of TOOLS) {
      expect(spec.paths.linux?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
