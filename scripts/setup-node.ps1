# ============================================================================
#  Download the pinned Node.js into THIS project (.node\), once.
# ============================================================================
#  The version lives in .node-version. The download is checked against the
#  SHA-256 published by nodejs.org before it is unpacked, and nothing outside
#  this project folder is touched: no installer, no PATH change, no registry.
#
#  You normally never run this yourself - env.cmd, env.ps1 and run-ui.cmd call
#  it when .node\ is missing. Running it again when Node is already there does
#  nothing.
# ============================================================================
param(
    [string]$Root = (Split-Path $PSScriptRoot -Parent)
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # the progress bar makes downloads ~10x slower in Windows PowerShell

$version = (Get-Content (Join-Path $Root '.node-version') -Raw).Trim()
$nodeRoot = Join-Path $Root '.node'
$nodeDir = Join-Path $nodeRoot "node-v$version-win-x64"

if (Test-Path (Join-Path $nodeDir 'node.exe')) {
    Write-Host "Node $version is already in $nodeDir"
    exit 0
}

$zipName = "node-v$version-win-x64.zip"
$base = "https://nodejs.org/dist/v$version"
$zip = Join-Path $nodeRoot $zipName

New-Item -ItemType Directory -Force $nodeRoot | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Write-Host "Downloading Node $version (about 30 MB) into $nodeRoot ..."
Invoke-WebRequest "$base/$zipName" -OutFile $zip -UseBasicParsing

$sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content
$line = ($sums -split "`n") | Where-Object { $_ -match [regex]::Escape($zipName) } | Select-Object -First 1
if (-not $line) {
    Remove-Item $zip -Force
    throw "nodejs.org lists no checksum for $zipName - refusing to use an unverified download."
}
$expected = ($line.Trim() -split '\s+')[0].ToLower()
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) {
    Remove-Item $zip -Force
    throw "Checksum mismatch for $zipName (expected $expected, got $actual). The download was discarded."
}

Write-Host 'Checksum verified. Unpacking ...'
Expand-Archive $zip $nodeRoot -Force
Remove-Item $zip -Force

if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) {
    throw "Unpacked, but $nodeDir\node.exe is missing."
}
Write-Host "Node $version is ready in $nodeDir"
