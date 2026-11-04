<#
  Supervisor started by the "Wamon" scheduled task: runs the app, logs its output,
  and restarts it 5 seconds after any exit. Not meant to be run by hand.
#>
param(
  [Parameter(Mandatory)] [string]$EnvFile,
  [Parameter(Mandatory)] [string]$Logs
)
$App = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $App
$env:ENV_FILE = $EnvFile

while ($true) {
  # One log file per day; keep two weeks.
  Get-ChildItem $Logs -Filter 'wamon-*.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -ErrorAction SilentlyContinue
  $log = Join-Path $Logs ('wamon-{0:yyyy-MM-dd}.log' -f (Get-Date))
  Add-Content -Path $log -Value "[$(Get-Date -Format s)] starting"
  # --wamon-prod marks this process so update/uninstall can find it without touching other Node apps.
  cmd /c "node --import tsx src/index.ts --wamon-prod >> `"$log`" 2>&1"
  Add-Content -Path $log -Value "[$(Get-Date -Format s)] exited with code $LASTEXITCODE, restarting in 5s"
  Start-Sleep -Seconds 5
}
