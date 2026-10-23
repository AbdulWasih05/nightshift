# Stops everything Nightshift runs on the laptop: dashboard, worker, Temporal dev server, Ollama, Docker Desktop.
# Refuses while a night is running (use -Force to stop anyway; the night resumes when the stack comes back).
# `pnpm stack:down`. Bring it back with `pnpm stack` or `pnpm night`.
param([switch]$Force)
$ErrorActionPreference = 'Continue'

function Test-Port([int]$port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $port); return $true } catch { return $false } finally { $c.Close() }
}

$temporal = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\temporal.exe'
if ((Test-Port 7233) -and -not $Force) {
  $running = & $temporal workflow list --query "ExecutionStatus='Running'" 2>$null | Select-String -Pattern 'nightlyTriage'
  if ($running) { Write-Host 'A night is running. Not stopping (pass -Force to stop anyway; it resumes when restarted).'; exit 1 }
}

function Stop-Matching([string]$label, [scriptblock]$filter) {
  $procs = Get-CimInstance Win32_Process | Where-Object $filter
  if ($procs) {
    $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Write-Host "stopped $label"
  } else { Write-Host "$label not running" }
}

Stop-Matching 'dashboard' { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'next' }
Stop-Matching 'worker' { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'nightshift worker|index\.ts"? "?worker' }
Stop-Matching 'temporal dev server' { $_.Name -eq 'temporal.exe' }
Stop-Matching 'ollama' { $_.Name -in @('ollama app.exe', 'ollama.exe', 'llama-server.exe') }
Stop-Matching 'docker desktop' { $_.Name -in @('Docker Desktop.exe', 'com.docker.backend.exe', 'com.docker.build.exe', 'com.docker.dev-envs.exe') }
Write-Host 'done. The Docker VM (vmmemWSL) releases its memory a minute or two after Docker Desktop exits.'
