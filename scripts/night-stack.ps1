# Starts the overnight stack detached, so it survives closing the terminal:
# the Temporal dev server (SQLite state in ~/.nightshift) and the Nightshift worker.
# Safe to re-run: skips anything already running. Logs go to ~/.nightshift/*.log.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $env:USERPROFILE '.nightshift'
New-Item -ItemType Directory -Force $dir | Out-Null

$temporal = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\temporal.exe'
$serverUp = $false
try { $serverUp = (Test-NetConnection -ComputerName localhost -Port 7233 -WarningAction SilentlyContinue).TcpTestSucceeded } catch {}
if (-not $serverUp) {
  Start-Process -FilePath $temporal -WindowStyle Hidden `
    -ArgumentList @('server', 'start-dev', '--db-filename', (Join-Path $dir 'temporal.db'), '--ui-port', '8233', '--log-level', 'warn') `
    -RedirectStandardOutput (Join-Path $dir 'temporal.out.log') -RedirectStandardError (Join-Path $dir 'temporal.err.log')
  Start-Sleep -Seconds 8
  Write-Host 'temporal dev server started (UI http://localhost:8233)'
} else { Write-Host 'temporal dev server already running' }

$worker = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match 'index.ts worker' }
if (-not $worker) {
  Start-Process -FilePath 'cmd.exe' -WorkingDirectory $repo -WindowStyle Hidden `
    -ArgumentList @('/c', 'pnpm -s nightshift worker') `
    -RedirectStandardOutput (Join-Path $dir 'worker.out.log') -RedirectStandardError (Join-Path $dir 'worker.err.log')
  Write-Host 'worker started (logs in ~/.nightshift/worker.*.log)'
} else { Write-Host 'worker already running' }
