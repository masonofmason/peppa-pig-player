# Peppa Pig Player - static file server for Windows PCs without Node.js.
# Uses only what ships with Windows (PowerShell 5.1 + .NET HttpListener); no admin rights needed.
# Usage: powershell -ExecutionPolicy Bypass -File server.ps1 [-Open]
# NOTE: keep this file ASCII-only. PowerShell 5.1 reads BOM-less files in the ANSI code page.
param([switch]$Open)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'public'))
$basePort = 5173
$maxTries = 10
$appTitle = '<title>Peppa Pig Player</title>'

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.webmanifest' = 'application/manifest+json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.ico'  = 'image/x-icon'
}

function Test-OurApp([int]$port) {
  try {
    # 127.0.0.1, not localhost: PS 5.1 tries ::1 first and can time out before falling back to IPv4.
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/" -TimeoutSec 2
    return $r.Content.Contains($appTitle)
  } catch {
    return $false
  }
}

# Watch history lives in localStorage, which is per origin (incl. port), so prefer the same port.
$listener = $null
$port = $basePort
for (; $port -lt $basePort + $maxTries; $port++) {
  $candidate = New-Object System.Net.HttpListener
  $candidate.Prefixes.Add("http://localhost:$port/")
  try {
    $candidate.Start()
    $listener = $candidate
    break
  } catch {
    $candidate.Close()
    if (Test-OurApp $port) {
      Write-Host "Peppa Pig Player is already running: http://localhost:$port"
      if ($Open) { Start-Process "http://localhost:$port" }
      exit 0
    }
  }
}

if (-not $listener) {
  Write-Host "Could not find a free port ($basePort-$($port - 1))."
  exit 1
}

$url = "http://localhost:$port"
Write-Host "Peppa Pig Player: $url"
Write-Host 'Close this window to stop the app.'
if ($Open) { Start-Process $url }

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $res = $ctx.Response
    try {
      $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
      if ($rel -eq '/') { $rel = '/index.html' }
      $path = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($root, $rel.TrimStart('/')))

      if (-not $path.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        $res.StatusCode = 403
      } elseif (-not [System.IO.File]::Exists($path)) {
        $res.StatusCode = 404
      } else {
        $bytes = [System.IO.File]::ReadAllBytes($path)
        $type = $mime[[System.IO.Path]::GetExtension($path).ToLower()]
        if (-not $type) { $type = 'application/octet-stream' }
        $res.ContentType = $type
        $res.Headers.Add('Cache-Control', 'no-cache')
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
      }
    } catch {
      $res.StatusCode = 500
    } finally {
      $res.Close()
    }
  }
} finally {
  $listener.Stop()
}
