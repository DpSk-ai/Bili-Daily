# Bili Daily C3-0：个性化推荐算法架构与离线评测设计

- 日期：2026-11-11
- 项目：Bili Daily（Edge Manifest V3 本地扩展）
- 阶段：C3-0（纯设计，**不写推荐排序代码**，不进入 C3-1）
- 对应验收报告：`docs/acceptance/C3-0/C3-0-research-report.md`
- 前置阶段：C1、C2-1、C2-2、C2-3、C2-4A、C2-4B 均已验收

---

## 0. 本文可信度声明

| 项目 | 状态 |
|---|---|
| 现有模块的输入输出、字段、统计单位 | **本次逐个读取源码核对**（见 §1 与附录 A） |
| 现有测试基线 | **本次实际执行**：8 个测试文件 `241/241` 通过，退出码全 0 |
| 推荐算法原理（TF-IDF / 余弦 / 衰减 / MMR） | 公开算法知识，自行设计实现（C 类，不移植代码） |
| 本项目上的推荐效果、准确率、耗时 | **没有任何实测**，本文不给任何效果数值 |
| 各权重、半衰期、λ、阈值 | **先验实验参数，不是调优结果** |

本文中所有"应达到/预计"的表述都是设计目标，不是已达成的事实。

---

## 1. 现有推荐数据模块的真实接口

> 不以 C2-0 调研草案为准，以下全部以**当前源码**为准，并标出与早期草案不一致的地方。

### 1.1 数据源与运行边界

`manifest.json`（已读取）：`permissions: ["storage"]`，content script 仅匹配
`https://www.bilibili.com/video/*`，加载 `storage.js` + `content.js`。

`biliDailyRecords` 结构（`stats.js` 头注释）：

```
{ version: 1, days: { "YYYY-MM-DD": { "BVxxxx": { bvid, page, title, upName, upUid,
  partition, videoDuration, watchMs, watchMsByHour, startedAt, lastWatchedAt, updatedAt } } } }
```

关键约束：日期键是**本地日历日**；同一 BV 跨天/多分 P 合并计一个视频；
时长只认真实 `watchMs`；有效观看阈值 `watchMs >= 30_000`。

### 1.2 五个模块的真实接口

| 模块 | 入口 | 输入 | 输出（关键字段） | 明确不做 |
|---|---|---|---|---|
| `stats.js` | `aggregateUps(videos)` / `cleanRecord` / `mergeByBvid` / `localDateKey` | 记录数组或单条记录 | UP 聚合项 `{upName, upUid, watchMs, effectiveWatchMs, videoCount, effectiveVideoCount}`；`unknown` 桶 | 不做推荐、不做特征 |
| `interest-profile.js` | `buildInterestProfile(records, {windows, endDate, now})` | `biliDailyRecords` 或 days | `{asOfDate, status, windows: {"7d","30d"}, comparisons, thresholds}`；窗口内含 `partitions[]`、`ups[]`、`partitionCoverage`、`topUp` | 不产出标题特征 |
| `candidate-pool.js` | `buildFromRecords` / `buildFromManual` / `mergePools` / `assessCandidate` / `filterEligibleCandidates` | records + 手动 UID | 候选 `{upUid, upName, sources, watchedBefore, candidateType, uidVerified, evidence:{watchedVideoCount, watchedWatchMs, fromWatchHistory, fromUserInput, onlineVerified:false, conflictVideoCount, conflicts, nameConflict, ...}}`；评估 `{eligibility, reasons[], identityEvidence, freshness:{state, ageDays, thresholdDays, lastObservedAt}}` | 不排序、不算相似度 |
| `candidate-features.js` | `buildCandidateFeatures(records, pool, {thresholds})` / `extractTitleBigrams(title)` | records + C2-1/C2-2 池 | 每候选 `{partitionFeatures:{partitions[], vector, unknown}, titleFeatures:{tokens[], uniqueTokenCount, totalTokenCount, documentCount}, partitionCoverage, partitionCoverageBasis:"watch-ms", titleCoverage, titleCoverageBasis:"video-count", featureStatus:"ready"|"partial"|"missing", featureReasons[]}` | 不生成推荐分 |
| `candidate-content-import.js` | `parseCandidateContentImport` / `buildCandidateContentEvidence` / `assessImportedContentCandidates` | 导入 JSON + records | sidecar `{status, candidates:[{upUid, upName, provenance:"user-provided", lane:"exploration", videos[], partitionCounts[], titleTokens[], titleTokenStats, partitionCoverage, titleCoverage, contentStatus, promotion?}]}`；评估 `{candidates:[{freshness, identityEvidence:{onlineVerified:false, crossSourceConflictVideoCount,...}, contentEvidence, promotion:{eligibleForExploration, reasons[]}}]}` | 不写存储、不联网、不生成正式 UI |

### 1.3 三种特征口径的差异（**最容易踩坑的地方**）

| 字段 | 模块 | 分子 / 分母 | 单位 |
|---|---|---|---|
| `windows["30d"].partitions[].share` | C1 | 该分区观看时长 / **窗口总观看时长（含"未知"）** | 毫秒 |
| `partitionFeatures.partitions[].shareOfIdentified` | C2-3 | 该分区观看时长 / **已识别分区观看时长** | 毫秒 |
| `partitionCounts[].shareOfImportedVideos` | C2-4B | 该分区可用视频数 / **可用视频数** | 视频个数 |
| `partitionCoverage`（C2-3） | C2-3 | 已识别分区观看时长 / 观察到的观看时长 | 毫秒 |
| `partitionCoverage`（C2-4B） | C2-4B | 有分区的可用视频数 / 可用视频数 | 视频个数 |
| `titleCoverage`（C2-3） | C2-3 | 能产出 bigram 的视频数 / `observedVideoCount` | 视频个数 |
| `titleCoverage`（C2-4B） | C2-4B | 有标题的可用视频数 / 可用视频数 | 视频个数 |

**结论（设计约束）**：

1. 分区向量的两个主要来源（C1 / C2-3）都是**观看时长口径**，可以互相比较；
2. C2-4B 的分区分布是**视频个数口径**，只能用于 exploration lane 内部，
   不得与 C2-3 的 `shareOfIdentified` 拼进同一向量；
3. 覆盖率阈值不可跨模块直接比较（C2-3 默认 0.5，C2-4B 默认 0.6，且单位不同）；
4. 任何"分区相似度"输出都必须带 `basis` 字段说明口径。

### 1.4 身份与可信度语义（不得误读）

| 字段 | 真实含义 | 不表示 |
|---|---|---|
| `uidVerified`（C2-1） | UID 格式合法 + 本地观看记录中存在该 UID | 平台核验、账号仍存在 |
| `onlineVerified`（全部模块） | **恒为 false**，代码中写死 | 任何在线校验能力 |
| `candidateType: returning` | 本地有观看记录 | 用户仍然喜欢 |
| `candidateType: new` | 仅用户手动输入 | 插件自动发现的陌生 UP 主 |
| `featureStatus: ready/partial` | 技术数据条件达标 | 推荐质量好 |
| `promotion.eligibleForExploration` | 满足本地探索通道技术准入 | 账号真实、平台认证、推荐有效 |
| `contentStatus: complete` | 导入视频的元数据完整 | 内容经过核验 |

### 1.5 当前可用数据量（来自既有文档，非本次重新采集）

C1 验收与 C2-0 调研记录：**4 个有效视频、8.9 分钟、1 个有效观看日**，画像 `insufficient`。
本次未重新读取用户真实观看记录（C3-0 不接触 `chrome.storage`），该数字只作为
"当前阶段不足以做效果评测"的依据，不作为任何指标。

---

## 2. 总体架构

### 2.1 分层

```
biliDailyRecords (chrome.storage.local, 只读)
   │
   ├─[C1] buildInterestProfile ──► 分区画像 / UP 聚合 / 覆盖率 / 状态
   ├─[C2-1] buildFromRecords ────► 候选池（returning / new）
   │      └─[C2-2] assessCandidate ─► eligible / review / excluded + freshness
   ├─[C2-3] buildCandidateFeatures ► 分区向量（watch-ms）+ 标题 tokens（视频数）
   │
   └─[C2-4B] 导入文档 ─► sidecar ─► 评估 ─► eligibleForExploration
                                    （provenance=user-provided, onlineVerified=false）

                    ▼
   [C3-1] 特征向量化与相似度（纯函数）        ← 本阶段设计，未实现
                    ▼
   [C3-2] 时间衰减 / 冷启动降级
                    ▼
   [C3-3] 双通道排序 + MMR + 融合去重
                    ▼
   [C3-*] 解释生成 ─► 排序结果（含来源标签）
                    ▼
   [C3-5] popup 展示（未来）
```

### 2.2 三条不可违反的边界

1. **不合并两条 lane 的原始分**：main lane 与 exploration lane 分别打分、分别排序，
   只在配额层面合并。原因：两者的证据强度不同，直接相加会让"用户自己导入的 UP 主"
   与"真实看过的 UP 主"在数值上不可区分。
2. **导入内容不是观看行为**：exploration lane 不使用任何 `watchMs` 权重，
   也不写入 `biliDailyRecords`。
3. **身份冲突优先于内容完整**：任一 lane 中 `hasUidConflict` 或
   `crossSourceConflictVideoCount > 0` 的候选都不进入排序，内容再完整也不行。

---

## 3. C3-1：内容匹配算法

### 3.1 两个特征空间，永不拼接

| 空间 | 维度 | 来源 | 相似度 |
|---|---|---|---|
| 分区空间 `P` | 分区名（字符串键） | C1 `windows["30d"].partitions[]` / C2-3 `partitionFeatures.vector` / C2-4B `partitionCounts[]` | 余弦 |
| 文本空间 `T` | 中文标题字符 bigram | C2-3 `titleFeatures.tokens[]` / C2-4B `titleTokens[]`，用户侧由 C3 从记录现算 | TF-IDF + 余弦 |

分区与文本**分别算相似度，再在打分层按权重合成**；绝不把两种量纲拼成一个长向量。
拼成一条向量会让 200 维文本淹没 10 维分区，且无法解释"是因为分区还是因为标题"。

### 3.2 用户向量

#### 3.2.1 分区向量 `u_P`

来源：C1 `windows["30d"]`（可配置窗口）。**不使用** `partitions[].share` 的原始分母，
因为该分母包含"未知"桶。构造：

```
对每个已识别分区 p：
    u_P[p] = Σ_{r∈R, r.partition=p, r 已识别} cw(r) / Σ_{r∈R, r 已识别} cw(r)
其中 cw(r) = decay(age(r)) × durationWeight(r.watchMs)
```

- `R` = 窗口内 `watchMs > 0` 的记录（先按 BV 合并，复用 `stats.mergeByBvid`）；
- "未知"分区**不进入向量维度**，但仍在覆盖率分母里；
- 若已识别记录集合为空 → `u_P = null`（不是全 0 向量）。

**为什么不让 C1 直接给现成向量**：C1 的 `share` 分母含未知桶、且没有时间衰减，
而 C3-2 要求连续衰减。C3 复用 C1 的**视频选择与身份口径**，但自行累加权重，
不改动 C1 输出。两者对"哪些视频算数"的规则完全一致。

#### 3.2.2 文本词频 `tf_u`

C1 **不产出标题特征**（`interest-profile.js` 只做分区/UP/时段），因此用户文本向量
必须由 C3 从记录现算：

```
tf_u[t] = Σ_{r∈R} cw(r) × count(r.title, t)
count 由 Features.extractTitleBigrams(r.title) 统计，token 为字符 bigram
```

- 复用 C2-3 的 `extractTitleBigrams`，保证与候选侧**同一套归一化**（NFKC、小写、
  只在字母/数字连续段内连接、单字符段不产词元）；
- 不做分词、不做同义词、**不假设任何语义理解**：`"科技"` 与 `"数码"` 只有在字面
  bigram 重合时才算相关。

### 3.3 候选向量

#### 3.3.1 main lane（来自 C2-3）

```
c_P[p] = partitionFeatures.partitions[].shareOfIdentified     // 已排除「未知」
tf_c[t] = titleFeatures.tokens[].count                         // 跨视频累计出现次数
```

`titleFeatures.tokens[].count` 是**总出现次数**，`documentCount` 是该候选有多少个视频
含该词元——两者不可混用：TF 用 `count`，IDF 的文档频次 `df` 用**候选级**的"是否含该词元"。

#### 3.3.2 exploration lane（来自 C2-4B）

```
c_P[p] = partitionCounts[].shareOfImportedVideos               // 视频个数口径
tf_c[t] = titleTokens[].count
```

该向量只在 exploration lane 内部使用；其 `basis: "video-count"` 必须随结果输出。

### 3.4 TF 的定义

- 原始 TF：`tf(t, d)` = 词元 t 在文档 d 中的出现次数；
- 采用**次线性**变换：`tf'(t, d) = 1 + ln(tf(t, d))`（`tf = 0` 时不产生该项）；
- 文档 d 的定义：候选侧 = 一个 UP 主（其全部可用视频的标题合并）；
  用户侧 = 用户在该窗口内的全部观看视频标题合并；
- 次线性的理由：单个标题重复出现不应线性放大权重；该选择是实验参数，可关闭对比。

### 3.5 IDF 的定义、平滑与语料范围（防泄漏）

#### 3.5.1 公式

```
idf(t) = ln( (N + 1) / (df(t) + 1) ) + 1
```

- `N` = 语料中文档数（**只统计至少含一个词元的文档**）；
- `df(t)` = 含词元 t 的文档数（候选级，不是视频级）；
- 加 1 平滑保证：`df = 0` 时 `idf = ln(N+1)+1 > 0`，`N = 1` 时不除零、不出现 0 权重；
- 该式恒大于 0，不会产生负权重。

#### 3.5.2 语料范围

| lane | IDF 语料 | 说明 |
|---|---|---|
| main | **当前 main lane 候选池中的候选文档** | 不包含用户文档，不包含观看记录 |
| exploration | **当前 exploration lane 候选文档** | 与 main 语料分离 |

**为什么分开**：两条 lane 的候选来源、数量级、可信度都不同。合并语料会让
`idf` 依赖"用户今天导入了多少东西"，同一候选的分数随无关导入内容变化。

**为什么用户文档不进语料**：用户的观看历史长度变化不应改变候选侧权重；
用户侧词元若不在语料中，按 `df = 0` 取平滑值（其候选侧权重为 0，只影响用户向量范数）。

#### 3.5.3 防泄漏规则（离线评测时强制）

1. 以切分点 `T` 为界，`idf` **只能**用 `T` 之前的候选文档计算；
2. 评测段（`T` 之后）出现的新候选不得参与 `idf` 统计，只能用冻结的 `idf`，
   未登录词按 `df = 0` 平滑；
3. 用户向量只能用 `T` 之前的记录；
4. 候选池的"存在性"也必须来自 `T` 之前已知的数据（避免用未来才知道的候选做召回）。

### 3.6 余弦相似度与零分母

```
cos(u, c) = Σ_i u_i·c_i / (||u||₂ · ||c||₂)
```

| 情况 | 处理 | 输出 |
|---|---|---|
| `‖u‖ = 0` 或 `‖c‖ = 0` | 不计算 | `similarity = null` |
| 两侧都为空 | 组件不可用 | `null` |
| 仅有单维重合但范数正常 | 正常计算 | `0..1` |

**必须区分 `0` 与 `null`**：

- `0` 表示"测过了，确实不相似"；
- `null` 表示"没数据，无法判断"。

若把 `null` 当 0，会让"数据缺失"被误判为"完全不相关"，进而错误压低候选分数。
这是 C3-1 的核心单测点之一。

### 3.7 未知分区

- C1 的「未知」桶与 C2-3 的 `unknown` 桶**都不进入向量维度**；
- 不把「未知」当作一个可以互相匹配的"分区"（否则"两个都不知道分区"会算作高相似）；
- 「未知」仍保留在覆盖率分母中，用于降低可靠性权重；
- 若某候选全部分区未知，`c_P` 为空 → 分区相似度 `null`，由文本组件承担评分。

### 3.8 覆盖率 → 可靠性权重

相似度本身不表达"这个分数有多可信"。设计两层：

```
r_P = coveragePartition === null ? 0 : clamp(coveragePartition / 0.8, 0.25, 1)
r_T = coverageTitle     === null ? 0 : clamp(coverageTitle     / 0.8, 0.25, 1)
```

- `coveragePartition` 在 main lane 取 C2-3 的 `partitionCoverage`（watch-ms），
  在 exploration lane 取 C2-4B 的 `partitionCoverage`（video-count）；
- `coverageTitle` 同理，两处都是 video-count；
- 0.8 / 0.25 是**实验参数**，不是最优值；
- 可靠性进入打分时**乘在相似度上**，并同时作为结果的 `confidence` 输出字段，
  使用户能看到"为什么这条分数低是因为数据不够"。

### 3.9 打分合成

只对**可用**（非 `null`）的组件加权，并在可用组件上重新归一化：

```
S = Σ_{i∈可用} w_i · r_i · s_i / Σ_{i∈可用} w_i · r_i
```

main lane 默认权重（先验）：

| 组件 | 含义 | w |
|---|---|---|
| `S_part` | 分区余弦 | 0.45 |
| `S_text` | 标题 TF-IDF 余弦 | 0.25 |
| `S_fam` | 熟悉度 | 0.20 |
| `S_rec` | 近期性 | 0.10 |

```
S_fam = min(1, watchedWatchMs / 30天窗口 effectiveWatchMs)
S_rec = 0.5 ^ (ageDays(lastObservedAt) / 30)
```

exploration lane 默认权重（先验，**不含观看时长**）：

| 组件 | 含义 | w |
|---|---|---|
| `S_part` | 分区余弦（video-count 口径） | 0.45 |
| `S_text` | 标题 TF-IDF 余弦 | 0.35 |
| `S_complete` | 内容完整度 | 0.20 |

```
S_complete = 0.5 × partitionCoverage + 0.5 × titleCoverage   // 均为 C2-4B 视频数口径
```

**不设"总分 = main + exploration"**；两条 lane 的 `S` 只在各自内部比较。

### 3.10 降级矩阵

| 条件 | 行为 |
|---|---|
| 用户有效视频 = 0 或画像 `empty` | 不产出推荐；返回 `reason: "no-history"` |
| 画像 `insufficient` | 只输出 main lane 的"回访列表"，按 `S_fam`/`S_rec` 排序；**不做相似度**、不叫"猜你喜欢" |
| 用户文本向量为空 | 关闭文本组件，权重在剩余组件上重新归一化 |
| 候选文本向量为空 | 同上，该候选 `S_text = null` |
| 某候选分区/文本都为空 | `S = null`，进入 `insufficient-features` 分组，不参与排序 |
| 全部候选都 `null` | 返回空列表 + 结构化原因，不填充虚构项 |
| 候选池 < 20 | 关闭 IDF（`idf ≡ 1`），退化为次线性 TF 的余弦 |
| 候选池 < 5 | 关闭文本组件，只按分区 + 熟悉度排序 |

### 3.11 小候选池为什么必须关 IDF

`idf` 的方差随 `N` 增大而收敛；`N` 很小时，一个候选是否包含某个词元会让 `df` 从 1 跳到 2，
权重剧烈摆动。候选池 < 20 时 `idf` 的排序贡献不稳定，因此退化为二值/次线性 TF。
这不是近似"更好"，而是**在数据不足时选择更少假设**。

### 3.12 不同口径不可混算（强制规则）

1. 任何向量对象带 `basis` 字段：`"watch-ms"` 或 `"video-count"`；
2. 余弦计算前断言两侧 `basis` 一致（main lane 内部两侧都是 watch-ms；
   exploration lane 内部两侧都是 video-count）；
3. 用户向量一律是 watch-ms 口径；因此 **exploration lane 的分区余弦必须显式标注
   "用户侧 watch-ms × 候选侧 video-count"**，属于**跨口径近似**，在结果中以
   `confidence: "low"` 降级，并且不得用于跨 lane 比较；
4. 覆盖率阈值不跨模块比较（C2-3 0.5 / C2-4B 0.6 各用各的）。

> 第 3 点无法完全消除，因为用户侧只有观看时长、导入侧只有视频个数。
> 诚实做法是**承认近似并降级**，而不是假装两者同口径。

---

## 4. C3-2：时间衰减与冷启动

### 4.1 衰减函数

```
decay(ageDays) = 0.5 ^ (ageDays / H)          H 默认 14 天（实验值）
ageDays        = (now - observationTime) / 86400000
```

- `now` **必须由调用方注入**（`options.now`），默认不读系统时钟，保证测试可复现；
- `ageDays < 0`（未来记录）→ 权重按 0 处理并计数，不参与向量，不"假装新鲜"；
- `ageDays > 6H`（默认 84 天）→ 权重 < 1/64，直接丢弃（性能与噪声双重要求）；
- 半衰期是实验参数，C3-4 需要用 B/M 对比决定，**不预设 14 天为最优**。

### 4.2 观察时间取哪个字段

记录以日期键存储，可能缺 `startedAt` / `lastWatchedAt`：

| 情况 | 使用的观察时间 |
|---|---|
| 有合法 `lastWatchedAt` | 该时间戳 |
| 只有日期键 | 该日期键的**本地日 12:00**（约定值，避免跨日边界抖动） |
| 日期键非法且无时间戳 | 该记录不进入衰减向量，计入 `untimedRecords` |

> 不用 `updatedAt` 作为观看时间：它可能因数据修复而变化，不代表观看行为发生时间。

### 4.3 观看时长权重

```
durationWeight(watchMs) = watchMs < 30000 ? 0
                        : min(1, watchMs / 300000)      // 5 分钟封顶
```

- 30 秒以下本就不是"有效观看"（与 `stats.EFFECTIVE_WATCH_MS` 一致）；
- 5 分钟封顶避免长视频循环播放主导向量；
- **不使用 `videoDuration` 做归一化**：该字段缺失率高，且 C1/C2 的既有口径也不使用它；
- 权重与衰减相乘得到 `cw(r)`，见 §3.2。

### 4.4 冷启动与数据不足

| 数据状态 | 策略 |
|---|---|
| 0 个有效视频 / 画像 `empty` | 不推荐，文案"继续观看以生成推荐" |
| 1–4 个有效视频 / `insufficient` | 回访列表（按 `S_fam` + `S_rec`），无相似度、无 MMR |
| 5–49 个有效视频 | 允许 main lane 相似度；`idf` 在小池下关闭；结果标注 `confidence: low` |
| ≥ 50 个有效视频且 ≥ 10 个 UP 主 | 允许完整排序 + 离线评测（与 C2-0 的结论一致） |
| 无文本特征 | 分区 + 熟悉度；解释中不出现"标题相关" |
| 无分区特征 | 文本 + 熟悉度；解释中不出现"分区匹配" |

**已观看候选 vs 新候选**：

- main lane 按定义都是"看过的 UP 主"，其作用是**回访**；
- 对刚看过（`ageDays < 1`）的候选加轻微抑制（`S_rec` 低），避免推荐列表变成
  "最近观看复制"；
- exploration lane 全部是**未看过的 UID**（若同一 UID 已在 main lane，按 §6 去重），
  不设"已看过"抑制，但也不享受任何观看时长加成。

### 4.5 禁止事项

- 不得用评测期（未来）的数据构建评测点之前的向量——见 §8.3；
- 不得把 C2-4B 导入视频计入 `watchMs`、熟悉度、近期性或有效观看数；
- 不得在没有时间戳时用"当前位置/当前时间"冒充观看时间。

---

## 5. C3-3：MMR 多样性与重排序

### 5.1 原始相关性

每个 lane 内部完成 §3.9 的打分与排序后，得到 `rel(c) ∈ [0,1]`（不可用组件已重归一化）。
MMR 只在 **Top N' = min(2K, N)** 上运行，避免为多样性牺牲长尾之外的相关性。

### 5.2 候选间相似度

```
sim(c_i, c_j) = ( w_P · s_P(i,j) + w_T · s_T(i,j) ) / (w_P + w_T)   // 只计可用组件
w_P = 0.6, w_T = 0.4
```

- `s_P`：两候选分区向量的余弦（同一 lane 内，口径一致）；
- `s_T`：两候选 TF-IDF 向量的余弦（复用同一 `idf`）；
- 任一侧向量为空 → 该组件 `null` 并按可用组件重新归一化；
- 两个组件都不可用 → `sim = 0`（**没有证据不等于相似**，不应因此惩罚）。

### 5.3 MMR 递推

```
S = []
while |S| < K and 还有候选:
    c* = argmax_{c ∉ S} [ λ·rel(c) − (1−λ)·max_{d∈S} sim(c, d) ]
    S.append(c*)
```

- `λ` 默认 `0.7`，可配置，**仅作实验参数**；C3-4 需要对比 0.5 / 0.7 / 0.9；
- `λ = 1` 退化为纯相关性排序，用于消融对比；
- 首个候选（`S` 为空）取 `rel` 最大者。

### 5.4 减少同分区重复

两条措施叠加：

1. **软约束**：MMR 的 `sim` 中分区余弦占 0.6 权重，同分区候选会被自然推后；
2. **硬约束（可选，默认关闭）**：`maxPerPartition = 2`，按候选的主导分区
   （`argmax c_P`）计数，超过上限的候选在 top-K 中跳过。
   硬约束可能导致列表不满，需按 §5.6 降级。

### 5.5 避免过度牺牲相关性

- MMR 只在 Top `2K` 内进行，最坏情况不会把低相关候选提到高位；
- 设相关性下限：`rel(c) < 0.5 × rel(top1)` 的候选不参与 MMR（直接沉底）；
- 输出结果附带 `relevance` 与 `diversityPenalty` 两个字段，便于审计"为什么排这里"。

### 5.6 推荐数量不足

| 情况 | 行为 |
|---|---|
| `N < K` | 返回全部，标注 `truncated: true` |
| 硬约束导致不足 | 先放宽硬约束补足，仍不足则返回现有数量 |
| 某 lane 不足配额 | 剩余配额按 §6.3 归还给另一 lane |
| 两条 lane 都为空 | 返回空列表 + 原因，不填充占位项 |

### 5.7 稳定性与可复现

- 全部比较使用确定性并列规则：`rel` 降序 → `upUid` 码点升序；
- MMR 中 `max sim` 与 `argmax` 均使用同一并列规则；
- 不使用随机数、不使用 `Date.now()`（时间由 `now` 注入）；
- 输入顺序被打乱后，输出必须逐项一致（对应 C2-4B 测试 47 的同型约束）；
- 浮点比较使用固定精度（例如 `1e-9`）后再比较，避免累加顺序造成抖动。

---

## 6. 双通道融合

### 6.1 main lane 准入

全部满足才进入：

1. C2-2 `assessCandidate().eligibility === "eligible"`；
2. C2-3 `featureStatus ∈ {ready, partial}`（`missing` 的候选无法计算相似度）；
3. `hasUidConflict === false`，且 C2-3 `conflictVideoCount === 0`；
4. `freshness.state` 不为 `stale` / `unknown`（C2-2 已把这两种降为 review）；
5. 来源含 `watched`。

### 6.2 exploration lane 准入

全部满足才进入：

1. C2-4B `promotion.eligibleForExploration === true`；
2. `provenance === "user-provided"`；`onlineVerified === false`；
3. `crossSourceConflictVideoCount === 0` 且 `identityEvidence.hasIdentityConflict === false`；
4. `contentStatus ∈ {complete, partial}`（`missing` 无法打分）；
5. 该 UID **不在** main lane 的任何候选中（见 §6.4）。

### 6.3 配额与合并

```
K            = 5（默认，popup 空间约束）
exploreRatio = 0.2（实验值）
equota       = min(K-1, floor(K × exploreRatio))      // K=5 → 1
mquota       = K − equota
```

- 先排 main lane 取 `mquota`，再排 exploration lane 取 `equota`；
- 若某条 lane 可用数量不足，**空闲配额让给另一条**，但 exploration 总量不超过
  `ceil(K × 0.4)`，防止探索项反客为主；
- 合并顺序：main 结果在前、exploration 结果在后（**位置固定**，不随机穿插），
  每条结果带 `lane` 字段；UI 必须分组或加标签展示。

### 6.4 同一 UID 跨通道去重

| 情况 | 规则 |
|---|---|
| UID 在 main lane 可排序，同时在 exploration lane 可排序 | **保留 main**，丢弃 exploration 条目，计数 `laneDuplicateDropped` |
| UID 在 main lane 但为 `review/excluded`，在 exploration 可排序 | **两条都不出**（身份/资格问题不因换通道而绕过），计数 `blockedByMainEligibility` |
| 同一 UID 在两条 lane 都不满足准入 | 不出现 |
| 两条 lane 都有但 UID 规范化后相同（`"001001"` vs `1001`） | 按 C2-1 `normalizeUid` 规范化后再比较 |

**不允许**把同一 UID 的两个分数相加、取平均或"取高者"当作合并——来源不同，
分数不可比；只能按身份证据强度选择一条通道。

### 6.5 exploration lane 的展示约束

- 必须显示"来源于你主动导入的候选资料"；
- 必须显示"本地未观看过"（若属实）；
- **不得**显示"已认证""官方推荐""为你精选的陌生 UP 主"等未经验证或误导性措辞；
- 该 lane 可一键关闭（未来 UI 开关），关闭后不影响 main lane 结果。

---

## 7. 推荐解释与透明度

每条推荐返回结构化 `reasons[]`，每项含 `code`、`level`、`message`、`evidence`。
`evidence` 必须是**实际存在的字段路径与取值**，不是模板填充。

### 7.1 允许的解释（附数据来源）

| code | 文案模板 | evidence 来源 |
|---|---|---|
| `partition-match` | 「你近 30 天有 {pct}% 的观看时长在「{分区}」，该 UP 主的内容也以该分区为主」 | C1 `windows["30d"].partitions[]` + C2-3 `partitions[]` / C2-4B `partitionCounts[]` |
| `title-match` | 「标题共同出现的用词：{top 3 词元}」 | 用户 ∩ 候选 TF-IDF 向量，取乘积最大且实际存在于两侧的词元 |
| `watched-before` | 「你在本地记录中看过该 UP 主 {n} 个视频，累计 {m} 分钟」 | C2-1 `evidence.watchedVideoCount` / `watchedWatchMs` |
| `recently-watched` | 「最近一次观看在 {d} 天前」 | C2-2 `freshness.ageDays` |
| `user-imported` | 「该候选来自你主动导入的候选资料，共 {n} 个视频；本地未观看过；未经平台核验」 | C2-4B `provenance` / `importedVideoCount` / `onlineVerified:false` |
| `low-coverage` | 「该候选仅有 {pct}% 的视频有分区信息，匹配可靠性较低」 | C2-3/C2-4B `partitionCoverage` |
| `no-text` | 「该候选没有可用标题，未参与标题匹配」 | `titleCoverage === null` / `titleTokens.length === 0` |
| `conflict-excluded` | 「{n} 个视频的身份归属存在冲突，已排除，不参与推荐」 | `conflictVideoCount` / `crossSourceConflictVideoCount` |

### 7.2 禁止的解释

| 禁止 | 原因 |
|---|---|
| 「根据你的喜好，你可能喜欢…」但无任何分区/词元证据 | 虚构用户偏好 |
| 给 UP 主贴「科技博主」「二次元」等标签 | 本地没有标签数据，只有分区与标题 |
| 「已通过 B 站认证」「官方推荐」 | `onlineVerified` 恒为 false，无核验能力 |
| 「推荐准确率提升 X%」 | 无实测，且离线指标≠线上效果 |
| 「发现了一个你可能没见过的 UP 主」用于用户导入项 | 来源是用户自己提供的，不能伪装成插件发现 |
| 引用不存在视频的标题 | 只能使用 sidecar / C2-3 中真实存在的 token 与计数 |

### 7.3 解释的可测试性

- 每条 `code` 必须能在 fixture 中构造出"数据缺失 → 该理由不出现"的用例；
- `message` 中的百分比、天数、条数必须来自 `evidence` 中的数值，而不是另行计算；
- 单元测试对每条理由做"字段缺失则不生成"的断言。

---

## 8. 离线评测设计

### 8.1 对比方案

| 编号 | 方案 | 输入要求 | 优势 | 局限 |
|---|---|---|---|---|
| B0 | 固定顺序基线（按 `upUid` 升序） | 候选池 | 最弱基线，检验评测流程本身是否有偏差 | 无任何个性 |
| B1 | 分区匹配（仅 `S_part`） | C1 + C2-3 | 可解释、稳定、冷启动友好 | 忽略标题，同分区内无法区分 |
| M1 | 分区 + 标题余弦（无 IDF，次线性 TF） | + 标题 tokens | 小候选池下更稳 | 常用词权重过高 |
| M2 | M1 + TF-IDF | 候选池 ≥ 20 | 稀有词区分度好 | 小池不稳定、需要防泄漏 |
| M3 | M2 + 时间衰减 | 记录时间戳 | 反映兴趣漂移 | 半衰期需调参 |
| M4 | M3 + MMR | 候选 ≥ K | 列表多样性提升 | 相关性可能下降，λ 敏感 |

每条方案都必须输出同一套指标，且评测脚本必须把"当前参数"写入结果文件。

### 8.2 指标定义

```
Precision@K = |TopK ∩ R| / K
Recall@K    = |TopK ∩ R| / |R|
HitRate@K   = 1[|TopK ∩ R| > 0]
NDCG@K      = DCG@K / IDCG@K,  rel_i ∈ {0,1}
Coverage    = |⋃ TopK over folds| / |候选池|
IntraListSim= 1 / (K(K−1)/2) × Σ_{i<j} sim(c_i, c_j)
Stability   = Jaccard(TopK_顺序A, TopK_顺序B) 与 Spearman 相关系数
Latency     = performance.now() 差值（p50 / p95 / max）
```

`R` = 评测窗口内实际发生的"有效观看 UP 主集合"。

### 8.3 标签的诚实界定

**这是本次设计最重要的限制**：

- `R` 只是"用户在评测期实际看了什么"，**不是"用户喜欢什么"**；
- 没有负反馈（划走、不喜欢），因此 Precision 会被"没看到但可能喜欢"的候选低估；
- 因此离线指标只能回答"推荐与未来行为的一致程度"，**不能**回答"推荐是否准确"；
- 任何报告不得把离线指标写成"推荐准确率"或"效果提升"。

### 8.4 时间切分与防泄漏

```
切分点 T：最近 7 天为测试段，T 之前 30 天为训练段；
滚动：每次向前平移 7 天，多折（fold）重复，报告均值与方差。
```

硬性规则：

1. 用户向量只用 `≤ T` 的记录；
2. 候选池只用 `≤ T` 已知的数据（`firstObservedAt` / `observedAt` 不晚于 T）；
3. `idf` 用训练段候选语料冻结，测试段新词按 `df = 0` 处理；
4. 测试段新出现的候选**不进入** TopK（否则等于用未来信息做召回）；
5. 每折独立重算，不跨折共享统计量。

### 8.5 四层评测必须分开写

| 层 | 名称 | 现在能否执行 | 说明 |
|---|---|---|---|
| L1 | 算法正确性测试 | **能**（C3-1 起） | 手算 fixture：余弦、TF-IDF、衰减、MMR 的确定值 |
| L2 | 合成数据实验 | **能**（C3-4 起） | 构造已知真值的候选/历史，验证排序方向与降级行为 |
| L3 | 真实历史离线评测 | **不能**（数据不足） | 需 ≥ 50 个有效视频、≥ 10 个 UP 主、≥ 14 个有效观看日 |
| L4 | 用户实际反馈评测 | **不能**（无 UI、无反馈机制） | 需 C3-5 的 UI + 显式反馈，且需用户同意 |

报告中必须逐层标注，**禁止把 L1/L2 的通过写成"推荐效果好"**。

### 8.6 评测结果的不确定性

- 单用户样本，指标方差大；必须报告折数与样本量；
- 数据量极小时 B0 常常打败复杂方法，这是正常现象，不是 bug；
- `K` 增大时 Recall 必然上升，跨方案比较必须固定 `K`；
- MMR 的多样性提升与相关性下降必须同时报告，不能只报一边。

---

## 9. 性能与运行限制

### 9.1 硬约束

- 纯 JavaScript，无框架、无 npm 运行时依赖；
- 不访问 Cookie、不调用 B 站 API、不新增权限；
- 计算在主线程会阻塞 UI，必须分片；
- `chrome.storage.local` 未申请 `unlimitedStorage`，缓存需限量。

### 9.2 复杂度与上限

| 阶段 | 复杂度 | 上限（沿用现有模块） |
|---|---|---|
| 向量构建 | O(候选数 × 词元数) | 候选 ≤ 500（C2-4B `maxCandidates`）、单候选词元 ≤ 4000、输出 ≤ 2000 |
| IDF | O(词元数) | 同上 |
| 打分 | O(N × D) | D 为并集维度 |
| MMR | O(K² × N') | N' = min(2K, N) |

### 9.3 避免阻塞 popup

- 只在 popup 打开时计算，不放入 content script；
- 单次同步计算预算目标 **< 50 ms**（设计目标，未实测）；
- 超出预算时按 `requestIdleCallback` / `setTimeout(0)` 分片，先出 main lane；
- 结果按 `(画像版本, 候选池哈希, 参数哈希)` 缓存，避免重复计算；
- 缓存体积上限与失效策略必须显式定义（建议只缓存 Top 20 结果，不缓存全量向量）。

### 9.4 性能测试方法（尚无数据）

1. 用合成 fixture 生成 50 / 200 / 500 个候选，词元规模 20 / 200 / 800；
2. 每个规模预热 5 次，正式测量 30 次；
3. 分阶段计时：向量构建、IDF、打分、MMR、解释生成；
4. 报告 p50 / p95 / max，以及一次运行的输出 JSON 字节数（作为内存代理）；
5. 在 Node（离线基准）与 Edge popup（真实环境）都测，两者结果分列；
6. **在测出数据前，本设计不声称任何毫秒数。**

---

## 10. C3 最小开发路线

> 每阶段都遵守：先写测试再实现；改动前 `rollback/` 快照；纯函数；不碰 `biliDailyRecords`；
> 不新增权限；数据不足时降级优先。

### C3-1 内容匹配纯函数

| 项 | 内容 |
|---|---|
| 输入 | records（只读）、C1 画像、C2-3 特征、C2-4B sidecar |
| 新增 | `recommend-core.js`：`buildUserPartitionVector`、`buildUserTextCounts`、`buildCandidateVector`、`computeIdf`、`buildTfIdfVector`、`cosineSimilarity` |
| 单测 | 零分母 → `null`；未知分区不入维；`df=0` 平滑；小池关 IDF；口径断言 |
| 防回归 | 不修改任何现有模块；241 项既有测试必须全绿 |
| 进入下一阶段门槛 | 新增单测 100% 通过；无 `NaN`/`Infinity` 泄漏；既有 241 项无变化 |

### C3-2 时间衰减与冷启动

| 项 | 内容 |
|---|---|
| 输入 | 同上 + `now` 注入 |
| 新增 | `decayWeight`、`durationWeight`、`resolveObservationTime`、降级决策器 |
| 单测 | 衰减单调；`now` 注入可复现；无时间戳记录处理；未来时间不参与；`insufficient` 时不出相似度 |
| 防回归 | 不改 C1 的窗口语义；不透传删除候选 |
| 门槛 | 降级矩阵每条都有对应测试；注入不同 `now` 得到确定结果 |

### C3-3 MMR 与双通道

| 项 | 内容 |
|---|---|
| 输入 | C3-1/2 输出、C2-2 资格、C2-4B 准入 |
| 新增 | `recommend-rank.js`：`rankMainLane`、`rankExplorationLane`、`mmrSelect`、`mergeLanes`、`dedupeAcrossLanes`、`explain` |
| 单测 | `λ=1` 退化为相关性；输入乱序输出一致；同 UID 跨通道去重；配额不足回填；冲突候选不出现 |
| 防回归 | 不改 C2-2/C2-4B 资格；不合并原始分 |
| 门槛 | 稳定性测试通过；每条推荐都带 `lane` 与可追溯 `reasons`；无未经验证的措辞 |

### C3-4 离线评测

| 项 | 内容 |
|---|---|
| 输入 | 合成 fixture + （数据达标后）真实记录 |
| 新增 | `tools/eval-recommend.js`：时间切分、六方案、全部指标、输出 JSON/Markdown |
| 单测 | 冻结的 fixture 上指标手算一致；泄漏检查（未来数据不得进入向量）；可复现（同输入同输出） |
| 防回归 | 只读 records；不写 `chrome.storage`；不改运行时模块 |
| 门槛 | 同输入两次运行结果逐字节一致；L2 合成实验完成；L3 明确标注"数据不足，未执行" |

### C3-5 Edge UI 接入与真实验收

| 项 | 内容 |
|---|---|
| 输入 | C3-3 排序结果（已缓存） |
| 新增 | popup 推荐卡片、来源标签、exploration 开关、降级文案 |
| 单测 | 推荐为空不白屏；`insufficient` 展示回访列表；来源标签正确；无权限新增 |
| 防回归 | 不改 `manifest.json` 权限；不改 `content.js` 采集逻辑 |
| 门槛 | 用户真实数据下不崩、不白屏；文案不含未经验证的断言；四项权限/隐私检查通过 |

---

## 11. 风险与待解决问题

### 11.1 数据风险

1. **样本量不足**：4 个有效视频无法支撑任何效果结论，C3-4 的 L3 实际不可执行；
2. **无负反馈**：没有"不喜欢"，无法计算真正的准确率；
3. **标题短**：中文 bigram 在短标题上几乎无特征；
4. **分区粒度不一致**：`tname` / `tname_v2` 层级混用会污染向量——需在 C3-1 用现有
   `normalizePartition` 口径，不另立规则。

### 11.2 算法风险

5. **小候选池下 IDF 不稳**：已设计关闭阈值，但阈值 20 本身没有实验依据；
6. **权重与 λ 全是先验值**：C3-4 前不能声称任何组合更优；
7. **跨口径近似**：exploration lane 的用户侧是 watch-ms、候选侧是 video-count，
   余弦在数学上可算，语义上只是近似——已设计 `confidence: low` 降级；
8. **MMR 可能压低强相关候选**：已用 Top2K 限制与相关性下限缓解。

### 11.3 工程风险

9. **主线程阻塞**：N=500、D=2000 时同步计算可能超 50 ms，需分片；
10. **缓存膨胀**：全量向量缓存会挤占 storage 配额，需只缓存结果；
11. **浮点不稳定**：累加顺序会影响末位，需固定排序与精度比较。

### 11.4 产品与合规风险

12. **来源误导**：exploration lane 的文案是最大风险点，必须逐条审查；
13. **"猜你喜欢"承诺过高**：数据不足时必须降级为"你常看的 UP 主"；
14. **未经验证的措辞**：`onlineVerified` 恒 false，任何"认证/官方"措辞都禁止。

### 11.5 待用户确认

1. 默认推荐条数 `K = 5` 是否合适？
2. exploration lane 默认占比 20%（K=5 时 1 条）是否可接受？
3. 是否允许 C3-5 在 popup 增加"探索推荐"独立分组（而非混排）？
4. 是否接受 `insufficient` 阶段完全不出现"猜你喜欢"字样？
5. 性能预算 50 ms 是否需要调整？

---

## 附录 A：字段路径速查（C3 实现时的唯一依据）

| 用途 | 路径 |
|---|---|
| 分区占比（用户，watch-ms） | `interestProfile.windows["30d"].partitions[].watchMs / 该窗口 identified 总计` |
| 分区占比（main 候选，watch-ms） | `features.candidates[].partitionFeatures.partitions[].shareOfIdentified` |
| 分区占比（exploration 候选，video-count） | `sidecar.candidates[].partitionCounts[].shareOfImportedVideos` |
| 候选标题词频 | `features...titleFeatures.tokens[].count` / `sidecar...titleTokens[].count` |
| 候选文档数代理 | `titleFeatures.documentCount`（视频级，仅用于诊断） |
| 覆盖率（main） | `partitionCoverage`(watch-ms) / `titleCoverage`(video-count) |
| 覆盖率（exploration） | `partitionCoverage`(video-count) / `titleCoverage`(video-count) |
| 资格（main） | `assessCandidate().eligibility === "eligible"` |
| 资格（exploration） | `assessment.candidates[].promotion.eligibleForExploration === true` |
| 熟悉度原料 | `poolCandidates[].evidence.watchedWatchMs`、`interestProfile.windows["30d"].effectiveWatchMs` |
| 近期性原料 | `assessCandidate().freshness.ageDays`、`lastObservedAt` |
| 身份冲突 | `evidence.conflictVideoCount` / `assessment.identityEvidence.crossSourceConflictVideoCount` |

## 附录 B：术语

| 术语 | 含义 |
|---|---|
| main lane | 来自本地观看记录的回访通道 |
| exploration lane | 来自用户主动导入、未观看过的探索通道 |
| 口径（basis） | 统计分母单位：`watch-ms` 或 `video-count` |
| 可靠性（reliability） | 由覆盖率导出的可信度权重，乘在相似度上 |
| 可用组件 | 相似度为非 `null` 的组件 |
| L1–L4 | 算法测试 / 合成实验 / 真实历史离线评测 / 用户反馈评测 |
