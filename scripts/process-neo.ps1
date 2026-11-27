# NEO 动漫角色透明背景批处理脚本
# 使用 rembg + isnet-anime 模型

param(
    [string]$InputDir = "D:\Bili-Daily\assets\neo-images\original",
    [string]$OutputDir = "D:\Bili-Daily\assets\neo-images\transparent",
    [switch]$HighQuality = $false
)

$ErrorActionPreference = "Stop"

# 配置
$rembgExe = "D:\rembg-env\venv\Scripts\rembg.exe"

Write-Host "=====================================" -ForegroundColor Cyan
Write-Host " NEO 动漫角色透明背景批处理工具" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

# 检查 rembg 是否存在
if (-not (Test-Path $rembgExe)) {
    Write-Host "错误: rembg 未找到" -ForegroundColor Red
    Write-Host "路径: $rembgExe" -ForegroundColor Red
    Write-Host ""
    Write-Host "请先安装 rembg 或检查路径。" -ForegroundColor Yellow
    exit 1
}

# 检查输入目录
if (-not (Test-Path $InputDir)) {
    Write-Host "错误: 输入目录不存在" -ForegroundColor Red
    Write-Host "路径: $InputDir" -ForegroundColor Red
    Write-Host ""
    Write-Host "请创建目录并放入图片文件。" -ForegroundColor Yellow
    exit 1
}

# 创建输出目录
Write-Host "输入目录: $InputDir" -ForegroundColor Green
Write-Host "输出目录: $OutputDir" -ForegroundColor Green
Write-Host ""

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

# 统计文件数
$imageFiles = Get-ChildItem -Path $InputDir -Include *.png,*.jpg,*.jpeg,*.bmp -Recurse
$fileCount = $imageFiles.Count

if ($fileCount -eq 0) {
    Write-Host "警告: 输入目录中没有图片文件" -ForegroundColor Yellow
    Write-Host "支持格式: PNG, JPG, JPEG, BMP" -ForegroundColor Yellow
    exit 0
}

Write-Host "找到 $fileCount 个图片文件" -ForegroundColor Cyan
Write-Host ""

# 构建命令参数
$args = @(
    "p",                    # 批处理模式
    "-m", "isnet-anime",   # 动漫模型
    $InputDir,
    $OutputDir,
    "-ppm"                 # 清理蒙版斑点
)

if ($HighQuality) {
    Write-Host "模式: 高质量（启用 alpha matting）" -ForegroundColor Magenta
    $args += "-a"
} else {
    Write-Host "模式: 标准（快速处理）" -ForegroundColor Magenta
}

Write-Host "模型: isnet-anime（动漫角色专用）" -ForegroundColor Magenta
Write-Host ""
Write-Host "开始处理..." -ForegroundColor Yellow
Write-Host ""

# 记录开始时间
$startTime = Get-Date

# 执行 rembg
try {
    & $rembgExe @args

    # 记录结束时间
    $endTime = Get-Date
    $duration = $endTime - $startTime

    Write-Host ""
    Write-Host "=====================================" -ForegroundColor Green
    Write-Host " 处理完成！" -ForegroundColor Green
    Write-Host "=====================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "输出目录: $OutputDir" -ForegroundColor Cyan
    Write-Host "处理时间: $($duration.TotalSeconds.ToString('0.0')) 秒" -ForegroundColor Cyan
    Write-Host "平均速度: $([math]::Round($fileCount / $duration.TotalSeconds, 1)) 张/秒" -ForegroundColor Cyan
    Write-Host ""

    # 统计输出文件
    $outputFiles = Get-ChildItem -Path $OutputDir -Filter *.png
    Write-Host "输出文件数: $($outputFiles.Count)" -ForegroundColor Green

    if ($outputFiles.Count -lt $fileCount) {
        Write-Host "警告: 部分文件可能处理失败" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "下一步: 请检查输出图片的透明背景效果" -ForegroundColor Yellow

} catch {
    Write-Host ""
    Write-Host "错误: 处理失败" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
