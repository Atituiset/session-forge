#!/usr/bin/env pwsh
# Windows mirror of engine-e2e.sh (serve-mode API contract test).
$ErrorActionPreference = 'Stop'
$Port = 4190
$Db = Join-Path ([IO.Path]::GetTempPath()) "sf-e2e-$PID.db"
$env:SESSION_FORGE_TEST_FIXTURES = (Resolve-Path "tests/ui/fixtures-ui").Path
$env:SESSION_FORGE_HOME = Join-Path ([IO.Path]::GetTempPath()) "sf-e2e-home-$PID"

$engine = Start-Process ".\dist\session-forge.exe" -ArgumentList "serve","--port",$Port,"--db",$Db,"--headless" -PassThru -NoNewWindow
function Cleanup { if (-not $engine.HasExited) { Stop-Process -Id $engine.Id -Force } }
trap { Cleanup; throw }

$base = "http://127.0.0.1:$Port"
$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep 1
  try {
    $h = Invoke-RestMethod "$base/api/health" -TimeoutSec 2
    if ($h.ok) { $healthy = $true; break }
  } catch {}
}
if (-not $healthy) { Cleanup; throw "engine not healthy" }

# scan job: 202 + poll
$res = Invoke-WebRequest "$base/api/scan" -Method POST -UseBasicParsing
if ($res.StatusCode -ne 202) { Cleanup; throw "expected 202, got $($res.StatusCode)" }
$status = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep 1
  $status = Invoke-RestMethod "$base/api/scan/status" -TimeoutSec 5
  if ($status.status -ne "running") { break }
}
if ($status.status -ne "ok") { Cleanup; throw "scan failed: $($status | ConvertTo-Json -Compress)" }

# dashboard has fixture sessions
$data = Invoke-RestMethod "$base/api/data" -TimeoutSec 10
if ($data.totals.sessions -lt 2) { Cleanup; throw "expected >=2 sessions" }

# dashboard machine scoping
$local = Invoke-RestMethod "$base/api/data?machine=local" -TimeoutSec 10
if ($local.machine -ne "local") { Cleanup; throw "machine echo missing" }
$none = Invoke-RestMethod "$base/api/data?machine=ghost-machine" -TimeoutSec 10
if ($none.totals.sessions -ne 0) { Cleanup; throw "unknown machine should isolate to 0" }

# machines endpoint: one card row per machine
$machines = Invoke-RestMethod "$base/api/machines" -TimeoutSec 10
if (-not ($machines.machines | Where-Object { $_.machine -eq "local" })) { Cleanup; throw "local machine missing" }
if (-not $machines.machines[0].tools) { Cleanup; throw "tools missing" }

# sessions list endpoint
$listRes = Invoke-RestMethod "$base/api/sessions?limit=10" -TimeoutSec 10
if ($null -eq $listRes.sessions) { Cleanup; throw "sessions array missing" }
if ($null -eq $listRes.total) { Cleanup; throw "total missing" }

# session detail endpoint
$detail = Invoke-RestMethod "$base/api/session?source=codex&id=e2e-codex-1" -TimeoutSec 10
if ($detail.messages.Count -lt 1) { Cleanup; throw "messages missing" }

# remotes CRUD: password never persisted, never echoed back
Invoke-RestMethod "$base/api/remotes" -Method POST -ContentType "application/json" `
  -Body '{"name":"ci@10.255.255.1","username":"ci","password":"supersecret"}' | Out-Null
$list = Invoke-RestMethod "$base/api/remotes"
if (($list | ConvertTo-Json -Compress) -match "supersecret") { Cleanup; throw "PASSWORD LEAKED IN API" }
$entry = $list.remotes | Where-Object { $_.name -eq "ci@10.255.255.1" }
if (-not $entry.hasPassword) { Cleanup; throw "hasPassword missing" }
$disk = Join-Path $env:SESSION_FORGE_HOME "remotes.json"
if ((Test-Path $disk) -and ((Get-Content $disk -Raw) -match "supersecret")) { Cleanup; throw "PASSWORD ON DISK" }

# display label roundtrip
Invoke-RestMethod "$base/api/remotes" -Method POST -ContentType "application/json; charset=utf-8" `
  -Body ([Text.Encoding]::UTF8.GetBytes('{"name":"labeled@10.9.9.9","username":"ci","password":"x","label":"开发机一"}')) | Out-Null
$labeled = (Invoke-RestMethod "$base/api/remotes").remotes | Where-Object { $_.name -eq "labeled@10.9.9.9" }
if ($labeled.label -ne "开发机一") { Cleanup; throw "label roundtrip failed: $($labeled.label)" }

# delete
Invoke-RestMethod "$base/api/remotes/ci@10.255.255.1" -Method DELETE | Out-Null
$list2 = Invoke-RestMethod "$base/api/remotes"
if ($list2.remotes | Where-Object { $_.name -eq "ci@10.255.255.1" }) { Cleanup; throw "delete failed" }

Cleanup
Write-Host "ENGINE E2E PASSED (windows)"
