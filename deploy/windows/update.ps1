<#
  Pulls the latest Wamon from GitHub and restarts it. Linked WhatsApp numbers reconnect by themselves.
    powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Wamon\app\deploy\windows\update.ps1"
#>
$ErrorActionPreference = 'Stop'
$App = Join-Path $env:LOCALAPPDATA 'Wamon\app'

function Stop-Wamon {
  Stop-ScheduledTask -TaskName 'Wamon' -ErrorAction SilentlyContinue
  # Stopping the task ends the supervisor; end its Node child too (only ours, marked --wamon-prod).
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like '*--wamon-prod*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

Stop-Wamon
git -C $App pull --ff-only
if ($LASTEXITCODE -ne 0) { throw 'git pull failed' }
Push-Location $App
try {
  npm ci --omit=dev --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
} finally { Pop-Location }
Start-ScheduledTask -TaskName 'Wamon'
Write-Host 'Updated and restarted.' -ForegroundColor Green
