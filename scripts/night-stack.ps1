# Starts everything a run needs, detached, so it survives closing the terminal:
# Docker Desktop + the Postgres container, Ollama, the Temporal dev server (SQLite state in ~/.nightshift)
# and the Nightshift worker. Safe to re-run: skips anything already running. Logs go to ~/.nightshift/*.log.
# Restart the worker only BETWEEN runs: a worker restart with changed workflow code breaks a running night.
# `pnpm night` = this script + a scheduled run 2 minutes later.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $env:USERPROFILE '.nightshift'
New-Item -ItemType Directory -Force $dir | Out-Null

function Test-Port([int]$port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $port); return $true } catch { return $false } finally { $c.Close() }
}

function Test-Docker {
  $ErrorActionPreference = 'SilentlyContinue'
  docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
  return ($LASTEXITCODE -eq 0)
}

# 1. Docker + Postgres, only when the database is local. With Tiger Data (DATABASE_URL on *.timescale.com)
#    Docker is not needed at all, which frees ~1.4 GB of RAM for Gemma.
$dbUrl = (Get-Content (Join-Path $repo '.env') | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1) -replace '^DATABASE_URL=', ''
$localDb = $dbUrl -match '@(localhost|127\.0\.0\.1)[:/]'
if (-not $localDb) {
  Write-Host 'database: Tiger Data (remote), Docker not needed'
} elseif (-not (Test-Docker)) {
  Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
  $deadline = (Get-Date).AddSeconds(240)
  while (-not (Test-Docker)) {
    if ((Get-Date) -gt $deadline) { throw 'Docker Desktop did not start within 4 minutes' }
    Start-Sleep -Seconds 5
  }
  Write-Host 'docker started'
}
if ($localDb) {
Push-Location $repo
try {
  $deadline = (Get-Date).AddSeconds(180)
  $ready = $false
  while (-not $ready) {
    $ErrorActionPreference = 'SilentlyContinue'
    docker compose up -d db 2>$null | Out-Null
    docker compose exec -T db pg_isready -U nightshift 2>$null | Out-Null
    $ready = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = 'Stop'
    if (-not $ready) {
      if ((Get-Date) -gt $deadline) { throw 'Postgres container did not become ready within 3 minutes' }
      Start-Sleep -Seconds 3
    }
  }
} finally { Pop-Location }
Write-Host 'postgres ready'
}

# 2. Ollama (usually starts with Windows)
if (-not (Test-Port 11434)) {
  Start-Process (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama app.exe') -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(60)
  while (-not (Test-Port 11434)) {
    if ((Get-Date) -gt $deadline) { throw 'Ollama did not start within 60s' }
    Start-Sleep -Seconds 2
  }
  Write-Host 'ollama started'
} else { Write-Host 'ollama already running' }

# 3. Temporal dev server
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

# 4. Worker. The worker runs as a chain (cmd -> pnpm -> tsx -> node); match any link of it.
function Get-Worker { Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match 'nightshift worker|index\.ts"? "?worker' } }
if (-not (Get-Worker)) {
  Start-Process -FilePath 'cmd.exe' -WorkingDirectory $repo -WindowStyle Hidden `
    -ArgumentList @('/c', 'pnpm -s nightshift worker') `
    -RedirectStandardOutput (Join-Path $dir 'worker.out.log') -RedirectStandardError (Join-Path $dir 'worker.err.log')
  # The worker bundles workflow code before polling; confirm it got there and did not exit.
  $started = Get-Date
  $log = Join-Path $dir 'worker.out.log'
  while (-not ((Test-Path $log) -and (Select-String -Path $log -Pattern 'polling task queue' -Quiet))) {
    $elapsed = ((Get-Date) - $started).TotalSeconds
    # Give the process chain 15s to appear before treating "no process" as a crash; 240s overall (bundling is slow under memory pressure).
    if (($elapsed -gt 15 -and -not (Get-Worker)) -or $elapsed -gt 240) { throw 'worker did not start; see ~/.nightshift/worker.err.log' }
    Start-Sleep -Seconds 3
  }
  Select-String -Path $log -Pattern '\[worker\] sentry:' | Select-Object -Last 1 | ForEach-Object { Write-Host $_.Line }
  Write-Host 'worker started and polling (logs in ~/.nightshift/worker.*.log)'
} else { Write-Host 'worker already running (restart it only between runs)' }

Write-Host 'stack up. A run needs the laptop on until it finishes; if it sleeps, the run pauses and resumes on wake.'
