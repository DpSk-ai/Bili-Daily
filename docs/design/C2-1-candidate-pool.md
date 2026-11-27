# C2-1：UP 主候选池数据模型与本地召回引擎（设计说明）

- **模块**：`candidate-pool.js`（`globalThis.BiliDailyCandidatePool`）
- **测试**：`test-candidate-pool.js`
- **阶段**：C2-1，纯函数，无 UI、无存储写入、无网络
- **依赖**：必须先加载 `stats.js`（复用其 UID 归一化、记录清洗与同 BV 合并规则）

---

## 1. 候选对象结构

```js
{
  upUid: "1001",              // 规范化 UID（字符串）。池中每条候选都必须有合法 UID
  upName: "UP甲",             // 展示昵称；没有可靠昵称时为空字符串
  sources: ["watched"],       // 来源集合，按固定顺序：watched → manual
  firstObservedAt: 1762776000000,  // 可靠观测时间（毫秒）；无法确认时为 null
  lastObservedAt: 1762776060000,
  watchedBefore: true,        // 本地是否存在该 UID 的观看记录
  candidateType: "returning", // returning / new / unknown
  uidVerified: true,          // 见第 3 节，含义有严格限制
  evidence: {
    uidFormatValid: true,     // UID 格式合法
    fromWatchHistory: true,   // 有本地观看记录作为身份证据
    fromUserInput: true,      // 有用户手动提供的来源
    onlineVerified: false,    // 恒为 false：本阶段没有在线核验
    watchedVideoCount: 2,     // 合并后的不同视频数（同一 BV 只算一次）
    watchedWatchMs: 120000,   // 这些视频的累计观看时长
    names: ["UP甲", "旧名"],  // 观察到的全部昵称，升序
    nameSource: "watch-history" // 展示昵称来自哪里：watch-history / manual / ""
  }
}
```

**刻意不包含的字段**：`partition`、`tags`、`videos`、`title`、`avatar`。
未观看过的候选没有任何本地内容特征，本阶段不虚构，也不为将来预留空壳字段。

---

## 2. UID 三条证据级别（必须区分）

| 级别 | 字段 | 含义 |
|---|---|---|
| 1. 格式合法 | `evidence.uidFormatValid` | 正整数、可安全表示、统一为字符串。**只说明格式对**。 |
| 2. 有可信来源 | `evidence.fromWatchHistory` / `fromUserInput` | 来自本地观看记录（由 content.js 从页面 `owner.mid` 采集），或来自用户手动输入。 |
| 3. 在线核实 | `evidence.onlineVerified` | **本阶段不存在此能力，恒为 `false`**。 |

## 3. `uidVerified` 的确切语义

```
uidVerified === true  ⇔  uidFormatValid && fromWatchHistory
```

即：**"UID 格式合法，且至少有一条本地观看记录把它记录为 upUid。"**

它**不表示**：

- 该账号已在哔哩哔哩在线核实；
- 该账号当前仍然存在、活跃或可访问；
- 该候选值得推荐，或推荐质量更高。

手动输入的 UID 永远是 `uidVerified: false`（格式通过 + 用户提供，未在线核验）。
任何代码都不得为了"看起来更好"把它改成 `true`；`onlineVerified` 在 C2-1 中恒为 `false`。

---

## 4. 两种候选来源

### A. 本地观看记录 `buildFromRecords(records)`

- 输入与 C1 完全一致：`{ version, days }` 或「日期 → 记录表」映射。
- 复用 `Stats.cleanRecord` 做字段清洗与 UID 归一化，复用 `Stats.mergeByBvid` 合并同一 BV。
- 只有带 UID 的记录成为候选；缺失 UID 的昵称记录只计数（`diagnostics.nameOnlyVideos`），
  不按昵称并入任何 UID 分组，不伪造 UID。
- 时间只取记录中可解析的 `startedAt` / `lastWatchedAt`；没有就留 `null`，
  不用日期键反推。
- 同一 BV 跨天重复只计一个视频；时长累加。

### B. 用户手动提供 `buildFromManual(list)`

- 接受 `"1001"`、`1001`、`{ upUid, upName?, observedAt? }`。
- 逐条校验：`not-object`、`missing-uid`、`invalid-uid`、`invalid-name`，
  统计写入 `diagnostics.rejectedReasons`，**不回显用户输入内容**。
- 时间非法时忽略该时间并计入 `diagnostics.invalidTimes`，候选本身保留。
- 不写存储、不联网、不校验账号真实存在。

---

## 5. 去重与合并规则（`mergePools`）

1. **身份只按 UID**：同 UID 合并；不同 UID 即使同名也保持分开。
2. `sources` 取并集，顺序固定为 `watched` → `manual`。
3. `watchedVideoCount` / `watchedWatchMs` 取各输入的**最大值**而不是求和，
   这样把同一个观看池重复合并不会把视频数翻倍。
4. `firstObservedAt` 取最早可靠值，`lastObservedAt` 取最晚可靠值；`null` 不参与比较。
5. 昵称选择规则（可解释、可复现）：
   1. 观看时长最多的昵称优先；
   2. 并列时来自观看记录的昵称优先于手动昵称；
   3. 仍并列时按码点升序取最小。
   `evidence.names` 保留全部观察到的昵称（升序），不丢失改名历史。
6. 不修改任何输入对象；返回的对象可 `JSON.stringify` 往返。

---

## 6. 候选分类

| 类型 | 条件 |
|---|---|
| `returning` | 本地存在该 UID 的观看记录（`watchedBefore === true`） |
| `new` | 无观看记录，但来源包含 `manual`（用户主动提供） |
| `unknown` | 无观看记录，且来源未声明（证据不足） |

`buildFromRecords` 只产出 `returning`，`buildFromManual` 只产出 `new`；
`unknown` 由 `mergePools` 接收调用方自行声明的候选时产生（例如未来新增的来源）。

---

## 7. API

| 函数 | 说明 |
|---|---|
| `buildFromRecords(records)` | 从本地观看记录构建候选池 |
| `buildFromManual(list)` | 从手动候选构建候选池 |
| `mergePools(pools)` | 合并多个池子 / 候选数组 |
| `getCandidate(pool, uid)` | 按 UID 查询，非法或不存在返回 `null` |
| `filterCandidates(pool, criteria)` | 按 `candidateType` / `source` / `watchedBefore` / `uidVerified` 筛选，返回新池 |
| `normalizeUid(value)` | 复用 stats.js 的 UID 规则 |

所有构建函数返回同一结构：

```js
{
  status: "ok" | "empty",
  reason: "" | "no-candidates",
  candidates: [...],          // 稳定排序：returning → new → unknown，再按 UID 数字序
  summary: {
    total, byType: { returning, new, unknown },
    bySource: { watched, manual }, uidVerified
  },
  diagnostics: { ... }        // 各来源不同的诊断字段
}
```

---

## 8. 诊断字段

`buildFromRecords`：

```js
{ inputKind, daysScanned, daysInvalid, recordsScanned, recordsInvalid,
  nameOnlyVideos, anonymousVideos, uidConflictVideos }
```

`buildFromManual`：

```js
{ inputKind, entries, accepted, rejected, duplicatesInInput, invalidTimes, rejectedReasons }
```

`mergePools`：

```js
{ inputKind, inputs, candidatesIn, candidatesInvalid, poolsWithoutCandidates }
```

`uidConflictVideos`：同一 BV 在历史记录里对应了不同 UID。此时候选按合并后的主 UID 计数，
另一个 UID 仍保留为候选但 `watchedVideoCount` 为 0 —— 不静默丢弃，也不猜测谁对。

---

## 9. 明确不做的事

- 不计算 TF-IDF、余弦相似度、时间衰减权重或 MMR（属于 C3）。
- 不做个性化排序，不产出"推荐分"。
- 不采集 DOM、不调用 B 站接口、不读 Cookie。
- 不写 `chrome.storage.local`，不新增存储键。
- 不修改 `interest-profile.js`、`stats.js`、`storage.js` 的既有口径。
- 不修改 `popup.*`、`manifest.json`、`content.js`。

---

## 10. 已知限制

1. UID 只来自本地记录或用户输入，**没有任何在线真实性校验**。
2. 新候选没有分区/标签特征，C3 的文本相似度只能依赖后续来源补充。
3. 昵称是"观测值"，不是账号当前名称；改名只体现在 `evidence.names`。
4. 缺少时间字段的老记录，候选时间为 `null`，下游排序不能据此做新鲜度计算。
5. 同一 BV 被记录成不同 UID 时，视频只按主 UID 计一次，另一个 UID 计数为 0。
6. 召回结果只代表"你接触过这个 UP 主"，不代表推荐质量。

---

## 11. C2-2 扩展（2026-11-11）

在**不改变** C2-1 既有字段与函数语义的前提下新增：

### 11.1 `evidence` 新增字段

| 字段 | 说明 |
|---|---|
| `conflictVideoCount` | 该 UID 涉及身份冲突的视频数，与 `watchedVideoCount` 分开统计 |
| `conflicts` | 冲突明细 `[{ otherUid, dateKey }]`，按日期 + UID 排序去重；不写入标题、昵称或原始记录 |
| `nameConflict` | 手动昵称与观看记录昵称不一致（仅提示，不参与身份判定） |

新增字段是**纯增量**：C2-1 的所有函数、`watchedBefore`、`candidateType`、UID 去重规则、
观看时长口径均未改变。唯一受影响的既有断言是 `test-candidate-pool.js` 中
"evidence 键集合严格比对"那条，已按严格方式补上三个新键。

### 11.2 新增函数

| 函数 | 返回 |
|---|---|
| `assessCandidateFreshness(candidate, { now, staleDays })` | `{ state: fresh\|stale\|unknown, ageDays, thresholdDays, reason, note }` |
| `assessCandidate(candidate, { now, staleDays })` | `{ eligibility, reasons, identityEvidence, hasUidConflict, stale, freshness, onlineVerified }` |
| `filterEligibleCandidates(pool, options)` | `{ eligible, review, excluded, summary, diagnostics }` |

### 11.3 资格规则

| 资格 | 条件 |
|---|---|
| `excluded` | 不是对象，或没有合法 UID |
| `review` | 身份冲突 / 仅手动来源 / 无来源证据 / 观察时间缺失、非法、未来 / 超过过期阈值 |
| `eligible` | 合法 UID + 观看历史证据 + 无冲突 + 新鲜度正常 |

昵称不一致（`nickname-mismatch`）只记 `info`，不改变资格。
`onlineVerified` 在所有输出中恒为 `false`，调用方自称的核验结果也会被忽略。

### 11.4 新鲜度阈值语义

- 默认 90 天，可注入 `staleDays` 覆盖。
- `ageDays > staleDays` 才是 `stale`；**恰好等于阈值仍为 `fresh`**。
- 缺少 / 非法 / 未来时间戳一律 `unknown`，绝不默认成新鲜。
- `stale` 只表示"本地很久没有观察到"，**不代表账号已注销**；候选保留在 `review`，不删除。
