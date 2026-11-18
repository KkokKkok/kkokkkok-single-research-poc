# Starts the analysis server the Spring backend calls (analysis-server.mjs), on this machine only.
# It takes the place of the earlier runtime's analysis server and OCR sidecar: stop those first.
#   .\start-analysis.ps1                 port 3001, the port the local backend is pointed at
#   .\start-analysis.ps1 -Port 3011
# ANALYSIS_API_KEY must equal the backend's NODE_ANALYSIS_API_KEY. When it is not set, it is read
# from .env here, else from the .env.local of the earlier runtime that the local backend start
# script also reads.
# The model is Claude: ANTHROPIC_API_KEY comes from .env here (ANALYSIS_MODEL and ANALYSIS_EFFORT are
# optional). No value is printed.
param([int]$Port = 3001, [string]$KeyFile = 'C:\KKokKKok\local-test\KkokKkok-PoC\.env.local')
Set-Location -LiteralPath $PSScriptRoot
if (-not $env:KKOK_LEGACY_ROOT -and (Test-Path -LiteralPath 'C:\KKokKKok\KkokKkok-PoC\package.json')) {
  $env:KKOK_LEGACY_ROOT = 'C:\KKokKKok\KkokKkok-PoC'
}
# Looked for in this order: the environment, .env here, then the key file.
foreach ($file in @((Join-Path $PSScriptRoot '.env'), $KeyFile)) {
  if (-not $env:ANALYSIS_API_KEY -and (Test-Path -LiteralPath $file)) {
    $line = Get-Content -LiteralPath $file -Encoding UTF8 | Where-Object { $_ -match '^\s*ANALYSIS_API_KEY\s*=\s*(.+)$' } | Select-Object -First 1
    if ($line -match '^\s*ANALYSIS_API_KEY\s*=\s*(.+)$') { $env:ANALYSIS_API_KEY = $Matches[1].Trim() }
  }
}
if (-not $env:ANALYSIS_API_KEY) { throw 'ANALYSIS_API_KEY is not set and was not found in .env or the key file.' }
$env:ANALYSIS_PORT = "$Port"
node analysis-server.mjs
