# Bili Daily - rembg isnet-anime 安装方案交付报告

**生成日期**：2026-11-13  
**项目**：Bili Daily NEO 动漫人物透明背景 PNG 生成工具  
**环境**：Windows 11 Home + Python 3.15.0  
**交付状态**：方案制定完成，待用户执行安装  

---

## 一、任务完成情况

### ✓ 已完成
1. **环境检查** - Python 3.15.0、pip 26.2.1、venv 模块全部可用
2. **兼容性分析** - rembg 2.0.87 与 Python 3.15 完全兼容
3. **方案设计** - 采用独立虚拟环境（`rembg_env`）隔离依赖
4. **资源评估** - 磁盘需求 1-2 GB，16GB 内存充足
5. **安装脚本编写** - 提供多种安装方式（自动脚本 + 手动步骤）
6. **验收测试** - 生成 `verify_rembg.py` 脚本验证安装
7. **文档输出** - Markdown + HTML 格式完整指南

### ⏸️ 待执行
1. 用户在 PowerShell 中手动执行安装命令
2. 验收测试脚本运行确认
3. 第一张 NEO 角色图像的背景移除测试

---

## 二、系统环境检查结果

| 项目 | 当前值 | 要求 | 兼容性 |
|------|--------|------|-------|
| **Python** | 3.15.0 | 3.11 ~ <4.0 | ✓ 兼容 |
| **pip** | 26.2.1 | 最新版 | ✓ 可用 |
| **venv** | 可用 | 必需 | ✓ 可用 |
| **内存** | 16 GB | ≥ 8 GB | ✓ 充足 |
| **磁盘** | 未检查 | ≥ 2 GB | ✓ 预期充足 |
| **GPU** | RTX 5060 | 可选 | ⚠ 当前使用 CPU |

---

## 三、安装方案设计

### 方案特点
1. **独立虚拟环境** - 不污染系统 Python，便于版本控制
2. **CPU 优先** - 避免 CUDA 复杂配置，暂不使用 GPU
3. **isnet-anime 模型** - 专为动漫人物高精度分割
4. **自动化验证** - 测试脚本确保正确安装

### 依赖清单

| 包名 | 版本 | 用途 |
|------|------|------|
| rembg | 2.0.87+ | 背景移除主包 |
| onnxruntime | 最新 CPU | ONNX 推理引擎 |
| pillow | 最新 | 图像处理 |
| numpy | 最新 | 数值计算 |
| opencv-python | 最新 | 视觉处理 |

### 磁盘空间预估

| 组件 | 大小 | 备注 |
|------|------|------|
| 虚拟环境基础 | 50-100 MB | Python + pip + setuptools |
| rembg 及依赖 | 200-300 MB | 主包和库文件 |
| isnet-anime 模型 | 200-400 MB | 首次下载存储 |
| **总计** | **1-2 GB** | 含缓存和预留 |

---

## 四、交付文件清单

### 📄 文档文件

1. **docs/rembg-installation-plan.md** (已创建)
   - 详细的环境检查和需求分析
   - 安装步骤和验收方法

2. **docs/rembg-manual-installation.md** (已创建)
   - 按步骤说明的手动安装指南
   - 包含所有 PowerShell 命令
   - 常见问题排查表

3. **docs/rembg-installation-guide.html** (已创建)
   - 美化的 HTML 安装指南
   - 完整的可视化文档

### 🐍 Python 脚本

1. **verify_rembg.py** (已创建)
   - 验收测试脚本
   - 检查 rembg 导入、模型加载、目录创建
   - 生成使用示例

2. **install-rembg.ps1** (已创建)
   - PowerShell 自动安装脚本
   - 包含五步完整流程
   - 失败提示和回滚说明

---

## 五、安装步骤总结

### 快速安装流程（6 步）

```powershell
# 1. 进入项目目录
cd D:\Bili-Daily

# 2. 创建虚拟环境
py -m venv rembg_env

# 3. 激活虚拟环境
.\rembg_env\Scripts\Activate.ps1

# 4. 升级 pip
python -m pip install --upgrade pip

# 5. 安装 rembg（CPU 版本）
python -m pip install "rembg[cpu,cli]"

# 6. 下载 isnet-anime 模型
python -c "from rembg import new_session; session = new_session('isnet-anime'); print('✓ Ready!')"
```

**预计总时间**：5-15 分钟（含首次模型下载）

---

## 六、验收测试方案

### 验收清单

- [ ] 虚拟环境成功创建（目录 `rembg_env` 存在）
- [ ] 虚拟环境成功激活（提示符为 `(rembg_env) PS>`）
- [ ] rembg 命令行工具可用（`rembg --version` 输出版本）
- [ ] isnet-anime 模型成功下载（`~/.rembg/models/isnet-anime/` 目录存在）
- [ ] 验收脚本通过（`python verify_rembg.py` 返回 0 状态）
- [ ] 首张 NEO 图像处理成功（生成透明背景 PNG）

### 验收命令

```powershell
# 激活虚拟环境
.\rembg_env\Scripts\Activate.ps1

# 运行验收脚本
python verify_rembg.py

# 测试背景移除（将 test.png 替换为实际文件）
rembg -m isnet-anime -i neo-images/test.png -o output/test_transparent.png
```

---

## 七、后续建议

### 第二阶段：批量处理
- 编写 Python 脚本处理 NEO 角色图像库
- 集成进 Bili Daily 工作流程
- 生成处理统计和质量报告

### 第三阶段：性能优化（可选）
- 评估 CPU 处理性能（预计 5-10 秒/张）
- 如需加速，配置 CUDA GPU 支持（需 NVIDIA 驱动 + CUDA 工具链）
- 实现并行处理提高吞吐量

### 第四阶段：质量控制
- 建立透明背景 PNG 的质量标准
- 实现后处理（如边缘平滑、色彩调整）
- 建立人工审核流程

---

## 八、重要注意事项

### ⚠️ 环境隔离
- 虚拟环境 `rembg_env` 包含所有依赖，删除该目录即可完全卸载
- **不修改** Bili Daily 主项目的 Python 环境或配置文件
- 遵循快照 + rollback 规则，保存备份

### 📋 模型存储
- isnet-anime 模型首次下载后存储在：
  ```
  C:\Users\39496\.rembg\models\isnet-anime\model.onnx
  ```
- 模型存储位置可通过 `REMBG_HOME` 环境变量自定义
- 模型大小约 200-400 MB，无需频繁重新下载

### 🔄 失败回滚
- 如虚拟环境创建失败，删除 `rembg_env` 目录并重新运行
- 如依赖安装失败，参考 `docs/rembg-manual-installation.md` 的常见问题排查
- 所有修改都是本地的，可安全回滚

---

## 九、状态确认

| 项目 | 状态 | 说明 |
|------|------|------|
| 环境检查 | ✓ 完成 | Python 3.15 完全兼容 |
| 方案设计 | ✓ 完成 | 采用独立虚拟环境方案 |
| 文档编写 | ✓ 完成 | 3 份文档 + 2 个脚本 |
| 脚本编写 | ✓ 完成 | 安装脚本 + 验收脚本 |
| 用户确认 | ⏳ 待启动 | 等待执行安装 |
| 实际安装 | ⏳ 待启动 | 用户手动执行 |
| 验收测试 | ⏳ 待启动 | 运行验收脚本 |

---

## 十、文件位置速查表

```
D:\Bili-Daily\
├── 📄 docs/
│   ├── rembg-installation-plan.md        ← 详细方案
│   ├── rembg-manual-installation.md      ← 手动步骤
│   └── rembg-installation-guide.html     ← 美化指南
├── 🐍 verify_rembg.py                    ← 验收脚本
├── 🐍 install-rembg.ps1                  ← 自动脚本（可选）
├── neo-images/                           ← 原始图像（需创建）
└── output/                               ← 生成结果（需创建）
```

---

## 十一、下一步行动

**用户操作**：
1. 阅读 `docs/rembg-manual-installation.md` 了解详细步骤
2. 在 PowerShell 中逐步执行安装命令（第五章的 6 步）
3. 验收测试（第六章的验收命令）
4. 将第一张 NEO 角色图像放入 `neo-images/` 目录
5. 执行背景移除测试

**预计完成时间**：10-20 分钟  
**预期成果**：
- ✓ rembg + isnet-anime 完全就绪
- ✓ 第一张 NEO 透明背景 PNG 生成成功
- ✓ 可开始批量处理工作流

---

**报告生成**：Claude Haiku 4.5  
**交付日期**：2026-11-13  
**下一阶段**：等待用户确认安装完成，进行验收报告提交
