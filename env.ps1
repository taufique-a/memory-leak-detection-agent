# ============================================================================
#  Memory Leak Agent - Node environment activator (PowerShell)
# ============================================================================
#  WHAT THIS DOES
#    Puts this project's own Node.js (pinned in .node-version, kept in .node\)
#    at the FRONT of PATH, but ONLY for the PowerShell window you run it in.
#    If .node\ is missing it is downloaded once (about 30 MB, verified against
#    nodejs.org's SHA-256), so nothing needs installing anywhere else.
#
#  WHAT IT DOES NOT DO
#    It does not change your system PATH.
#    It does not touch C:\Program Files\nodejs (your Node 14 / IOSense).
#    Close this window, and everything is back to Node 14.
#
#  HOW TO USE
#    cd C:\Users\Taufique\memory-leak-detection-agent
#    . .\env.ps1              <-- note the leading dot-space. That matters.
#
#  The leading "dot space" is called dot-sourcing. It runs the script INSIDE
#  your current shell so the PATH change sticks. Without it, the change would
#  happen in a child process and vanish immediately.
#
#  Want to skip this whole file? Run run-ui.cmd instead - it does this step
#  and launches the guided UI in one go, from any directory.
# ============================================================================

$AgentRoot = $PSScriptRoot
$NodeVersion = (Get-Content (Join-Path $AgentRoot '.node-version') -Raw).Trim()
$MEMORY_AGENT_NODE = Join-Path $AgentRoot ".node\node-v$NodeVersion-win-x64"

if (-not (Test-Path "$MEMORY_AGENT_NODE\node.exe")) {
    Write-Host "  Node $NodeVersion is not in this project yet - downloading it once..." -ForegroundColor Yellow
    & (Join-Path $AgentRoot 'scripts\setup-node.ps1') -Root $AgentRoot
    if (-not (Test-Path "$MEMORY_AGENT_NODE\node.exe")) {
        Write-Host "ERROR: could not set up Node $NodeVersion. See the message above." -ForegroundColor Red
        return
    }
}

# Only prepend once, even if you dot-source this twice in the same window.
if ($env:Path -notlike "*$MEMORY_AGENT_NODE*") {
    $env:Path = "$MEMORY_AGENT_NODE;" + $env:Path
}

# npm's cache and Playwright's browsers also stay inside the project.
$env:npm_config_cache = Join-Path $AgentRoot '.node\npm-cache'
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $AgentRoot '.node\playwright-browsers'

Write-Host ""
Write-Host "  Memory Leak Agent environment ACTIVE (this window only)" -ForegroundColor Green
Write-Host "  ------------------------------------------------------"
Write-Host ("  node : " + (& node -v))
Write-Host ("  npm  : " + (& npm -v))
Write-Host ("  from : " + (Get-Command node).Source)
Write-Host ("  cache: " + $env:npm_config_cache)
Write-Host ""
Write-Host "  Your system Node 14 / IOSense is untouched." -ForegroundColor DarkGray
Write-Host "  Open a NORMAL PowerShell window to get Node 14 back." -ForegroundColor DarkGray
Write-Host ""
