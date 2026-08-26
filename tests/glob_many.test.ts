import { describe, expect, test } from "bun:test";

import { findWholenameToRegex, globToFind } from "../src/transport/ssh.ts";

describe("globToFind + wholename matcher", () => {
  test("single-star pattern: remote fnmatch semantics (star crosses /)", () => {
    const spec = globToFind("/home/u/.claude/projects/*/*.jsonl");
    const re = findWholenameToRegex(spec.wholename);
    expect(re.test("/home/u/.claude/projects/abc/session.jsonl")).toBe(true);
    // find -wholename uses fnmatch without FNM_PATHNAME, so a bare * also
    // matches slashes — mirror that so client-side attribution agrees with
    // what the remote find actually returns.
    expect(re.test("/home/u/.claude/projects/abc/deep/session.jsonl")).toBe(true);
  });

  test("** pattern matches across segments up to maxdepth", () => {
    const spec = globToFind("/home/u/.codex/sessions/**/*.jsonl");
    const re = findWholenameToRegex(spec.wholename);
    expect(re.test("/home/u/.codex/sessions/2026/08/rollout-x.jsonl")).toBe(true);
  });

  test("literal path (no star) yields exact wholename", () => {
    const spec = globToFind("/home/u/.local/share/opencode/opencode.db");
    expect(spec.wholename).toBe("/home/u/.local/share/opencode/opencode.db");
    const re = findWholenameToRegex(spec.wholename);
    expect(re.test("/home/u/.local/share/opencode/opencode.db")).toBe(true);
    expect(re.test("/home/u/.local/share/opencode/other.db")).toBe(false);
  });
});
