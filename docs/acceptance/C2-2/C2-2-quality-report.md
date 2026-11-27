# Bili Daily C2-2 验收报告：候选身份可信度、来源证据与数据质量控制

- **阶段**：C2-2（纯函数逻辑 + 测试，不含排序、持久化与 UI）
- **日期**：2026-11-11
- **模块**：`candidate-pool.js`（扩展）、`test-candidate-quality.js`（新增）
- **依赖**：必须先加载 `stats.js`

---

## 1. 实际修改及新建文件

### 新建

| 文件 | 说明 |
|---|---|
| `test-candidate-quality.js` | 28 个质量评估用例，全部注入固定时间 `NOW` |
| `docs/acceptance/C2-2/C2-2-quality-report.md` | 本报告 |
| `rollback/before-c2-2-quality/` | 修改前快照（`candidate-pool.js`、`test-candidate-pool.js`） |

### 修改

| 文件 | 改动 | 兼容性影响 |
|---|---|---|
| `candidate-pool.js` | ① `evidence` 新增 `conflictVideoCount` / `conflicts` / `nameConflict`；② 新增 `assessCandidateFreshness` / `assessCandidate` / `filterEligibleCandidates` / `DEFAULT_STALE_DAYS` | 纯增量。既有字段、函数签名、`watchedBefore`、`candidateType`、UID 去重规则、观看时长口径均未变 |
| `test-candidate-pool.js` | 仅更新第 23 条"evidence 键集合严格比对"的期望键（新增 3 个键），断言方式未放松 | 用例数与严格程度不变 |
| `docs/design/C2-1-candidate-pool.md` | 追加第 11 节 C2-2 扩展说明 | 文档 |

**未修改**：`manifest.json`、`popup.html`、`popup.css`、`popup.js`、`content.js`、`storage.js`、
`stats.js`、`interest-profile.js`、四个既有测试文件、`chrome.storage.local` 数据。

---

## 2. 身份可信度语义

严格区分五件事：

| 维度 | 字段 | 含义 |
|---|---|---|
| 格式合法 | `evidence.uidFormatValid` | 正整数、安全整数、统一字符串。**只说明格式对** |
| 来源可靠 | `evidence.fromWatchHistory` / `fromUserInput` | 观看记录（content.js 从页面 `owner.mid` 采集）或用户手动输入 |
| 身份冲突 | `evidence.conflictVideoCount` / `conflicts` | 同一视频被记录成多个 UID |
| 在线核验 | `evidence.onlineVerified` | **恒为 false**；调用方自称 `true` 也会被忽略 |
| 是否进入排序 | `assessCandidate().eligibility` | eligible / review / excluded |

`uidVerified` 的语义保持不变：**格式合法 + 至少一条本地观看记录**。它不是"B 站官方认证"，
也不是"已在线核验"。本阶段不联网，任何输出里都不存在可信的在线核验结果。

---

## 3. UID 冲突处理策略

### 3.1 证据保留

`buildFromRecords` 在记录层收集 `bvid → Map(UID → 首次观察到的日期键)`。
同一 BV 出现 ≥2 个 UID 时：

- `diagnostics.uidConflictVideos` 计数；
- 每个涉及的 UID 都获得一条冲突明细 `{ otherUid, dateKey }`；
- `conflictVideoCount` 记录该 UID 涉及冲突的视频数，**与 `watchedVideoCount` 分开**。

### 3.2 不猜测、不覆盖

- 不判断"哪个 UID 才对"，不修改原始观看记录，不写 `chrome.storage.local`。
- 视频数仍按 C2-1 的合并规则归属主 UID（先出现者），另一个 UID 保留为候选但
  `watchedVideoCount` 为 0 —— 冲突和正常观看不会被混为一谈。
- 昵称从不参与身份判定：同名不同 UID 不合并，同 UID 改名也不拆开。

### 3.3 资格影响

存在冲突的候选默认进入 `review`，**不会静默进入 eligible 集合**；不删除、不降级为 excluded
（除非 UID 本身非法）。`filterEligibleCandidates` 的诊断里单独统计 `conflictCandidates`。

### 3.4 兼容扩展

C2-1 的候选对象原本只有聚合级的 `diagnostics.uidConflictVideos`，无法定位到候选。
C2-2 以最小方式在 `evidence` 上追加上述三个字段，未引入新的顶层结构，JSON 序列化能力不变。

---

## 4. 来源证据合并规则

1. 身份只按 UID；`sources` 取并集，顺序固定 `watched → manual`。
2. `watchedVideoCount` / `watchedWatchMs` / `conflictVideoCount` 取各输入的**最大值**，
   重复合并同一池子不会把计数翻倍。
3. 手动输入只能说明"用户提供过这个数字"：`fromUserInput`，`uidVerified` 仍为 false。
4. 观看记录只能说明"插件曾观察并记录过这个身份"：`fromWatchHistory`。
5. 手动昵称与历史昵称不一致时：`nameConflict: true` + `nickname-mismatch`（info），
   **展示昵称仍以观看记录为准**，身份不被覆盖。
6. 时间取各来源可靠值的 min / max；缺失不补。
7. 诊断只保留 `otherUid` 与 `dateKey`，不写标题、昵称或原始记录。

---

## 5. stale / unknown 的判断方式

`assessCandidateFreshness(candidate, { now, staleDays })`：

| 情况 | state | reason |
|---|---|---|
| `ageDays > staleDays` | `stale` | `stale-observation` |
| `0 ≤ ageDays ≤ staleDays` | `fresh` | `""` |
| 缺少 `lastObservedAt` | `unknown` | `missing-observation-time` |
| 时间无法解析 | `unknown` | `invalid-observation-time` |
| 时间晚于 `now` | `unknown` | `future-observation-time` |

- 默认阈值 **90 天**，可通过 `staleDays` 覆盖。
- **恰好等于阈值算 fresh**（只有严格超过才算 stale）。
- 时间差按毫秒计算，与本地时区无关。
- `stale` 的文案明确写"不代表账号已注销"；候选保留在 `review`，不删除。
- `unknown` 不等于 `stale`：`assessment.stale` 只在 `state === "stale"` 时为 true。

---

## 6. eligible / review / excluded 的筛选规则

`filterEligibleCandidates(pool, options)` 返回：

```js
{
  eligible: [{ candidate, assessment }],
  review:   [{ candidate, assessment }],
  excluded: [{ candidate, assessment }],
  summary:  { total, eligible, review, excluded },
  diagnostics: {
    now, staleDays, onlineVerified: 0, reasonCounts,
    conflictCandidates, staleCandidates, unknownFreshnessCandidates,
    manualOnlyCandidates, nameMismatchCandidates, malformedCandidates
  }
}
```

| 资格 | 条件 |
|---|---|
| **excluded** | 不是对象，或没有合法 UID |
| **review** | 身份冲突、仅手动来源、无来源证据、观察时间缺失/非法/未来、超过过期阈值 |
| **eligible** | 合法 UID + 观看历史证据 + 无冲突 + 新鲜度正常 |

附加规则：

- **new 候选不因"尚未观看"被排除**，而是进入 `review` 待核验。
- `nickname-mismatch` 只记 info，不改变资格。
- 结果顺序与池内候选顺序一致；不修改输入；可 JSON 往返。
- 不计算任何兴趣匹配分数，不生成推荐结果，不因来源数量或臆造分数覆盖身份规则。

---

## 7. 新增测试数量及结果

**新增 28 个用例**（`test-candidate-quality.js`），覆盖任务要求的 26 项，另补：

- 过期阈值可配置（默认 90 天）；
- 重复合并同一冲突池不翻倍。

> ⚠️ **执行结果：本会话未能执行**。`node`、`Agent` 均被安全分类服务拦截，
> 只有只读命令可用。未伪造任何通过结果。请用第 11 节命令执行后回填本节。

---

## 8. 原有 115 项测试结果

**本会话未能重新执行**，原因同上。

静态核对：`test-candidate-pool.js` 33、`test-interest-profile.js` 24、`test-uid.js` 21、
`test-up-stats.js` 17、`test-stats.js` 20，合计 **115**。

`test-candidate-pool.js` 仅按严格方式更新了 evidence 键集合的期望值（新增 3 个键），
其余用例与断言未改动。

---

## 9. 语法检查结果

**未能执行**（`node --check` 同样被拦截）。已在代码层人工复核括号、导出与闭包结构，
但这不构成语法验证。命令见第 11 节。

---

## 10. 已知限制与风险

1. 无在线核验：`onlineVerified` 恒为 false，`uidVerified` 不等同平台认证。
2. 冲突只能定位到 `otherUid + dateKey`，不保存 BV 号与标题；多个同日冲突会合并成一条。
3. 冲突视频数按"主 UID 计视频、另一 UID 计 0"的既有口径，不重新归属。
4. `unknown` 新鲜度会让老记录（无时间字段）进入 `review`，可能造成大量待复核项。
5. 默认 90 天是经验值，不是账号失效判定；不可据此提示"账号已注销"。
6. 手动昵称冲突只做提示，不自动改名。
7. 本阶段不产出推荐分，也不保证 `eligible` 的候选"值得推荐"。
8. 新增 evidence 字段是**数据形状变更**：任何逐键快照式断言都需要同步更新（已更新一处）。

---

## 11. PowerShell 验收命令

```powershell
cd D:\Bili-Daily
chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

node test-candidate-quality.js
if ($LASTEXITCODE -ne 0) { Write-Host "FAILED: candidate-quality" -ForegroundColor Red }

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
node --check test-candidate-quality.js
node --check test-candidate-pool.js
node --check interest-profile.js
node --check stats.js
node --check storage.js
node --check content.js
node --check popup.js
if ($LASTEXITCODE -eq 0) { Write-Host "语法检查通过" -ForegroundColor Green }
```

**期望**：`test-candidate-quality.js` 输出 `28/28 通过`；既有 115 项保持通过；
语法检查无输出。

---

## 12. 回滚方式

修改前快照在 `rollback/before-c2-2-quality/`（`candidate-pool.js`、`test-candidate-pool.js`）。

```powershell
cd D:\Bili-Daily
Copy-Item rollback\before-c2-2-quality\candidate-pool.js candidate-pool.js -Force
Copy-Item rollback\before-c2-2-quality\test-candidate-pool.js test-candidate-pool.js -Force
Remove-Item test-candidate-quality.js
```

回滚后跑 `node test-candidate-pool.js`，应恢复 C2-1 的 33 项通过。
回滚不影响 `chrome.storage.local`；扩展运行时行为不变（`manifest.json` / `popup.html` 未引用该模块）。
