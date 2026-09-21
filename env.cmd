@echo off
REM ============================================================================
REM  Memory Leak Agent - Node environment activator (cmd.exe version)
REM ============================================================================
REM  The PowerShell equivalent is env.ps1.
REM
REM  HOW TO USE (from cmd.exe):
REM      cd /d C:\Users\Taufique\memory-leak-detection-agent
REM      .\env.cmd
REM
REM  Note the ".\" prefix, written WITHOUT a space. This machine has
REM  NoDefaultCurrentDirectoryInExePath=1 set, a Windows security setting
REM  that stops cmd searching the current folder for a command - so plain
REM  "env.cmd" gives "is not recognized" even standing in this directory.
REM
REM  NODE LIVES INSIDE THIS PROJECT
REM      The Node.js version is pinned in .node-version and kept in .node\
REM      (gitignored). If it is not there yet, this script downloads it - about
REM      30 MB, checked against nodejs.org's SHA-256 - so there is nothing to
REM      install or set up anywhere else.
REM
REM  WHAT IT DOES NOT DO
REM      It does not change your system PATH.
REM      It does not touch C:\Program Files\nodejs (Node 14 / IOSense).
REM      Close this window and everything is back to Node 14.
REM
REM  Want to skip this whole file? Run run-ui.cmd instead - it does this step
REM  and launches the guided UI in one go, from any directory.
REM ============================================================================

set "AGENT_ROOT=%~dp0"
set /p NODE_VERSION=<"%AGENT_ROOT%.node-version"
set "MEMORY_AGENT_NODE=%AGENT_ROOT%.node\node-v%NODE_VERSION%-win-x64"

if not exist "%MEMORY_AGENT_NODE%\node.exe" (
    echo   Node %NODE_VERSION% is not in this project yet - downloading it once...
    call "%AGENT_ROOT%scripts\setup-node.cmd"
    if errorlevel 1 (
        echo ERROR: could not set up Node %NODE_VERSION%. See the message above.
        exit /b 1
    )
)

REM Only prepend once, even if this is run twice in the same window.
echo %PATH% | find /i "%MEMORY_AGENT_NODE%" >nul
if errorlevel 1 set "PATH=%MEMORY_AGENT_NODE%;%PATH%"

REM npm's cache and Playwright's browsers also stay inside the project.
set "npm_config_cache=%AGENT_ROOT%.node\npm-cache"
set "PLAYWRIGHT_BROWSERS_PATH=%AGENT_ROOT%.node\playwright-browsers"

echo.
echo   Memory Leak Agent environment ACTIVE (this window only)
echo   ------------------------------------------------------
for /f "delims=" %%v in ('node -v') do echo   node : %%v
for /f "delims=" %%v in ('npm -v') do echo   npm  : %%v
echo   from : %MEMORY_AGENT_NODE%\node.exe
echo.
echo   Your system Node 14 / IOSense is untouched.
echo   Open a NORMAL Command Prompt to get Node 14 back.
echo.
