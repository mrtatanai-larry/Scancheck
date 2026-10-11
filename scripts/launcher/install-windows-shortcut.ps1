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
$LauncherBat = Join-Path $ScriptDir "start-scancheck.bat"
$DesktopPath = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $DesktopPath "ScanCheck.lnk"

if (-not (Test-Path $LauncherBat)) {
    throw "Missing launcher batch file: $LauncherBat"
}

$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = $LauncherBat
$shortcut.WorkingDirectory = $RootDir
$shortcut.Description = "Start ScanCheck server and open dashboard"
$shortcut.IconLocation = "powershell.exe,0"
$shortcut.Save()

Write-Host "[ScanCheck] Windows desktop shortcut created:"
Write-Host "  $ShortcutPath"
