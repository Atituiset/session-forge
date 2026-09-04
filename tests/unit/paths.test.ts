import { describe, expect, test } from "bun:test";
import { adapterForSource, parentDir, resolveProjectRoot, tomnt } from "../../src/paths.ts";
import type { Transport } from "../../src/transport/types.ts";

/** Minimal fake transport: knows a set of paths that "exist". */
function fakeTransport(existing: Set<string>): Transport {
  return {
    kind: "ssh",
    label: "ssh:fake",
    canExec: false,
    async host() {
      return { platform: "linux", homeDir: "/home/t", env: {} };
    },
    async exists(p) {
      return existing.has(p);
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
  };
}

describe("path bridging", () => {
  test("tomnt converts Windows drive paths", () => {
    expect(tomnt("C:\\Users\\x\\proj")).toBe("/mnt/c/Users/x/proj");
    expect(tomnt("D:/code")).toBe("/mnt/d/code");
    expect(tomnt("/home/nope")).toBeNull();
  });

  test("parentDir walks both posix and drive paths, stops at roots", () => {
    expect(parentDir("/a/b/c")).toBe("/a/b");
    expect(parentDir("/a")).toBe("/");
    expect(parentDir("/")).toBeNull();
    expect(parentDir("C:/Users/x")).toBe("C:/Users");
    expect(parentDir("C:\\Users\\x\\proj")).toBe("C:/Users/x");
    expect(parentDir("C:/")).toBeNull();
  });

  test("adapterForSource picks the right twin mapping per engine platform", () => {
    const wslGuest = adapterForSource("codex@wsl-Ubuntu", "win32");
    expect(wslGuest.local("/home/t/p")).toBe("//wsl.localhost/Ubuntu/home/t/p");
    const winHost = adapterForSource("codex@windows-host", "linux");
    expect(winHost.local("C:\\Users\\t\\p")).toBe("/mnt/c/Users/t/p");
    // plain local and ssh remotes have no twin
    expect(adapterForSource("codex", "win32").local("/x")).toBeNull();
    expect(adapterForSource("codex@devbox", "win32").local("/x")).toBeNull();
  });

  test("resolveProjectRoot walks up to the nearest .git", async () => {
    const git = new Set(["/home/t/proj/.git"]);
    const root = await resolveProjectRoot(
      fakeTransport(git),
      adapterForSource("codex", "linux"),
      "/home/t/proj/apps/web",
    );
    expect(root).toBe("/home/t/proj");
  });

  test("resolveProjectRoot prefers the INNER repo when nested", async () => {
    const git = new Set(["/home/t/proj/.git", "/home/t/proj/vendor/inner/.git"]);
    const root = await resolveProjectRoot(
      fakeTransport(git),
      adapterForSource("codex", "linux"),
      "/home/t/proj/vendor/inner/src",
    );
    expect(root).toBe("/home/t/proj/vendor/inner");
  });

  test("resolveProjectRoot falls back to the input without .git anywhere", async () => {
    const root = await resolveProjectRoot(
      fakeTransport(new Set()),
      adapterForSource("codex", "linux"),
      "/home/t/loose/dir",
    );
    expect(root).toBe("/home/t/loose/dir");
  });

  test("resolveProjectRoot probes across the WSL boundary", async () => {
    // Engine on Windows, session ran in WSL: probe path gets the UNC prefix.
    const git = new Set(["//wsl.localhost/Ubuntu/home/t/proj/.git"]);
    const root = await resolveProjectRoot(
      fakeTransport(git),
      adapterForSource("codex@wsl-Ubuntu", "win32"),
      "/home/t/proj/sub",
    );
    expect(root).toBe("/home/t/proj");
  });

  test("resolveProjectRoot probes /mnt/c for windows-host sessions on linux", async () => {
    const git = new Set(["/mnt/c/Users/t/proj/.git"]);
    const root = await resolveProjectRoot(
      fakeTransport(git),
      adapterForSource("codex@windows-host", "linux"),
      "C:\\Users\\t\\proj\\sub",
    );
    expect(root).toBe("C:/Users/t/proj");
  });
});
