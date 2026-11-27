# C3-2 排序层测试失败分析与修复（2026-11-12）

- 报告日期：2026-11-12
- 阶段：C3-2（`recommend-quality.js` / `recommend-rank.js`）
- 状态：**修复已写入代码，验证命令待项目所有者执行**
- 本报告不含任何“测试通过”结论（本会话未能执行 `node`，见 §4）。

## 1. 事实来源

`D:\Bili-Daily\rank-debug.txt`（2026-11-12 14:34，项目所有者本机以
PowerShell 重定向生成，UTF-16LE 编码）。实际运行的是：

```
node test-recommend-rank.js
```

结果行：

```
9/28 通过
```

即 28 项中 9 项通过、**19 项失败**。

## 2. 失败原因（单一根因）

19 条 FAIL 全部是同一个异常：

```
ReferenceError: userPartitionVector is not defined
    at D:\Bili-Daily\recommend-rank.js:620:11
    at Array.forEach (<anonymous>)
    at collectMainLane (D:\Bili-Daily\recommend-rank.js:584:12)
    at Object.buildRecommendations (D:\Bili-Daily\recommend-rank.js:469:18)
```

`rank-debug.txt` 中 `ReferenceError: userPartitionVector is not defined`
出现 **19 次**，与 `FAIL` 出现次数一致——说明没有第二个失败原因。

### 2.1 代码根因

`collectMainLane`（`recommend-rank.js:537`）解构出的变量名是 `userPartition`：

```js
const { source, userPartition, userText, now, config, similarityMode } = context;
```

但第 615–621 行给 `buildEntry` 传对象时用了**未定义的简写属性**
`userPartitionVector`：

```js
buildEntry(draft, combined.score, partitionSimilarity, textSimilarity, config, {
  partitionVector: draft.partitionVector,
  textVector,
  userTextVector,
  userPartitionVector        // ← ReferenceError
})
```

`buildEntry` 期望的形状是 `vectors.userPartitionVector.vector`
（`recommend-rank.js:665-669`），而 `userPartition` 正是
`Quality.buildDecayedUserPartitionVector(...)` 的返回值，
其本身带有 `.vector` 字段（`recommend-core.js:412-424`、
`recommend-quality.js:664-680`）。因此正确值就是 `userPartition`。

探索通道 `collectExplorationLane` 存在完全相同的错误
（`recommend-rank.js:780-786` → `buildExplorationEntry`，期望形状见 `:829-831`）。
该分支在本次运行中未触发，但同样会抛错。

## 3. 本次修改

回滚快照：`rollback/before-rank-undefined-fix/`（含原文件与 README）。

| 位置 | 修改 |
|---|---|
| `recommend-rank.js:620` | `userPartitionVector` → `userPartitionVector: userPartition` |
| `recommend-rank.js:785` | `userPartitionVector` → `userPartitionVector: userPartition` |

只改这两处对象字面量，未改动任何逻辑、阈值或导出接口。

## 4. 验证状态（未执行）

本会话的 Bash 执行通道在尝试时返回：

```
claude-opus-5-5 is temporarily unavailable (connection failed),
so auto mode cannot determine the safety of Bash right now.
```

因此 **`node --check` 与 `node test-recommend-rank.js` 均未执行**，
§3 的修改是否让 28 项全部通过，目前**未知**。

请在本机 PowerShell 执行并回填结果：

```powershell
cd D:\Bili-Daily
node --check recommend-rank.js
node test-recommend-rank.js
if ($?) { "EXIT_OK" } else { "EXIT_FAIL" }
```

建议同时跑邻近回归：

```powershell
node test-recommend-quality.js
node test-recommend-core.js
```

## 5. 文件落盘位置（回答“保存在 D 盘”）

全部代码与测试文件本来就在 D 盘项目根目录 `D:\Bili-Daily\`：

| 类型 | 文件 |
|---|---|
| 测试 | `test-recommend-rank.js`、`test-recommend-quality.js`、`test-recommend-core.js`、`test-candidate-*.js`、`test-interest-profile.js`、`test-stats.js`、`test-uid.js`、`test-up-stats.js` |
| 被测算代码 | `recommend-rank.js`、`recommend-quality.js`、`recommend-core.js`、`candidate-*.js`、`interest-profile.js`、`stats.js`、`storage.js`、`content.js`、`popup.*` |
| 测试输出 | `rank-debug.txt`（2026-11-12）、`C2-4B-test-debug.txt`（2026-11-11） |
| 报告 | `docs/acceptance/`（C1…C3-1、MVP-Sprint）；本次新增 `docs/acceptance/C3-2/` |

单文件 HTML 版本：需要 `node tools/build-report-html.js`，本会话通道被阻断，
**未生成**。生成命令：

```powershell
cd D:\Bili-Daily
node tools/build-report-html.js docs/acceptance/C3-2/rank-test-failure-2026-11-12.md docs/acceptance/C3-2/rank-test-failure-2026-11-12.html
```

## 6. 下一步

1. 本机执行 §4 命令，回填 `9/28` 是否变为 `28/28`。
2. 若仍有失败，把新的 `rank-debug.txt` 重新生成（注意用
   `node test-recommend-rank.js *> rank-debug.txt` 或设置
   `$OutputEncoding`/`chcp 65001`，避免 UTF-16 乱码）。
3. 通过后按 MVP 计划进入导入存储层（工作包 B）。
