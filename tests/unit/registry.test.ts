import { describe, expect, test } from "bun:test";
import {
  type CandidateProbe,
  expandHome,
  heuristicCandidatesFor,
  resolveCandidates,
  TOOLS,
} from "../../src/registry.ts";

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
    expect(
      guest.some(
        (c) =>
          c.pattern === "//wsl.localhost/Ubuntu/home/atituiset/.local/share/opencode/opencode.db",
      ),
    ).toBe(true); // sqlite included — discovery routes it to the wsl-agent scan
  });

  test("every tool spec declares at least one linux path", () => {
    for (const spec of TOOLS) {
      expect(spec.paths.linux?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("heuristic discovery finds unknown tool dirs by signature", async () => {
    const files = new Set(["/home/t/.acmecode/session_index.jsonl", "/home/t/.oc/opencode.db"]);
    const dirTree: Record<string, { name: string; isDirectory: boolean }[]> = {
      "/home/t": [
        { name: ".acmecode", isDirectory: true },
        { name: ".codex", isDirectory: true }, // known — must be skipped
        { name: ".chatty", isDirectory: true }, // claude-shape
        { name: ".oc", isDirectory: true },
        { name: ".config", isDirectory: true }, // no signature
        { name: "Projects", isDirectory: true }, // not a dotdir
        { name: ".zshrc", isDirectory: false }, // file, not dir
      ],
      "/home/t/.chatty/projects": [{ name: "-home-t-x", isDirectory: true }],
      "/home/t/.acmecode/sessions": [],
    };
    const probe: CandidateProbe = {
      exists: async (p) => files.has(p),
      listDir: async (p) => dirTree[p] ?? null,
    };
    const found = await heuristicCandidatesFor("/home/t", "", probe);
    const ids = found.map((c) => c.toolId);
    expect(ids).toContain("acmecode");
    expect(ids).toContain("chatty");
    expect(ids).toContain("oc");
    expect(ids).not.toContain("codex");
    expect(ids).not.toContain("config");
    const acme = found.find((c) => c.toolId === "acmecode");
    expect(acme?.family).toBe("codex-family");
    expect(found.find((c) => c.toolId === "chatty")?.pattern).toBe(
      "/home/t/.chatty/projects/*/*.jsonl",
    );
    expect(found.find((c) => c.toolId === "oc")?.family).toBe("opencode-sqlite");
  });

  test("heuristic discovery applies the machine suffix for overlays", async () => {
    const files = new Set(["//wsl.localhost/Ubuntu/home/t/.tinyllm/session_index.jsonl"]);
    const probe: CandidateProbe = {
      exists: async (p) => files.has(p),
      listDir: async (p) =>
        p === "//wsl.localhost/Ubuntu/home/t" ? [{ name: ".tinyllm", isDirectory: true }] : null,
    };
    const found = await heuristicCandidatesFor(
      "//wsl.localhost/Ubuntu/home/t",
      "@wsl-Ubuntu",
      probe,
    );
    expect(found.map((f) => f.toolId)).toEqual(["tinyllm@wsl-Ubuntu", "tinyllm@wsl-Ubuntu"]);
    expect(found.find((f) => f.pattern.endsWith("/sessions/**/*.jsonl"))?.pattern).toContain(
      "//wsl.localhost/Ubuntu/home/t/.tinyllm/sessions/",
    );
  });
});
