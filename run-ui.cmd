@echo off
REM ============================================================================
REM  Memory Leak Agent - one-step launcher for the guided UI
REM ============================================================================
REM  Run this from anywhere on ANY machine - double-click it, or type its full
REM  path in any terminal. It does not matter what your current directory,
REM  drive letter or Windows user account is.
REM
REM  It sets up Node itself (pinned in .node-version and kept inside this
REM  project, in .node\ - downloaded once if it is not there), installs
REM  dependencies if they are missing,
REM  checks and compiles the project you are investigating, and then opens
REM  the guided UI. The UI's own "choose your project" step lets you pick the
REM  app to investigate, so no project path needs to be hardcoded here either.
REM
REM  TWO DIFFERENT NODES, ON PURPOSE
REM    This script only manages the Node THIS TOOL runs on (it needs >=20).
REM    The project you are investigating always builds and serves with
REM    whatever "node" is already the default on this machine - v14 for
REM    IOSense - never with the Node below. That split is intentional: the
REM    tool's own requirements should never change how your project builds.
REM
REM  NOTHING TO SET UP
REM    The Node this tool needs (>=20) lives in this project's .node\ folder.
REM    The first run downloads it (about 30 MB, checked against nodejs.org's
REM    SHA-256); after that there is no download. No installer, no PATH change.
REM
REM  OPTIONAL OVERRIDES
REM    To use a different Node, or to set a default project, without editing
REM    this file (which is shared/committed):
REM      1. Copy run-ui.local.cmd.example to run-ui.local.cmd (next to this
REM         file - it is gitignored, so your machine's paths never get
REM         committed).
REM      2. Edit MEMORY_AGENT_NODE and MEMORY_AGENT_PROJECT in that copy.
REM ============================================================================

REM %~dp0 is this script's own folder, so this works no matter where you run
REM it from or what your current directory was.
cd /d "%~dp0"

if exist ".\run-ui.local.cmd" call ".\run-ui.local.cmd"

REM The project's own Node, unless run-ui.local.cmd pointed somewhere else.
set /p NODE_VERSION=<".node-version"
set "PROJECT_NODE=%~dp0.node\node-v%NODE_VERSION%-win-x64"
if not defined MEMORY_AGENT_NODE set "MEMORY_AGENT_NODE=%PROJECT_NODE%"
if not exist "%PROJECT_NODE%\node.exe" if /i "%MEMORY_AGENT_NODE%"=="%PROJECT_NODE%" (
    echo   Node %NODE_VERSION% is not in this project yet - downloading it once...
    call "%~dp0scripts\setup-node.cmd"
)
if not defined MEMORY_AGENT_NPM_CACHE set "MEMORY_AGENT_NPM_CACHE=%~dp0.node\npm-cache"
if not defined MEMORY_AGENT_PLAYWRIGHT_PATH set "MEMORY_AGENT_PLAYWRIGHT_PATH=%~dp0.node\playwright-browsers"

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
    echo ERROR: the project's Node could not be set up ^(see the message above^).
    echo Check the internet connection and run scripts\setup-node.cmd again.
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

REM Keep dependencies in step with package.json on every start - after a
REM git pull that added a package, a stale node_modules is otherwise a crash.
REM Quick when nothing changed. A failure only blocks the very first install.
if not exist "node_modules" (
    echo Dependencies not installed yet - running npm install ^(one-time, may take a minute^)...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo.
        echo   npm install failed - see the output above.
        pause
        exit /b 1
    )
) else (
    call npm install --no-audit --no-fund --prefer-offline >nul 2>nul
    if errorlevel 1 echo   ^(could not refresh dependencies - continuing with what is installed^)
)

echo.
echo   Memory Leak Agent
echo   ------------------------------------------------------
for /f "delims=" %%v in ('node -v') do echo   node    : %%v
if defined MEMORY_AGENT_PROJECT echo   project : %MEMORY_AGENT_PROJECT%
echo.

REM Check, debug and compile the project FIRST - before opening anything, and
REM before assuming it is in working order. If the project already has known
REM problems, they show up here, plainly, rather than surfacing later as a
REM confusing failure somewhere downstream. This can take a while on a large
REM project; it is allowed to.
if defined MEMORY_AGENT_PROJECT (
    echo   Checking the project...
    echo.
    call npm run dev -- compile "%MEMORY_AGENT_PROJECT%"
)

echo.
echo   Opening the guided UI...
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
