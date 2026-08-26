import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/ui",
  timeout: 30_000,
  retries: 1,
  workers: 1, // tests share one engine instance and mutate remotes state
  use: {
    headless: true,
    viewport: { width: 1380, height: 920 },
  },
});
