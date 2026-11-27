# Bili Daily - rembg isnet-anime 环境安装脚本
# NEO 动漫人物透明背景 PNG 生成工具安装

Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "Bili Daily rembg 安装脚本" -ForegroundColor Cyan
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host ""

# 第一步：检查 Python
Write-Host "[1/5] 检查 Python 环境..." -ForegroundColor Yellow
$pythonVersion = py --version 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "错误：无法找到 Python" -ForegroundColor Red
    exit 1
}
Write-Host "√ $pythonVersion" -ForegroundColor Green

# 第二步：创建虚拟环境
Write-Host ""
Write-Host "[2/5] 创建虚拟环境 rembg_env..." -ForegroundColor Yellow
if (Test-Path "D:\Bili-Daily\rembg_env") {
    Write-Host "~ 虚拟环境已存在，跳过创建" -ForegroundColor Cyan
} else {
    py -m venv D:\Bili-Daily\rembg_env
    if ($LASTEXITCODE -eq 0) {
        Write-Host "√ 虚拟环境创建成功" -ForegroundColor Green
    } else {
        Write-Host "错误：虚拟环境创建失败" -ForegroundColor Red
        exit 1
    }
}

# 第三步：激活虚拟环境
Write-Host ""
Write-Host "[3/5] 激活虚拟环境..." -ForegroundColor Yellow
$activateScript = "D:\Bili-Daily\rembg_env\Scripts\Activate.ps1"
if (Test-Path $activateScript) {
    & $activateScript
    Write-Host "√ 虚拟环境已激活" -ForegroundColor Green
} else {
    Write-Host "错误：激活脚本不存在" -ForegroundColor Red
    exit 1
}

# 第四步：升级 pip 并安装 rembg
Write-Host ""
Write-Host "[4/5] 安装 rembg 依赖（CPU版本）..." -ForegroundColor Yellow
Write-Host "这可能需要 2-5 分钟，请耐心等待..." -ForegroundColor Cyan
python -m pip install --upgrade pip --quiet
python -m pip install "rembg[cpu,cli]" --quiet
if ($LASTEXITCODE -eq 0) {
    Write-Host "√ rembg 安装成功" -ForegroundColor Green
} else {
    Write-Host "错误：rembg 安装失败" -ForegroundColor Red
    exit 1
}

# 第五步：验证安装并下载模型
Write-Host ""
Write-Host "[5/5] 验证安装并下载 isnet-anime 模型..." -ForegroundColor Yellow
Write-Host "模型首次加载时自动下载，可能需要 1-5 分钟..." -ForegroundColor Cyan

$tempPyFile = "$env:TEMP\test_rembg_model.py"
@'
from rembg import new_session
import sys

try:
    print('正在加载 isnet-anime 模型...')
    session = new_session('isnet-anime')
    print('√ 模型加载成功!')
    print('√ rembg 和 isnet-anime 已准备好')
except Exception as e:
    print(f'错误: 模型加载失败 - {e}')
    sys.exit(1)
'@ | Set-Content $tempPyFile -Encoding UTF8

python $tempPyFile
$testResult = $LASTEXITCODE

if ($testResult -eq 0) {
    Write-Host "√ 模型验证成功" -ForegroundColor Green
} else {
    Write-Host "错误：模型下载或加载失败" -ForegroundColor Red
    exit 1
}

# 清理临时文件
Remove-Item $tempPyFile -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "安装完成！" -ForegroundColor Green
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "下一步：" -ForegroundColor Yellow
Write-Host "1. 激活虚拟环境: .\rembg_env\Scripts\Activate.ps1" -ForegroundColor White
Write-Host "2. 验证命令: rembg --version" -ForegroundColor White
Write-Host "3. 处理图像: rembg -m isnet-anime -i input.png -o output.png" -ForegroundColor White
Write-Host ""
