@echo off
setlocal

set "PS_SCRIPT=%~1"
if "%PS_SCRIPT%"=="" (
    echo [ScanCheck] Missing PowerShell script path.
    exit /b 1
)

if not exist "%PS_SCRIPT%" (
    echo [ScanCheck] PowerShell script not found: %PS_SCRIPT%
    exit /b 1
)

where pwsh.exe >nul 2>nul
if "%ERRORLEVEL%"=="0" (
    set "PS_EXE=pwsh.exe"
) else (
    set "PS_EXE=powershell.exe"
)

"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"
if "%ERRORLEVEL%"=="0" (
    exit /b 0
)

echo.
echo [ScanCheck] PowerShell script-file execution failed.
echo [ScanCheck] Retrying with an in-memory launcher...

set "SCANCHECK_PS_SCRIPT=%PS_SCRIPT%"
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -Command "$scriptPath = $env:SCANCHECK_PS_SCRIPT; $script = [scriptblock]::Create((Get-Content -LiteralPath $scriptPath -Raw)); & $script"
if "%ERRORLEVEL%"=="0" (
    exit /b 0
)

echo.
echo [ScanCheck] PowerShell could not run the launcher.
echo [ScanCheck] If this computer is managed by school, company, or antivirus policy,
echo [ScanCheck] Group Policy, AppLocker, or Defender Application Control may be blocking it.
exit /b %ERRORLEVEL%
