# ============================================================================
#  Memory Leak Agent - isolated Node environment activator
# ============================================================================
#  WHAT THIS DOES
#    Puts our portable Node 22 at the FRONT of PATH, but ONLY for the
#    PowerShell window you run it in.
#
#  WHAT IT DOES NOT DO
#    It does not change your system PATH.
#    It does not touch C:\Program Files\nodejs (your Node 14 / IOSense).
#    Close this window, and everything is back to Node 14.
#
#  HOW TO USE
#    cd e:\taufique\memory-agent
#    . .\env.ps1              <-- note the leading dot-space. That matters.
#
#  The leading "dot space" is called dot-sourcing. It runs the script INSIDE
#  your current shell so the PATH change sticks. Without it, the change would
#  happen in a child process and vanish immediately.
# ============================================================================

$MEMORY_AGENT_NODE = "E:\taufique\node-portable\node-v22.23.2-win-x64"

if (-not (Test-Path "$MEMORY_AGENT_NODE\node.exe")) {
    Write-Host "ERROR: portable Node not found at $MEMORY_AGENT_NODE" -ForegroundColor Red
    Write-Host "Re-run the Phase 0 download step." -ForegroundColor Red
    return
}

# Only prepend once, even if you dot-source this twice in the same window.
if ($env:Path -notlike "*$MEMORY_AGENT_NODE*") {
    $env:Path = "$MEMORY_AGENT_NODE;" + $env:Path
}

# Keep npm's cache off C: - that drive only has ~5 GB free.
$env:npm_config_cache = "E:\taufique\node-portable\npm-cache"

# Keep Playwright browser downloads off C: too (used from Phase 7 onward).
$env:PLAYWRIGHT_BROWSERS_PATH = "E:\taufique\node-portable\playwright-browsers"

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
