import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NirSession } from "../../src/nir/schema.ts";
import {
  type RelaySink,
  relayMachineOfSource,
  relaySession,
  relaySessionToMachine,
  sshRelaySink,
  windowsHostRelaySink,
  windowsProfileToMntDir,
  wslRelaySink,
} from "../../src/relay.ts";
import type { Transport } from "../../src/transport/types.ts";

function makeHome(): string {
  return mkdtempSync(path.join(tmpdir(), "sf-relay-"));
}

function makeSession(overrides: Partial<NirSession> = {}): NirSession {
  return {
    id: "ses_relaytest",
    source: "opencode",
    sourceVersion: null,
    title: null,
    model: null,
    cost: null,
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
        toolCallId: null,
        model: null,
        thinking: null,
        agent: null,
        agentLabel: null,
      },
      {
        role: "assistant",
        content: "done — the cause was a race in beforeEach",
        timestamp: "2026-08-20T10:01:00.000Z",
        toolName: null,
        toolInput: null,
        toolCallId: null,
        model: "kimi-k2",
        thinking: "let me look at the test setup",
        agent: null,
        agentLabel: null,
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

describe("relayMachineOfSource", () => {
  test("parses local, wsl, windows-host and ssh machine tags", () => {
    expect(relayMachineOfSource("codex")).toEqual({ kind: "local" });
    expect(relayMachineOfSource("codex@wsl-Ubuntu")).toEqual({ kind: "wsl", distro: "Ubuntu" });
    expect(relayMachineOfSource("claude-code@windows-host")).toEqual({ kind: "windows-host" });
    expect(relayMachineOfSource("opencode@lan-ubuntu")).toEqual({
      kind: "ssh",
      label: "lan-ubuntu",
    });
    // ssh labels may themselves contain @ (user@host) — split on the first @ only.
    expect(relayMachineOfSource("codex@ops@10.0.0.1")).toEqual({
      kind: "ssh",
      label: "ops@10.0.0.1",
    });
  });
});

describe("relaySessionToMachine", () => {
  const dummyTransport = {} as unknown as Transport;

  function fakeSink(existing = false): RelaySink & { written: [string, string][] } {
    const written: [string, string][] = [];
    return {
      written,
      exists: async () => existing,
      write: async (rel, content) => {
        written.push([rel, content]);
        return `fake:~/${rel}`;
      },
    };
  }

  test("wsl source: files go to the machine sink; hint is machine-prefixed", async () => {
    const sink = fakeSink();
    const result = await relaySessionToMachine(
      makeSession({ source: "codex@wsl-Ubuntu" }),
      "claude-code",
      {
        withNote: false,
        localTransport: dummyTransport,
        sinkFor: () => sink,
      },
    );
    expect(result.machine).toBe("wsl-Ubuntu");
    expect(sink.written).toHaveLength(1);
    const [rel] = sink.written[0] ?? ["", ""];
    expect(rel).toBe(`.claude/projects/-home-ci-proj-alpha/${result.sessionId}.jsonl`);
    expect(result.resumeHint).toBe(
      `（在 wsl-Ubuntu 上）cd <项目目录> && claude --resume ${result.sessionId}`,
    );
  });

  test("same tool on a DIFFERENT machine is a legal relay; local same-tool still refused", async () => {
    const sink = fakeSink();
    const result = await relaySessionToMachine(
      makeSession({ source: "codex@wsl-Ubuntu" }),
      "codex",
      {
        withNote: false,
        localTransport: dummyTransport,
        sinkFor: () => sink,
      },
    );
    expect(result.machine).toBe("wsl-Ubuntu");
    expect(sink.written).toHaveLength(1);
    await expect(
      relaySessionToMachine(makeSession({ source: "codex" }), "codex", {
        localTransport: dummyTransport,
        sinkFor: () => fakeSink(),
      }),
    ).rejects.toThrow(/无需接力/);
  });

  test("existing destination refuses without force; force overwrites", async () => {
    await expect(
      relaySessionToMachine(makeSession({ source: "codex@wsl-Ubuntu" }), "claude-code", {
        localTransport: dummyTransport,
        sinkFor: () => fakeSink(true),
      }),
    ).rejects.toThrow(/目标文件已存在/);
    const sink = fakeSink(true);
    await relaySessionToMachine(makeSession({ source: "codex@wsl-Ubuntu" }), "claude-code", {
      force: true,
      localTransport: dummyTransport,
      sinkFor: () => sink,
    });
    expect(sink.written).toHaveLength(1);
  });

  test("unknown ssh machine: clear error pointing at remotes", async () => {
    await expect(
      relaySessionToMachine(makeSession({ source: "opencode@ghost" }), "codex", {
        localTransport: dummyTransport,
        sshTransportFor: () => null,
      }),
    ).rejects.toThrow(/ghost.*remotes/);
  });
});

describe("relay sinks", () => {
  test("wslRelaySink resolves guest $HOME via wsl.exe and writes under the UNC root", async () => {
    const uncRoot = makeHome();
    const execCalls: string[][] = [];
    const transport = {
      exec: async (argv: string[]) => {
        execCalls.push(argv);
        return { exitCode: 0, stdout: "/home/u\n", stderr: "" };
      },
    } as unknown as Transport;
    const sink = wslRelaySink("Ubuntu", transport, { uncRoot });
    expect(await sink.exists(".claude/x.jsonl")).toBe(false);
    const dest = await sink.write(".claude/x.jsonl", "abc");
    expect(dest).toBe(path.join(uncRoot, "Ubuntu", "home", "u", ".claude", "x.jsonl"));
    expect(readFileSync(dest, "utf8")).toBe("abc");
    expect(await sink.exists(".claude/x.jsonl")).toBe(true);
    expect(execCalls[0]).toEqual(["wsl.exe", "-d", "Ubuntu", "--", "printenv", "HOME"]);
  });

  test("windowsProfileToMntDir maps drive paths to drvfs mounts", () => {
    expect(windowsProfileToMntDir("C:\\Users\\Tester")).toBe("/mnt/c/Users/Tester");
    expect(windowsProfileToMntDir("D:/u/me")).toBe("/mnt/d/u/me");
    expect(windowsProfileToMntDir("/home/u")).toBeNull();
  });

  test("windowsHostRelaySink writes under the resolved profile dir", async () => {
    const profile = makeHome();
    const sink = windowsHostRelaySink({} as unknown as Transport, { profileDir: profile });
    const dest = await sink.write(".claude/projects/-p/1.jsonl", "xyz");
    expect(dest).toBe(path.join(profile, ".claude", "projects", "-p", "1.jsonl"));
    expect(readFileSync(dest, "utf8")).toBe("xyz");
  });

  test("sshRelaySink stages content, deploys, then mkdir+mv guest-side", async () => {
    const tmpRoot = makeHome();
    const execCmds: string[][] = [];
    const deployed: [string, string][] = [];
    const transport = {
      label: "ssh:lan-ubuntu",
      exec: async (argv: string[]) => {
        execCmds.push(argv);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      deployFile: async (local: string, remoteRel: string) => {
        deployed.push([local, remoteRel]);
      },
    } as unknown as Transport;
    const sink = sshRelaySink(transport, { tmpDir: tmpRoot });
    expect(await sink.exists(".claude/x.jsonl")).toBe(true);
    expect(execCmds[0]?.join(" ")).toContain("test -e");
    const dest = await sink.write(".claude/projects/-p/1.jsonl", "data");
    expect(dest).toBe("lan-ubuntu:~/.claude/projects/-p/1.jsonl");
    expect(deployed).toHaveLength(1);
    const [stageFile, stageName] = deployed[0] ?? ["", ""];
    expect(stageName).toBe(".session-forge-relay-stage");
    // Staging file is cleaned up after the push.
    expect(existsSync(stageFile)).toBe(false);
    const mv = execCmds[1]?.join(" ") ?? "";
    expect(mv).toContain("mkdir -p");
    expect(mv).toContain(".claude/projects/-p");
    expect(mv).toContain("mv");
  });
});
