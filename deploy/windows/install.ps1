<#
  Installs Wamon on this Windows PC as a hidden background app that starts when you log in
  and restarts itself if it crashes.

    powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1 [-DevEnv path\to\.env]

  Code goes to %LOCALAPPDATA%\Wamon\app (a clean copy from GitHub, separate from your dev folder),
  settings to %LOCALAPPDATA%\Wamon\wamon.env, WhatsApp sessions to ...\data, logs to ...\logs.
  The dashboard listens on http://127.0.0.1:3100; a Cloudflare Tunnel makes it public.
#>
param(
  [string]$RepoUrl = 'https://github.com/lorangutan/whatsapp-admin-dashboard.git',
  [int]$Port = 3100,
  # Optional: reuse the TiDB cluster from your dev .env (the production database is named "wamon").
  [string]$DevEnv = ''
)
$ErrorActionPreference = 'Stop'

$Root = Join-Path $env:LOCALAPPDATA 'Wamon'
$App = Join-Path $Root 'app'
$Data = Join-Path $Root 'data'
$Logs = Join-Path $Root 'logs'
$EnvFile = Join-Path $Root 'wamon.env'
New-Item -ItemType Directory -Force -Path $Root, $Data, $Logs | Out-Null

function Get-Plain([Security.SecureString]$s) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

Write-Host '==> Code' -ForegroundColor Cyan
if (Test-Path (Join-Path $App '.git')) { git -C $App pull --ff-only } else { git clone --quiet $RepoUrl $App }
if ($LASTEXITCODE -ne 0) { throw 'git failed' }
Push-Location $App
try {
  npm ci --omit=dev --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
} finally { Pop-Location }

if (-not (Test-Path $EnvFile)) {
  Write-Host "==> Settings (saved only in $EnvFile)" -ForegroundColor Cyan
  $dbUrl = ''
  if ($DevEnv -and (Test-Path $DevEnv)) {
    $line = Get-Content $DevEnv | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
    if ($line) {
      # Same TiDB cluster, separate production database "wamon"; drop any ?query options.
      $dbUrl = (($line -replace '^DATABASE_URL=', '') -replace '\?.*$', '') -replace '/[^/]*$', '/wamon'
      Write-Host 'Using the TiDB cluster from your dev .env with database "wamon".'
    }
  }
  if (-not $dbUrl) { $dbUrl = Read-Host 'TiDB DATABASE_URL (mysql://user:pass@host:4000/wamon)' }

  while ($true) {
    $pw = Get-Plain (Read-Host 'Choose a dashboard password (min. 8 characters)' -AsSecureString)
    $again = Get-Plain (Read-Host 'Repeat the password' -AsSecureString)
    if ($pw -ne $again) { Write-Host 'Passwords differ, try again.' -ForegroundColor Yellow; continue }
    if ($pw.Length -lt 8) { Write-Host 'Too short, use at least 8 characters.' -ForegroundColor Yellow; continue }
    if ($pw.Contains("'")) { Write-Host "Please avoid the ' character." -ForegroundColor Yellow; continue }
    break
  }
  $shop = Read-Host 'Shop name [Toko Saya]'
  if (-not $shop) { $shop = 'Toko Saya' }

  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $secret = -join ($bytes | ForEach-Object { $_.ToString('x2') })

  # Single quotes keep characters like # or $ literal for Node's env-file parser.
  $lines = @(
    'NODE_ENV=production', 'HOST=127.0.0.1', "PORT=$Port", 'TRUST_PROXY=true',
    "DATA_DIR='$Data'", "SHOP_NAME='$shop'", "DATABASE_URL='$dbUrl'",
    "ADMIN_PASSWORD='$pw'", "SESSION_SECRET=$secret", 'LOG_LEVEL=info'
  )
  # UTF-8 without BOM: a BOM would become part of the first variable name.
  [IO.File]::WriteAllLines($EnvFile, $lines, (New-Object Text.UTF8Encoding $false))
  # Only your Windows account can read the file with the password in it.
  icacls $EnvFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
  $pw = $null; $again = $null
}

Write-Host '==> Background task' -ForegroundColor Cyan
$run = Join-Path $App 'deploy\windows\run.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$run`" -EnvFile `"$EnvFile`" -Logs `"$Logs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Wamon' -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Wamon WhatsApp CRM (starts at logon, restarts on crash)' -Force | Out-Null
Start-ScheduledTask -TaskName 'Wamon'

Write-Host 'Waiting for Wamon to start...'
$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 2
  try { Invoke-RestMethod "http://127.0.0.1:$Port/api/session" -TimeoutSec 3 | Out-Null; $ok = $true; break } catch { }
}
if ($ok) {
  Write-Host ''
  Write-Host "Wamon is running on http://127.0.0.1:$Port" -ForegroundColor Green
  Write-Host "Logs:   $Logs"
  Write-Host 'Update: powershell -ExecutionPolicy Bypass -File' (Join-Path $App 'deploy\windows\update.ps1')
} else {
  Write-Host "Wamon did not start. Check the newest log in $Logs" -ForegroundColor Red
  exit 1
}
