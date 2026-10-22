# Starts the overnight stack detached, so it survives closing the terminal:
# the Temporal dev server (SQLite state in ~/.nightshift) and the Nightshift worker.
# Safe to re-run: skips anything already running. Logs go to ~/.nightshift/*.log.
# Restart the worker only BETWEEN nights: a worker restart with changed workflow code breaks a running night.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $env:USERPROFILE '.nightshift'
New-Item -ItemType Directory -Force $dir | Out-Null

function Test-Port([int]$port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $port); return $true } catch { return $false } finally { $c.Close() }
}

$temporal = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\temporal.exe'
if (-not (Test-Port 7233)) {
  Start-Process -FilePath $temporal -WindowStyle Hidden `
    -ArgumentList @('server', 'start-dev', '--db-filename', (Join-Path $dir 'temporal.db'), '--ui-port', '8233', '--log-level', 'warn') `
    -RedirectStandardOutput (Join-Path $dir 'temporal.out.log') -RedirectStandardError (Join-Path $dir 'temporal.err.log')
  $deadline = (Get-Date).AddSeconds(60)
  while (-not (Test-Port 7233)) {
    if ((Get-Date) -gt $deadline) { throw 'temporal dev server did not open port 7233 within 60s; see ~/.nightshift/temporal.err.log' }
    Start-Sleep -Seconds 2
  }
  Write-Host 'temporal dev server started (UI http://localhost:8233)'
} else { Write-Host 'temporal dev server already running' }

# The worker runs as a chain (cmd -> pnpm -> tsx -> node); match any link of it.
function Get-Worker { Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match 'nightshift worker|index\.ts"? "?worker' } }
if (-not (Get-Worker)) {
  Start-Process -FilePath 'cmd.exe' -WorkingDirectory $repo -WindowStyle Hidden `
    -ArgumentList @('/c', 'pnpm -s nightshift worker') `
    -RedirectStandardOutput (Join-Path $dir 'worker.out.log') -RedirectStandardError (Join-Path $dir 'worker.err.log')
  # The worker bundles workflow code (~10s) before polling; confirm it got there and did not exit.
  $started = Get-Date
  $log = Join-Path $dir 'worker.out.log'
  while (-not ((Test-Path $log) -and (Select-String -Path $log -Pattern 'polling task queue' -Quiet))) {
    $elapsed = ((Get-Date) - $started).TotalSeconds
    # Give the process chain 15s to appear before treating "no process" as a crash; 90s overall.
    if (($elapsed -gt 15 -and -not (Get-Worker)) -or $elapsed -gt 90) { throw 'worker did not start; see ~/.nightshift/worker.err.log' }
    Start-Sleep -Seconds 3
  }
  Select-String -Path $log -Pattern '\[worker\] sentry:' | Select-Object -Last 1 | ForEach-Object { Write-Host $_.Line }
  Write-Host 'worker started and polling (logs in ~/.nightshift/worker.*.log)'
} else { Write-Host 'worker already running (restart it only between nights)' }

Write-Host 'Keep the laptop awake overnight: plugged in, sleep = Never (Settings > System > Power).'
