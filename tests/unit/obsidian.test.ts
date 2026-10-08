import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  digestOf,
  renderVault,
  slugify,
  type VaultRow,
  writeVault,
} from "../../src/output/obsidian.ts";

function row(over: Partial<VaultRow> = {}): VaultRow {
  return {
    source: "opencode",
    id: "session-id-0001",
    projectPath: "/home/u/proj-a",
    localPath: null,
    startedAt: "2026-10-01T10:00:00Z",
    endedAt: "2026-10-01T11:00:00Z",
    model: "claude-x",
    tokensIn: 1200,
    tokensOut: 300,
    tokensCache: 500,
    tokenSource: "reported",
    cost: null,
    rounds: 3,
    filesJson: '["src/a.ts","src/b.ts"]',
    additions: 10,
    deletions: 2,
    hasError: 0,
    tagsJson: '["bug_fix"]',
    raw: null,
    title: "修复登录崩溃",
    goal: "帮我修一下登录页的崩溃",
    ...over,
  };
}

describe("slugify", () => {
  test("keeps CJK, collapses punctuation, trims dashes", () => {
    expect(slugify("修复 login 崩溃!")).toBe("修复-login-崩溃");
    expect(slugify("  --weird//path\\\\name-- ")).toBe("weird-path-name");
    expect(slugify("!!!")).toBe("session");
  });
});

describe("digestOf", () => {
  test("title from session.title, goal from first user message", () => {
    const d = digestOf({
      title: "  我的标题  ",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "  帮我做 X  " },
        { role: "assistant", content: "好" },
      ],
    });
    expect(d.title).toBe("我的标题");
    expect(d.goal).toBe("帮我做 X");
  });

  test("tolerates null, non-object and missing messages", () => {
    expect(digestOf(null)).toEqual({ title: null, goal: null });
    expect(digestOf("junk")).toEqual({ title: null, goal: null });
    expect(digestOf({ title: "t" })).toEqual({ title: "t", goal: null });
  });
});

describe("renderVault", () => {
  test("produces Home, project and session files with frontmatter", () => {
    const files = renderVault([row()]);
    expect(files.has("Home.md")).toBe(true);
    const projectFile = files.get("Projects/proj-a.md");
    expect(projectFile).toBeDefined();
    expect(projectFile).toContain("sessions: 1");
    const sessionPaths = [...files.keys()].filter((k) => k.startsWith("Sessions/"));
    expect(sessionPaths).toHaveLength(1);
    const session = files.get(sessionPaths[0] ?? "") ?? "";
    expect(sessionPaths[0]).toMatch(/^Sessions\/proj-a\/2026-10-01_修复登录崩溃_.+\.md$/);
    expect(session).toContain('source: "opencode"');
    expect(session).toContain('project: "[[proj-a]]"');
    expect(session).toContain("## 目标");
    expect(session).toContain('tags: ["bug_fix"]');
  });

  test("every wikilink resolves to a file in the vault", () => {
    const files = renderVault([
      row(),
      row({ id: "session-id-0002", title: "另一件事", startedAt: "2026-09-30T09:00:00Z" }),
      row({ id: "x".repeat(100), projectPath: null, title: null, goal: null }),
    ]);
    for (const [path, content] of files) {
      for (const m of content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
        const target = m[1] ?? "";
        const exists =
          files.has(`Projects/${target}.md`) ||
          [...files.keys()].some((k) => k.endsWith(`/${target}.md`));
        expect(exists, `broken wikilink [[${target}]] in ${path}`).toBe(true);
      }
    }
  });

  test("null projectPath lands in _unknown", () => {
    const files = renderVault([row({ projectPath: null, title: "t" })]);
    expect(files.has("Projects/_unknown.md")).toBe(true);
    expect([...files.keys()].some((k) => k.startsWith("Sessions/_unknown/"))).toBe(true);
  });

  test('root-like projectPath ("/", "C:\\") is treated as unknown, never as a file named "/"', () => {
    const files = renderVault([
      row({ projectPath: "/", id: "root-1", title: "at root" }),
      row({ projectPath: "C:\\", id: "root-2", title: "at drive root" }),
    ]);
    expect(files.has("Projects/_unknown.md")).toBe(true);
    for (const k of files.keys()) {
      expect(k.includes("//")).toBe(false);
    }
    const session = [...files.values()].find((c) => c.includes("at root")) ?? "";
    expect(session).toContain('project_path: "/"');
  });

  test("same-basename projects are disambiguated deterministically", () => {
    const rows = [
      row({ projectPath: "/home/a/work", id: "aaa111", title: "a" }),
      row({ projectPath: "C:\\Users\\x\\work", id: "bbb222", title: "b" }),
    ];
    const first = renderVault(rows);
    const second = renderVault(rows);
    expect(first.has("Projects/work.md")).toBe(true);
    expect(first.has("Projects/work-2.md")).toBe(true);
    expect([...first.keys()].sort()).toEqual([...second.keys()].sort());
  });

  test("machine suffix is split out of the source", () => {
    const files = renderVault([row({ source: "hermes@wsl-UbuntuRecover" })]);
    const session = [...files.values()].find((c) => c.includes("machine:")) ?? "";
    expect(session).toContain('source: "hermes"');
    expect(session).toContain('machine: "wsl-UbuntuRecover"');
  });

  test("missing title and goal still yields a file with no 目标 section", () => {
    const files = renderVault([row({ title: null, goal: null })]);
    const session = [...files.values()].find((c) => c.includes("# session")) ?? "";
    expect(session).not.toContain("## 目标");
    expect(session).toContain("## 统计");
  });
});

describe("writeVault", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  test("writes files and manifest, then removes stale files on the next run", async () => {
    dir = mkdtempSync(join(tmpdir(), "sf-vault-"));
    const first = new Map([
      ["Home.md", "home"],
      ["Projects/a.md", "a"],
    ]);
    const r1 = await writeVault(dir, first);
    expect(r1.written).toBe(2);
    expect(existsSync(join(dir, ".session-forge-manifest.json"))).toBe(true);

    writeFileSync(join(dir, "notes.md"), "user content");
    const second = new Map([["Home.md", "home2"]]);
    const r2 = await writeVault(dir, second);
    expect(r2.removed).toBe(1);
    expect(existsSync(join(dir, "Projects/a.md"))).toBe(false);
    // Files outside the manifest are never touched.
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("user content");
    expect(readFileSync(join(dir, "Home.md"), "utf8")).toBe("home2");
  });
});
