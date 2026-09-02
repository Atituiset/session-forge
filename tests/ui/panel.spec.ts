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
      // Relay writes land in a sandbox, never the runner's real ~/.codex etc.
      SESSION_FORGE_RELAY_HOME: path.join(dbDir, "relay-home"),
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

// v0.1.8–v0.1.10 incidents: WebView2 + Tauri's nonce-based CSP modification
// silently refused to execute our script no matter how script-src was tuned
// ('unsafe-inline', external file — all failed on real Windows). Fix: ship NO
// custom CSP at all. This guard fails if anyone reintroduces a hand-written
// policy without re-verifying on real Windows hardware.
import { readFileSync } from "node:fs";

const CONF = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "src-tauri/tauri.conf.json"), "utf8"),
) as {
  app?: { security?: { csp?: string | null; dangerousDisableAssetCspModification?: boolean } };
};
const PROD_CSP: string | null = CONF.app?.security?.csp ?? null;

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
        });
        fs.createReadStream(path.join(root, file)).pipe(res);
      })
      .listen(cspPort);
  });

  test.afterAll(async () => {
    cspServer?.close();
  });

  test("panel boots with the shipped security config (no custom CSP)", async ({ page }) => {
    // Guard: a hand-written CSP broke script execution on WebView2 in
    // v0.1.8-v0.1.10 (nonce modification). Fail if one reappears.
    if (PROD_CSP) {
      throw new Error(
        `tauri.conf.json sets a custom CSP (${PROD_CSP.slice(0, 60)}...). ` +
          "WebView2 + Tauri nonce modification broke script execution before. " +
          "Only reintroduce after manual verification on real Windows.",
      );
    }
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

// Seed sessions deterministically via the API, so describes that need session
// data stay self-sufficient even when run standalone (playwright --grep).
async function ensureScanned(): Promise<void> {
  const st0 = (await (await fetch(`${API}/api/scan/status`)).json()) as { status?: string };
  if (st0.status !== "running") await fetch(`${API}/api/scan`, { method: "POST" });
  for (let i = 0; i < 90; i++) {
    const st = (await (await fetch(`${API}/api/scan/status`)).json()) as { status?: string };
    if (st.status === "ok") return;
    if (st.status && st.status !== "running") throw new Error(`scan failed: ${st.status}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("scan did not finish");
}

test.describe("session detail", () => {
  test.beforeAll(ensureScanned);

  // Regression: a leftover `lastSessionRows` reference threw inside the
  // detail renderer and the silent catch left the spinner up forever.
  test("clicking a session opens its messages (not a stuck spinner)", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(PANEL);
    const row = page.locator(".session-row").first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    await expect(page.locator("#session-overlay.show")).toBeVisible();
    await expect(page.locator("#session-detail .msg").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#session-detail .spinner")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe("machine scope", () => {
  test.beforeAll(ensureScanned);

  test("/api/data?machine= scopes aggregates; unknown machine yields zero", async () => {
    const all = (await (await fetch(`${API}/api/data`)).json()) as {
      machine: string;
      totals: { sessions: number };
    };
    const local = (await (await fetch(`${API}/api/data?machine=local`)).json()) as {
      machine: string;
      totals: { sessions: number };
    };
    const none = (await (await fetch(`${API}/api/data?machine=ghost-machine`)).json()) as {
      totals: { sessions: number };
    };
    expect(all.machine).toBe("all");
    expect(local.machine).toBe("local");
    // The seeded fixtures are all local, so scoping to local loses nothing…
    expect(local.totals.sessions).toBe(all.totals.sessions);
    // …while an unknown machine isolates to zero.
    expect(none.totals.sessions).toBe(0);
  });

  test("one card per machine with tools; clicking a card scopes the dashboard", async ({
    page,
  }) => {
    await page.goto(PANEL);
    const cards = page.locator(".machine-card");
    await expect(cards).toHaveCount(2); // 全部机器 + 本机（fixtures 无远程数据）
    await expect(cards.nth(0)).toContainText("全部机器");
    await expect(cards.nth(1)).toContainText("本机");
    // Tool chips come from the sources observed on that machine.
    await expect(cards.nth(1).locator(".chip", { hasText: "claude-code" })).toBeVisible();
    await page.waitForTimeout(1200);
    const before = (await page.locator(".metric .value").first().textContent()) ?? "";
    await cards.nth(1).click();
    await expect(cards.nth(1)).toHaveClass(/active/);
    await expect(cards.nth(0)).not.toHaveClass(/active/);
    await page.waitForTimeout(800);
    const after = (await page.locator(".metric .value").first().textContent()) ?? "";
    // Fixtures are all-local: scoping to "本机" keeps the same totals.
    expect(after).toBe(before);
    await expect(page.locator("#foot")).toContainText("本机");
    // Switching back restores the aggregate card as active.
    await cards.nth(0).click();
    await expect(cards.nth(0)).toHaveClass(/active/);
  });

  test("/api/machines returns per-machine aggregates with tool chips", async () => {
    const j = (await (await fetch(`${API}/api/machines`)).json()) as {
      machines: { machine: string; sessions: number; tools: string[] }[];
    };
    const local = j.machines.find((m) => m.machine === "local");
    expect(local).toBeDefined();
    expect(local?.sessions).toBeGreaterThan(0);
    expect(local?.tools).toContain("claude-code");
    expect(local?.tools).toContain("codex");
  });
});

test.describe("relay (projection to another CLI)", () => {
  test.beforeAll(ensureScanned);

  test("claude-code session relays to codex and shows the resume hint", async ({ page }) => {
    const fs = await import("node:fs");
    await page.goto(PANEL);
    const row = page.locator(".session-row", { hasText: "claude-code" }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    const btn = page.locator("#btn-relay");
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await page.selectOption("#relay-target", "codex");
    await btn.click();
    const result = page.locator("#relay-result");
    await expect(result).toContainText("已接力到", { timeout: 10_000 });
    await expect(result).toContainText("codex resume");
    // The rollout file actually landed in the sandboxed relay home.
    const root = path.join(dbDir, "relay-home", ".codex", "sessions");
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(d, e.name);
        return e.isDirectory() ? walk(p) : [p];
      });
    const files = walk(root);
    expect(files.some((f) => f.endsWith(".jsonl"))).toBe(true);
    const content = fs.readFileSync(files.find((f) => f.endsWith(".jsonl")) ?? "", "utf8");
    expect(content).toContain("session_meta");
  });

  test("relay result survives the 15s live refresh", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(PANEL);
    const row = page.locator(".session-row", { hasText: "claude-code" }).first();
    await row.click();
    await expect(page.locator("#btn-relay")).toBeVisible({ timeout: 10_000 });
    // The session's own tool (claude-code) is excluded from the target list.
    await expect(page.locator("#relay-target option[value='claude-code']")).toHaveCount(0);
    // Use a different target than the sibling test so they never collide on
    // the "already relayed" overwrite guard regardless of execution order.
    await page.selectOption("#relay-target", "kimi-code");
    await page.click("#btn-relay");
    await expect(page.locator("#relay-result")).toContainText("已接力到", { timeout: 10_000 });
    // Force a live refresh of the open detail view.
    await page.waitForTimeout(16_000);
    await expect(page.locator("#relay-result")).toContainText("已接力到");
  });
});
