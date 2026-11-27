# MVP Sprint 工作包 A · 排序层缺陷修复报告

**`ReferenceError: userPartitionVector is not defined`**

- 报告日期：2026-11-12
- 阶段：MVP Sprint / 工作包 A（算法与测试层）
- 修复文件：`recommend-rank.js`（唯一改动文件）
- 代码状态：**两处缺陷已在工作区修正**
- 测试状态：**本轮未执行**（Bash / `node` 执行通道被阻断，见 §5）
- 结论边界：本报告**不含任何“测试通过”结论**。28 / 47 / 297 三项测试均需项目所有者本机执行后回填。

---

## 0. 事实来源与时间线

| 时间 | 事件 | 证据 |
|---|---|---|
| 2026-11-12 14:34 | 项目所有者在 PowerShell 运行 `node test-recommend-rank.js`，结果 `9/28 通过`，19 项失败 | `rank-debug.txt`（UTF-16LE，未改动） |
| 2026-11-12 14:39 | 修复前快照落盘；两处调用点改为显式传参 | `rollback/before-rank-undefined-fix/`（36102 字节，含缺陷） |
| 2026-11-12 14:39 | 工作区 `recommend-rank.js` 变为 36132 字节（+30 字节 = 两处 `: userPartition`） | 文件大小对照 |
| 2026-11-12（本轮） | 静态复核当前工作区：两处均已修复；未能执行 `node` | 本报告 §2–§4 |

> **重要**：`rank-debug.txt` 生成于修复**之前**。其中的行号 620 / 584 对应的是修复前的文件内容。
> 当前工作区第 620 行已经是 `userPartitionVector: userPartition`，不可能再在该行抛
> `ReferenceError`。如果本机再次运行仍报同一错误，请先确认运行的是 `D:\Bili-Daily\recommend-rank.js`
> （这是测试 `require` 的唯一路径），再生成新的日志。

---

## 1. 根本原因

### 1.1 main 通道

`buildRecommendations()` 中：

```js
const userPartition = Quality.buildDecayedUserPartitionVector(source.records, vectorOptions);
```

`collectMainLane()` 的签名解构出的变量名是 `userPartition`：

```js
function collectMainLane(context) {
  const { source, userPartition, userText, now, config, similarityMode } = context;
```

但调用 `buildEntry` 时，对象字面量使用了**未声明的简写属性** `userPartitionVector`：

```js
buildEntry(draft, combined.score, partitionSimilarity, textSimilarity, config, {
  partitionVector: draft.partitionVector,
  textVector,
  userTextVector,
  userPartitionVector        // ← 简写 = userPartitionVector: userPartitionVector
})
```

在该函数作用域内没有任何名为 `userPartitionVector` 的绑定，因此求值对象字面量时立即抛出
`ReferenceError`。这不是“值是 undefined”，而是**标识符本身不存在**。

`buildEntry` 期望的形状是 `vectors.userPartitionVector.vector`：

```js
userPartitionVector:
  vectorInfo.userPartitionVector &&
  isPlainObject(vectorInfo.userPartitionVector.vector)
    ? vectorInfo.userPartitionVector.vector
    : null,
```

而 `Quality.buildDecayedUserPartitionVector()` 的返回值正是带 `.vector` 的包装对象
（`recommend-quality.js:806-844`：`{ kind, space, side, basis, status, available, vector, ... }`）。
关闭衰减时它委托 `Core.buildUserPartitionVector()`，形状一致。因此正确的值就是 `userPartition`。

### 1.2 exploration 通道

`collectExplorationLane()` 存在**完全相同**的缺陷（修复前第 785 行）：

```js
const { source, userPartition, userText, now, config } = context;
...
buildExplorationEntry(draft, combined.score, partitionSimilarity, textSimilarity, config, {
  partitionVector: draft.partitionVector,
  textVector,
  userTextVector,
  userPartitionVector        // ← 同一个未声明标识符
})
```

`buildExplorationEntry` 同样读取 `vectors.userPartitionVector.vector`（`recommend-rank.js:829-832`）。

本次失败日志中没有出现该行号，是因为 main 通道先抛错：`collectMainLane` 在
`buildRecommendations` 中先于 `collectExplorationLane` 执行。**不是该处没有问题。**

### 1.3 为什么不是其他原因

- `userTextVector` 在两条通道内都有 `const` 声明（`:582`、`:750`），不构成同类问题。
- `textVector` 在 `forEach` 回调内声明（`:585`、`:753`）。
- `draft.partitionVector` 由 `Core.buildCandidatePartitionVector()` 生成。
- 异常栈固定在同一层 `collectMainLane (recommend-rank.js:584)`，19 条 FAIL 全部同因。

---

## 2. 精确修改位置

只改两个对象字面量，共 2 处、每处 1 行：

| 文件:行 | 修改前 | 修改后 |
|---|---|---|
| `recommend-rank.js:620` | `userPartitionVector` | `userPartitionVector: userPartition` |
| `recommend-rank.js:785` | `userPartitionVector` | `userPartitionVector: userPartition` |

修改后源码（节选）：

```js
// main lane，recommend-rank.js:615-622
entries.push(
  buildEntry(draft, combined.score, partitionSimilarity, textSimilarity, config, {
    partitionVector: draft.partitionVector,
    textVector,
    userTextVector,
    userPartitionVector: userPartition
  })
);
```

```js
// exploration lane，recommend-rank.js:780-787
entries.push(
  buildExplorationEntry(draft, combined.score, partitionSimilarity, textSimilarity, config, {
    partitionVector: draft.partitionVector,
    textVector,
    userTextVector,
    userPartitionVector: userPartition
  })
);
```

### 2.1 未修改的内容

- 未改动 `buildEntry` / `buildExplorationEntry` 的签名与取值逻辑。
- 未改动 `buildRecommendations` 中用户向量的构建方式。
- 未改动任何阈值、权重、衰减公式、冷启动门槛。
- 未改动 `recommend-quality.js`、`recommend-core.js`、C1 / C2 / C3-1 任何业务模块。
- 未修改任何测试文件，未跳过测试，未放宽断言。
- 未用全 0 向量或其他伪造数据填补缺失值。

### 2.2 关于“本轮是否再次编辑”

本轮复核时，上述两处修正**已经存在于工作区**（上一轮修复写入，见 `rollback/before-rank-undefined-fix/README.md`）。
本轮没有再对代码做第三次改动——因为再改就会偏离最小修复原则。本轮工作是：

1. 逐行复核两处调用与两个 `buildEntry` 的取值约定；
2. 扫描全文件其余简写属性，确认无同类未声明标识符（§3）；
3. 记录修复前/后行为差异（§4）；
4. 归档本报告。

---

## 3. 同类变量问题扫描

对 `recommend-rank.js` 全文件执行“对象字面量简写属性”扫描（正则 `^\s+[A-Za-z_$][A-Za-z0-9_$]*,?\s*$`），
逐个核对是否在作用域内声明：

| 行 | 简写 | 声明处 | 结论 |
|---|---|---|---|
| 94-95 | `code, message` | `reason(code, message, evidence)` | 正常 |
| 129 / 135 | `K` | `normalizeConfig` 内 `const K` | 正常 |
| 374 / 378 | `userShare` | `buildReasons` 内 `const userShare` | 正常 |
| 431 | `config` | `buildRecommendations` 参数链 | 正常 |
| 445 | `vectorOptions` | `:435` | 正常 |
| 470-475 / 482-486 | `source, userPartition, userText, now, config, similarityMode` | `buildRecommendations` 内均已绑定 | 正常 |
| 618-619 / 783-784 | `textVector, userTextVector` | `:585 / :582`、`:753 / :750` | 正常 |
| 670 / 682 / 833 / 847 | `reliability, config` | `buildEntry` / `buildExplorationEntry` 内 | 正常 |
| 875 / 889 / 899 | `explorationSorted, remaining, mainQuota` | `finalizeSimilarityLanes` 内 | 正常 |
| 1064-1070 | `MODULE_KIND` 等 | 顶层 `const` | 正常 |

**结论：除已修复的两处外，未发现其他未声明的简写属性。**

依赖符号的可用性也已核对：

| 符号 | 来源 | 结果 |
|---|---|---|
| `Quality.buildDecayedUserPartitionVector` | `recommend-quality.js:664`，导出 `:1787` | 存在 |
| `Quality.buildDecayedUserTextCounts` | `:854`，导出 `:1788` | 存在 |
| `Core.buildCandidatePartitionVector` | `recommend-core.js:746` | 存在 |
| `Core.buildCandidateTextCounts` | `:923` | 存在 |
| `Core.computeIdf` / `buildTfIdfVector` / `compareVectors` | `:1183 / :1464 / :1750` | 存在 |
| `Import.assessImportedContentCandidates` | `candidate-content-import.js:1547` | 存在 |
| `Quality.assessFeatureReliability` 的 `coverage.partition.ratio` | `recommend-quality.js:1528-1535, 1574-1586` | 存在 |

---

## 4. 修改前后的行为区别

### 4.1 修复前

- `similarityMode === true` 且 main 通道存在可评分候选时，构造 `buildEntry` 参数对象即抛
  `ReferenceError`，**整条 `buildRecommendations()` 调用失败**。
- 结果：`test-recommend-rank.js` 中所有进入相似度路径的用例失败（19 项）。
- exploration 通道即使被调用也会在同一位置失败，只是 main 先抛。
- `returning-only`（冷启动数据不足）路径传 `vectors = undefined`，不经过该对象字面量，所以那 9 项能通过。

### 4.2 修复后

- `buildEntry` / `buildExplorationEntry` 收到 `userPartitionVector` = `Quality` 返回的包装对象；
  内部按既有约定取出 `.vector` 与 `.basis`，供 `buildReasons()` 的 `partition-match` 理由使用。
- 若用户分区向量不可用（`available === false`，`.vector === null`），仍按原逻辑落为 `null`，
  **不会伪造 0 向量**，也不会生成 `partition-match` 理由。
- 数值口径、排序权重、MMR、配额、去重逻辑零变化。
- 关闭衰减路径与 C3-1 的行为一致性不受影响（`Quality` 委托逻辑未动）。

---

## 5. 测试与语法检查结果（未执行）

本轮执行通道在被调用时返回：

```
qwen/qwen-flash is temporarily unavailable (connection failed),
so auto mode cannot determine the safety of Bash right now.
```

因此以下结果**全部为未执行**，不得视为通过：

| 检查项 | 数量 | 本轮结果 | 最近一次已知结果 |
|---|---|---|---|
| `node --check recommend-rank.js` | — | **未执行** | 无记录 |
| `test-recommend-rank.js` | 28 | **未执行** | 9/28（2026-11-12 14:34，修复前） |
| `test-recommend-quality.js` | 47 | **未执行** | 无记录 |
| 既有回归 | 297 | **未执行** | 无记录 |
| 合计 | 372 | **未执行** | — |

---

## 6. 执行命令与退出码（需本机回填）

在 `D:\Bili-Daily` 打开 PowerShell，逐条执行。`$LASTEXITCODE` 为该条命令的退出码
（`0` 为成功）；每条测试自身的统计行（如 `28/28 通过`）也请一并记录。

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

### 6.1 建议的日志重定向（避免 UTF-16 乱码）

```powershell
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
node test-recommend-rank.js 2>&1 | Tee-Object -FilePath rank-fix-run.txt
"exit=$LASTEXITCODE"
```

### 6.2 回填模板

| 命令 | 退出码 | 统计行 | 结论 |
|---|---|---|---|
| `node --check recommend-rank.js` |  |  |  |
| `node test-recommend-rank.js` |  |  /28 |  |
| `node test-recommend-quality.js` |  |  /47 |  |
| 既有回归（9 个文件） |  |  /297 |  |

---

## 7. 回滚方法

修复前快照已存在，**未覆盖任何其他 rollback 子目录**：

- `D:\Bili-Daily\rollback\before-rank-undefined-fix\recommend-rank.js`（36102 字节，含两处缺陷）
- `D:\Bili-Daily\rollback\before-rank-undefined-fix\README.md`

```powershell
Copy-Item D:\Bili-Daily\rollback\before-rank-undefined-fix\recommend-rank.js `
          D:\Bili-Daily\recommend-rank.js -Force
```

项目当前没有 Git 仓库，因此未创建提交；回滚依赖上述文件快照。

---

## 8. 风险与已知限制

1. **修复未经运行验证**：语法与逻辑为静态复核结论，可能存在未暴露的问题。
2. 若本机复跑仍报同一条 `ReferenceError`，请确认：
   - 运行目录与 `require` 路径都是 `D:\Bili-Daily\recommend-rank.js`；
   - 文件第 620 行为 `userPartitionVector: userPartition`（而不是简写）。
3. `rank-debug.txt` 是修复前的历史日志，**保留未改动**；不要把它当作修复后的结果。
4. 本报告 §5 的三项测试数字均为“未执行”，在回填前不得对外声称 372 项通过。

---

## 9. 下一步

1. 本机执行 §6 命令，回填 §6.2 表格；若 28 项仍有失败，生成新日志并定位。
2. 28 项通过后，允许继续推进工作包 B（导入存储层）与工作包 C（popup 集成）。
3. 单文件 HTML 由本报告同名生成（见 `MVP-rank-fix-report.html`）。
