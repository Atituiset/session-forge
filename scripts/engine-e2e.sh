#!/usr/bin/env bash
# Engine serve-mode e2e: boots the compiled binary, exercises the API contract
# (health, async scan job, dashboard, remotes CRUD with password handling).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=${SF_E2E_PORT:-4189}
DB="$(mktemp -d)/e2e.db"
export SESSION_FORGE_TEST_FIXTURES="$PWD/tests/ui/fixtures-ui"
export SESSION_FORGE_HOME="$(mktemp -d)"

./dist/session-forge serve --port "$PORT" --db "$DB" --headless &
ENGINE_PID=$!
trap 'kill $ENGINE_PID 2>/dev/null || true' EXIT

for i in $(seq 1 30); do
  if curl -sf -m 2 "http://127.0.0.1:$PORT/api/health" | grep -q '"ok":true'; then break; fi
  [ "$i" = 30 ] && { echo "engine not healthy"; exit 1; }
  sleep 1
done

B="http://127.0.0.1:$PORT"

echo "== scan job: 202 + poll =="
CODE=$(curl -s -o /tmp/e2e-scan.json -w '%{http_code}' -X POST "$B/api/scan")
[ "$CODE" = "202" ] || { echo "expected 202, got $CODE"; exit 1; }
for i in $(seq 1 60); do
  ST=$(curl -s "$B/api/scan/status")
  echo "$ST" | grep -q running || break
  sleep 1
done
echo "$ST" | grep -q '"status":"ok"' || { echo "scan failed: $ST"; exit 1; }

echo "== dashboard has fixture sessions =="
N=$(curl -s "$B/api/data" | grep -o '"sessions":[0-9]*' | head -1 | cut -d: -f2)
[ "${N:-0}" -ge 2 ] || { echo "expected >=2 sessions, got $N"; exit 1; }

echo "== dashboard machine scoping =="
curl -s "$B/api/data?machine=local" | grep -q '"machine":"local"' || { echo "machine echo missing"; exit 1; }
ZERO=$(curl -s "$B/api/data?machine=ghost-machine" | grep -o '"sessions":[0-9]*' | head -1 | cut -d: -f2)
[ "${ZERO:-1}" = "0" ] || { echo "unknown machine should isolate to 0 sessions, got $ZERO"; exit 1; }

echo "== machines endpoint: one card row per machine =="
MACH=$(curl -s "$B/api/machines")
echo "$MACH" | grep -q '"machine":"local"' || { echo "local machine missing: $MACH"; exit 1; }
echo "$MACH" | grep -q '"tools":\[' || { echo "tools missing: $MACH"; exit 1; }

echo "== sessions list endpoint =="
LIST_RES=$(curl -s "$B/api/sessions?limit=10")
echo "$LIST_RES" | grep -q '"sessions":\[' || { echo "sessions array missing: $LIST_RES"; exit 1; }
echo "$LIST_RES" | grep -q '"total":' || { echo "total missing: $LIST_RES"; exit 1; }

echo "== session detail endpoint =="
curl -s "$B/api/session?source=codex&id=e2e-codex-1" | grep -q '"messages":\[' || { echo "messages missing"; exit 1; }

echo "== remotes CRUD: password never persisted =="
curl -s -X POST "$B/api/remotes" -H 'content-type: application/json' \
  -d '{"name":"ci@10.255.255.1","username":"ci","password":"supersecret"}' | grep -q ok
LIST=$(curl -s "$B/api/remotes")
echo "$LIST" | grep -q supersecret && { echo "PASSWORD LEAKED IN API"; exit 1; }
echo "$LIST" | grep -q '"hasPassword":true' || { echo "hasPassword missing"; exit 1; }
if [ -f "$SESSION_FORGE_HOME/remotes.json" ]; then
  grep -q supersecret "$SESSION_FORGE_HOME/remotes.json" && { echo "PASSWORD ON DISK"; exit 1; }
fi

echo "== remote display label roundtrip =="
curl -s -X POST "$B/api/remotes" -H 'content-type: application/json' \
  -d '{"name":"labeled@10.9.9.9","username":"ci","password":"x","label":"开发机一"}' >/dev/null
curl -s "$B/api/remotes" | grep -qE '"label":"(开发机一|\\u5f00\\u53d1\\u673a\\u4e00)"' || { echo "label missing"; exit 1; }

echo "== delete remote =="
curl -s -X DELETE "$B/api/remotes/ci@10.255.255.1" | grep -q ok
curl -s "$B/api/remotes" | grep -q '10.255.255.1' && { echo "delete failed"; exit 1; }

echo "ENGINE E2E PASSED"
