# 候选 sidecar 测试第 25 / 26 项修复报告

- 日期：2026-11-12
- 范围：`test-candidate-store.js` 第 25、26 项对 C2-4B sidecar 数据契约的断言
- 实际修改文件：仅 `test-candidate-store.js`
- `candidate-store.js`：本轮未修改
- C2-4B 正式接口：未修改
- 既有测试：未修改
- 断言：未删除、未跳过、未放宽；第 25 项按正式契约改为更强断言，第 26 项追加同 BV 去重断言
- 修复后测试状态：**Claude Code 未执行**（命令通道再次被安全分类器阻断）；本机结果待回填

---

## 1. 原始失败记录（用户本机执行）

命令：

```powershell
cd D:\Bili-Daily
node test-candidate-store.js
```

结果：**26/28 通过**。

失败第 25 项：`buildSidecar 为导入候选生成可用的 C2-4B 证据`

```text
TypeError: Cannot read properties of undefined (reading 'onlineVerified')
test-candidate-store.js:489:42
```

失败第 26 项：`同一 UID 出现在多个批次时 sidecar 合并身份`

```text
TypeError: Cannot read properties of undefined (reading 'importedVideoCount')
test-candidate-store.js:502:56
```

其余 26 项通过。退出码未在用户输出中回填。

---

## 2. C2-4B 正式数据契约核对

### 2.1 `buildCandidateContentEvidence()` 的直接产出（sidecar）

源码：`candidate-content-import.js:1217-1391`

sidecar 顶层字段：

```text
schemaVersion, kind, provenance, lane, status, reason,
userConfirmed, exportedAt, sourceNote,
candidates, summary, diagnostics, limits, thresholds, note
```

`candidates[]` 每项的真实字段（`candidate-content-import.js:1092-1147`）：

```text
upUid, upName, names, nameConflict,
provenance, lane, observedAt, observedAtState,
videos,
partitionCounts, titleTokens, titleTokenStats,
importedVideoCount, observedVideoCount, usableVideoCount,
importedTitleCount, importedPartitionCount,
partitionCoverage, titleCoverage,
partitionCoverageState, titleCoverageState, coverageBasis,
contentStatus, conflictVideoCount, metadataConflictVideoCount,
conflicts, videosTruncated, globalVideoLimitDropped, reasons
```

结论：

- `importedVideoCount` 在 **sidecar 候选的顶层**，不在 `contentEvidence` 下。
- `provenance`、`lane` 也在 **sidecar 候选的顶层**。
- sidecar 候选**没有** `identityEvidence` / `contentEvidence` 字段，也**没有** `onlineVerified` 字段。
- sidecar 顶层 `note` 明确写着“用户提供的内容证据，未在线核验”。

### 2.2 `assessImportedContentCandidates()` 的产出（正式评估结果）

源码：`candidate-content-import.js:1720-1764`

```text
candidates[] {
  upUid, upName, provenance, lane, observedAt, observedAtState, freshness,
  identityEvidence: { uid, uidFormatValid, provenance, userConfirmed,
                      fromWatchHistory, fromUserInput, sources,
                      onlineVerified: false, ... },
  contentEvidence: { importedVideoCount, trustedVideoCount, ... },
  promotion: { eligibleForExploration, status, reasons, thresholds }
}
```

结论：

- `onlineVerified` 的正式位置是 **`assessment.candidates[].identityEvidence.onlineVerified`**，本阶段恒为 `false`。
- `importedVideoCount` 在评估结果中位于 **`contentEvidence.importedVideoCount`**，值等于 sidecar 候选去重后的 `videos.length`。

### 2.3 `candidate-store.js` 的 `buildSidecar()`

源码：`candidate-store.js:484-490`

```js
function buildSidecar(store, options) {
  const document = toImportDocument(store);
  if (!document) return null;
  const parsed = Import.parseCandidateContentImport(document);
  if (parsed.status !== "ok") return null;
  return Import.buildCandidateContentEvidence(parsed, options);
}
```

它只做“批次 → 单个导入文档 → 重新解析 → 原生构建”，**原样返回 C2-4B sidecar**，没有二次包装，也没有丢字段。

### 2.4 下游使用方式

- `recommend-service.js:348-352`：把 sidecar 直接传给 `Rank.buildRecommendations({ ..., sidecar })`。
- `recommend-rank.js:703`：在探索通道内调用 `assessImportedContentCandidates(sidecar, records, ...)`；
  随后从 **sidecar 候选顶层**读取 `importedVideoCount`（`recommend-rank.js:838-841`），并用 sidecar 候选构建分区/文本向量。
- `recommend-rank.js` 从不假设 sidecar 候选带 `identityEvidence` / `contentEvidence`。

结论：**数据结构本身正确，错误只在 `test-candidate-store.js` 的断言假设。** 不需要修改 `candidate-store.js`，更不能为了测试去改 C2-4B 正式接口。

---

## 3. 修复前后对比

### 3.1 第 25 项

修复前（错误假设）：

```js
assert.notEqual(sidecar.status, "invalid");
sidecar.candidates.forEach((item) => {
  assert.equal(item.provenance, "user-provided");
  assert.equal(item.identityEvidence.onlineVerified, false); // undefined
  assert.equal(item.lane, "exploration");
});
```

修复后（正式契约 + 更强断言）：

```js
assert.equal(sidecar.kind, "bili-daily-candidate-content");
assert.equal(sidecar.provenance, "user-provided");
assert.equal(sidecar.lane, "exploration");
assert.equal(sidecar.status, "ok");
assert.ok(sidecar.note.includes("未在线核验"));
assert.equal(sidecar.candidates.length, 2);
const byUid = new Map(sidecar.candidates.map((item) => [item.upUid, item]));
assert.equal(byUid.get("2001").importedVideoCount, 3);
assert.equal(byUid.get("2002").importedVideoCount, 2);
sidecar.candidates.forEach((item) => {
  assert.equal(item.provenance, "user-provided");
  assert.equal(item.lane, "exploration");
});

// onlineVerified 只在正式评估结果里，且恒为 false
const assessment = Import.assessImportedContentCandidates(sidecar, {}, { now: BASE });
assert.equal(assessment.status, "ok");
assert.equal(assessment.candidates.length, 2);
assessment.candidates.forEach((item) => {
  assert.equal(item.identityEvidence.onlineVerified, false);
  assert.equal(item.identityEvidence.fromWatchHistory, false);
});
```

说明：

- 没有把 `onlineVerified` 伪造成 `true`；相反，验证了正式评估结果中恒为 `false`。
- 增加了 `fromWatchHistory === false`，确认导入候选没有被冒充成观看记录。
- 断言由“存在即可”收紧为 `status === "ok"`、具体视频数与来源通道。

### 3.2 第 26 项

修复前：

```js
assert.equal(sidecar.candidates.length, 1, "同一 UID 在 sidecar 中应合并");
assert.equal(sidecar.candidates[0].contentEvidence.importedVideoCount, 2); // undefined
```

修复后：

```js
assert.equal(sidecar.candidates.length, 1, "同一 UID 在 sidecar 中应合并");
assert.equal(sidecar.candidates[0].provenance, "user-provided");
assert.equal(sidecar.candidates[0].lane, "exploration");
assert.equal(sidecar.candidates[0].importedVideoCount, 2);

// 同一 UID 再次导入已存在的 BV：仍只算一个视频
await Store.importText(
  JSON.stringify(document([candidate("8101", "同人", [video(2, "科技评测", "科技")])]))
);
const dedupedRead = await Store.readStore();
const deduped = Store.buildSidecar(dedupedRead.store, { now: BASE });
assert.equal(deduped.candidates.length, 1);
assert.equal(deduped.candidates[0].importedVideoCount, 2, "同一 UID 的同一 BV 不得重复计数");
```

---

## 4. 同 UID / 同 BV 去重规则

依据 `candidate-content-import.js` 的实现：

1. **同 UID 跨批次**：`candidate-store.js` 的 `toImportDocument()` 把多个批次摊平成候选数组；
   `mergeCandidates()` 以 `upUid` 为键合并，`diagnostics.candidatesMerged` 递增。
2. **同 UID 同 BV**：`mergeCandidates()` 以 `bvid` 为键收集所有变体；
   `resolveVideo()` 对变体做一次归并，`diagnostics.duplicateVideos += variants.length - 1`。
3. **计数**：`importedVideoCount = videos.length`，即 **UID + BV 去重后的视频数**，
   不是原始出现次数。
4. **元数据冲突**：同一 BV 的标题或分区出现两个不同非空值时，标记 `metadata-conflict`，
   该视频不参与内容特征；缺失 + 有值不视为冲突。
5. **跨 UID 同 BV**：同一 BV 被不同 UID 声明时标记 `uid-conflict`，不参与任何一方的内容特征。

第 26 项新增的重复导入断言直接验证第 1～3 条。

---

## 5. 实际修改文件

| 文件 | 修改 |
|---|---|
| `test-candidate-store.js` | 第 25 项改用 sidecar 顶层字段，并通过正式评估结果验证 `onlineVerified === false`；第 26 项改用顶层 `importedVideoCount`，追加同 BV 去重断言 |
| `rollback/before-candidate-sidecar-test-fix/README.md` | 新增回滚说明 |

未修改：

- `candidate-store.js`
- `candidate-content-import.js`
- `recommend-service.js`
- `recommend-rank.js`
- `popup.html` / `popup.css` / `popup.js`
- `biliDailyRecords` 相关代码
- 其余 26 项测试

---

## 6. 测试与退出码

### 6.1 修复前（用户本机）

| 命令 | 结果 |
|---|---|
| `node test-candidate-store.js` | 26/28 通过；第 25、26 项 TypeError；退出码未回填 |

### 6.2 修复后（Claude Code）

本轮**没有执行**以下命令：

```powershell
node --check test-candidate-store.js
node --check candidate-store.js
node test-candidate-store.js
node test-recommend-service.js
node test-candidate-content-import.js
```

原因：命令工具再次返回：

```text
qwen/qwen-flash is temporarily unavailable (connection failed), so auto mode cannot determine the safety of Bash right now.
```

因此：

- 不宣称 28/28 通过；
- 不宣称 422/422 通过；
- 不提供虚构的退出码。

### 6.3 需要在本机执行的完整命令

```powershell
cd D:\Bili-Daily

node --check test-candidate-store.js
node --check candidate-store.js
node test-candidate-store.js

node test-recommend-service.js
node test-candidate-content-import.js

# 完整回归
node test-recommend-rank.js
node test-recommend-quality.js
node test-stats.js
node test-up-stats.js
node test-uid.js
node test-interest-profile.js
node test-candidate-pool.js
node test-candidate-quality.js
node test-candidate-features.js
node test-recommend-core.js
```

目标：

- `test-candidate-store.js`：**28/28**，退出码 0；
- 全部 13 个测试文件：**422/422**（既有 372 + 新增 28 + 22），全部退出码 0。

请回填每个脚本末尾的 `N/M 通过` 与退出码。若仍有失败，按真实断言输出定位，不把新失败归因于加载顺序或字段契约猜测。

---

## 7. 回滚方法

快照目录：`rollback/before-candidate-sidecar-test-fix/`

```powershell
cd D:\Bili-Daily
Copy-Item rollback\before-candidate-sidecar-test-fix\test-candidate-store.js . -Force
Copy-Item rollback\before-candidate-sidecar-test-fix\candidate-store.js . -Force
```

回滚只影响测试文件与候选存储模块存档；不会触碰 `biliDailyRecords`、`biliDailyCandidateImports` 或弹窗功能。

---

## 8. 当前状态

- 第 25、26 项根因：已确认是测试断言对 C2-4B 返回结构的错误假设，不是业务模块缺陷。
- 修复：仅测试文件，未改正式接口。
- 回滚快照：已保存。
- 自动化验证：待本机执行。
- 下一步：完整回归通过后，继续按既定方向推进“自动发现陌生 UP 主”的可行性实现与权限审批。
