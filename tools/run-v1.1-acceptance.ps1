# Bili Daily v1.1 Neon Edition - 本机验收脚本
# 用法：在 PowerShell 中执行
#   cd D:\Bili-Daily
#   powershell -ExecutionPolicy Bypass -File .\tools\run-v1.1-acceptance.ps1
#
# 说明：只运行语法检查、测试与 HTML 生成；不修改代码，不读写 chrome.storage.local。

$ErrorActionPreference = "Continue"
Set-Location "D:\Bili-Daily"

$failed = 0

Write-Host "`n=== 1. 语法检查（新增/修改文件）===" -ForegroundColor Cyan
$changed = @(
  "data-backup.js",
  "popup.js",
  "test-data-backup.js",
  "test-neon-ui-contract.js",
  "dev-config.js"
)
foreach ($file in $changed) {
  node --check $file
  $code = $LASTEXITCODE
  "CHECK_EXIT=$code FILE=$file"
  if ($code -ne 0) { $failed += 1 }
}

Write-Host "`n=== 2. 新增 50 项测试 ===" -ForegroundColor Cyan
foreach ($file in @("test-data-backup.js", "test-neon-ui-contract.js")) {
  node $file
  $code = $LASTEXITCODE
  "EXIT=$code FILE=$file"
  if ($code -ne 0) { $failed += 1 }
}

Write-Host "`n=== 3. 原有 495 项回归 ===" -ForegroundColor Cyan
$oldSuites = @(
  "test-stats.js",
  "test-up-stats.js",
  "test-uid.js",
  "test-interest-profile.js",
  "test-candidate-pool.js",
  "test-candidate-quality.js",
  "test-candidate-features.js",
  "test-candidate-content-import.js",
  "test-candidate-store.js",
  "test-recommend-core.js",
  "test-recommend-quality.js",
  "test-recommend-rank.js",
  "test-recommend-service.js",
  "test-candidate-discovery.js",
  "test-discovered-candidate-store.js",
  "test-auto-discovery-integration.js",
  "test-auto-discovery-performance.js"
)
foreach ($file in $oldSuites) {
  node $file
  $code = $LASTEXITCODE
  "EXIT=$code FILE=$file"
  if ($code -ne 0) { $failed += 1 }
}

Write-Host "`n=== 4. 生成 v1.1 单文件 HTML 报告 ===" -ForegroundColor Cyan
node tools/build-report-html.js `
  docs/acceptance/v1.1/v1.1-development-report.md `
  docs/acceptance/v1.1/v1.1-development-report.html
$code = $LASTEXITCODE
"EXIT=$code FILE=docs/acceptance/v1.1/v1.1-development-report.html"
if ($code -ne 0) { $failed += 1 }

Write-Host "`n=== 完成 ===" -ForegroundColor Cyan
if ($failed -eq 0) {
  Write-Host "全部命令退出码为 0。请把每个套件的 N/N 通过与 EXIT 回填到开发报告。" -ForegroundColor Green
} else {
  Write-Host "有 $failed 个命令返回非 0 退出码，请先修复，不要提交 v1.1 标签。" -ForegroundColor Red
  exit 1
}
