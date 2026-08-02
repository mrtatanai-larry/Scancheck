@echo off
setlocal enabledelayedexpansion

echo Configuring firewall for ScanCheck Server...
echo.

:: Try to read port from current_port.txt
set "PORT=3000"
if exist current_port.txt (
    set /p PORT=<current_port.txt
)

echo Detected port: %PORT%
echo.

:: Remove old rules if they exist
netsh advfirewall firewall delete rule name="ScanCheck Server" >nul 2>&1

:: Add rule for the detected port
echo Adding firewall rule for port %PORT%...
netsh advfirewall firewall add rule name="ScanCheck Server" dir=in action=allow protocol=TCP localport=%PORT%

:: Also add rule for a range to be safe
echo Adding firewall rule for port range 3000-3010...
netsh advfirewall firewall add rule name="ScanCheck Server Range" dir=in action=allow protocol=TCP localport=3000-3010

echo.
echo Detecting Local IP Address...
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4 Address"') do (
    set "IP=%%a"
    set "IP=!IP:~1!"
    echo Found IP: !IP!
)

echo.
echo Setup complete! 
echo.
echo Use this URL on your phone: http://!IP!:%PORT%
echo.
pause