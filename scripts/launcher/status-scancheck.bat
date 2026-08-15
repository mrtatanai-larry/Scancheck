@echo off
setlocal
set SCRIPT_DIR=%~dp0
call "%SCRIPT_DIR%run-powershell-script.bat" "%SCRIPT_DIR%status-scancheck.ps1"
exit /b %ERRORLEVEL%
