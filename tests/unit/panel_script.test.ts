import { describe, expect, test } from "bun:test";

// The desktop panel runs inside Tauri's webview, which injects
// non-configurable globals (`window.isTauri`, `__TAURI__`, …) before any
// page script. A top-level lexical declaration of the same name is a
// SyntaxError that kills the entire script — every button goes dead while
// the page still renders. Guard the panel script against reintroducing
// such a collision.
const TAURI_RESERVED_GLOBALS = [
  "isTauri",
  "__TAURI__",
  "__TAURI_INTERNALS__",
  "__TAURI_METADATA__",
];

describe("panel script (src-web/app.js)", () => {
  test("declares no top-level binding that collides with Tauri injected globals", async () => {
    const src = await Bun.file(new URL("../../src-web/app.js", import.meta.url)).text();
    for (const name of TAURI_RESERVED_GLOBALS) {
      const decl = new RegExp(`(?:^|[;\\n])\\s*(?:const|let|var|function)\\s+${name}\\b`);
      expect(decl.test(src)).toBe(false);
    }
  });
});
