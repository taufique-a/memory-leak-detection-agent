@echo off
REM ============================================================================
REM  Memory Leak Agent - isolated Node environment activator (cmd.exe version)
REM ============================================================================
REM  The PowerShell equivalent is env.ps1. This exists because Command Prompt
REM  does not understand PowerShell's dot-sourcing syntax: typing
REM  ". .\env.ps1" in cmd gives "'.' is not recognized as an internal or
REM  external command", which looks like a broken project rather than the
REM  wrong shell.
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
REM  Do not confuse this with PowerShell's ". .\env.ps1", which is
REM  dot-SPACE-dot-backslash and is a completely different mechanism
REM  (dot-sourcing). Here the dot-backslash is just part of the path.
REM
REM  WHAT IT DOES NOT DO
REM      It does not change your system PATH.
REM      It does not touch C:\Program Files\nodejs (Node 14 / IOSense).
REM      Close this window and everything is back to Node 14.
REM
REM  Want to skip this whole file? Run run-ui.cmd instead - it does this step
REM  and launches the guided UI in one go, from any directory.
REM ============================================================================

set "MEMORY_AGENT_NODE=C:\Users\Taufique\node-portable\node-v22.23.2-win-x64"

if not exist "%MEMORY_AGENT_NODE%\node.exe" (
    echo ERROR: portable Node not found at %MEMORY_AGENT_NODE%
    echo Re-run the Phase 0 download step.
    exit /b 1
)

REM Only prepend once, even if this is run twice in the same window.
echo %PATH% | find /i "%MEMORY_AGENT_NODE%" >nul
if errorlevel 1 set "PATH=%MEMORY_AGENT_NODE%;%PATH%"

REM Keep npm's cache and Playwright's browsers alongside the portable Node install.
set "npm_config_cache=C:\Users\Taufique\node-portable\npm-cache"
set "PLAYWRIGHT_BROWSERS_PATH=C:\Users\Taufique\node-portable\playwright-browsers"

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
