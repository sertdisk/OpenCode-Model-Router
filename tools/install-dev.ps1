# Tek yon: repo -> dev config. Orijinal config dosyasi yerinde kalir, uzerine yazilir.
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$src = Join-Path $repoRoot "src\model-router.js"
$dstDir = "C:\Users\Hb\.config\opencode\plugins"
$dst = Join-Path $dstDir "model-router.js"
if (-not (Test-Path $src)) { throw "Kaynak bulunamadi: $src" }
if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Force -Path $dstDir | Out-Null }
Copy-Item $src $dst -Force
Write-Host "Kopyalandi: $src -> $dst"
node --check $dst
if ($LASTEXITCODE -ne 0) { throw "node --check basarisiz: $dst" }
# Web UI: repo web/ -> ~/.config/opencode/model-router-web/ (temiz kopya).
$webSrc = Join-Path $repoRoot "web"
$webDst = "C:\Users\Hb\.config\opencode\model-router-web"
if (Test-Path $webSrc) {
  if (Test-Path $webDst) { Remove-Item -Recurse -Force $webDst }
  New-Item -ItemType Directory -Force -Path $webDst | Out-Null
  Copy-Item (Join-Path $webSrc "*") $webDst -Recurse -Force
  Write-Host "Kopyalandi: $webSrc -> $webDst"
} else {
  Write-Host "UYARI: web klasoru henuz yok ($webSrc); sunucu API calisir, UI 404 doner."
}
