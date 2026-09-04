import { describe, expect, test } from "bun:test";
import { channelApi, ensureAgent, probeAgent, wslChannelFromUnc } from "../../src/agent.ts";
import type { Transport } from "../../src/transport/types.ts";

/** Minimal fake transport: routes "commands" through an in-memory shell. */
function fakeTransport(run: (argv: string[]) => { exitCode: number; stdout: string }): Transport {
  return {
    kind: "local",
    label: "local",
    canExec: true,
    async host() {
      return { platform: "win32", homeDir: "C:/Users/t", env: {} };
    },
    async exists() {
      return true;
    },
    async readTextFile() {
      throw new Error("unused");
    },
    async readBinaryFile() {
      throw new Error("unused");
    },
    async listDir() {
      return null;
    },
    async glob() {
      return [];
    },
    async exec(argv) {
      const r = run(argv);
      return { ...r, stderr: "" };
    },
  };
}

describe("agent channel", () => {
  test("wslChannelFromUnc parses distro from UNC paths", () => {
    expect(wslChannelFromUnc("//wsl.localhost/Ubuntu/home/t/x.db")).toEqual({
      kind: "wsl",
      distro: "Ubuntu",
    });
    expect(wslChannelFromUnc("//wsl$/Ubuntu-22.04/home/t")).toEqual({
      kind: "wsl",
      distro: "Ubuntu-22.04",
    });
    expect(wslChannelFromUnc("/home/t/nope")).toBeNull();
  });

  test("wsl channel probes through wsl.exe with the distro prefix", async () => {
    const calls: string[] = [];
    const t = fakeTransport((argv) => {
      calls.push(argv.join(" "));
      if (argv[0] === "wsl.exe") {
        if (argv.includes("printenv")) return { exitCode: 0, stdout: "/home/t" };
        if (argv.at(-1)?.includes("test -x"))
          return { exitCode: 0, stdout: "/home/t/.local/bin/session-forge" };
      }
      return { exitCode: 0, stdout: "" };
    });
    const api = channelApi({ kind: "wsl", distro: "Ubuntu" }, t);
    const bin = await probeAgent(api);
    expect(bin).toBe("/home/t/.local/bin/session-forge");
    expect(calls[0]).toContain("wsl.exe -d Ubuntu --");
  });

  test("ensureAgent reports a clear error when nothing is deployable", async () => {
    const t = fakeTransport(() => ({ exitCode: 1, stdout: "" }));
    const api = channelApi({ kind: "wsl", distro: "Ubuntu" }, t);
    // In the repo cwd a bundled agent MAY exist (dist/), in which case the
    // failure surfaces from the deploy step instead — either way the result
    // must be a structured, human-readable error.
    const r = await ensureAgent(api);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(5);
  });

  test("ssh channel execs through the transport itself (no wsl.exe prefix)", async () => {
    const calls: string[] = [];
    const fakeSsh: Transport = {
      ...fakeTransport((argv) => {
        calls.push(argv.join(" "));
        return { exitCode: 0, stdout: "/root/.local/bin/session-forge" };
      }),
      kind: "ssh",
      label: "ssh:ci-box",
      canExec: true,
    };
    const api = channelApi({ kind: "ssh", hostArg: "ci-box" }, fakeSsh);
    const bin = await probeAgent(api);
    expect(bin).toBe("/root/.local/bin/session-forge");
    expect(calls[0]?.startsWith("sh -c")).toBe(true);
    expect(calls[0]).not.toContain("wsl.exe");
  });
});
