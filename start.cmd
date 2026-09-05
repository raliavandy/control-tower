@echo off
rem Control Tower - double-click to open the session console.
rem Runs the server in a MINIMISED window so it never sits on top of the dashboard.
rem It stays in the taskbar as "Control Tower" - close that window to stop the server.
cd /d "%~dp0"
where node >nul 2>&1 || (echo Node.js is required but was not found on PATH. & pause & exit /b 1)
if not defined FLEET_PORT set FLEET_PORT=7457

rem Already running? Just open the page instead of starting a second one.
netstat -ano | findstr /r /c:"LISTENING.*:%FLEET_PORT% " >nul 2>&1 && (
  echo Control Tower is already running - opening it.
  start "" "http://localhost:%FLEET_PORT%/"
  exit /b 0
)

start "Control Tower" /min cmd /c "title Control Tower & node server.mjs & echo. & echo Control Tower stopped. & pause"
exit /b 0
