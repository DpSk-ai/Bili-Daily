# C2-1 候选池测试记录（2026-11-11）

## 状态：⚠️ 本次会话未能执行

`candidate-pool.js` 与 `test-candidate-pool.js` 写完后，按要求执行验收测试，
但本会话的命令执行被环境拦截：

```text
claude-opus-5-5 is temporarily unavailable (connection failed),
so auto mode cannot determine the safety of Bash right now.
```

同样被拦截的还有 `Agent`（子代理）。只有 `ls`、`grep`、`read` 这类只读操作可用。

**因此本文件不记录任何"通过"结果。** 这次没有实际运行过任何测试，
不会把未执行的项目标记为通过。

---

## 1. 新增测试用例数（静态核对）

`test-candidate-pool.js` 中共 33 个 `test(...)` 调用（编号 1–32，其中 3b 为补充用例）；
具体数量以实际运行为准。

> 之前的静态统计仅确认"写了多少个用例"，不证明它们能通过。

---

## 2. 请在 Windows PowerShell 中执行

```powershell
cd D:\Bili-Daily
chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

node test-candidate-pool.js
if ($LASTEXITCODE -ne 0) { Write-Host "FAILED: candidate-pool" -ForegroundColor Red }

node test-interest-profile.js
if ($LASTEXITCODE -ne 0) { Write-Host "FAILED: interest-profile" -ForegroundColor Red }

node test-uid.js
if ($LASTEXITCODE -ne 0) { Write-Host "FAILED: uid" -ForegroundColor Red }

node test-up-stats.js
if ($LASTEXITCODE -ne 0) { Write-Host "FAILED: up-stats" -ForegroundColor Red }

node test-stats.js
if ($LASTEXITCODE -ne 0) { Write-Host "FAILED: stats" -ForegroundColor Red }

node --check candidate-pool.js
node --check test-candidate-pool.js
node --check interest-profile.js
node --check stats.js
node --check storage.js
node --check content.js
node --check popup.js
if ($LASTEXITCODE -eq 0) { Write-Host "语法检查通过" -ForegroundColor Green }
```

**期望**：

- `test-candidate-pool.js` 输出 `N/N 通过`（N = 实际用例数，当前文件为 33）；
- 既有四个测试仍为 `24/24`、`21/21`、`17/17`、`20/20`（合计 82）；
- 语法检查无输出。

把输出贴回对话，我会据此更新本文件与总报告。

---

## 3. 静态复核范围（本次实际做了的）

- 逐行阅读 `candidate-pool.js`：依赖检查、UID 归一化复用、日期映射兼容、
  累加器、昵称选择、分类、池化、两种来源、合并、查询、筛选、导出。
- 逐条核对 `test-candidate-pool.js` 的断言与实现是否一致（尤其是
  `uidConflictVideos`、`duplicateEntries`、`rejectedReasons` 的计数）。
- 确认新模块没有被任何正式文件引用（`manifest.json` / `popup.html` 均未加载它）。

静态复核**不能替代运行**，尤其是 `Date.parse` 时区、`Array.sort` 码点顺序、
`JSON.stringify` 往返这类行为，必须由真实执行确认。
