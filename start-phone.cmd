@echo off
rem Rals Cockpit - same console, but reachable from your phone on this Wi-Fi.
rem The port is protected by an access code printed in the server window; asked once per device.
rem Do NOT port-forward this. Anyone with the code can open terminals on this PC.
rem
rem This one does NOT minimise: you need to read the access code out of the window.
cd /d "%~dp0"
where node >nul 2>&1 || (echo Node.js is required but was not found on PATH. & pause & exit /b 1)
if not defined FLEET_PORT set FLEET_PORT=7457

netstat -ano | findstr /r /c:"LISTENING.*:%FLEET_PORT% " >nul 2>&1 && (
  echo Something is already listening on %FLEET_PORT% - stop that window first.
  pause
  exit /b 1
)

title Rals Cockpit (phone access)
set FLEET_LAN=1
rem Uncomment to keep the same code across restarts instead of a fresh one each time:
rem set FLEET_KEY=MYCODE12
node server.mjs
echo.
echo Rals Cockpit stopped.
pause
