# Contributing

Thanks for your interest in improving SessionForge! This document covers the
essentials — for anything else, open an issue and ask.

## Setup

Requires [Bun](https://bun.sh) (exact version in `.bun-version`).

```bash
git clone https://github.com/Atituiset/session-forge.git
cd session-forge
bun install
bun run dev -- scan    # run the CLI from source
```

## Before sending a PR

All of these must pass (they are what CI runs on Linux / macOS / Windows):

```bash
bun run lint        # biome check
bun run typecheck   # tsc --noEmit
bun test            # unit tests
bun run build       # compiled-binary smoke
bunx playwright test  # UI e2e (self-contained: spins up its own engine)
```

## Conventions

- **Match the file you're in.** Naming, structure, and comment style follow the
  surrounding code. Comments explain *why*, not *what* — most code needs none.
- **Format families, not tools.** New agent support belongs in a reader for its
  storage format (`src/readers/`), so one adapter covers every tool sharing
  that layout. Check `src/registry.ts` first — the layout may already be known.
- **Never move session stores across machines.** Remote data is read by the
  auto-deployed agent on the source machine and streamed back (`src/agent.ts`).
- **No telemetry, ever.** Data stays local; the API binds to localhost.

## Tests

- Unit tests live in `tests/unit/` (`bun:test`). Add one when you change
  behavior — especially readers, the store, and relay sinks.
- UI e2e lives in `tests/ui/` (Playwright). It boots a real engine against
  fixture sessions, so it's the safety net for panel and API changes.
- Fixtures for agent formats are in `tests/fixtures/`. Redact anything real.

## Commit & PR style

- Conventional-ish commits as used in history: `feat:`, `fix:`,
  `chore(release):`, … with a short body explaining *why* when non-obvious.
- One logical change per PR. If you find an unrelated bug along the way,
  separate PRs are welcome.

## Reporting bugs

Use the bug report template. The single most helpful thing you can include is
the **session file that isn't parsed correctly** (or a redacted slice of it) —
every reader bug so far has been a format variant we hadn't seen.
