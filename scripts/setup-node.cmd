@echo off
REM Download the pinned Node.js into this project's .node\ folder (see setup-node.ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-node.ps1"
exit /b %errorlevel%
