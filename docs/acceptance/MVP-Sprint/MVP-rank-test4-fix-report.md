# MVP Sprint 工作包 A · 第 4 项排序测试修复报告

**推荐理由 / 结果文本不得包含“准确率”字样**

- 报告日期：2026-11-12
- 阶段：MVP Sprint / 工作包 A（算法与测试层）
- 修复文件：`recommend-rank.js`（唯一改动文件，1 行文案）
- 测试状态：**本轮未执行**（`node` 执行通道被阻断，见 §5）
- 结论边界：本报告**不含任何“测试通过”结论**。28 / 47 / 297 需项目所有者本机回填。

---

## 1. 现象

项目所有者本机执行 `node test-recommend-rank.js`：

- 结果：**27/28 通过**
- 唯一失败：第 4 项「推荐理由只引用真实存在的字段」
- 位置：`test-recommend-rank.js:200:10`
- 错误：`AssertionError [ERR_ASSERTION] Expected values to be strictly equal: true !== false`

失败断言（第 197-200 行）：

```js
const text = JSON.stringify(result);
assert.equal(text.includes("已认证"), false);
assert.equal(text.includes("官方推荐"), false);
assert.equal(text.includes("准确率"), false);   // ← 实际 true
```

---

## 2. 定位过程

### 2.1 测试 fixture

`baseRecords()` 提供 7 条观看记录（科技 4 条、生活 1 条、知识 2 条），
`buildRecommendations({ now, endDate: D1, K: 5 })` 走相似度路径，UP 1001 的推荐理由为
`watched-before` + `partition-match`（第 192-195 行断言已通过）。

### 2.2 实际 true 的来源

对返回对象做字符串搜索，命中位置只有一处，不在 `reasons` 里：

```js
// recommend-rank.js:1029-1032（修复前）
note:
  "推荐基于本地观看记录与用户主动导入的候选资料，本地计算、不上传；" +
  "不代表平台核验，也不构成推荐准确率声明。"
```

`JSON.stringify(result)` 序列化了 `result.note`，其中包含“准确率”三个字。
**触发 true 的是这句否定式免责声明，不是任何推荐理由或证据字段。**

### 2.3 排除其他可能

| 候选来源 | 是否进入 `JSON.stringify(result)` | 是否含“准确率” |
|---|---|---|
| `buildReasons()` 生成的四类理由 | 是 | 否（代码逐条核查） |
| `entry.reliability` 完整对象 | 否（`toRecommendation` 只取 `level` / 覆盖率） | — |
| `Quality.assessFeatureReliability().note` | 否 | 含，但未被序列化 |
| `coldStart` / `diagnostics` / `config` | 是 | 否 |
| `result.note` | 是 | **是 ← 唯一命中** |

全仓库检索 `准确率`：业务代码中只有 `recommend-rank.js` 的两处（顶部注释与 `note`）
以及 `recommend-quality.js` 的两处（注释与可靠性 `note`，均不进入本结果）。

### 2.4 问题分类

**属于“测试预期与提示文案冲突”，不是业务逻辑错误，也不是推荐证据字段错误。**

- 业务规范：不得虚构“准确率 / 已认证 / 官方推荐”。
- 测试实现：用三个粗粒度子串检查守护该规范，覆盖整个结果 JSON。
- 冲突点：结果中的**否定式免责声明**（“不构成……声明”）恰好包含了被禁词。
- 理由与证据本身是真实字段：`watched-before` 的 `watchedVideoCount = 2`、
  `partition-match` 的 `userShare` 与 `candidateShare` 均来自实际观看统计，
  第 195 行断言已通过。

因此不存在“虚构用户分区偏好 / 虚构标题匹配 / 虚构观看记录 / 虚构认证状态”的问题。
测试断言本身符合业务规范，**不需要也不允许**把 `false` 改成 `true`。

---

## 3. 修复

只改 `recommend-rank.js` 的一行文案，保留免责语义，去掉被禁词：

| 位置 | 修改前 | 修改后 |
|---|---|---|
| `recommend-rank.js:1031` | `"不代表平台核验，也不构成推荐准确率声明。"` | `"不代表平台核验，也不构成对推荐效果的承诺。"` |

修改后：

```js
note:
  "推荐基于本地观看记录与用户主动导入的候选资料，本地计算、不上传；" +
  "不代表平台核验，也不构成对推荐效果的承诺。"
```

### 3.1 未修改的内容

- 未修改 `test-recommend-rank.js`（未删测试、未改断言、未放宽条件）。
- 未修改 `buildReasons()` 的任何条件或证据字段。
- 未修改评分公式、相似度合成、MMR、λ、配额、跨通道去重。
- 未修改 `recommend-quality.js`、`recommend-core.js` 及 C1 / C2 / C3-1 模块。
- 未新增任何“准确率 / 已认证 / 官方推荐”类字段。

### 3.2 修复后行为

- `result.note` 依旧是明确的能力边界声明：本地计算、不上传、不代表平台核验、
  不作推荐效果承诺。
- `JSON.stringify(result)` 不再包含 `准确率`、`已认证`、`官方推荐`。
- 推荐理由、分数、可靠性、置信度、配额全部不变。

---

## 4. 影响面扫描

| 检查 | 结果 |
|---|---|
| `recommend-rank.js` 中残留 `准确率` | 仅第 8 行文件头注释，不进入返回值 |
| `recommend-rank.js` 中 `已认证` / `官方推荐` | 0 处 |
| 结果 JSON 的组成字段 | `note` 已改写；其余字段不新增、不删除 |
| 其他模块的 `note` | `recommend-quality.js:1621` 含“预测准确率”，但不在 `buildRecommendations()` 的输出中 |

---

## 5. 测试与语法检查结果（未执行）

本轮多次尝试 `node`，通道返回：

```
qwen/qwen-flash is temporarily unavailable (connection failed),
so auto mode cannot determine the safety of Bash right now.
```

| 检查项 | 数量 | 本轮结果 | 已知结果 |
|---|---|---|---|
| `node --check recommend-rank.js` | — | **未执行** | 无 |
| `test-recommend-rank.js` | 28 | **未执行** | 27/28（修复前，失败于第 4 项） |
| `test-recommend-quality.js` | 47 | **未执行** | 项目所有者报告为全部通过，尚待复跑确认 |
| 既有回归 | 297 | **未执行** | 项目所有者报告为全部通过，尚待复跑确认 |
| 合计 | 372 | **未执行** | — |

> 不将 27/28 或历史回归结果当作本轮修复后的结论。

---

## 6. 本机验收命令

```powershell
cd D:\Bili-Daily

node --check recommend-rank.js;   "check-rank   exit=$LASTEXITCODE"
node test-recommend-rank.js;      "rank         exit=$LASTEXITCODE"
node test-recommend-quality.js;   "quality      exit=$LASTEXITCODE"
node test-recommend-core.js;      "core         exit=$LASTEXITCODE"
node test-candidate-content-import.js; "import   exit=$LASTEXITCODE"
node test-candidate-features.js;  "features     exit=$LASTEXITCODE"
node test-candidate-quality.js;   "cand-quality exit=$LASTEXITCODE"
node test-candidate-pool.js;      "pool         exit=$LASTEXITCODE"
node test-interest-profile.js;    "profile      exit=$LASTEXITCODE"
node test-uid.js;                 "uid          exit=$LASTEXITCODE"
node test-up-stats.js;            "up-stats     exit=$LASTEXITCODE"
node test-stats.js;               "stats        exit=$LASTEXITCODE"
```

建议同时保留 UTF-8 日志：

```powershell
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
node test-recommend-rank.js 2>&1 | Tee-Object -FilePath rank-test4-run.txt
"exit=$LASTEXITCODE"
```

### 6.1 回填模板

| 命令 | 退出码 | 统计行 | 结论 |
|---|---|---|---|
| `node --check recommend-rank.js` |  |  |  |
| `node test-recommend-rank.js` |  |  /28 |  |
| `node test-recommend-quality.js` |  |  /47 |  |
| 既有回归（9 个文件） |  |  /297 |  |

---

## 7. 回滚方法

修复前快照（本轮新建，未覆盖任何旧目录）：

- `D:\Bili-Daily\rollback\before-rank-reason-note-fix\recommend-rank.js`（36132 字节）

```powershell
Copy-Item D:\Bili-Daily\rollback\before-rank-reason-note-fix\recommend-rank.js `
          D:\Bili-Daily\recommend-rank.js -Force
```

项目无 Git 仓库，回滚依赖文件快照；上一轮快照
`rollback/before-rank-undefined-fix/` 保持原样。

---

## 8. 已知限制与风险

1. 修复未经运行验证；若第 4 项仍失败，请提供新的失败行号与 `expected/actual`。
2. 若未来其它模块的返回值再次包含“准确率”等字样，同样会被第 4 项拦截；
   这是测试的有意设计，不应通过放宽断言解决，而应审视文案。
3. 此前两轮的失败日志（`rank-debug.txt`）与报告均未改动。

---

## 9. 下一步

1. 本机执行 §6，回填 §6.1；目标 372/372。
2. 全部通过后立即推进工作包 B（本地候选存储与导入），不再重做算法设计。
3. 工作包 C / D 按既定 MVP 计划执行；自动发现陌生 UP 主需先验证可用且获准的数据来源。
