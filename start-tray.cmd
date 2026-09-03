@echo off
rem Rals Cockpit - system tray mode. Same server as start.cmd, but with a tray icon instead of a
rem visible console window: right-click it for Open / View log / Quit.
cd /d "%~dp0"
where node >nul 2>&1 || (echo Node.js is required but was not found on PATH. & pause & exit /b 1)

rem Already running? Just open the page instead of starting a second one.
netstat -ano | findstr /r /c:"LISTENING.*:7457 " >nul 2>&1 && (
  echo Rals Cockpit is already running - opening it.
  start "" "http://localhost:7457/"
  exit /b 0
)

rem wscript running a tiny generated .vbs is the standard trick for a truly windowless launch -
rem powershell.exe's own -WindowStyle Hidden still flashes a console for an instant on its own.
set VBS=%TEMP%\ralias-cockpit-tray-launch.vbs
> "%VBS%" echo Set WshShell = CreateObject("WScript.Shell")
>> "%VBS%" echo WshShell.Run "powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File ""%~dp0tray.ps1""", 0, False
wscript.exe "%VBS%"
del "%VBS%" >nul 2>&1
exit /b 0
