Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = $null
if ($PSScriptRoot) {
    $ScriptDir = $PSScriptRoot
} elseif ($env:SCANCHECK_PS_SCRIPT -and (Test-Path $env:SCANCHECK_PS_SCRIPT)) {
    $ScriptDir = Split-Path -Parent $env:SCANCHECK_PS_SCRIPT
} else {
    try {
        $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    } catch {
        $ScriptDir = Get-Location
    }
}
$RootDir = (Resolve-Path (Join-Path $ScriptDir "..\..")).ProviderPath
$RuntimeDir = Join-Path $RootDir ".runtime"
$PidFile = Join-Path $RuntimeDir "scancheck.pid"

if (-not (Test-Path $PidFile)) {
    Write-Host "[ScanCheck] No PID file found. Server may already be stopped."
    exit 0
}

$pidValue = (Get-Content $PidFile -Raw).Trim()
if (-not $pidValue) {
    Write-Host "[ScanCheck] Empty PID file. Cleaning up."
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    exit 0
}

$proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
if (-not $proc) {
    Write-Host "[ScanCheck] PID $pidValue is not running."
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    exit 0
}

Write-Host "[ScanCheck] Stopping server PID $pidValue..."
try {
    Stop-Process -Id $pidValue -ErrorAction Stop
} catch {
    Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
}

Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
Write-Host "[ScanCheck] Server stopped."
