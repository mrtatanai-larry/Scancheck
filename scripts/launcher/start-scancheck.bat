@echo off
setlocal
set SCRIPT_DIR=%~dp0
call "%SCRIPT_DIR%run-powershell-script.bat" "%SCRIPT_DIR%start-scancheck.ps1"
set EXIT_CODE=%ERRORLEVEL%
if not "%EXIT_CODE%"=="0" (
    echo.
    echo [ScanCheck] Startup failed. Read the error above.
    echo [ScanCheck] If this window was opened by double-clicking, press any key to close it.
    pause >nul
)
exit /b %EXIT_CODE%
