#!/usr/bin/env bash
# Cross-platform CLI smoke for CI. Exercises the compiled binary end to end:
# version, scan against seeded fixtures, report, export, classify.
set -euo pipefail

cd "$(dirname "$0")/.."

BIN=./dist/session-forge
DB="$(mktemp -d)/smoke.db"

echo "== version =="
"$BIN" --version

echo "== scan seeded fixtures =="
export SESSION_FORGE_TEST_FIXTURES="$PWD/tests/ui/fixtures-ui"
"$BIN" scan --db "$DB" | tail -5

echo "== report =="
"$BIN" report --db "$DB" | head -8

echo "== export markdown + json =="
"$BIN" export --db "$DB" --format json --out "$DB.json"
[ -s "$DB.json" ] || { echo "json export empty"; exit 1; }
"$BIN" export --db "$DB" --format markdown --out "$DB.md"
[ -s "$DB.md" ] || { echo "md export empty"; exit 1; }

echo "== classify (rule engine) =="
"$BIN" classify --db "$DB" --limit 20 | head -3

echo "== blackholes validation errors =="
if "$BIN" blackholes --db "$DB" --threshold abc >/dev/null 2>&1; then
  echo "--threshold abc should fail"; exit 1
fi

echo "CI SMOKE PASSED"
