# SessionForge

**The session hub for AI coding agents — every CLI, every machine, one searchable memory.**

[![CI](https://github.com/Atituiset/session-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/Atituiset/session-forge/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Atituiset/session-forge)](https://github.com/Atituiset/session-forge/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-blue)](https://github.com/Atituiset/session-forge/releases/latest)

[中文文档](README.zh-CN.md)

Your AI coding sessions are scattered across `~/.claude`, `~/.codex`, `~/.kimi-code`, SQLite databases and JSONL rollouts — on your laptop, inside WSL distros, and on remote machines. SessionForge scans them all into one local, searchable knowledge base, and lets you **relay** a session from one agent CLI to another when you hit a token wall or want a different model.

![SessionForge dashboard](docs/screenshots/dashboard.png)

## Why

- **Relay (the killer feature)** — out of tokens on Codex? Hand the session to Claude Code and keep working. SessionForge projects the full conversation into the target CLI's native storage, on the machine where the session actually lives, so `claude --resume` / `codex resume` just works.
- **Every machine, one panel** — local scans, WSL distros (auto-deployed agent, no manual setup), and SSH remotes all aggregate into a single dashboard.
- **Your data stays local** — a single binary with an embedded SQLite cache. No cloud, no account, no telemetry.

![Relay demo](docs/screenshots/relay-demo.gif)

## Supported agents

| Agent | Scan & browse | Relay target |
|---|---|---|
| Claude Code | ✅ | ✅ |
| Codex CLI | ✅ | ✅ |
| Kimi Code | ✅ | ✅ |
| DeepSeek CLI | ✅ | ✅ |
| opencode | ✅ | — |
| codewhale | ✅ | — |
| Gemini Antigravity | ✅ | — |

Cross-tool relay works in any direction (e.g. `codex → claude-code`, `claude-code → kimi-code`), across machines: relay a session that lives in a WSL distro or on an SSH remote and the projection lands on that machine.

## Quickstart

### Desktop app

Download the installer for your platform from [Releases](https://github.com/Atituiset/session-forge/releases/latest) (`.dmg` / `.deb` / `-setup.exe`), launch it, and hit **扫描全部 Agent**. That's it.

### CLI

```bash
# 1. Grab the binary for your platform from Releases, or build from source:
git clone https://github.com/Atituiset/session-forge.git
cd session-forge && bun install && bun run build   # → dist/session-forge

# 2. Scan every agent on this machine (and WSL distros / SSH remotes)
./dist/session-forge scan

# 3. Serve the panel — it's embedded in the binary
./dist/session-forge serve
# → open http://127.0.0.1:4177
```

### Useful commands

```
session-forge scan                 discover & ingest sessions from all known agents
session-forge serve [--port N]     local API + embedded panel (default :4177)
session-forge report               token/round/diff stats per project, tool, model
session-forge relay <id> --to <cli>  project a session into another CLI's storage
session-forge export               export the knowledge base as Markdown
session-forge blackholes           find runaway sessions (tech-debt candidates)
```

## How it works

```
~/.claude  ~/.codex  ~/.kimi-code  ~/.deepseek  opencode.db  …
        │                 (WSL distros & SSH remotes via auto-deployed agent)
        ▼
  format-family readers ──▶ NIR (normalized session schema)
        ▼
  embedded SQLite cache ──▶ local HTTP API ──▶ panel (desktop app or browser)
```

Readers are written against **format families** (Codex-style JSONL, Claude transcripts, SQLite stores), not per-tool adapters — so new tools that reuse a known layout work out of the box. Scans are incremental (rev watermark), crash-safe (chunked transactions), and never copy session stores across machines — remote scans run a tiny auto-deployed agent that streams results back.

## Privacy

Everything stays on your machines: the cache is a local SQLite file (`~/.session-forge/cache.db`), the API binds to localhost, and there is no telemetry of any kind.

## Development

Requires [Bun](https://bun.sh) (see `.bun-version`).

```bash
bun install
bun run dev -- scan     # run the CLI from source
bun test                # unit tests
bun run typecheck       # tsc --noEmit
bun run lint            # biome
bunx playwright test    # UI e2e (spins up its own engine + panel)
bun run desktop         # Tauri desktop app (dev)
```

## Roadmap

- Markdown rendering with code highlighting in the session viewer
- One-line install script + brew / scoop / winget packages

## License

[MIT](LICENSE)
