# Bili Daily C3-1 验收报告：内容向量化 / TF-IDF / 余弦纯函数引擎

- 日期：2026-11-11
- 阶段：C3-1（只做数学与特征适配层，不做排序、不做 UI）
- 新增模块：`recommend-core.js`
- 新增测试：`test-recommend-core.js`（45 项）
- 设计依据：`docs/design/C3-0-recommendation-architecture.md`
  + `docs/design/C3-0-architecture-amendments.md`
- 结论：**新增 45/45 通过；既有 241/241 保持通过；合计 286/286**
- 本阶段**没有**实现时间衰减、MMR、推荐排序或综合评分

---

## 0. 执行状态总表

> 严格区分“已执行 / 未执行 / 设计推导”。

| 项目 | 状态 | 证据 |
|---|---|---|
| 阅读 C3-0 架构文档与补充说明 | 已执行 | §1 |
| 阅读 5 个运行时模块 + 8 个测试文件 | 已执行 | §1 |
| 新建 `recommend-core.js` | 已执行 | §2 |
| 新建 `test-recommend-core.js`（45 项） | 已执行 | §6 |
| `node --check`（7 个文件） | 已执行 | §8，退出码全 0 |
| 新增 45 项测试 | **已执行** | `45/45 通过`，退出码 0 |
| 既有 241 项回归 | **已执行** | 8 个文件全绿，退出码全 0 |
| 全量合计 286 项 | **已执行** | §7 |
| 输入不可变 / JSON 往返 | **已执行** | 测试 24、31、32 |
| 合成数据微基准 | **已执行（Node，非 Edge popup）** | §10，注明局限 |
| Edge popup 真实性能 | **未执行** | 尚无 UI 接入 |
| 真实观看数据评测 | **未执行** | 数据量不足（4 个有效视频） |
| 修改既有模块 | **未执行（禁止）** | 13 个文件 `diff -q` 全部 same |

---

## 1. 开发前审计结论

### 1.1 读取范围

- 文档：`docs/design/C3-0-recommendation-architecture.md`、`docs/acceptance/C3-0/C3-0-research-report.md`、
  `docs/acceptance/README.md`
- 代码：`stats.js`、`interest-profile.js`、`candidate-pool.js`、`candidate-features.js`、
  `candidate-content-import.js`
- 测试：全部 8 个既有测试文件

### 1.2 核对结果（与 C3-0 一致，未发现新偏差）

| 依赖 | 实际用法 |
|---|---|
| `Stats.cleanRecord` | 记录清洗，分区 trim，watchMs 安全化 |
| `Stats.mergeByBvid` | 同 BV 跨天 / 分 P 合并，时长累加 |
| `Stats.parseDateKey` / `shiftLocalDate` / `localDateKey` | 本地日历窗口，与 C1 同口径 |
| `Features.extractTitleBigrams` | 标题 bigram，与 C2-3 同一归一化 |
| 候选字段 | C2-3 `partitionFeatures` / `titleFeatures`；C2-4B `partitionCounts` / `titleTokens` |

**关键口径确认**：C1 的 `partitions[].share` 分母含“未知”，C2-3 的 `shareOfIdentified`
分母不含；本模块**不复用** C1 的 share，而是按 C1 的视频选择口径自行按 watchMs 累加，
并在输出中显式写 `basis: "watch-ms"`。

---

## 2. 新增 / 修改文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `recommend-core.js` | 新增 | 纯函数引擎，1732 行 / 56 KB |
| `test-recommend-core.js` | 新增 | 45 项测试，788 行 |
| `docs/design/C3-0-architecture-amendments.md` | 新增 | C3-0 三项设计问题补充说明 |
| `docs/acceptance/C3-1/C3-1-core-report.md` | 新增 | 本报告 |
| `docs/acceptance/C3-1/C3-1-core-report.html` | 新增 | 由 Markdown 生成 |
| `docs/acceptance/README.md` | 修改 | 索引新增 C3-1 行 |
| `rollback/before-c3-1-core/` | 新增 | 13 个源文件快照 + README |

**既有的 5 个业务模块、8 个测试文件一个字节未改**（§11 有 `diff -q` 证据）。

---

## 3. C3-0 三处设计问题的处理

补充说明全文见 `docs/design/C3-0-architecture-amendments.md`。

### 3.1 问题 A：可靠性与相似度混合

- **问题**：`S = Σ(w·r·s)/Σ(w·r)` 在只有一个可用组件时，`r` 被分子分母约掉。
- **处理**：三层分离——`similarity`（纯余弦）、`coverage`（独立元数据）、
  `confidence`（**推迟到 C3-2**）。
- **落地**：`compareVectors()` 返回值含 `evidence.left/right.coverage`、
  `evidence.minCoverage`、`evidence.confidencePolicy: "deferred-to-c3-2"`；
  **没有任何乘法、没有任何综合分字段**。
- **测试**：27 号断言 `confidencePolicy`；35 号断言输出不含 `score` / `confidence`。

### 3.2 问题 B：跨统计口径比较

- **处理**：每个向量对象带 `basis`；`compareVectors` 默认返回
  `status: "cross-basis-rejected"`、`similarity: null`；
  显式 `allowCrossBasis: true` 时返回 `status: "approximation"`、
  `approximate: true`、`bases`、`limitations`。
- **落地**：`cosineSimilarity()` 同样默认拒绝跨口径（返回 `null`），
  不把拒绝伪装成 0。
- **测试**：28 号（默认拒绝）、29 号（近似标记）、30 号（缺失组件返回 null）。

### 3.3 问题 C：近期性与重复曝光抑制

- **处理**：两者概念分离，均由 C3-2 设计；C3-1 **不实现任何一个**。
- **落地**：输出中显式写 `decay: "none"`、`weighting: "raw-count"` /
  `"watch-ms-raw"`；`buildUserTextCounts` 保留 `options.recordWeight` 接入点，
  默认 `null`，不引入任何时间概念。
- **测试**：45 号断言权重与衰减语义字段。

---

## 4. TF-IDF 实现与数学测试

### 4.1 定义（与 C3-0 一致）

```
tf'(t,d) = 1 + ln(tf(t,d))              tf > 0 时
idf(t)   = ln((N+1)/(df(t)+1)) + 1
w(t,d)   = tf'(t,d) × idf(t)
```

- 文档 = 一个候选 UP 主（`documentBasis: "candidate-up"`）；
- `N` = 至少含一个有效词元的候选文档数；
- `df(t)` = 含词元 t 的**候选文档数**，不是视频数；
- IDF 语料按 lane 独立，用户文档**不得**进入候选语料；
- 文档数 < `minIdfDocuments`（默认 20）时关闭 IDF，统一权重 1；
- 空语料：`enabled=false`，`oovIdf = ln(0+1)+1 = 1`；
- 未登录词使用 `oovIdf`，不产生 NaN / Infinity；
- 模型可 JSON 往返后复用（`frozen: true`），供 C3-4 时间切分评测。

### 4.2 手算 fixture 与实测结果

| 测试 | 手算期望 | 结果 |
|---|---|---|
| 11 次线性 TF | `tf=2 → 1+ln2 ≈ 1.6931` | PASS |
| 12 DF 按候选 | 2 篇文档中 1 词出现于 2 篇 → `df=2` | PASS |
| 13 IDF 平滑 | `N=1, df=1 → ln(2/2)+1 = 1`；OOV `ln2+1 ≈ 1.6931` | PASS |
| 14 空语料 | 无 NaN/Infinity，`oovIdf=1` | PASS |
| 15 未登录词 | 权重 = `oovIdf` | PASS |
| 16 小池 | 2 篇 < 20 → 关闭；`minIdfDocuments=1` → 开启 | PASS |
| 17 冻结复用 | JSON 往返后向量完全相等 | PASS |
| 40 非法文档 | 跳过并计数，不污染 df | PASS |
| 41 无模型 | 等价统一权重 1 | PASS |

---

## 5. 余弦相似度实现与测试

### 5.1 规则

- 稀疏向量：只遍历非零维度，键按码点排序后累加（浮点顺序确定）；
- 分母：两侧 L2 范数；
- 空向量 / 零范数 → `null`；
- 双方非空但无共同词元 → `0`；
- 非法权重（NaN / Infinity / 负数 / 非数字）→ `null`，不抛异常；
- 不同 `basis` 默认拒绝（`null`），显式允许时由 `compareVectors` 打 `approximation` 标记；
- 结果限定在 `[0,1]`，浮点误差 `1e-12` 内按边界处理。

### 5.2 测试

| 测试 | 期望 | 结果 |
|---|---|---|
| 18 一维 | `cos({a:1},{a:2}) = 1` | PASS |
| 19 多维 | `cos({x:1,y:1},{x:1}) = 1/√2 ≈ 0.7071` | PASS |
| 20 正交 | 返回 `0`（不是 null） | PASS |
| 21 零范数 | `null` | PASS |
| 22 两侧空 | `null` | PASS |
| 23 非法权重 | 四种非法输入全部 `null` | PASS |
| 42 非法输入比较 | `status: "invalid-input"`，不抛异常 | PASS |

---

## 6. 两条 lane 的向量接口

### 6.1 main lane（来自 C2-3）

```js
buildCandidatePartitionVector(mainCandidate, { lane: "main" })
// space: "partition", basis: "watch-ms", lane: "main"
// 读取: partitionFeatures.partitions[].shareOfIdentified
// 排除: 「未知」分区

buildCandidateTextCounts(mainCandidate, { lane: "main" })
// space: "title", basis: "token-count", lane: "main"
// 读取: titleFeatures.tokens[].count
```

### 6.2 exploration lane（来自 C2-4B）

```js
buildCandidatePartitionVector(explorationCandidate, { lane: "exploration" })
// space: "partition", basis: "video-count", lane: "exploration"
// 读取: partitionCounts[].shareOfImportedVideos

buildCandidateTextCounts(explorationCandidate, { lane: "exploration" })
// space: "title", basis: "token-count", lane: "exploration"
// 读取: titleTokens[].count
```

### 6.3 共同约束

- 只读候选字段，不修改候选池，不改变 C2-2 / C2-4B 的任何资格结论；
- 缺字段 → `status: "unavailable"` + 结构化原因，`vector: null`；
- 身份冲突（`hasUidConflict` / `conflictVideoCount > 0` /
  `identityEvidence.hasIdentityConflict` / `crossSourceConflictVideoCount > 0`）
  → `status: "blocked"`，**即使内容特征齐全**也不提供向量（测试 34）；
- 不基于昵称推断内容。

---

## 7. 测试结果

### 7.1 新增 C3-1 测试

```
node test-recommend-core.js
45/45 通过
退出码 0
```

### 7.2 既有 241 项回归

| 测试文件 | 结果 | 退出码 |
|---|---|---|
| `test-candidate-content-import.js` | 60/60 通过 | 0 |
| `test-candidate-features.js` | 38/38 通过 | 0 |
| `test-candidate-quality.js` | 28/28 通过 | 0 |
| `test-candidate-pool.js` | 33/33 通过 | 0 |
| `test-interest-profile.js` | 24/24 通过 | 0 |
| `test-uid.js` | 21/21 通过 | 0 |
| `test-up-stats.js` | 17/17 通过 | 0 |
| `test-stats.js` | 20/20 通过 | 0 |
| **合计** | **241/241** | 全部 0 |

### 7.3 全量

`45 + 241 = 286/286`，`FAILED_FILES=0`。

---

## 8. 语法检查

```
node --check recommend-core.js            -> 0
node --check test-recommend-core.js       -> 0
node --check stats.js                     -> 0
node --check interest-profile.js          -> 0
node --check candidate-pool.js            -> 0
node --check candidate-features.js        -> 0
node --check candidate-content-import.js  -> 0
```

---

## 9. 输入输出 JSON 稳定性

- 所有构建函数输出均为普通对象：**无 `undefined`、无 `NaN`、无 `Infinity`、无循环引用**；
- 空值统一用 `null`（如 `vector: null`、`coverage.ratio: null`），不省略键；
- 测试 24：6 类输出逐个 `JSON.parse(JSON.stringify(x))` 深等；
- 测试 32：用户向量、词频、候选向量、IDF、TF-IDF、比较结果全部往返相等；
- 测试 31：输入深度冻结后仍可计算，且输入 JSON 快照不变；
- 测试 33：记录键顺序反转后，输出 JSON 字符串逐字节相同。

> 这直接针对 C2-4B 第 46 项的 `undefined` 序列化教训：凡是可能缺失的字段，
> 本模块一律显式写 `null`，不依赖“读的时候不出错”。

---

## 10. 已知局限与性能

### 10.1 性能实测（合成数据，Node v24.19.0 / Windows 11）

| 场景 | p50 | p95 | max |
|---|---|---|---|
| IDF（500 文档 × 50 词元） | 1.978 ms | 2.341 ms | 2.356 ms |
| 余弦 ×500 次 | 6.180 ms | 6.822 ms | 6.931 ms |
| 用户分区 + 词频（500 视频） | 1.142 ms | 1.398 ms | 1.895 ms |

说明：

- 这是**Node 进程内**的微基准，预热 5 次、测量 30 次；
- **不是 Edge popup 的真实性能**，未测 UI 阻塞、未测 extension CSP / 调度；
- 数据是合成数据，不代表真实用户规模；
- 结论只能说明“量级可信”，不能作为产品性能承诺。

### 10.2 已知局限

1. **无时间衰减**：所有观看记录等权；C3-2 才接入。
2. **无综合评分**：`compareVectors` 只给相似度，排名逻辑不存在。
3. **文本无语义**：bigram 只认字面重合，`"科技"` 与 `"数码"` 不会因为语义相近而匹配。
4. **跨口径只是近似**：exploration lane 的用户侧 watch-ms × 候选侧 video-count，
   已在输出中标 `approximation`，不能与同口径结果比较。
5. **覆盖率阈值未定**：C3-1 只输出 coverage，判定谁是“高可信”留给 C3-2。
6. **IDF 阈值 20 是经验值**：无实验依据。
7. **候选标题来自 C2-3 汇总**：若上游 tokens 被截断（`outputTruncated`），
   本层无法恢复丢失词元。
8. **内存**：单次构建不缓存，调用方重复调用会重复计算；缓存策略留给 C3-2/3。

---

## 11. 回滚方法

快照目录：`rollback/before-c3-1-core/`（13 个文件 + README）。

本轮**只新增文件**，既有文件字节级未变：

```
diff -q rollback/before-c3-1-core/<file> <file>  →  same（13/13）
```

回滚只需删除新增文件：

```powershell
cd D:\Bili-Daily
Remove-Item recommend-core.js
Remove-Item test-recommend-core.js
Remove-Item docs\acceptance\C3-1 -Recurse
Remove-Item docs\design\C3-0-architecture-amendments.md
# docs\acceptance\README.md 中 C3-1 索引行手动删除
```

若担心既有文件被误改，按快照 README 的恢复命令逐文件覆盖即可。

---

## 12. C3-2 的前置条件

进入 C3-2（时间衰减与冷启动）前需要：

1. **确认 `recordWeight` 钩子形态**：`(video) => number`，默认 `null`；
   C3-2 的衰减函数通过它接入，不改 C3-1 签名。
2. **确认半衰期初值 14 天、观察时间取 `lastWatchedAt` / 日期键 12:00**。
3. **确认 confidence 策略**：收缩式（shrinkage）还是展示层分级，需在 C3-2 明确，
   并同步修订 C3-0 补充说明。
4. **确认“已观看候选抑制”与“重复曝光抑制”分离**：前者属于 C3-2 的兴趣建模，
   后者需要新的本地曝光记录（当前不存在），可能需要单独的存储设计。
5. **不修改 C3-1 的既有断言**：C3-2 只能新增测试，不得放宽 45 项中的任何一项。

C3-2 交付物（设计预定）：衰减函数、观察时间解析、降级决策器、对应测试。
进入 C3-2 后仍不实现 MMR 与 UI。

---

## 13. 声明

- 本报告所有通过数、退出码、耗时均为**实际执行**所得；
- 未执行项已在 §0、§10 明确标注；
- 没有编造任何推荐效果、准确率或线上性能；
- 本阶段结束，等待审核，**不进入 C3-2**。
