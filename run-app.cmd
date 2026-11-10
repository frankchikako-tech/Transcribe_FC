@echo off
rem Transcriber app launcher — double-click me
cd /d "%~dp0app"
start "" cmd /c "npm start"
