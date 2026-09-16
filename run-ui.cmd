@echo off
REM ============================================================================
REM  Memory Leak Agent - one-step launcher for the guided UI
REM ============================================================================
REM  Run this from anywhere on ANY machine - double-click it, or type its full
REM  path in any terminal. It does not matter what your current directory,
REM  drive letter or Windows user account is.
REM
REM  It figures out Node itself, installs dependencies if they are missing,
REM  and opens the guided UI. The UI's own "choose your project" step lets you
REM  pick the app to investigate, so no project path needs to be hardcoded
REM  here either.
REM
REM  MACHINE-SPECIFIC SETUP (optional)
REM    This tool needs Node >=20. If this machine's system Node already
REM    satisfies that, you need nothing else - skip to running the script.
REM
REM    If not (e.g. system Node is v14, as on Taufique's original machine),
REM    point this script at a portable Node 20+ install and, if you want, a
REM    default project, without editing this file (which is shared/committed):
REM      1. Copy run-ui.local.cmd.example to run-ui.local.cmd (next to this
REM         file - it is gitignored, so your machine's paths never get
REM         committed).
REM      2. Edit MEMORY_AGENT_NODE and MEMORY_AGENT_PROJECT in that copy.
REM ============================================================================

REM %~dp0 is this script's own folder, so this works no matter where you run
REM it from or what your current directory was.
cd /d "%~dp0"

if exist ".\run-ui.local.cmd" call ".\run-ui.local.cmd"

if defined MEMORY_AGENT_NODE (
    if exist "%MEMORY_AGENT_NODE%\node.exe" (
        echo %PATH% | find /i "%MEMORY_AGENT_NODE%" >nul
        if errorlevel 1 set "PATH=%MEMORY_AGENT_NODE%;%PATH%"
    ) else (
        echo WARNING: MEMORY_AGENT_NODE is set to "%MEMORY_AGENT_NODE%" but no node.exe was found there. Falling back to the system Node.
    )
)

if defined MEMORY_AGENT_NPM_CACHE set "npm_config_cache=%MEMORY_AGENT_NPM_CACHE%"
if defined MEMORY_AGENT_PLAYWRIGHT_PATH set "PLAYWRIGHT_BROWSERS_PATH=%MEMORY_AGENT_PLAYWRIGHT_PATH%"

where node >nul 2>nul
if errorlevel 1 (
    echo ERROR: no "node" found on PATH, and no working MEMORY_AGENT_NODE override.
    echo Install Node 20+, or see run-ui.local.cmd.example for pointing this
    echo script at a portable Node install.
    pause
    exit /b 1
)

set NODE_MAJOR=
for /f "tokens=1 delims=." %%v in ('node -v') do set NODE_MAJOR=%%v
set NODE_MAJOR=%NODE_MAJOR:v=%

if %NODE_MAJOR% LSS 20 (
    echo ERROR: this Node is too old ^(need ^>=20, found v%NODE_MAJOR%.x^).
    for /f "delims=" %%p in ('where node') do echo   node.exe : %%p
    echo.
    echo Either install Node 20+ as this machine's default, or point this
    echo script at a portable Node 20+ install - see run-ui.local.cmd.example.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo Dependencies not installed yet - running npm install ^(one-time, may take a minute^)...
    call npm install
    if errorlevel 1 (
        echo.
        echo   npm install failed - see the output above.
        pause
        exit /b 1
    )
)

echo.
echo   Memory Leak Agent - guided UI
echo   ------------------------------------------------------
for /f "delims=" %%v in ('node -v') do echo   node    : %%v
if defined MEMORY_AGENT_PROJECT echo   project : %MEMORY_AGENT_PROJECT%
echo.

if defined MEMORY_AGENT_PROJECT (
    call npm run dev -- ui --project "%MEMORY_AGENT_PROJECT%"
) else (
    call npm run dev -- ui
)

if errorlevel 1 (
    echo.
    echo   Something went wrong - see the output above.
    pause
)
