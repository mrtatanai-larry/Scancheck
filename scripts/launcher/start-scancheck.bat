@echo off
setlocal
set SCRIPT_DIR=%~dp0
where pwsh.exe >nul 2>nul
if "%ERRORLEVEL%"=="0" (
    pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start-scancheck.ps1"
) else (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start-scancheck.ps1"
)
set EXIT_CODE=%ERRORLEVEL%
if not "%EXIT_CODE%"=="0" (
    echo.
    echo [ScanCheck] Startup failed. Read the error above.
    echo [ScanCheck] If this window was opened by double-clicking, press any key to close it.
    pause >nul
)
exit /b %EXIT_CODE%
