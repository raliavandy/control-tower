@echo off
rem Rals Cockpit - double-click to open the session console.
rem Runs the server in a MINIMISED window so it never sits on top of the dashboard.
rem It stays in the taskbar as "Rals Cockpit" - close that window to stop the server.
cd /d "%~dp0"
where node >nul 2>&1 || (echo Node.js is required but was not found on PATH. & pause & exit /b 1)

rem Already running? Just open the page instead of starting a second one.
netstat -ano | findstr /r /c:"LISTENING.*:7457 " >nul 2>&1 && (
  echo Rals Cockpit is already running - opening it.
  start "" "http://localhost:7457/"
  exit /b 0
)

start "Rals Cockpit" /min cmd /c "title Rals Cockpit & node server.mjs & echo. & echo Rals Cockpit stopped. & pause"
exit /b 0
