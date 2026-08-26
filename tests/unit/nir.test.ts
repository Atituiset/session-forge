import { describe, expect, test } from "bun:test";
import { makeNirSession, nirSessionSchema } from "../../src/nir/schema.ts";

const validSession = {
  id: "s1",
  source: "codex",
  sourceVersion: "0.118.0",
  projectPath: "/home/u/proj",
  startedAt: "2026-04-04T15:24:06.895Z",
  endedAt: null,
  messages: [
    {
      role: "user",
      content: "fix the bug",
      timestamp: "2026-04-04T15:24:07.000Z",
      toolName: null,
      toolInput: null,
      model: null,
    },
  ],
};

describe("nir schema", () => {
  test("accepts a minimal valid session", () => {
    const s = makeNirSession(validSession);
    expect(s.id).toBe("s1");
    expect(s.rawMeta).toEqual({});
    expect(s.messages[0]?.role).toBe("user");
    expect(s.messages[0]?.thinking).toBeNull();
  });

  test("defaults token usage fields to zero", () => {
    const s = makeNirSession({
      ...validSession,
      messages: [
        {
          ...validSession.messages[0],
          tokens: { input: 10 },
        },
      ],
    });
    expect(s.messages[0]?.tokens).toEqual({
      input: 10,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  test("rejects unknown role", () => {
    const bad = {
      ...validSession,
      messages: [{ ...validSession.messages[0], role: "alien" }],
    };
    expect(nirSessionSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects session without messages", () => {
    const bad = { ...validSession, messages: [] };
    expect(nirSessionSchema.safeParse(bad).success).toBe(false);
  });
});
