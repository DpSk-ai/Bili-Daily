# Bili Daily NEO 动漫人物透明背景 PNG 制作方案

制定时间：2026-11-13  
环境检查状态：已完成  
计划进展：方案制定阶段（待用户确认）

---

## 一、本地环境检查结果

### Python 环境
- **Python 版本**: 3.15.0 ✓
- **pip 版本**: 26.2.1
- **位置**: C:\Users\39496\AppData\Local\Python\pythoncore-3.15-64
- **venv 模块**: 可用 ✓
- **现有虚拟环境**: 无（当前目录）

### 兼容性评估
✓ **Python 3.15.0 与 rembg 兼容**
- rembg 2.0.87 要求：Python 3.11 ~ <4.0
- 当前版本处于支持范围内

---

## 二、rembg 与 isnet-anime 模型分析

### rembg 核心依赖
- **主包**: `rembg` 2.0.87+
- **推理引擎**: `onnxruntime` （CPU 版本）
- **模型格式**: ONNX (.onnx 文件)

### isnet-anime 模型特性
| 项目 | 说明 |
|------|------|
| **用途** | 高精度动漫人物分割 |
| **类型** | ONNX 格式分割网络 |
| **预计大小** | 200-400 MB（基于类似模型推估） |
| **下载来源** | rembg 官方模型库（首次使用时自动下载） |
| **存储位置** | `~/.rembg/models/isnet-anime/` |

### 默认模型对比
| 模型 | 大小 | 用途 | 推荐 |
|------|------|------|------|
| `bria-rmbg` | ~1 GB | 通用背景移除 | ✗ 不是动漫 |
| `isnet-anime` | ~200-400 MB | 动漫人物 ✓ | ✓ 本次使用 |
| `u2netp` | ~43 MB | 轻量版通用 | ✗ 精度低 |

---

## 三、虚拟环境建议

### 为什么需要独立虚拟环境？
1. **隔离依赖**: rembg 的 onnxruntime、numpy 等版本可能与其他项目冲突
2. **Bili Daily 项目保护**: 避免污染现有项目依赖
3. **便于回滚**: 根据项目规则（快照 + rollback 目录），独立 venv 便于整体清理

### 建议方案
在 `D:\Bili-Daily` 目录下创建专用虚拟环境：
```
D:\Bili-Daily\
├── rembg_env\          ← 专用虚拟环境
├── neo-images\         ← NEO 原始图像存放
├── output\             ← 生成的透明背景 PNG
└── ...
```

---

## 四、磁盘空间需求评估

| 项目 | 大小 | 说明 |
|------|------|------|
| Python 虚拟环境基础 | ~50-100 MB | 包含 pip、setuptools 等 |
| rembg 包及依赖 | ~200-300 MB | onnxruntime-cpu、PIL、numpy 等 |
| isnet-anime 模型 | ~200-400 MB | 动漫分割模型 |
| **总计预留** | **~1-2 GB** | 含缓存和拓展空间 |

**你的配置**: RTX 5060 Laptop GPU（16GB RAM）— **充足** ✓

---

## 五、安装方案（CPU 版本优先）

### 第一步：创建虚拟环境
```powershell
cd D:\Bili-Daily
python -m venv rembg_env
```

### 第二步：激活虚拟环境
```powershell
# Windows PowerShell
.\rembg_env\Scripts\Activate.ps1

# 成功后提示符变为: (rembg_env) PS>
```

### 第三步：安装 rembg（CPU 版本，优先方案）
```powershell
python -m pip install --upgrade pip

# 仅安装 CPU 版本
python -m pip install "rembg[cpu,cli]"
```

**预计下载**: 300-400 MB  
**预计安装时间**: 2-5 分钟（取决于网络）

### 第四步：验证安装并下载模型
```powershell
# 验证 rembg 命令行工具
rembg --version

# 下载 isnet-anime 模型（首次运行自动下载）
# 以下命令会触发模型下载到 ~/.rembg/models/
python -c "from rembg import remove, new_session; session = new_session('isnet-anime'); print('Model loaded successfully')"
```

**注意**：
- 模型下载位置：`C:\Users\39496\.rembg\models\isnet-anime\`
- 下载时间：取决于网络速度（预计 1-5 分钟，200-400 MB）
- 下载期间会有进度提示

---

## 六、使用示例（验收参考）

### 验收方法 1：命令行工具
```powershell
# 激活虚拟环境后
rembg -m isnet-anime -o ./output i ./neo-images/character.png ./output/character_transparent.png
```

### 验收方法 2：Python 脚本
```powershell
# 新建 test_rembg.py
$testScript = @"
from rembg import remove, new_session
from PIL import Image

# 加载动漫模型
session = new_session('isnet-anime')

# 读取图像
input_image = Image.open('neo-images/character.png')

# 移除背景
output_image = remove(input_image, session=session)

# 保存透明背景版本
output_image.save('output/character_transparent.png')
print('✓ Background removed successfully!')
"@

$testScript | Out-File -Encoding UTF8 test_rembg.py
python test_rembg.py
```

---

## 七、后续步骤（GPU 加速 - 可选）

如果 CPU 处理速度不满足需求，可后续配置 GPU 版本（需要 CUDA 工具链）：
```powershell
# 卸载 CPU 版本
python -m pip uninstall onnxruntime -y

# 安装 GPU 版本（需要 CUDA 11.8+ 和 cuDNN）
python -m pip install "rembg[gpu,cli]"
```

---

## 八、常见问题预案

| 问题 | 解决方案 |
|------|----------|
| 模型下载失败 | 检查网络连接，或手动指定 `REMBG_HOME` 环境变量 |
| 虚拟环境激活失败 | 检查 PowerShell 执行策略：`Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser` |
| 内存不足 | 16GB RAM 足够，逐个处理图像而非批量加载 |
| 模型精度不理想 | 更换其他模型（如 `birefnet-general` 或 `sam`）进行对比 |

---

## 九、安装方案确认清单

- [ ] 已确认本地 Python 3.15.0 环境
- [ ] 已确认磁盘空间 2 GB 以上
- [ ] 已确认虚拟环境位置 `D:\Bili-Daily\rembg_env\`
- [ ] 已确认 isnet-anime 模型作为首选
- [ ] 已确认 CPU 版本为优先方案
- [ ] 已确认不修改 Bili Daily 项目文件
- [ ] 已准备好 NEO 原始图像存放目录

---

**下一步**: 等待你的确认后，将执行虚拟环境创建和依赖安装。
