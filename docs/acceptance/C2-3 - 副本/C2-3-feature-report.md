# Bili Daily C2-3 验收报告：候选 UP 主内容特征建模

- **阶段**：C2-3（纯函数特征提取 + 测试，不含排序、UI、存储与新增采集）
- **日期**：2026-11-11
- **模块**：`candidate-features.js`（新增）、`test-candidate-features.js`（新增）
- **依赖**：必须先加载 `stats.js`
- **运行环境**：Windows 11，Node.js `v24.19.0`

---

## 0. 验收状态总览

| 项目 | 状态 | 说明 |
|---|---|---|
| 新增特征模块 | 已执行 | `candidate-features.js` 已创建，纯函数、无外部依赖 |
| 新增测试 38 项 | 已执行 | `node test-candidate-features.js`，38/38 通过，退出码 0 |
| 原有 143 项回归 | 已执行 | 六个既有套件全部通过，退出码均为 0 |
| 语法检查 | 已执行 | 15 个 JS 文件 `node --check` 通过；`manifest.json` 可解析 |
| 既有文件未被改动 | 已执行 | 与回滚快照 SHA-256 对比，10/10 一致 |
| 合成数据性能观察 | 已执行 | 27,000 条记录 / 600 候选，5 次运行；**非真实数据压测** |
| 真实 `chrome.storage.local` 数据 | 未执行（本阶段禁止） | 未读取、未写入任何真实数据 |
| 正式排序 / UI / C3 | 未执行（范围外） | 本阶段在报告后停止，等待审核 |

---

## 1. 实际修改及新建文件

### 1.1 新建

| 文件 | 行数 | 说明 |
|---|---:|---|
| `candidate-features.js` | 843 | 候选 UP 主分区 / 标题特征提取，纯函数模块 |
| `test-candidate-features.js` | 809 | 38 个用例，覆盖身份、去重、冲突、覆盖率、边界与稳定性 |
| `docs/acceptance/C2-3/C2-3-feature-report.md` | — | 本报告（Markdown 源文件） |
| `docs/acceptance/C2-3/C2-3-feature-report.html` | — | 本报告的单文件 HTML 版本（CSS 内联，可直接打开 / 打印） |
| `rollback/before-c2-3-features/` | — | C2-3 开始前的 10 个既有文件快照 + `README.md` |

### 1.2 修改

**无。** 本阶段没有修改任何既有运行时模块或既有测试文件。

与 `rollback/before-c2-3-features/` 逐文件比对 SHA-256，以下 10 个文件全部一致：

`candidate-pool.js`、`stats.js`、`interest-profile.js`、`storage.js`、
`test-candidate-pool.js`、`test-candidate-quality.js`、`test-interest-profile.js`、
`test-stats.js`、`test-uid.js`、`test-up-stats.js`。

**明确未修改**：`manifest.json` 权限、`popup.html`、`popup.css`、`popup.js`、
`content.js` 采集逻辑、`storage.js` 持久化结构；未写入 `chrome.storage.local`；
未新增页面 DOM 采集；未连接 B 站 API；未读取 Cookie 或登录信息；未引入任何依赖。

> 说明：`candidate-features.js` 源码中只在注释里出现 `chrome.*` 字样，
> 运行代码不含 `chrome.*`、DOM、`fetch`、`XMLHttpRequest`、`Cookie`、`eval`、
> `new Function`、`require` 或动态 `import`。

---

## 2. 对外 API 与数据结构

### 2.1 导出

模块挂载在 `globalThis.BiliDailyCandidateFeatures`，整体冻结：

```js
globalThis.BiliDailyCandidateFeatures = Object.freeze({
  UNKNOWN_PARTITION,        // "未知"
  DEFAULT_THRESHOLDS,       // 默认阈值（冻结对象）
  buildCandidateFeatures,   // 主入口
  extractTitleBigrams       // 按默认上限提取标题 bigram 的纯辅助函数
});
```

### 2.2 主入口

```js
buildCandidateFeatures(records, pool, options)
```

- `records`：`biliDailyRecords` 根结构 `{ version, days }`，或直接的“日期 → 记录表”映射。
- `pool`：支持三种形态：
  1. 候选数组；
  2. C2-1 / C2-2 的 `{ candidates: [...] }`；
  3. C2-2 `filterEligibleCandidates` 的 `{ eligible, review, excluded }`，
     元素可以是 `{ candidate, assessment }` 或裸候选对象。
- `options.thresholds`：覆盖 `DEFAULT_THRESHOLDS`。只接受有限、非负数值；
  覆盖率阈值钳制在 `0..1`，数量 / 长度上限取整且不小于 1。
- `options` 中无法识别的键被忽略，不产生副作用。

### 2.3 顶层返回

```js
{
  status: "ok" | "empty",
  reason: "" | "no-candidates",
  candidates: [ /* 每个候选一条，按 UID 稳定排序 */ ],
  summary: {
    total, ready, partial, missing,
    withPartitionFeatures, withTitleFeatures,
    observedVideoCount, observedWatchMs,
    conflictVideoCount,          // 跨候选的唯一冲突视频数
    conflictedCandidates
  },
  diagnostics: { /* 见 2.5 */ },
  thresholds: { /* 实际生效的阈值 */ },
  unknownPartition: "未知",
  note: "featureStatus 只描述技术数据条件……"
}
```

空候选池返回 `status: "empty"`、`reason: "no-candidates"`，其余结构完整，
不抛异常。

### 2.4 单候选字段

| 字段 | 类型 | 含义 |
|---|---|---|
| `upUid` | string | 规范化后的 UID，唯一身份键 |
| `upName` | string | 候选昵称，仅展示，不参与身份判定 |
| `candidateType` | string | 原样继承候选池的 `candidateType`（如 `new` / `returning`） |
| `sources` | string[] | 来源并集，顺序为 `watched`、`manual`、其余按码点排序 |
| `hasUidConflict` | boolean | 该 UID 是否涉及同 BV 多 UID 冲突 |
| `partitionFeatures` | object | 分区明细、占比向量、未知桶与时长 |
| `titleFeatures` | object | 词元、词频、文档数、截断与溢出标记 |
| `partitionCoverage` | number \| null | 已识别分区时长 / `observedWatchMs` |
| `partitionCoverageState` | string | `"available"` \| `"no-data"` |
| `partitionCoverageBasis` | string | 固定 `"watch-ms"` |
| `titleCoverage` | number \| null | 有可用 bigram 的视频数 / `observedVideoCount` |
| `titleCoverageState` | string | `"available"` \| `"no-data"` |
| `titleCoverageBasis` | string | 固定 `"video-count"` |
| `observedVideoCount` | number | 去重、无冲突、`watchMs > 0` 的视频数 |
| `featureVideoCount` | number | 至少有分区或标题特征之一的视频数 |
| `observedWatchMs` | number | 参与统计的真实观看时长（毫秒） |
| `missingPartitionCount` | number | 分区缺失 / 非法而进入未知桶的视频数 |
| `missingTitleCount` | number | 标题缺失或归一化后为空的视频数 |
| `tokenlessTitleCount` | number | 有标题但无法生成任何 bigram 的视频数 |
| `conflictVideoCount` | number | 该 UID 涉及的冲突视频数（不计入特征） |
| `featureStatus` | string | `ready` \| `partial` \| `missing` |
| `featureReasons` | object[] | 结构化原因 `{ code, level, message }` |

`partitionFeatures`：

```js
{
  partitions: [
    { name, watchMs, videoCount, shareOfIdentified, shareOfAll }
  ],
  vector: { [分区名]: shareOfIdentified },   // 已识别分区内部归一化
  unknown: null | {
    name: "未知", watchMs, videoCount,
    shareOfIdentified: 0, shareOfAll
  },
  identifiedWatchMs,
  unknownWatchMs,
  identifiedVideoCount,
  unknownVideoCount
}
```

`titleFeatures`：

```js
{
  tokens: [{ token, count, documentCount }],
  uniqueTokenCount, totalTokenCount, documentCount,
  truncatedTitleCount, tokenlessTitleCount,
  tokenMapOverflow, outputTruncated
}
```

### 2.5 诊断字段

```js
{
  inputKind,                 // "root" | "days" | "empty"
  daysScanned, daysInvalid,
  recordsScanned, recordsInvalid, recordsWithoutBvid,
  videosScanned,             // 同 BV 合并后的视频数
  uidConflictVideos,         // 唯一冲突 BV 数
  candidatesInPool, candidatesInvalid, duplicateCandidates,
  candidatesWithoutObservedVideos,
  conflictVideosSeen,        // 扫描时遇到的冲突视频数
  uidlessVideos, zeroWatchVideos
}
```

所有输出均为普通对象 / 数组 / 数字 / 字符串 / 布尔 / `null`，
可 `JSON.stringify` 往返；分区名即使为 `"__proto__"` 也不会污染原型
（使用 `Object.defineProperty` 写入向量）。

---

## 3. 分区特征的计算方式

### 3.1 数据来源与去重

1. 通过 `stats.cleanRecord` 清洗每条记录，复用既有的字段规则、UID 规范化与
   `watchMs` 安全转换。
2. 通过 `stats.mergeByBvid` 合并同一 BV 的同日重复、跨天记录与多分 P：
   **一个 BV 只算一个视频，`watchMs` 累加**。
3. 记录没有 BV 时无法可靠去重，跳过并计入 `diagnostics.recordsWithoutBvid`，
   不把多条无 BV 记录合并成一个虚构视频。

### 3.2 时长加权

- 每个已识别分区累加真实 `watchMs`，不使用 `videoDuration`。
- `shareOfIdentified = 分区 watchMs / identifiedWatchMs`，
  即“已识别分区内部”的占比，已识别分区之和为 1。
- `shareOfAll = 分区 watchMs / observedWatchMs`，
  分母包含未知分区，用于观察该分区在全部真实观看中的份额。
- 分区列表按 `watchMs` 降序、再按分区名字符串升序排序，结果确定。

### 3.3 未知分区

以下情况统一归入 `"未知"` 桶，**真实时长仍保留在分母中**：

- 非字符串；
- 空字符串或仅空白；
- 字面值 `"未知"`；
- 含控制字符、零宽字符或双向格式字符；
- 按 Unicode 码点超过 `maxPartitionLength`（默认 64）；
- 为防御异常大输入，UTF-16 长度超过 `maxPartitionLength * 2` 时提前拒绝。

未知桶的 `shareOfIdentified` 固定为 0（它不属于已识别分区），
`shareOfAll = unknownWatchMs / observedWatchMs`。

### 3.4 覆盖率

```text
partitionCoverage = identifiedWatchMs / observedWatchMs
```

- 分母是**全部真实观看时长**，包含未知分区，不会把缺失数据悄悄排除。
- 无任何有效观看时长时为 `null`，同时 `partitionCoverageState = "no-data"`；
  **不会伪装成 0% 或 100%**。
- `missingPartitionCount` 记录进入未知桶的视频数。

---

## 4. 标题 bigram 规则

### 4.1 确定性归一化

`normalizeTitle` 的顺序固定：

1. 非字符串 → 视为空标题，不猜测；
2. 原始字符串超过 `maxTitleRawLength`（1000 个 UTF-16 单元）时截断，
   并避免截断在 UTF-16 代理对中间；
3. 尝试 `NFKC`（如全角 `ＡＩ` → `AI`）；环境不支持时保留原文，不丢标题；
4. 控制字符、零宽字符、双向控制符替换为**空格**（不是删除），避免两侧字符粘连；
5. 去除首尾空白，Latin 字母统一小写；
6. 按 Unicode 码点截断到 `maxTitleLength`（默认 200）。

### 4.2 分词与 bigram

- 词内字符定义为 Unicode `\p{L}`（字母）、`\p{N}`（数字）、`\p{M}`（组合附加符）。
- 其余字符（标点、空白、emoji、符号）一律作为分隔符。
- 对每个连续段，取相邻两字符组成 bigram；**不跨标点或空白拼接**。
- 单字符段不产生 bigram（例如标题只有“猫”时词元为空）。
- 中文、英文、数字、混合标题使用同一规则，不做额外分词或词典匹配。

示例：

| 标题 | 生成的 bigram（节选） |
|---|---|
| `科技前沿` | `科技`、`技前`、`前沿` |
| `AI 2026` | `ai`、`20`、`02`、`26` |
| `Hello,世界!` | `he`、`el`、`ll`、`lo`、`世界` |

英文按字符 bigram 处理，不切分为完整单词；这是本阶段的明确口径。

### 4.3 词频与文档数

- 同一视频内重复出现的词元：`count` 累计，`documentCount` 只加 1。
- 同一 BV 的重复观看、跨天观看、多分 P 已在 3.1 合并为一个视频，
  因此不会因重复观看而重复累计词元或文档数。
- 每个候选最多保留 `maxUniqueTokens`（默认 4000）个不同词元；
  达到上限后不再接收新词元，已有词元继续累计，并置 `tokenMapOverflow = true`。
- 输出最多 `maxOutputTokens`（默认 2000）个词元，按 `count` 降序、
  再按词元字符串升序排序；被截断时 `outputTruncated = true`。
- `uniqueTokenCount` 是词表实际大小；`totalTokenCount` 是所有词元出现次数之和；
  `documentCount` 是至少生成一个 bigram 的视频数。

### 4.4 标题覆盖率

```text
titleCoverage = titledVideoCount / observedVideoCount
```

- 分母是参与统计的视频数（去重、无冲突、`watchMs > 0`）。
- 分子只统计**至少能生成一个 bigram** 的视频；缺失标题、
  归一化后为空、只有单字符而无 bigram 的视频都不计入分子。
- 无任何参与统计的视频时，覆盖率为 `null`，状态为 `"no-data"`。

---

## 5. UID 与 BV 的身份 / 去重规则

### 5.1 只认 UID

- 所有归属只使用规范化后的 `upUid`，复用 `stats.cleanRecord` 的规则：
  正整数、安全整数、统一为字符串。
- **昵称不参与身份判定**：同一 UID 改名仍合并；不同 UID 同名严格分开。
- 缺失 UID 的旧记录**不会**凭昵称并入任何候选；它们只计入
  `diagnostics.uidlessVideos`。这是有意的保守策略，避免把旧记录错误归属。

### 5.2 BV 去重

- 同一 BV 无论出现在同一天多次、跨天、不同分 P，均通过 `mergeByBvid`
  合并为一个视频，`watchMs` 累加。
- 重复观看不会让 `observedVideoCount`、`documentCount` 或词频虚假膨胀。
- `observedVideoCount` 只统计 `watchMs > 0` 的视频；`watchMs <= 0` 的记录
  进入 `diagnostics.zeroWatchVideos`，不参与特征统计。

### 5.3 与 C2-1 / C2-2 的关系

- 本模块**不修改** C2-1 的 `watchedVideoCount`、`watchedWatchMs` 等观看计数。
- 本模块**不修改** C2-2 的 `eligible` / `review` / `excluded` 结论。
- `featureStatus` 与 C2-2 资格是正交维度：特征不完整不会自动降级 C2-2 资格，
  C2-2 的冲突结论也不会被本模块改写。
- 测试 32 明确验证：冲突候选的 C2-2 资格结论在特征计算前后保持一致。

---

## 6. 同 BV 多 UID 冲突处理

### 6.1 独立检测

本模块不信任 C2-1 的“先出现者”归属。扫描记录时单独建立
`BV → Set(UID)`，只要同一 BV 出现 ≥2 个不同有效 UID，就把该 BV 标记为冲突视频。

### 6.2 保守策略

对冲突 BV：

- **不计入任何一方的分区特征**；
- **不计入任何一方的标题特征**；
- **不计入任何一方的 `observedVideoCount` / `observedWatchMs`**；
- 每个涉及该 BV 的池内候选，`conflictVideoCount` 加 1，`hasUidConflict = true`；
- 只保留在诊断中：`diagnostics.uidConflictVideos`（唯一 BV 数）、
  `diagnostics.conflictVideosSeen`（扫描到的冲突视频数）；
- 跨候选汇总的 `summary.conflictVideoCount` 使用**唯一冲突 BV 数**，
  避免同一 BV 涉及两个 UID 时被重复计算。

### 6.3 为什么整体排除

同一 BV 被记录成两个 UID 时，无法从本地数据判断谁是真实 UP 主。
把该视频分配给任意一方都会制造虚假内容特征；整体排除只会损失少量数据，
但能保证“所有进入特征的分区 / 标题都来自可信归属”。冲突本身仍可诊断，
不会静默消失。

身份冲突只产生 `level: "info"` 的原因 `uid-conflicts-excluded`，
**不会**单独把 `featureStatus` 降级，也不会改变 C2-2 资格。

---

## 7. 新增手动候选的处理

只有 UID、没有本地观看历史的手动候选（典型为 `candidateType: "new"`）：

| 行为 | 结果 |
|---|---|
| 保留候选 | 是，只要 UID 规范化后有效 |
| 分区特征 | 不虚构；`partitions = []`、`vector = {}`、`unknown = null` |
| 标题特征 | 不虚构；`tokens = []`、各计数为 0 |
| `observedVideoCount` / `observedWatchMs` | 0 |
| `partitionCoverage` / `titleCoverage` | `null`，状态 `"no-data"` |
| `featureStatus` | `"missing"` |
| 原因 | `no-observed-videos`（warning），明确说明本地没有可提取内容 |
| 删除 / 标记不存在 | 否 |
| 默认 eligible | 否；本模块不改变 C2-2 资格 |
| `candidateType` | 原样保留，不强行改成 `returning` |

无效 UID 或非对象候选计入 `diagnostics.candidatesInvalid`，不生成候选；
重复 UID 只输出一次，`sources` 取并集，并计入 `duplicateCandidates`。

---

## 8. 覆盖率、质量字段与 `featureStatus` 定义

### 8.1 默认阈值

| 阈值 | 默认值 | 用途 |
|---|---:|---|
| `minObservedVideos` | 2 | `ready` 的最低视频数 |
| `minObservedWatchMs` | 300,000 ms（5 分钟） | `ready` 的最低真实观看时长 |
| `minPartitionCoverage` | 0.5 | `ready` 的最低分区覆盖率 |
| `minTitleCoverage` | 0.5 | `ready` 的最低标题覆盖率 |
| `maxTitleRawLength` | 1000 | 原始标题 UTF-16 截断 |
| `maxTitleLength` | 200 | 归一化后码点截断 |
| `maxUniqueTokens` | 4000 | 每候选词表上限 |
| `maxOutputTokens` | 2000 | 输出词元上限 |
| `maxPartitionLength` | 64 | 分区名码点上限 |

实际生效阈值随结果输出到 `thresholds`，便于后续调参和审计。

### 8.2 `featureStatus`

| 状态 | 判定 |
|---|---|
| `ready` | 有可用特征（`featureVideoCount > 0`），且视频数、观看时长、分区覆盖率、标题覆盖率**全部**达标 |
| `partial` | 有真实可用特征，但至少一项未达标，或覆盖率为 `null` |
| `missing` | `observedVideoCount === 0` 或 `featureVideoCount === 0`，没有可用内容特征 |

`featureStatus` **只描述技术数据条件**，不表示推荐质量，也不代表用户喜好强度。

### 8.3 原因代码

| code | level | 触发条件 |
|---|---|---|
| `no-observed-videos` | warning | 没有非冲突、`watchMs > 0` 的本地观看记录 |
| `uid-conflicts-excluded` | info | 有视频因同 BV 多 UID 被排除 |
| `partition-coverage-no-data` | warning | 分区覆盖率为 `null` |
| `partition-coverage-low` | warning | 分区覆盖率为 0 且低于阈值 |
| `title-coverage-no-data` | warning | 标题覆盖率为 `null` |
| `title-coverage-low` | warning | 标题覆盖率低于阈值 |
| `insufficient-videos` | warning | 视频数少于 `minObservedVideos` |
| `insufficient-watch-time` | warning | 观看时长少于 `minObservedWatchMs` |
| `no-usable-features` | warning | 没有任何可用分区或标题特征 |

---

## 9. 新增测试数量及结果

### 9.1 执行结果

```text
node test-candidate-features.js
→ 38/38 通过
→ 退出码 0
```

**已实际执行**，不是只统计 `test()` 数量。

### 9.2 用例覆盖

| # | 用例 | # | 用例 |
|---:|---|---:|---|
| 1 | 单 UID 单视频：分区、标题与基础计数 | 20 | 同 BV 不同 UID 冲突：冲突视频不参与任何一方 |
| 2 | 单 UID 多视频：满足最低样本后为 ready | 21 | 冲突视频不污染分区与标题特征 |
| 3 | 分区时长加权：以真实 watchMs 为基础 | 22 | 只有手动 UID 的新候选：保留候选，返回 missing |
| 4 | 分区占比归一化：已识别分区内部占比之和为 1 | 23 | 新候选不虚构内容：分区 / 标题 / 覆盖率均为无数据 |
| 5 | 缺失分区：归入未知桶，观看时长不丢弃 | 24 | ready / partial / missing 三种状态同时出现 |
| 6 | 字面「未知」分区：与缺失分区同样按未识别处理 | 25 | 空输入：结构完整、不抛异常 |
| 7 | 分区覆盖率：按观看时长计算，分母包含未知分区 | 26 | 异常记录：安全降级，不产生虚构特征 |
| 8 | 中文标题 bigram：相邻双字符 | 27 | 输入对象不可变 |
| 9 | 中英文数字混合标题：NFKC + 小写 + 连续段 bigram | 28 | 结果可 JSON 序列化往返，且分区名为 `__proto__` 时安全 |
| 10 | 标点和空白不跨段拼接词元 | 29 | 结果顺序稳定：与输入顺序无关，按 UID 升序 |
| 11 | 重复词元：词频累计，文档数只算一次 | 30 | 大量重复记录不会错误膨胀统计 |
| 12 | 缺失标题：不虚构文本特征，覆盖率为 0 | 31 | 支持 C2-2 `filterEligibleCandidates` 结果作为候选池 |
| 13 | 标题覆盖率：有效标题文档数 / 参与统计视频数 | 32 | 冲突候选的 C2-2 资格结论不被特征模块改变 |
| 14 | 同 BV 同日重复：只算一个视频，时长累加，词元不重复计数 | 33 | 超长标题被截断，词元数量有上限 |
| 15 | 同 BV 跨天：合并为一个视频，观看时长累加 | 34 | 空白 / 非字符串 / 控制字符 / 超长分区统一归入未知 |
| 16 | 同 BV 不同分 P：按同一视频合并，不重复计数 | 35 | 超大 / 非法 watchMs 安全处理 |
| 17 | 同 UID 改名：按 UID 聚合，昵称不参与身份判定 | 36 | 重复候选 UID 只输出一次，来源取并集 |
| 18 | 不同 UID 同名：特征严格分开，不按昵称混合 | 37 | 零观看时长视频不参与特征统计 |
| 19 | UID 缺失的旧记录：不凭昵称并入候选 | 38 | 阈值可覆盖，并随结果输出 |

---

## 10. 原有 143 项回归结果

**全部实际执行，退出码均为 0：**

| 套件 | 结果 | 退出码 |
|---|---|---:|
| `node test-candidate-quality.js` | 28/28 通过 | 0 |
| `node test-candidate-pool.js` | 33/33 通过 | 0 |
| `node test-interest-profile.js` | 24/24 通过 | 0 |
| `node test-uid.js` | 21/21 通过 | 0 |
| `node test-up-stats.js` | 17/17 通过 | 0 |
| `node test-stats.js` | 20/20 通过 | 0 |
| **合计** | **143/143 通过** | — |

加上新增 38 项，当前总计 **181/181 通过**。

---

## 11. 语法检查结果

以下检查均**已实际执行**，全部通过：

```text
node --check candidate-features.js
node --check test-candidate-features.js
node --check candidate-pool.js
node --check stats.js
node --check interest-profile.js
node --check storage.js
node --check test-candidate-quality.js
node --check test-candidate-pool.js
node --check test-interest-profile.js
node --check test-uid.js
node --check test-up-stats.js
node --check test-stats.js
node --check content.js
node --check popup.js
node --check dev-config.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"
```

共 15 个 JavaScript 文件语法通过，`manifest.json` JSON 解析通过。

> `node --check` 只验证语法，不代表运行通过；运行结果以上面的测试套件为准。

---

## 12. PowerShell 验收命令

在 `D:\Bili-Daily` 下执行：

```powershell
Set-Location D:\Bili-Daily

# 1) C2-3 新测试
node test-candidate-features.js
if ($LASTEXITCODE -ne 0) { throw "C2-3 tests failed" }

# 2) 原有六套回归
node test-candidate-quality.js
if ($LASTEXITCODE -ne 0) { throw "C2-2 tests failed" }
node test-candidate-pool.js
if ($LASTEXITCODE -ne 0) { throw "C2-1 tests failed" }
node test-interest-profile.js
if ($LASTEXITCODE -ne 0) { throw "interest-profile tests failed" }
node test-uid.js
if ($LASTEXITCODE -ne 0) { throw "uid tests failed" }
node test-up-stats.js
if ($LASTEXITCODE -ne 0) { throw "up-stats tests failed" }
node test-stats.js
if ($LASTEXITCODE -ne 0) { throw "stats tests failed" }

# 3) 语法检查
$files = @(
  "candidate-features.js", "test-candidate-features.js",
  "candidate-pool.js", "stats.js", "interest-profile.js", "storage.js",
  "test-candidate-quality.js", "test-candidate-pool.js",
  "test-interest-profile.js", "test-uid.js", "test-up-stats.js", "test-stats.js",
  "content.js", "popup.js", "dev-config.js"
)
foreach ($f in $files) {
  node --check $f
  if ($LASTEXITCODE -ne 0) { throw "syntax check failed: $f" }
}
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"
if ($LASTEXITCODE -ne 0) { throw "manifest.json invalid" }

Write-Host "ALL C2-3 CHECKS PASSED"
```

预期输出：C2-3 为 `38/38 通过`；六个既有套件分别为 28、33、24、21、17、20 项全通过；
最后打印 `ALL C2-3 CHECKS PASSED`。

---

## 13. 性能与稳定性观察

### 13.1 已执行的合成数据观察

**方法**：生成 90 天 × 每天 300 条 = 27,000 条记录、600 个 UID、12 个分区；
先用 C2-1 `buildFromRecords` 建立 600 个候选，再对
`buildCandidateFeatures(records, pool)` 连续运行 5 次，记录墙钟耗时。

**实际结果（Node.js v24.19.0，Windows 11）**：

```text
records = 27000
candidates = 600
featureCandidates = 600
timings = 184.4, 161.6, 177.5, 160.1, 156.1 ms
min = 156.1 ms
median = 161.6 ms
max = 184.4 ms
summary = ready 600 / partial 0 / missing 0，observedVideoCount 27000
```

这是**合成数据**上的单机观察，不是真实用户数据压测，也不代表浏览器环境耗时。
本报告没有编造任何未测得的数字。

### 13.2 稳定性措施

- 输入记录与候选池均不被修改；`cleanRecord` / `mergeByBvid` 返回新对象。
- `watchMs` 累加使用安全整数封顶，非法 / 负值 / `NaN` 安全降级。
- 超长标题先按 UTF-16 截断，再按码点截断；超长分区名提前拒绝。
- 词表与输出词元均有上限，避免异常数据造成无界内存增长。
- 结果可 JSON 序列化，不含 `Map` / `Set` / `undefined`。
- 所有排序都有确定的第二排序键，结果与输入顺序无关。
- 不使用 Node 专有运行时 API；模块只依赖 `globalThis` 和 `stats.js`。

---

## 14. 回滚方式

本阶段开始前已创建快照：

```text
D:\Bili-Daily\rollback\before-c2-3-features\
```

包含 10 个既有文件的原样副本和 `README.md`。C2-3 没有修改这些文件；
如需恢复或清理，在 `D:\Bili-Daily` 下执行：

```powershell
# 仅当既有文件被误改时恢复
Copy-Item rollback\before-c2-3-features\*.js . -Force

# 如需完全移除 C2-3 新增文件
Remove-Item candidate-features.js, test-candidate-features.js -ErrorAction SilentlyContinue
```

回滚不触碰 `chrome.storage.local`，也不会删除任何真实观看数据。
恢复后重新运行原有 143 项测试，应全部通过。

---

## 15. 已知限制与 C3 的数据需求

### 15.1 已知限制

1. **只做特征，不做排序**：没有 TF-IDF、余弦相似度、MMR、时间衰减或个性化评分。
2. **英文按字符 bigram**：`Hello` 会生成 `he` / `el` / `ll` / `lo`，
   不是完整单词；本阶段不引入分词器或词典。
3. **标题是词面特征**：无法识别同义词、语义或反讽；标题党、重复标题会直接反映在词频中。
4. **缺失 UID 的旧记录被排除**：这是身份安全策略的代价，可能损失部分老数据。
5. **冲突视频整体排除**：若冲突来自采集 bug，会损失该视频的全部特征；
   目前只在诊断中暴露，不做自动修复。
6. **覆盖率阈值是启发式**：2 个视频 / 5 分钟 / 50% 只是保守起点，
   尚未用真实分布校准。
7. **无真实数据验证**：本阶段禁止读写 `chrome.storage.local`，
   所有测试均为固定夹具；合成性能数字不代表真实规模。
8. **`featureStatus` 不是兴趣强度**：`ready` 只表示数据条件满足，
   不代表用户真的喜欢该 UP 主。
9. **分区与标题依赖记录字段**：如果记录本身缺失分区或标题，
   本模块不会从页面、API 或昵称反推。

### 15.2 C3 需要补齐的输入

- 明确的排序目标与评价口径（例如：回访概率、观看时长、分区多样性）。
- 真实数据上的特征分布抽样，用于校准覆盖率阈值与样本量阈值。
- 对冲突视频的人工 / 规则复核流程，决定是否可以恢复部分归属。
- 时间衰减、分区偏好、词元权重的设计文档与验收标准。
- 若要做语义特征，需要另行评审是否引入模型或词典；本阶段明确未引入。
- UI / 存储 / 新采集均未开始，需在 C3 或后续阶段单独评审。

---

## 结语

C2-3 已完成：新增纯函数特征模块与 38 项测试，原有 143 项测试继续通过，
语法检查通过，既有文件未被修改，回滚快照可用。

**本阶段到此停止，等待审核，不进入 C3。**
