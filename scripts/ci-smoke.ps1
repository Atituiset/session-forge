#!/usr/bin/env pwsh
# Windows mirror of ci-smoke.sh: compiled binary CLI round-trip with fixtures.
$ErrorActionPreference = 'Stop'
$env:SESSION_FORGE_TEST_FIXTURES = (Resolve-Path "tests/ui/fixtures-ui").Path
$bin = ".\dist\session-forge.exe"
$db = Join-Path ([IO.Path]::GetTempPath()) "sf-smoke-$PID.db"

Write-Host "== version =="
$v = & $bin --version
if (-not $v) { throw "no version output" }

Write-Host "== scan seeded fixtures =="
& $bin scan --db $db | Out-Null

Write-Host "== report =="
$report = & $bin report --db $db | Out-String
if ($report -notmatch "SESSIONFORGE REPORT") { throw "report missing header" }

Write-Host "== export =="
$json = Join-Path ([IO.Path]::GetTempPath()) "sf-smoke-$PID.json"
& $bin export --db $db --format json --out $json | Out-Null
if (-not (Test-Path $json) -or (Get-Item $json).Length -eq 0) { throw "json export empty" }

Write-Host "== classify =="
& $bin classify --db $db --limit 20 | Out-Null

Write-Host "== blackholes validation errors =="
$failed = $false
try { & $bin blackholes --db $db --threshold abc 2>$null | Out-Null } catch { $failed = $true }
# bun exits non-zero without throwing in pwsh; check $LASTEXITCODE instead
if (-not $failed -and $LASTEXITCODE -eq 0) { throw "--threshold abc should fail" }

Write-Host "CI SMOKE PASSED (windows)"
