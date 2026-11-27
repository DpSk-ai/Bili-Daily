# rembg isnet-anime 安装指南（手动执行版）

## 安装步骤

在 PowerShell 中逐步执行以下命令。

### 第一步：进入项目目录
```powershell
cd D:\Bili-Daily
```

### 第二步：创建虚拟环境
```powershell
py -m venv rembg_env
```

### 第三步：激活虚拟环境
```powershell
.\rembg_env\Scripts\Activate.ps1
```

**成功标志**：提示符变为 `(rembg_env) PS>`

### 第四步：升级 pip
```powershell
python -m pip install --upgrade pip
```

### 第五步：安装 rembg 和依赖（CPU 版本）
```powershell
python -m pip install "rembg[cpu,cli]"
```

**预计时间**：2-5 分钟  
**下载大小**：300-400 MB

### 第六步：下载 isnet-anime 模型
```powershell
python -c "from rembg import new_session; session = new_session('isnet-anime'); print('Model loaded successfully!')"
```

**首次运行**：会下载 200-400 MB 模型文件，可能需要 1-5 分钟

---

## 验证安装

### 方法 1：检查版本
```powershell
rembg --version
```

**预期输出**：版本号，如 `0.0.0`

### 方法 2：测试背景移除（需要图像文件）

创建测试脚本 `test_rembg.py`：

```python
from rembg import remove, new_session
from PIL import Image

# 确保 neo-images 目录存在，并放入测试图像
input_path = 'neo-images/test.png'
output_path = 'output/test_transparent.png'

session = new_session('isnet-anime')
input_image = Image.open(input_path)
output_image = remove(input_image, session=session)
output_image.save(output_path)
print(f'Success! Output saved to {output_path}')
```

运行测试：
```powershell
python test_rembg.py
```

---

## 目录结构（安装后）

```
D:\Bili-Daily\
├── rembg_env\              ← 虚拟环境（已创建）
├── neo-images\             ← NEO 原始图像（需手动创建）
├── output\                 ← 生成的透明背景 PNG（需手动创建）
├── install-rembg.ps1       ← 安装脚本
└── docs/
    └── rembg-installation-plan.md
```

创建输出目录：
```powershell
mkdir neo-images, output
```

---

## 常见问题排查

| 问题 | 解决方案 |
|------|----------|
| `py 无法找到` | 确保 Python 已添加到 PATH，或使用完整路径 `C:\Users\39496\AppData\Local\Python\pythoncore-3.15-64\python.exe` |
| 激活脚本拒绝执行 | 在 PowerShell 中运行 `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser` |
| 网络连接失败 | 检查网络，或使用代理 `python -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple rembg[cpu,cli]` |
| 磁盘空间不足 | 确保至少 2 GB 可用空间 |
| 模型加载缓慢 | 正常现象，首次下载可能需要数分钟 |

---

## 卸载（如需恢复）

删除虚拟环境目录：
```powershell
Remove-Item -Recurse -Force rembg_env
```

删除下载的模型（可选）：
```powershell
Remove-Item -Recurse -Force $env:USERPROFILE\.rembg
```

---

## 下一步

安装完成后，你可以：

1. **单个图像处理**：
   ```powershell
   .\rembg_env\Scripts\Activate.ps1
   rembg -m isnet-anime -i neo-images/character.png -o output/character_transparent.png
   ```

2. **批量处理脚本** - 创建 `batch_process.py`
3. **集成到 Bili Daily 流程** - 编写对应的处理模块

---

## 模型存储位置

下载后的 isnet-anime 模型位置：
```
C:\Users\39496\.rembg\models\isnet-anime\model.onnx
```

可通过环境变量自定义：
```powershell
$env:REMBG_HOME = "D:\Custom\rembg\path"
```

