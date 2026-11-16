param([int]$Port = 3210)
Set-Location -LiteralPath $PSScriptRoot
if (-not $env:KKOK_LEGACY_ROOT -and (Test-Path -LiteralPath 'C:\KKokKKok\KkokKkok-PoC\package.json')) {
  $env:KKOK_LEGACY_ROOT = 'C:\KKokKKok\KkokKkok-PoC'
}
$env:PORT = "$Port"
node server.mjs
