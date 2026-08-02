@echo off
setlocal
set SCRIPT_DIR=%~dp0
where pwsh.exe >nul 2>nul
if "%ERRORLEVEL%"=="0" (
    pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%status-scancheck.ps1"
) else (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%status-scancheck.ps1"
)
exit /b %ERRORLEVEL%
