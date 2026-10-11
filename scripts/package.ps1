# Builds dist/peppa-pig-player.zip for sharing with other PCs.
# Usage: npm run package
# NOTE: keep this file ASCII-only (PowerShell 5.1 reads BOM-less files in the ANSI code page).
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $projectRoot 'dist'
$stage = Join-Path $dist 'peppa-pig-player'
$zip = Join-Path $dist 'peppa-pig-player.zip'

# Only what the recipient needs (no CLAUDE.md, dev README, or this script).
$items = @('public', 'server.js', 'server.ps1', 'start.bat', 'start.command', 'package.json', 'INSTALL.txt')

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
if (Test-Path $zip) { Remove-Item -Force $zip }
New-Item -ItemType Directory -Force $stage | Out-Null

foreach ($item in $items) {
  Copy-Item -Recurse (Join-Path $projectRoot $item) $stage
}

# cmd.exe expects CRLF line endings in .bat files
$bat = Join-Path $stage 'start.bat'
$text = [System.IO.File]::ReadAllText($bat) -replace "`r?`n", "`r`n"
[System.IO.File]::WriteAllText($bat, $text, (New-Object System.Text.UTF8Encoding $false))

# Compress-Archive in PowerShell 5.1 writes '\' in entry names, which breaks extraction on macOS,
# so build the zip manually with '/' separators.
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($zip, 'Create')
try {
  Get-ChildItem -Recurse -File $stage | ForEach-Object {
    $entry = 'peppa-pig-player/' + $_.FullName.Substring($stage.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $entry) | Out-Null
  }
} finally {
  $archive.Dispose()
}
Remove-Item -Recurse -Force $stage

$sizeKb = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Host "Created $zip ($sizeKb KB)"
