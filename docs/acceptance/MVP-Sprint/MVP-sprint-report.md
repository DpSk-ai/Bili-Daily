# Bili Daily MVP 冲刺阶段报告（算法与测试层）

- 日期：2026-11-11
- 阶段：MVP Sprint / 工作包 A（算法层）
- 状态：**代码已编写，自动化测试未执行**
- 重要：本报告**不包含任何测试通过结论**。命令执行通道在本会话持续被阻断，
  所有 `node` 命令均未能运行。

---

## 0. 执行状态总表

| 项目 | 状态 | 证据 |
|---|---|---|
| 阅读现有模块与文档 | 已执行 | §1 |
| 新增 `recommend-quality.js` | 已执行（未验证） | 文件存在，约 1800 行 |
| 新增 `test-recommend-quality.js` | 已执行（未验证） | 47 项测试 |
| 新增 `recommend-rank.js` | 已执行（未验证） | 约 700 行 |
| 新增 `test-recommend-rank.js` | 已执行（未验证） | 28 项测试 |
| `node --check` | **未执行** | Bash 分类通道阻断 |
| 新增 75 项测试 | **未执行** | 未获得任何 PASS/FAIL |
| 既有 297 项回归 | **未执行** | 未获得任何输出 |
| popup / 存储 / 导入 UI | **未开始** | 按你的决定暂缓 |
| manifest / 权限变更 | **未执行** | 按你的决定不做自动发现 |
| 单文件 HTML | **未生成** | 生成脚本需要 `node` |

阻断错误原文（Bash、后台执行、子代理、WebSearch 全部一致）：

> DeepSeek-flash[1m] is temporarily unavailable (connection failed),
> so auto mode cannot determine the safety of Bash right now.

---

## 1. 开发前审计

| 核对项 | 结论 |
|---|---|
| 扩展入口 | `manifest.json`：MV3，`permissions: ["storage"]`，popup + 视频页 content script |
| popup 结构 | `popup.html` 加载 `storage.js → stats.js → dev-config.js → popup.js`；推荐区目前是占位文案 |
| 记录格式 | `{ version:1, days: {"YYYY-MM-DD": { BV: {bvid, title, partition, upName, upUid, watchMs, startedAt, lastWatchedAt, ...} } } }` |
| 导出方式 | 各模块 `globalThis.BiliDailyXxx = Object.freeze({...})` |
| C2-2 准入 | `assessCandidate().eligibility ∈ {eligible, review, excluded}`；身份冲突 → review |
| C2-4B 准入 | `promotion.eligibleForExploration`，仅技术准入，`onlineVerified` 恒 false |
| C3-1 接口 | `buildUserPartitionVector` / `buildUserTextCounts` / `computeIdf` / `buildTfIdfVector` / `compareVectors` |
| 权限 | 仅 `storage`；未申请 host_permissions |
| 数据本地性 | 全部本地，无网络请求 |

### 1.1 审计发现（影响实现）

1. **`recordWeight` 只作用于标题词频**，不作用于分区向量；分区衰减无法复用该钩子。
2. **`stats.mergeByBvid` 跨天合并会丢失每日 watchMs**，且 `lastWatchedAt` 取"排序后第一条非空"，
   不保证是最新一次。因此衰减必须按真实日期键逐日重建，而不是读合并后的时间字段。
3. C1 有效观看阈值 = 30 秒；画像不足门槛 = 10 分钟 + 2 个活跃日。
4. C2-3 的分区覆盖率是 watch-ms 口径，标题覆盖率是 video-count 口径；
   C2-4B 两者都是 video-count。跨口径不可直接比较。

---

## 2. 本轮新增

| 文件 | 说明 |
|---|---|
| `recommend-quality.js` | 时间衰减、逐日加权、用户证据、冷启动、候选可靠性、重复曝光信号 |
| `test-recommend-quality.js` | 47 项边界测试（未执行） |
| `recommend-rank.js` | 相关性打分、双通道、MMR、配额、推荐理由 |
| `test-recommend-rank.js` | 28 项排序/通道/MMR 测试（未执行） |
| `rollback/before-c3-2-quality/README.md` | 回滚说明（基线文件复制被阻断，见 §7） |

**未修改任何既有模块**；`manifest.json`、`popup.*`、`storage.js`、`content.js` 零改动。

---

## 3. 时间衰减设计

```
decay(ageDays, H) = 0.5 ^ (ageDays / H)      H 默认 14 天（实验值）
```

- `now` 必须注入；非法 `now` 返回 `invalid-now`，不回退系统时间。
- 时间戳按毫秒差（`ageBasis: "ms"`）；日期键按本地日历日差（`ageBasis: "local-date"`），
  两者在输出中显式区分，避免夏令时/时区造成 23/25 小时误差。
- `ageDays = 0 → 1`，`= H → 0.5`，`= 2H → 0.25`；未来时间 → `weight: null`；
  缺失时间 → `missing-time`；极久远 → 0，不产生 NaN/Infinity。

### 3.1 跨天观看的处理

`recommend-quality.js` 自带**逐日收集器**：按日期键保留每日 watchMs，不调用跨天 `mergeByBvid`。

- 分区：`每日 watchMs × 当日权重`，再按分区累加；同一 BV 跨天仍只算一个视频。
- 标题：每个 BV 只贡献**一个内容文档**，文档权重取该 BV 最近观看日的衰减值；
  标题取确定性顺序下第一个非空标题，与 C3-1 的合并规则一致。
- 关闭衰减（`decayEnabled: false`）时**直接委托 C3-1**，保证与既有结果完全一致。

### 3.2 真实使用路径

`recommend-rank.js` 调用 `buildDecayedUserPartitionVector` 与
`buildDecayedUserTextCounts`，衰减结果直接进入相似度计算与排序——
不是"算了一个不参与决策的参数"。

---

## 4. 冷启动

| 状态 | 条件 | 推荐行为 |
|---|---|---|
| `empty` | 窗口内无观看时长 | 不生成推荐 |
| `insufficient` | < 10 分钟 或 < 2 个活跃日（复用 C1） | 仅回访列表（按熟悉度），不做相似度 |
| `limited` | 未达到 ready 门槛 | 允许相似度，置信度标注 |
| `ready` | ≥ 50 个有效视频且 ≥ 14 个活跃日（C2-0 调研值） | 允许完整排序 |

所有阈值可配置，且随结果输出。`assessColdStart()` 可接受观看记录或已有的证据结果。
数据不足时不会生成探索推荐，也不会退化为抓取热门 UP 主。

---

## 5. 证据可靠性

`assessFeatureReliability(candidate, { lane })` 输出：

- `lane` / `provenance` / 分项 `coverage`（含 `basis`）
- `level: high | medium | low | unavailable`（工程启发式，不是概率）
- `identity.onlineVerified` 恒为 false；身份冲突时 `rankingBlocked: true`
- `passthrough` 只读透传 C2-2 eligibility 与 C2-4B eligibleForExploration，**不覆盖**

similarity 与 reliability 完全分离：相似度计算不乘可靠性，避免单组件时数学抵消。

---

## 6. 排序、MMR 与双通道

- 相关性 = 可用相似度组件的加权平均（分区 0.6 / 标题 0.4），不跨通道相加。
- MMR：`λ·rel − (1−λ)·maxSim`，λ 默认 0.7，仅在 Top 2K 内运行；
  λ=1 退化为纯相关性；同一 UID 在 MMR 内去重；输入乱序结果一致。
- 双通道：main（C2-2 eligible + C2-3 ready/partial）与 exploration
  （C2-4B eligibleForExploration）分别排序；默认 K=5、探索配额 1。
- 同 UID 跨通道：main 优先，只出现一次；main 被身份冲突阻断的 UID 在探索通道也不出现。
- 探索通道的分区比较是 watch-ms × video-count 近似，输出 `approximate: true` 且置信度压到 low。

推荐理由只引用真实字段：watched-before、partition-match、title-match、user-imported、low-coverage。

---

## 7. 回滚

- `rollback/before-c3-2-quality/README.md` 已写入恢复命令。
- **基线文件复制未完成**（`cp` 被阻断）。可用现有快照组合恢复：
  - `rollback/before-c3-1-core/`（各业务模块与测试）
  - `rollback/before-c3-1-audit/`（`recommend-core.js`、`test-recommend-core.js`）
- 撤回本轮只需删除新增的 4 个文件：

```powershell
cd D:\Bili-Daily
Remove-Item recommend-quality.js, test-recommend-quality.js
Remove-Item recommend-rank.js, test-recommend-rank.js
```

---

## 8. 需要项目所有者本机执行的验证

```powershell
cd D:\Bili-Daily

node --check recommend-quality.js
node --check test-recommend-quality.js
node --check recommend-rank.js
node --check test-recommend-rank.js

node test-recommend-quality.js
node test-recommend-rank.js

# 既有 297 项回归
node test-recommend-core.js
node test-candidate-content-import.js
node test-candidate-features.js
node test-candidate-quality.js
node test-candidate-pool.js
node test-interest-profile.js
node test-uid.js
node test-up-stats.js
node test-stats.js
```

把退出码与统计行回填后，才能判断本轮代码是否可用。**在此之前不应进入
popup 集成或声称 MVP 可用。**

---

## 9. 已知限制

1. **全部新增代码未经执行验证**：可能存在语法或断言错误。
2. 冷启动 `ready` 门槛（50 视频 / 14 天）来自 C2-0 调研，不是实测结论。
3. 探索通道分区相似度是跨口径近似，只能作为低可信信号。
4. 标题 bigram 无语义理解。
5. MMR 的 λ=0.7 是实验值，未做离线调参。
6. 推荐排序未接 UI、未接本地缓存与导入存储。
7. 自动陌生 UP 主发现**未实现**（按你的决定先只用导入 JSON；接口方案需新的
   `host_permissions`，必须先获你批准）。

---

## 10. 下一步

1. 恢复命令执行后，先跑 §8 的全部命令并修复失败。
2. 工作包 B：导入存储层（独立 storage key、schema/大小/UID/BV 校验、失败不覆盖旧数据）。
3. 工作包 C：popup 四个区域 + 推荐卡 + 导入面板 + 刷新按钮。
4. 工作包 D：端到端测试、Edge 手工验收清单、完整 MVP 报告。
