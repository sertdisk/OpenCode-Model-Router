# Tek yon: repo -> dev config. Orijinal config dosyasi yerinde kalir, uzerine yazilir.
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$src = Join-Path $repoRoot "src\model-router.js"
$dstDir = "C:\Users\Hb\.config\opencode\plugins"
$dst = Join-Path $dstDir "model-ata.js"
if (-not (Test-Path $src)) { throw "Kaynak bulunamadi: $src" }
if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Force -Path $dstDir | Out-Null }
Copy-Item $src $dst -Force
Write-Host "Kopyalandi: $src -> $dst"
node --check $dst
