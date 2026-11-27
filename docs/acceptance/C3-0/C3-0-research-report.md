# Bili Daily C3-0 验收报告：推荐算法架构与离线评测设计

- 日期：2026-11-11
- 阶段：C3-0（纯设计，**未写任何推荐排序代码**）
- 架构文档：`docs/design/C3-0-recommendation-architecture.md`
- 结论：设计完成；推荐效果、性能、离线指标**全部未测**，不构成任何效果结论

---

## 0. 执行状态总表

> 本报告严格区分“已执行 / 未执行 / 设计推导”。

| 项目 | 状态 | 证据 |
|---|---|---|
| 阅读五个运行时模块源码 | 已执行 | §1.1 逐文件列出 |
| 阅读既有设计与验收文档 | 已执行 | §1.2 |
| 核对模块真实输入/输出/字段/单位 | 已执行 | §2 |
| 现有 241 项测试基线复跑 | **已执行** | §5：8 个文件全绿，退出码全 0 |
| 生成架构文档 | 已执行 | `docs/design/C3-0-recommendation-architecture.md` |
| 生成本报告与单文件 HTML | 已执行 | §9 |
| 修改任何 JavaScript 业务模块 | **未执行（禁止）** | 本阶段零代码改动 |
| 新增推荐排序代码 | **未执行（禁止）** | C3-1 才开始 |
| 性能实测 | **未执行** | 无实现可测；不声称任何毫秒数 |
| 离线评测 | **未执行** | 无实现、且真实数据不足（L3 不可执行） |
| 读取 `chrome.storage.local` 真实记录 | **未执行** | 本阶段不接触浏览器存储 |
| 修改 manifest / popup / content / storage | **未执行（禁止）** | 零改动 |

---

## 1. 实际读取的代码与文档

### 1.1 代码（逐个读取，非凭记忆）

| 文件 | 读取重点 |
|---|---|
| `stats.js` | 记录结构、`EFFECTIVE_WATCH_MS`、`aggregateUps` 输出字段、日期键规则 |
| `interest-profile.js` | `buildInterestProfile` 输出、窗口键 `"7d"/"30d"`、`partitions[].share` 分母、`partitionCoverage` 结构 |
| `candidate-pool.js` | 候选对象、`evidence` 全部字段、`assessCandidate` 的资格规则、`filterEligibleCandidates` 分组 |
| `candidate-features.js` | `partitionFeatures`（`shareOfIdentified`）、`titleFeatures.tokens[]`、覆盖率口径、`featureStatus` 阈值、`extractTitleBigrams` |
| `candidate-content-import.js` | sidecar 结构、`partitionCounts[].shareOfImportedVideos`、`titleTokens[]`、`promotion.eligibleForExploration`、`onlineVerified` 恒 false |
| `manifest.json` | 权限仅 `storage`；content script 匹配范围 |

### 1.2 文档

- `docs/research/recommendation-algorithm-research.md`（C2-0 调研）
- `docs/design/C2-4A-candidate-source-review.md`（重点：§5.5、§6.2–6.5 两轴模型与双通道）
- `docs/design/C2-1-candidate-pool.md`
- `docs/acceptance/C2-3/C2-3-feature-report.md`（目录级阅读 + 字段章节）
- `docs/acceptance/C2-4B/C2-4B-import-report.md`（schema 章节）
- `docs/acceptance/README.md`（报告规范）

### 1.3 测试文件

- `test-candidate-content-import.js`（60 项，逐条标题）
- 其余 7 个测试文件按执行结果核对（见 §5）

---

## 2. 接口核对结论（与草案不一致之处已标出）

### 2.1 已确认的真实接口

| 模块 | 入口 | 关键输出 |
|---|---|---|
| C1 | `buildInterestProfile` | `windows["7d"/"30d"]`：`partitions[]`、`ups[]`、`partitionCoverage`、`status` |
| C2-1 | `buildFromRecords` / `buildFromManual` / `mergePools` | `{upUid, upName, sources, watchedBefore, candidateType, uidVerified, evidence}` |
| C2-2 | `assessCandidate` / `filterEligibleCandidates` | `{eligibility, reasons[], identityEvidence, freshness}` |
| C2-3 | `buildCandidateFeatures` / `extractTitleBigrams` | `partitionFeatures`、`titleFeatures`、覆盖率、`featureStatus` |
| C2-4B | `parse…` / `build…Evidence` / `assess…` | sidecar + 评估（`eligibleForExploration`、`contentStatus`） |

### 2.2 三处必须修正的设计假设

#### （1）C1 不提供标题特征

`interest-profile.js` 只统计分区、UP 主、时段、覆盖率，**没有任何标题/词元输出**。
因此 C3 的用户文本向量**不能**从 C1 直接取，必须由 C3 从观看记录现算，
并复用 C2-3 的 `extractTitleBigrams` 保证同一归一化口径。
`C2-0` 调研第 7.2 节“全部来自 C1 画像，不新建统计口径”在文本维度上不成立，
本设计已改为“分区来自 C1、文本由 C3 现算”。

#### （2）覆盖率单位不一致

- C2-3：`partitionCoverage` 是 **watch-ms** 口径，`titleCoverage` 是 **video-count** 口径；
- C2-4B：两者都是 **video-count** 口径；
- 阈值也不同（C2-3 0.5 / C2-4B 0.6）。

设计约束：阈值与覆盖率**不跨模块比较**，每个 lane 用自己模块的覆盖率。

#### （3）分区占比分母不一致

- C1 `partitions[].share` 分母含“未知”桶；
- C2-3 `shareOfIdentified` 分母只含已识别分区（watch-ms）；
- C2-4B `shareOfImportedVideos` 分母是可用视频数（video-count）。

设计约束：用户向量不用 C1 的原始 `share`，而是按 C1 的视频选择口径自行按
`decay × duration` 累加；exploration lane 的分区余弦属于**跨口径近似**，
结果 `confidence` 降为 `low`，且不得与 main lane 的分数直接比较。

### 2.3 身份与可信度语义（复核结果）

以下字段在代码中写死，C3 不得改写或覆盖：

- `onlineVerified: false`（C2-1、C2-2、C2-4B 三处均如此）；
- `uidVerified` 只代表“格式合法 + 本地观看记录中出现过”；
- `promotion.eligibleForExploration` 只代表技术准入；
- `featureStatus: ready` 只代表技术数据条件达标。

---

## 3. 本阶段产出

| 文件 | 类型 | 说明 |
|---|---|---|
| `docs/design/C3-0-recommendation-architecture.md` | 新建 | 架构主文档（12 章 + 2 附录） |
| `docs/acceptance/C3-0/C3-0-research-report.md` | 新建 | 本报告 |
| `docs/acceptance/C3-0/C3-0-research-report.html` | 新建 | 由 Markdown 生成 |
| `docs/acceptance/README.md` | 修改 | 第 5 节索引新增两行 |

**未修改任何 `.js` 文件**，未新建 `.js` 文件。

---

## 4. 设计要点摘要（详见架构文档）

1. **两个特征空间**：分区余弦与标题 TF-IDF 余弦分别计算后再加权，**不拼成一条向量**；
2. **TF**：次线性 `1 + ln(tf)`；**IDF**：`ln((N+1)/(df+1)) + 1`，`df` 为候选级；
3. **IDF 语料**：两条 lane 各自独立，且只取候选文档；离线评测时用切分点之前冻结；
4. **零分母**：返回 `null` 而非 0，权重在可用组件上重新归一化；
5. **未知分区**：不入维度，只进覆盖率分母；
6. **时间衰减**：`0.5^(ageDays/14)`，`now` 必须注入，未来时间按 0 处理；
7. **MMR**：`λ·rel − (1−λ)·maxSim`，λ=0.7 仅实验值，只在 Top2K 上运行；
8. **双通道**：独立打分、独立配额、固定位置合并、同 UID 以 main 优先且不合并原始分；
9. **解释**：每条理由必须携带字段路径与取值，禁止认证/准确率类措辞；
10. **评测**：B0/B1/M1–M4 六方案 + 七类指标 + 时间切分 + 四层分离。

---

## 5. 实际执行的命令与结果

### 5.1 既有测试基线复跑（本阶段未改代码，用于证明零回归）

```
test-candidate-content-import.js -> 60/60 通过  exit=0
test-candidate-features.js       -> 38/38 通过  exit=0
test-candidate-quality.js        -> 28/28 通过  exit=0
test-candidate-pool.js           -> 33/33 通过  exit=0
test-interest-profile.js         -> 24/24 通过  exit=0
test-uid.js                      -> 21/21 通过  exit=0
test-up-stats.js                 -> 17/17 通过  exit=0
test-stats.js                    -> 20/20 通过  exit=0
```

合计 **241/241**，`ANY_FAIL=0`。

### 5.2 新增测试

**0 项**。本阶段没有新增可执行代码，因此没有新增测试。
不为文档编写“假装通过”的测试。

### 5.3 语法检查

**未单独执行 `node --check`**：本阶段未修改任何 `.js` 文件。
上述 8 个测试文件在 Node 中成功加载并执行了全部模块（`candidate-content-import.js`
加载时还会校验 `stats.js` / `candidate-features.js` 依赖），因此现有文件的语法与
依赖完整性已被间接验证。

### 5.4 其他命令

- `diff -q`：确认本阶段未改动模块（上一轮修复的 `candidate-content-import.js`
  仍为修复后版本，未被本轮触碰）。

---

## 6. 未执行项及原因

| 项目 | 原因 |
|---|---|
| 推荐代码 / 测试 | C3-0 明确禁止编写正式排序代码 |
| 性能基准 | 无实现可测；且设计文档明确“测出前不声称毫秒数” |
| L3 真实历史离线评测 | 无实现 + 真实数据只有 4 个有效视频（C1 验收记录），无统计意义 |
| L4 用户反馈评测 | 无 UI、无反馈机制 |
| 读取真实 `biliDailyRecords` | C3-0 不接触浏览器存储 |
| TF-IDF 在真实数据上的行为 | 无实现 |

---

## 7. 已知限制与风险

1. **数据量**：4 个有效视频、1 个有效观看日，当前只能验证“流程与降级”，不能验证效果；
2. **无负反馈**：离线指标只能衡量“与未来观看一致程度”，不是准确率；
3. **跨口径近似**：exploration lane 的用户侧是 watch-ms、候选侧是 video-count，
   数学可算但语义近似，已设计 `confidence: low` 降级；
4. **参数无依据**：权重、半衰期 14 天、λ=0.7、IDF 阈值 20、可靠性阈值 0.8/0.25
   全部是先验值，需 C3-4 实验后再定；
5. **标题特征稀疏**：中文 bigram 在短标题上几乎没有信号，且无同义/语义能力；
6. **分区粒度**：`tname` / `tname_v2` 层级混用会污染向量；
7. **性能未知**：分片方案与 50 ms 预算都未实测；
8. **产品文案风险**：exploration lane 最容易被误读为“插件发现的陌生 UP 主”。

---

## 8. 回滚方式

本阶段**只新增/修改文档与索引**，且未覆盖任何历史报告：

- 新增文件：`docs/design/C3-0-recommendation-architecture.md`、
  `docs/acceptance/C3-0/`（本报告与 HTML）；
- 修改文件：`docs/acceptance/README.md`（仅新增两行索引）。

如需回滚（PowerShell，在 `D:\Bili-Daily` 下）：

```powershell
Remove-Item docs\design\C3-0-recommendation-architecture.md
Remove-Item docs\acceptance\C3-0 -Recurse
# README.md 第 5 节中 C3-0 的两行索引手动删除即可
```

无需恢复任何 `.js` 文件，因为本阶段没有改动代码。

---

## 9. 文件归档与 HTML 生成情况

| 文件 | 状态 |
|---|---|
| `docs/design/C3-0-recommendation-architecture.md` | 已生成 |
| `docs/acceptance/C3-0/C3-0-research-report.md` | 已生成 |
| `docs/acceptance/C3-0/C3-0-research-report.html` | 由 `tools/build-report-html.js` 从 Markdown 生成，单文件、内联 CSS、无 CDN |

生成命令（如 HTML 缺失需本机补跑）：

```powershell
cd D:\Bili-Daily
node tools/build-report-html.js `
  docs/acceptance/C3-0/C3-0-research-report.md `
  docs/acceptance/C3-0/C3-0-research-report.html
```

---

## 10. 下一步（C3-1）的输入需求

进入 C3-1 前需要确认：

1. 默认推荐条数 `K = 5`；
2. exploration lane 默认配额（K=5 时为 1 条，占 20%）；
3. 是否接受 `insufficient` 阶段完全不出现“猜你喜欢”字样；
4. 半衰期初值 14 天、λ 初值 0.7 是否作为实验起点（不视为最优）；
5. 是否允许 C3-1 新增 `recommend-core.js` 与对应测试文件（不改现有模块）。

C3-1 交付物（设计已定，尚未实现）：

- `recommend-core.js`：向量构建、TF-IDF、余弦、零分母处理；
- `test-recommend-core.js`：手算 fixture、缺数据降级、口径断言；
- 验收门槛：C3-1 单测全绿 + 既有 241 项仍全绿 + 无 `NaN`/`Infinity` 输出。

---

## 11. 声明

- 本报告没有编造任何测试数值、性能数值或推荐效果；
- §5 的 241/241 是本阶段真实执行结果；
- 其余未执行项均已在 §0、§6 明确标注；
- 本阶段结束，等待审核，**不进入 C3-1**。
