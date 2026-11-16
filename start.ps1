param([int]$Port = 3210)
& (Join-Path $PSScriptRoot 'location-cue-lab\start.ps1') -Port $Port
