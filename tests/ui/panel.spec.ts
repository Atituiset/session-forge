// @ts-check
// UI click-through tests for the desktop panel, run headlessly in CI on all
// three OSes. Drives src-web/index.html against a real engine serving seeded
// fixture data. Covers the exact classes of breakage seen in the wild:
// dead buttons (titlebar binding), scan feedback (async job protocol),
// remote machine add/delete with credentials.

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

const PORT = 4187;
const API = `http://127.0.0.1:${PORT}`;
const here = path.resolve(process.cwd(), "tests/ui"); // spec lives here
const PANEL = `file://${path.resolve(here, "../../src-web/index.html")}?api=${API}`;

let engine: ReturnType<typeof spawn> | null = null;
let dbDir = "";

test.beforeAll(async () => {
  dbDir = mkdtempSync(path.join(tmpdir(), "sf-ui-e2e-"));
  // Fixture mode keeps CI deterministic: scan reads tests/fixtures-ui instead
  // of the runner's real home directory.
  engine = spawn("./dist/session-forge", ["serve", "--port", String(PORT), "--headless"], {
    env: {
      ...process.env,
      SESSION_FORGE_TEST_FIXTURES: path.resolve(here, "fixtures-ui"),
      SESSION_FORGE_HOME: dbDir,
    },
  });
  // Wait for health.
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${API}/api/health`);
      if ((await r.json()).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("engine did not become healthy");
});

test.afterAll(async () => {
  engine?.kill();
});

// Read the CSP from tauri.conf.json at runtime so this guard can never drift
// from what production actually enforces.
import { readFileSync } from "node:fs";

const PROD_CSP: string = (() => {
  const conf = JSON.parse(
    readFileSync(path.resolve(process.cwd(), "src-tauri/tauri.conf.json"), "utf8"),
  ) as { app?: { security?: { csp?: string } } };
  return conf.app?.security?.csp ?? "";
})();

// Regression guard (the v0.1.8 "every button dead" incident): the packaged app
// enforces this CSP on tauri://localhost, which silently blocked our inline
// <script> when script-src lacked 'unsafe-inline'. Serve the panel over HTTP
// with exactly that header and require the UI to actually come alive.
test.describe("production CSP parity", () => {
  let cspServer: ReturnType<typeof import("node:http").createServer>;
  test.beforeAll(async () => {
    const http = await import("node:http");
    const fs = await import("node:fs");
    const cspPort = PORT + 1;
    const root = path.resolve(process.cwd(), "src-web");
    cspServer = http
      .createServer((req, res) => {
        const pathname = (req.url ?? "/").split("?")[0] ?? "/";
        const file = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
        const types: Record<string, string> = {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
        };
        res.writeHead(200, {
          "content-type": types[path.extname(file)] ?? "application/octet-stream",
          "content-security-policy": PROD_CSP,
        });
        fs.createReadStream(path.join(root, file)).pipe(res);
      })
      .listen(cspPort);
  });

  test.afterAll(async () => {
    cspServer?.close();
  });

  test("panel boots and binds buttons under the production CSP", async ({ page }) => {
    // Explicit contract: inline <script> must be allowed by the shipped policy.
    expect(PROD_CSP).toMatch(/script-src[^;]*'unsafe-inline'/);
    await page.goto(`http://127.0.0.1:${PORT + 1}/index.html?api=${API}`);
    // If inline JS was blocked, these never appear/change — fails fast.
    await expect(page.locator("#engine-pill-text")).toContainText("ENGINE ONLINE", {
      timeout: 15_000,
    });
    await expect(page.locator("#btn-scan")).toBeEnabled();
  });
});

test.describe("panel boot", () => {
  test("loads without JS errors and shows metrics", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(PANEL);
    await page.waitForTimeout(1500);
    expect(errors).toEqual([]);
    await expect(page.locator(".metric").first()).toBeVisible();
  });

  test("engine pill shows online state", async ({ page }) => {
    await page.goto(PANEL);
    await expect(page.locator("#engine-pill-text")).toContainText("ENGINE ONLINE");
    // scan button enabled when engine is up
    await expect(page.locator("#btn-scan")).toBeEnabled();
  });
});

test.describe("scan button", () => {
  test("click triggers scan, shows progress, then completion feedback", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(PANEL);
    await page.click("#btn-scan");
    // toast appears while running
    await expect(page.locator("#toast.show")).toBeVisible();
    // eventually completes with the new-format summary (duration + sources)
    await expect(page.locator("#toast-msg")).toContainText(/扫描完成|扫描失败/, {
      timeout: 90_000,
    });
    // button re-enabled afterwards
    await expect(page.locator("#btn-scan")).toBeEnabled({ timeout: 10_000 });
  });

  test("scan actually populates data", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(PANEL);
    await page.click("#btn-scan");
    await expect(page.locator("#toast-msg")).toContainText(/扫描完成/, { timeout: 90_000 });
    await page.reload();
    await page.waitForTimeout(1500);
    const sessions = await page.locator(".metric .value").first().textContent();
    expect(Number(sessions ?? "0")).toBeGreaterThan(0);
  });
});

test.describe("remote machines", () => {
  test("add form: fill host/user/password, submit, row appears, password cleared", async ({
    page,
  }) => {
    await page.goto(PANEL);
    await page.click("#remote-form-box summary");
    await page.fill("#remote-host", "e2e-host.example.com");
    await page.fill("#remote-user", "ci-runner");
    await page.fill("#remote-pass", "hunter2");
    await page.click("#btn-remote-add");
    const row = page.locator(".remote-row", { hasText: "ci-runner@e2e-host.example.com" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("已存密码凭证"); // credential state surfaced
    expect(await page.inputValue("#remote-pass")).toBe(""); // cleared after submit
  });

  test("multiple machines can be added and listed with a count", async ({ page }) => {
    await page.goto(PANEL);
    for (const host of ["a.example.com", "b.example.com"]) {
      await page.click("#remote-form-box summary");
      await page.fill("#remote-host", host);
      await page.click("#btn-remote-add");
    }
    await expect(page.locator(".remote-row")).toHaveCount(3); // 1 from previous test + 2
    await expect(page.locator("#remote-count")).toHaveText("3 台");
  });

  test("delete removes the machine", async ({ page }) => {
    await page.goto(PANEL);
    // Seed an isolated machine so this test does not depend on others' state.
    await fetch(`${API}/api/remotes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "doomed.example.com" }),
    });
    await page.reload();
    await page.waitForTimeout(800);
    const before = await page.locator(".remote-row").count();
    const row = page.locator(".remote-row", { hasText: "doomed.example.com" });
    await expect(row).toBeVisible();
    await row.locator("[data-del]").click();
    await expect(page.locator(".remote-row")).toHaveCount(before - 1);
    await expect(page.locator(".remote-row", { hasText: "doomed.example.com" })).toHaveCount(0);
  });

  test("scan button on unreachable host lands in error state without crashing the panel", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    // Credentials force the ssh2 transport, which fails deterministically and
    // fast on an unresolvable host (key-based path can return empty-ok).
    await fetch(`${API}/api/remotes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "unreachable.invalid", username: "ci", password: "x" }),
    });
    await page.goto(PANEL);
    const row = page.locator(".remote-row", { hasText: "unreachable.invalid" });
    await expect(row).toBeVisible();
    await row.locator("[data-scan]").click();
    // Assert the terminal state via the API (deterministic), then confirm the
    // panel reflects it within a generous window. SSH failure latency varies
    // by OS resolver (CI ubuntu can take ~30s per attempt).
    let finalStatus = "";
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const j = (await (await fetch(`${API}/api/remotes`)).json()) as {
          remotes: { name: string; job?: { status?: string } }[];
        };
        const entry = j.remotes.find((r2) => r2.name === "unreachable.invalid");
        finalStatus = entry?.job?.status ?? "";
        if (finalStatus === "error") break;
      } catch {}
    }
    expect(finalStatus).toBe("error");
    await page.reload();
    await page.waitForTimeout(1500);
    await expect(page.locator(".remote-row", { hasText: "unreachable.invalid" })).toContainText(
      /失败|待扫描/,
    );
    const resp = await fetch(`${API}/api/health`);
    expect((await resp.json()).ok).toBe(true);
  });
});

test.describe("export button", () => {
  test("export opens dashboard JSON in a new tab", async ({ page }) => {
    await page.goto(PANEL);
    const [popup] = await Promise.all([page.waitForEvent("popup"), page.click("#btn-export")]);
    await popup.waitForLoadState();
    const body = await popup.textContent("body");
    const parsed = JSON.parse(body ?? "{}");
    expect(parsed.totals).toBeDefined();
  });
});
