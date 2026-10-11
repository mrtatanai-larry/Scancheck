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
$PortFile = Join-Path $RuntimeDir "current_port.txt"

$port = "3000"
if (Test-Path $PortFile) {
    $port = (Get-Content $PortFile -Raw).Trim()
}

if (-not (Test-Path $PidFile)) {
    Write-Host "[ScanCheck] STOPPED"
    exit 1
}

$pidValue = (Get-Content $PidFile -Raw).Trim()
if (-not $pidValue) {
    Write-Host "[ScanCheck] STOPPED (empty PID file)"
    exit 1
}

$proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
if (-not $proc) {
    Write-Host "[ScanCheck] STOPPED (stale PID file)"
    exit 1
}

try {
    $null = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/health" -UseBasicParsing -TimeoutSec 2
    Write-Host "[ScanCheck] RUNNING | PID=$pidValue | URL=http://localhost:$port"
    exit 0
} catch {
    Write-Host "[ScanCheck] PROCESS UP but health check failed | PID=$pidValue | PORT=$port"
    exit 1
}
