#!/usr/bin/env bash
# Round-trip fidelity check (IO-05 R3): for each family fixture, import into a
# temp store, convert every session to the other family's format, re-import the
# converted output into a second temp store, and compare NIR message counts.
#
# Measured retention on the current fixtures: 100% (5/5, 6/6, 4/4, 3/3) for all
# four families — thinking is preserved both ways (codex reasoning items,
# claude thinking blocks). Thresholds sit at the 95% target from the design
# doc to leave headroom for minor fixture/writer changes.
set -euo pipefail
cd "$(dirname "$0")/.."

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

count_messages() { # <db> -> total NIR message count across all stored sessions
  bun -e 'import { Database } from "bun:sqlite";
    const db = new Database(process.argv[1], { readonly: true });
    let n = 0;
    for (const r of db.prepare("SELECT raw FROM sessions").all()) {
      n += JSON.parse(r.raw).messages.length;
    }
    console.log(n);' "$1"
}

session_ids() { # <db> -> one session id per line
  bun -e 'import { Database } from "bun:sqlite";
    const db = new Database(process.argv[1], { readonly: true });
    for (const r of db.prepare("SELECT id FROM sessions").all()) console.log(r.id);' "$1"
}

run_family() { # <name> <fixture> <from> <to> <threshold-pct>
  local name="$1" fixture="$2" from="$3" to="$4" threshold="$5"
  local db_a="$WORK/$name-a.db" db_b="$WORK/$name-b.db" out="$WORK/$name-out"
  echo "== $name: $fixture --($to)--> re-import =="

  bun run src/cli.ts import "$fixture" --from "$from" --db "$db_a" >/dev/null

  local ids
  ids="$(session_ids "$db_a")"
  [ -n "$ids" ] || { echo "FAIL: no sessions imported for $name"; exit 1; }
  while IFS= read -r id; do
    bun run src/cli.ts convert "$id" --to "$to" --db "$db_a" --out "$out" >/dev/null
  done <<< "$ids"

  local converted=0
  while IFS= read -r f; do
    bun run src/cli.ts import "$f" --from "$to" --db "$db_b" >/dev/null
    converted=$((converted + 1))
  done < <(find "$out" -type f | sort)
  [ "$converted" -gt 0 ] || { echo "FAIL: convert produced no files for $name"; exit 1; }

  local a b pct
  a="$(count_messages "$db_a")"
  b="$(count_messages "$db_b")"
  pct=$((b * 100 / a))
  printf '%-10s %3s/%3s messages retained (%s%%, threshold %s%%)\n' \
    "$name" "$b" "$a" "$pct" "$threshold"
  [ "$pct" -ge "$threshold" ] || { echo "FAIL: $name retention below threshold"; exit 1; }
}

run_family claude    tests/fixtures/claude/session.jsonl   claude-code codex       95
run_family codex     tests/fixtures/codex/rollout.jsonl    codex       claude-code 95
run_family kimi      tests/fixtures/kimi/wire.jsonl        kimi        claude-code 95
run_family codewhale tests/fixtures/codewhale/session.json codewhale   claude-code 95

echo "ROUNDTRIP PASSED"
