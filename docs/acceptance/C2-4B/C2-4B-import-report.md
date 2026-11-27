# Bili Daily C2-4B 验收报告：用户主动导入的新 UP 主内容证据引擎

- 日期：2026-11-11
- 项目路径：`D:\Bili-Daily`
- 阶段：C2-4B（纯函数解析、校验、内容特征与探索资格评估）
- 前置阶段：C1、C2-1、C2-2、C2-3、C2-4A 已验收
- 本阶段边界：不实现正式导入 UI，不写浏览器存储，不联网，不进入 C3

---

## 0. 执行状态总表

> 本报告严格区分“已执行 / 未执行 / 静态审查”。**未执行的测试不会写成通过。**

| 项目 | 状态 | 说明 |
|---|---|---|
| `candidate-content-import.js` | 已创建 | 纯函数模块，静态审查完成 |
| `test-candidate-content-import.js` | 已创建 | 60 项测试，覆盖指定的 45 个场景并补充 15 项 |
| `node --check`（新增文件） | **未执行** | 本会话工具通道持续不可用，未获得语法检查退出码 |
| `node test-candidate-content-import.js` | **未执行** | 未获得任何 PASS/FAIL 输出 |
| 原有 181 项回归 | **未执行** | 未获得回归输出，不声称保持通过 |
| 性能实测 | **未执行** | 只有静态复杂度分析，无计时数据 |
| 单文件 HTML 报告 | **未生成** | 本会话无法运行生成脚本；命令见第 12 节 |
| 回滚快照 | 已创建 | `rollback/before-c2-4b-import/`（14 个文件 + README） |

工具通道错误（多次重试一致，原文）：

> DeepSeek-flash is temporarily unavailable (connection failed), so auto mode cannot determine the safety of Bash right now. Wait a moment and then try this action again. If it keeps failing, continue with other tasks that don't require this action and come back to it later.

旁证：`node -v` 可执行，返回 `v24.19.0`。说明 Node.js 环境正常，问题在命令安全分类通道，而非 Node 或脚本本身。

---

## 1. 实际新建 / 修改的文件

### 1.1 新建

| 文件 | 作用 |
|---|---|
| `candidate-content-import.js` | C2-4B 核心模块：解析、校验、去重、内容特征、探索资格评估 |
| `test-candidate-content-import.js` | 独立测试，60 项 |
| `rollback/before-c2-4b-import/` | 开发前回滚快照（14 个既有文件） |
| `rollback/before-c2-4b-import/README.md` | 快照范围与恢复命令 |
| `docs/acceptance/C2-4B/C2-4B-import-report.md` | 本报告 |

### 1.2 修改

| 文件 | 修改内容 |
|---|---|
| `docs/acceptance/README.md` | 修正 C2-4A 索引：HTML 已归档，不再标记“未生成” |
| `docs/acceptance/C2-4A/C2-4A-research-report.md` | 按实际文件状态更正第 0 节、11.3 与“生成记录”：HTML 文件已存在，但本会话未执行生成命令，未伪造退出码 |

### 1.3 未修改（按要求保持原样）

`candidate-pool.js`、`candidate-features.js`、`interest-profile.js`、`stats.js`、`storage.js`、`content.js`、`manifest.json`、popup 页面、观看记录格式、存储键、权限。

---

## 2. 模块接口与数据结构

### 2.1 加载依赖

模块挂载到 `globalThis.BiliDailyCandidateContentImport`，加载顺序必须是：

```html
<script src="stats.js"></script>
<script src="candidate-features.js"></script>
<script src="candidate-content-import.js"></script>
```

缺少依赖时抛出明确错误，不静默降级。

### 2.2 导出

```js
BiliDailyCandidateContentImport = Object.freeze({
  SCHEMA_VERSION,          // 1
  IMPORT_KIND,             // "bili-daily-candidate-content-import"
  EVIDENCE_KIND,           // "bili-daily-candidate-content"
  ASSESSMENT_KIND,         // "bili-daily-candidate-content-assessment"
  PROVENANCE_USER,         // "user-provided"
  LANE_EXPLORATION,        // "exploration"
  DEFAULT_LIMITS,
  DEFAULT_THRESHOLDS,
  parseCandidateContentImport,
  buildCandidateContentEvidence,
  assessImportedContentCandidates
});
```

### 2.3 `parseCandidateContentImport(input, options)`

输入：JSON 字符串或普通对象；可选 `options.limits`。

输出：

```js
{
  status: "ok" | "empty" | "invalid",
  reason: "",
  document: null | {
    schemaVersion: 1,
    kind: "bili-daily-candidate-content-import",
    provenance: "user-provided",
    userConfirmed: true,
    exportedAt: null | number,
    sourceNote: string,
    candidates: [{
      upUid: string,
      upName: string,
      observedAt: null | number,
      observedAtState: "available" | "unknown" | "invalid",
      videos: [{
        bvid: string,
        title: string,
        titleTruncated: boolean,
        partition: string,
        tags: string[],
        url: string,
        urlState: "missing" | "accepted" | "rejected" | "short-link" | "not-video-url"
      }]
    }]
  },
  diagnostics: {
    inputKind, inputBytes, candidatesIn, candidatesAccepted, candidatesInvalid,
    videosIn, videosAccepted, videosInvalid, invalidUids, invalidBvids,
    urlBvMismatch, urlRejected, unknownFields, rejectedReasons
  },
  limits: { ... }
}
```

解析只做校验与清洗，不去重、不生成特征、不读观看记录。

### 2.4 `buildCandidateContentEvidence(importDoc, options)`

输入：`parseCandidateContentImport` 的返回值，或原始导入文档对象。

输出 sidecar（关键字段）：

```js
{
  schemaVersion: 1,
  kind: "bili-daily-candidate-content",
  provenance: "user-provided",
  lane: "exploration",
  status: "ok" | "empty" | "invalid",
  userConfirmed: boolean,
  exportedAt, sourceNote,
  candidates: [{
    upUid, upName, names, nameConflict,
    provenance: "user-provided",
    lane: "exploration",
    observedAt, observedAtState,
    videos: [{
      bvid, title, partition, tags, url, urlState,
      titleState, partitionState, titleTruncated,
      status: "usable" | "metadata-conflict" | "uid-conflict",
      conflictFields
    }],
    partitionCounts: [{ name, videoCount, shareOfImportedVideos }],
    titleTokens: [{ token, count, documentCount }],
    titleTokenStats: { uniqueTokenCount, totalTokenCount, tokenMapOverflow, outputTruncated },
    importedVideoCount, observedVideoCount, usableVideoCount,
    importedTitleCount, importedPartitionCount,
    partitionCoverage, titleCoverage,
    partitionCoverageState, titleCoverageState,
    coverageBasis: "video-count",
    contentStatus: "complete" | "partial" | "missing" | "conflicted",
    conflictVideoCount, metadataConflictVideoCount,
    conflicts: [{ bvid, type, fields }],
    videosTruncated, globalVideoLimitDropped,
    reasons: [{ code, level, message }]
  }],
  summary: {
    total, complete, partial, missing, conflicted,
    withPartitionFeatures, withTitleFeatures,
    importedVideoCount, usableVideoCount,
    conflictVideoCount, metadataConflictVideoCount
  },
  diagnostics: { ..., duplicateVideos, conflictVideos, conflictBvids, ... },
  limits, thresholds: { ..., experimental: true },
  note: "用户提供的内容证据，未在线核验；不进入观看记录，不改变 C2-2 / C2-3 的结论。"
}
```

### 2.5 `assessImportedContentCandidates(sidecar, records, options)`

输入：sidecar、`biliDailyRecords` 根结构或日期映射、可选 `{ now, thresholds, limits }`。

输出（关键字段）：

```js
{
  kind: "bili-daily-candidate-content-assessment",
  lane: "exploration",
  status: "ok" | "empty" | "invalid",
  now,
  candidates: [{
    upUid, upName, provenance, lane, observedAt, observedAtState,
    freshness: { state, ageDays, thresholdDays, lastObservedAt, reason, note },
    identityEvidence: {
      uid, uidFormatValid, provenance, userConfirmed,
      fromWatchHistory, fromUserInput, sources: ["user-provided"],
      onlineVerified: false,
      localWatchedVideoCount,
      internalConflictVideoCount, metadataConflictVideoCount,
      crossSourceConflictVideoCount, hasIdentityConflict
    },
    contentEvidence: {
      importedVideoCount, trustedVideoCount,
      partitionVideoCount, titleVideoCount,
      partitionCoverage, titleCoverage,
      partitionCoverageState, titleCoverageState,
      coverageBasis: "video-count",
      partitionCounts, contentStatus,
      metadataConflictVideoCount
    },
    promotion: {
      eligibleForExploration,
      status: "eligible" | "pending-review" | "insufficient-data",
      reasons: [{ code, level, message }],
      thresholds: { ..., experimental: true }
    }
  }],
  summary: {
    total, eligible, pendingReview, insufficientData, conflicted,
    crossSourceConflictVideoCount
  },
  diagnostics, thresholds,
  note: "...不代表 B 站账号已在线认证、视频元数据已被平台核验或推荐质量已被证明..."
}
```

`eligibleForExploration` 只表示满足本地探索通道的技术准入条件，不等于在线核验、平台核验、推荐质量，也不绕过 C2-2 的冲突规则。

---

## 3. UID / BV / URL 校验规则

### 3.1 UID

1. 复用 `stats.js` 的 `cleanRecord` / `normalizeUpUid`，不另立口径。
2. 必须是正的安全整数；字符串会 trim，但不会从昵称、URL、标题猜测 UID。
3. 拒绝 `0`、负数、小数、前导零、非数字、超出 `Number.MAX_SAFE_INTEGER` 的值。
4. 非法 UID 的候选整体跳过，计入 `invalidUids` 与 `rejectedReasons["invalid-uid"]`。

### 3.2 BV

1. 仅接受 `^[Bb][Vv][0-9A-Za-z]{10}$`。
2. 前缀统一为 `BV`，其余 10 位保留大小写（BV 号区分大小写）。
3. 去重键使用规范化后的 `BV` + 载荷。
4. 非法 BV 的视频跳过，候选保留但内容缺失；不自动补全标题 / 分区 / 标签。

### 3.3 URL

1. 只接受 `https://www.bilibili.com/video/<BV>` 与 `https://m.bilibili.com/video/<BV>`。
2. 主机名精确匹配；不接受 userinfo、端口、其他域名、`http`。
3. 不访问、不打开、不跟随重定向、不解析 `b23.tv` / `bili2233.cn` 短链。
4. URL 只用于交叉验证 BV 一致性；与显式 `bvid` 不一致时**拒绝整个视频**。
5. 危险协议（`javascript:`、`data:`、`file:` 等）、其他域名、空间链接：只丢弃 URL，视频本身保留。
6. 规范链接去掉 query / hash，只保留 `https://www.bilibili.com/video/<BV>`。
7. 长 URL 超过 `maxUrlLength` 时丢弃 URL，不截断后继续解析。
8. 不执行导入内容中的任何代码；URL 字段不会进入 DOM、`fetch` 或 `chrome.*`。

### 3.4 上限（默认值，可被 `options.limits` 覆盖）

| 限制 | 默认值 |
|---|---|
| 输入 JSON 字节数 | 1 MiB（UTF-8） |
| 候选数 | 500 |
| 单候选视频数 | 50 |
| 总视频数 | 2000 |
| 原始标题长度 | 1000 |
| 分区长度 | 64 码点 |
| 标签数 / 单标签长度 | 20 / 50 |
| URL 长度 | 2048 |
| 昵称 / 备注长度 | 100 / 500 |
| 唯一词元 / 输出词元 | 4000 / 2000 |

所有计数与截断规则都是确定性的，并与输入顺序无关。

---

## 4. 去重与冲突

### 4.1 去重维度

- **候选**：按规范化 UID 合并；同一 UID 的多次出现只保留一个候选。
- **视频**：同一 UID 下按规范化 BV 去重；重复 BV 只算一个视频，不膨胀计数与词频。
- **昵称**：只展示，不参与身份判定；同一 UID 多个昵称时按“出现次数优先、再字典序”选择，并标记 `nameConflict`。

### 4.2 冲突类型

| 场景 | 处理 |
|---|---|
| 同 UID 重复出现 | 合并；`candidatesMerged` 计数 |
| 同 UID 改名 | 合并；保留全部昵称，选择一个确定性展示名，`nameConflict: true` |
| 不同 UID 同名 | 保持两个候选；昵称不参与身份判定 |
| 同 UID 重复 BV | 去重；`duplicateVideos` 计数；特征不重复累加 |
| 同 UID 同 BV 标题 / 分区矛盾 | 标记 `metadata-conflict`，该视频不进入特征；缺失 + 有值不算冲突 |
| 不同 UID 同 BV（导入内部） | 标记 `uid-conflict`，该 BV 从**所有**候选特征中排除；涉及候选 `contentStatus: "conflicted"` |
| 导入 BV 与本地观看 UID 不一致 | `assess` 标记跨来源冲突，该视频不进入可信特征；候选不晋升 |
| 历史记录内部同 BV 多 UID | 任何导入声明都不可信；同样排除并阻止晋升 |
| 身份无法确认 | 不猜测；候选保留但 `pending-review` / `insufficient-data` |
| 输入顺序变化 | 候选按 UID 排序、视频按 BV 排序、截断在排序后进行；输出稳定 |

### 4.3 结构

- 顶层 `conflicts`：`[{ bvid, type, fields }]`，按 BVID 排序。
- 候选级 `reasons`：`[{ code, level, message }]`，例如 `uid-conflict-in-import`、`metadata-conflict`、`videos-truncated`、`no-usable-videos`。
- 诊断级：`conflictVideos`、`conflictBvids`、`metadataConflictVideos`、`duplicateVideos`。
- 不覆盖、不写回任何观看记录；冲突只影响 sidecar 与评估结论。

---

## 5. 探索资格（实验阈值）

### 5.1 两轴模型

- **身份轴**：UID 合法、来源为 `user-provided`、用户已确认、无导入内部冲突、无跨来源冲突。
- **内容轴**：去重后视频数、分区覆盖率、标题覆盖率、是否存在有效分区特征与有效标题 bigram。
- **新鲜度**：观察时间必须可解析、非未来、且在阈值内。

### 5.2 默认阈值

| 条件 | 默认值 |
|---|---|
| 最少去重视频数 | 3 |
| 分区覆盖率下限 | 0.6 |
| 标题覆盖率下限 | 0.6 |
| 观察时间最大年龄 | 180 天 |
| 观察时间边界 | `ageDays > 180` 才算 stale；恰好 180 天仍为 fresh |

附加要求：

- `provenance === "user-provided"`（候选与 sidecar 总体都必须满足）；
- `userConfirmed === true`；
- 至少 1 个有效分区特征；
- 至少 1 个有效标题 bigram；
- 无身份冲突；
- 观察时间不是缺失 / 非法 / 未来。

### 5.3 输出语义

- `eligibleForExploration === true` 仅表示满足本地技术准入条件。
- 不表示 B 站账号在线认证、视频元数据已被平台核验、推荐质量已被证明。
- `onlineVerified` 恒为 `false`。
- 不满足条件的候选不会被删除：输出 `pending-review` 或 `insufficient-data`，并保留原因。
- 本阶段不做排序、不做推荐、不进入 C3。

### 5.4 覆盖率口径

- 分区覆盖率 = 有有效分区的可用视频数 / 可用视频数。
- 标题覆盖率 = 能生成至少一个有效 bigram 的可用视频数 / 可用视频数。
- 分母是**视频数**，不是 `watchMs`；导入数据不生成、不推断观看时长。
- 没有可用视频时，覆盖率为 `null`，状态为 `no-data`。
- 冲突视频整体排除，不进入分子或分母。
- 标题 bigram 直接复用 `candidate-features.js` 的 `extractTitleBigrams`。

---

## 6. 来源与 C2 兼容性

| 约束 | 实现 |
|---|---|
| 不修改观看记录格式 | sidecar 独立，不写入 `biliDailyRecords` |
| 不修改 C1 兴趣画像口径 | 无 `watchMs` 字段，不参与 7 / 30 天窗口与分区时长占比 |
| 不修改 C2-1 身份规则 | 只读取 `stats.js` 的 UID 规范化 |
| 不修改 C2-2 资格结论 | 导入-only 候选在 C2-2 中仍是 `review` |
| 不修改 C2-3 特征口径 | `featureStatus`、`partitionCoverage`、`titleCoverage` 不被 sidecar 覆盖 |
| 不新增权限 | `manifest.json` 未修改 |
| 不新增 DOM 采集 | 无 DOM API |
| 不联网 | 无 `fetch` / `XMLHttpRequest` / B 站 API / 短链解析 |
| 不读取登录凭据 | 无 Cookie / token / 登录态读取 |
| 不写存储 | 无 `chrome.storage.local` |
| 不实现排序 | 无 TF-IDF、余弦、MMR |
| 不开发正式导入 UI | 本阶段只提供纯函数 |
| 不进入 C3 | 未新增排序或推荐代码 |

两条通道：

- **main lane**：观看历史 → C2-1 → C2-2 → C2-3。
- **exploration lane**：用户导入 → C2-4B sidecar → 未来 C3。

本阶段只定义 exploration lane 的证据结构，不合并进 main lane。

---

## 7. 安全、隐私与不可变

静态审查确认：

- 无 `eval`、`new Function`、`fetch`、`XMLHttpRequest`、`chrome.*`、`localStorage`、`innerHTML`。
- JSON 解析失败只返回 `invalid-json`，不回显原始文本、解析器消息或位置内容。
- 动态键使用 `Map` / `Set`，未知字段只计数，不写入对象原型；`__proto__` 作为分区名时不会污染原型。
- 所有输入按只读处理：解析返回新对象；构建与评估不修改传入的文档、sidecar、观看记录。
- 输出可 JSON 序列化往返。
- 不传输任何数据；不访问网络；不读取 Cookie / token / 登录态。
- 导入内容中的代码、URL、HTML 不会被执行。
- 冲突、缺失、超限一律以结构化诊断表达，不静默猜测。

已知加固点：

- 输入大小限制以 UTF-8 字节计，仅对 JSON 字符串强制；直接传入的超大对象不受字节上限约束（但只按固定字段遍历，不递归未知字段）。
- 分区中的控制 / 零宽 / 双向格式字符直接判为未识别，不做猜测性清洗。
- 标题 / 昵称 / 备注会先把控制字符替换为空格再 trim；先截断再做正则，避免对超长字符串做无界替换。

---

## 8. 测试设计

文件：`test-candidate-content-import.js`

- 测试框架：Node 内置 `assert/strict`，无第三方依赖。
- 时间注入：固定 `NOW = Date.parse("2026-11-11T12:00:00.000Z")`，不依赖真实日期。
- 数据：全部内存模拟，不读写 `chrome.storage.local`，不联网。
- 数量：60 项，覆盖指定的 45 个场景，并补充 URL 规范化、短链 / 空间链接、标签限制、未知字段、截断确定性、跨来源冲突、C2 隔离、lane 区分等。

分组：

| 组 | 覆盖 |
|---|---|
| 结构与版本（1–7） | 合法最小文档、JSON 往返、版本 / kind / provenance / 确认、空输入 |
| UID / BV / URL（8–18） | 规范化、非法值、安全整数、大小写、URL 一致性、危险协议、域名、短链、空间链接 |
| 去重与冲突（19–25） | 同 UID 合并、改名、同名不同 UID、重复 BV、跨 UID BV、元数据矛盾、缺失 + 有值 |
| 内容特征（26–31） | bigram 一致性、覆盖率分母、缺失标题、无视频、标签限制 |
| 时间与准入（32–41） | 全条件满足、视频不足、覆盖率不足、缺失 / 非法 / 未来 / 过期时间、180 天边界、自定义阈值 |
| 跨来源冲突（42–44） | 导入 vs 历史 UID、历史内部冲突、同 UID 正常情况 |
| 安全与隔离（45–60） | 冻结输入、JSON 往返、顺序无关、异常输入、上限、原型污染、无 watchMs、C1/C2 隔离、lane、未知字段、截断、conflicted、onlineVerified、保留候选 |

运行方式：

```powershell
cd D:\Bili-Daily
node test-candidate-content-import.js
```

预期输出格式：逐项 `PASS` / `FAIL`，末尾 `N/60 通过`；全部通过时退出码为 `0`。

**本次会话未执行，以上不构成通过结论。**

---

## 9. 实际执行结果

### 9.1 新增测试

- 命令：`node test-candidate-content-import.js`
- 状态：**未执行**
- 退出码：无
- 输出：无
- 原因：Bash 工具的安全分类器持续不可用，命令未真正运行。

### 9.2 原有 181 项回归

计划执行：

```powershell
node test-candidate-features.js
node test-candidate-quality.js
node test-candidate-pool.js
node test-interest-profile.js
node test-uid.js
node test-up-stats.js
node test-stats.js
```

- 状态：**全部未执行**
- 退出码：无
- 通过数：无
- 说明：不声称“原有 181 项保持通过”。需要在本机执行后回填实际输出。

### 9.3 语法检查

```powershell
node --check candidate-content-import.js
node --check test-candidate-content-import.js
node --check candidate-features.js
node --check candidate-pool.js
node --check stats.js
node --check interest-profile.js
node --check storage.js
node --check content.js
```

- 状态：**未执行**
- 退出码：无
- 说明：本会话无法确认语法检查结果；不以静态阅读代替 `node --check`。

### 9.4 manifest 检查

```powershell
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest.json OK')"
```

- 状态：**未执行**
- 说明：本阶段未修改 `manifest.json`。

### 9.5 静态审查记录（不等同于执行）

在无法运行 Node 的情况下，对源码与测试做了逐段静态核对，并修正了以下问题：

- 用码点构造控制 / 零宽 / 双向格式字符类，移除源码中的不可见字符，避免 Trojan Source 类风险；
- 增加 sidecar 总体 `provenance` 检查，防止伪造 sidecar 绕过来源约束；
- 在评估结果 `note` 中明确写入“未在线核验”，与测试 59 的断言一致；
- 构建阶段复制 `rejectedReasons`，避免 build 反向修改调用方持有的 parse 结果；
- 候选输出同时提供 `importedVideoCount` 与 `observedVideoCount`，后者与阶段要求字段名对齐；
- 测试中的 BV 长度、截断顺序、原型污染写法、覆盖率分母等已按静态推演修正。

以上均为静态阅读与代码修改，**没有**运行测试或 `node --check`，不能视为运行通过。

---

## 10. 性能观察

- 状态：**未实测**。
- 静态复杂度：
  - 解析：与候选数 × 视频数线性相关；
  - 去重：按 UID / BV 哈希，接近线性；
  - 特征：每个可用标题调用一次 `extractTitleBigrams`，与标题长度和词元数线性相关；
  - 评估：扫描本地记录一次 + 每个候选重新计算一次特征。
- 上限把单次处理规模限制在 500 候选 / 2000 视频 / 1 MiB 输入以内。
- 未获得任何耗时、内存或吞吐数据，因此不写具体毫秒数。

建议在本机执行以下命令获得真实观察（PowerShell）：

```powershell
cd D:\Bili-Daily
Measure-Command { node test-candidate-content-import.js }
```

---

## 11. 已知限制与风险

1. **未运行**：全部测试与语法检查未执行，当前只能确认代码与测试已写入磁盘，无法确认可运行性。
2. **阈值未经真实数据校准**：3 个视频、0.6 覆盖率、180 天均为实验值，不代表推荐质量。
3. **覆盖率为视频数口径**：与 C2-3 的 watchMs 口径不同，不能直接相加或比较。
4. **无在线核验**：`onlineVerified` 恒为 `false`；不做 UID 归属验证、不访问 B 站。
5. **标签暂不参与特征**：只保存与去重，留给后续阶段决定。
6. **截断会影响覆盖率**：总视频上限按 UID / BV 稳定截断；被截断的候选会带 `videosTruncated` / `globalVideoLimitDropped`，覆盖率只基于保留下来的视频。
7. **直接对象输入不受 1 MiB 限制**：只有 JSON 字符串强制字节上限；这是本地纯函数接口的边界。
8. **sidecar 为内存对象**：本阶段不持久化；刷新后需要重新构建。
9. **C2-4A 文档更正后的 HTML 可能滞后**：本次更正了 C2-4A Markdown 的 HTML 状态与生成记录，但未能运行生成脚本更新其 HTML。Markdown 是事实来源，HTML 需按第 12 节命令重新生成。
10. **未进入 C3**：没有排序、召回融合、MMR、余弦或 TF-IDF。

---

## 12. 报告 HTML 生成（未执行）

源文件：`docs/acceptance/C2-4B/C2-4B-import-report.md`
输出：`docs/acceptance/C2-4B/C2-4B-import-report.html`

在 `D:\Bili-Daily` 下执行：

```powershell
node tools/build-report-html.js `
  docs/acceptance/C2-4B/C2-4B-import-report.md `
  docs/acceptance/C2-4B/C2-4B-import-report.html
```

- 本次会话状态：**未执行，HTML 未生成**。
- 原因：Bash 工具通道持续返回安全分类器不可用错误，命令未真正运行。
- 不伪造退出码、字节数或截图。
- 该脚本只读取 Markdown 并写出单文件 HTML，CSS 内联，不联网、不引入依赖。

如同时需要刷新 C2-4A 的 HTML：

```powershell
node tools/build-report-html.js `
  docs/acceptance/C2-4A/C2-4A-research-report.md `
  docs/acceptance/C2-4A/C2-4A-research-report.html
```

---

## 13. 回滚

开发前快照：`rollback/before-c2-4b-import/`

包含 14 个既有文件：`stats.js`、`candidate-pool.js`、`candidate-features.js`、`interest-profile.js`、`storage.js`、`content.js`、`manifest.json`、7 个既有测试文件。

恢复（仅在确认既有文件被误改时使用）：

```powershell
cd D:\Bili-Daily
Copy-Item rollback\before-c2-4b-import\*.js .
Copy-Item rollback\before-c2-4b-import\manifest.json .
```

本阶段新增文件不在快照中；如需完全回退，删除：

```powershell
Remove-Item candidate-content-import.js
Remove-Item test-candidate-content-import.js
Remove-Item -Recurse docs\acceptance\C2-4B
```

注意：不要删除任何既有 `rollback/` 子目录。

---

## 14. 下一步（C3 之前的输入需求）

1. 在本机执行第 9、12 节命令，把实际退出码、通过数、字节数回填本报告。
2. 用真实导入样本校准 3 视频 / 0.6 覆盖率 / 180 天阈值。
3. 明确 C3 如何在 main lane（观看历史）与 exploration lane（用户导入）之间融合，且不把两者混为同一来源。
4. 明确标签是否进入 C3 特征；本阶段只存储、不参与。
5. 明确 sidecar 的持久化位置与生命周期（本阶段不写存储）。
6. 明确正式导入页面的人机确认流程；本阶段只要求 `userConfirmed === true`。

---

## 15. 停止声明

本阶段完成到“纯函数模块 + 测试文件 + 回滚快照 + 报告”为止。

未修改观看记录格式、未修改既有身份与兴趣口径、未新增权限、未新增 DOM 采集、未调用 B 站 API、未联网、未读取凭据、未修改 popup、未写入 `chrome.storage.local`、未实现排序、未开发导入页面、未进入 C3、未删除既有回滚备份。

由于工具通道不可用，**本报告没有声称任何测试通过**；所有未执行项已逐条标注。等待审核。
