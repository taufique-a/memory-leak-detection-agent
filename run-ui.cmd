@echo off
REM ============================================================================
REM  Memory Leak Agent - one-step launcher for the guided UI
REM ============================================================================
REM  Run this from anywhere - double-click it, or type its full path in any
REM  terminal. It does not matter what your current directory is.
REM
REM  It replaces the old two-step dance (cd + env.cmd/env.ps1 + npm run dev)
REM  with one file: it finds the portable Node itself, switches into this repo,
REM  and opens the guided UI already pointed at your IOSense checkout.
REM ============================================================================

set "MEMORY_AGENT_NODE=C:\Users\Taufique\node-portable\node-v22.23.2-win-x64"
set "IOSENSE_PROJECT=C:\Users\Taufique\IOSense"

if not exist "%MEMORY_AGENT_NODE%\node.exe" (
    echo ERROR: portable Node not found at %MEMORY_AGENT_NODE%
    pause
    exit /b 1
)

echo %PATH% | find /i "%MEMORY_AGENT_NODE%" >nul
if errorlevel 1 set "PATH=%MEMORY_AGENT_NODE%;%PATH%"

set "npm_config_cache=C:\Users\Taufique\node-portable\npm-cache"
set "PLAYWRIGHT_BROWSERS_PATH=C:\Users\Taufique\node-portable\playwright-browsers"

REM %~dp0 is this script's own folder, so this works no matter where you run it from.
cd /d "%~dp0"

echo.
echo   Memory Leak Agent - guided UI
echo   ------------------------------------------------------
for /f "delims=" %%v in ('node -v') do echo   node    : %%v
echo   project : %IOSENSE_PROJECT%
echo.

call npm run dev -- ui --project "%IOSENSE_PROJECT%"

if errorlevel 1 (
    echo.
    echo   Something went wrong - see the output above.
    pause
)
