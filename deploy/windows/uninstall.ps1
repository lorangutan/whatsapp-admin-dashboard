<#
  Stops Wamon and removes the background task. Keeps %LOCALAPPDATA%\Wamon (settings, WhatsApp
  sessions, logs) unless you pass -DeleteFiles. Data in TiDB is never touched.
#>
param([switch]$DeleteFiles)
Stop-ScheduledTask -TaskName 'Wamon' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*--wamon-prod*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Unregister-ScheduledTask -TaskName 'Wamon' -Confirm:$false -ErrorAction SilentlyContinue
if ($DeleteFiles) { Remove-Item -Recurse -Force (Join-Path $env:LOCALAPPDATA 'Wamon') }
Write-Host 'Wamon removed.'
