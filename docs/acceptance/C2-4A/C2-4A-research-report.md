# Bili Daily C2-4A 验收报告：新 UP 主候选来源技术评审

- **阶段**：C2-4A（仅研究与设计，不修改正式业务代码）
- **日期**：2026-11-11
- **项目路径**：`D:\Bili-Daily`
- **前置状态**：C1、C2-1、C2-2、C2-3 已验收；181 项自动化测试已由项目所有者复核通过
- **本阶段交付**：来源评审、平台规则与隐私分析、C2-4B 接口草案、测试计划
- **详细设计**：见 [`docs/design/C2-4A-candidate-source-review.md`](../design/C2-4A-candidate-source-review.md)

---

## 0. 验收状态

| 项目 | 状态 | 说明 |
|---|---|---|
| 五类来源研究 | 已完成 | A–E 逐项分析，含降级策略 |
| 官方平台资料核查 | 部分完成 | robots.txt 已实际读取；开放平台/协议页面为 JS 渲染，正文使用搜索摘要并标记待复核 |
| 现有 C2 模块兼容性分析 | 已完成 | 读取 `candidate-pool.js`、`candidate-features.js`、`interest-profile.js`、`stats.js`、C2-1/C2-2/C2-3 文档 |
| C2-4B 接口草案 | 已完成 | 设计草案，未实现 |
| 代码修改 | 无 | 与 C2-3 快照 / 评审前哈希一致 |
| 181 项测试 | 未重跑 | 按本阶段要求，正式代码未变；用户已复核通过 |
| HTML 报告 | **已归档** | 文件 `docs/acceptance/C2-4A/C2-4A-research-report.html` 已存在（用户确认归档）；本会话未能执行命令复核其与 Markdown 的同步性，详见 11.3 |
| C2-4B / C3 | 未进入 | 本阶段停止，等待审核 |

---

## 1. 五类候选来源对比

| 维度 | A 本地历史 | B 手动 UID | C 用户导入视频+元数据 | D 当前页相关推荐 | E 官方授权 API |
|---|---|---|---|---|---|
| 数据来源 | 本地观看记录 | 用户输入 | 用户导入文件/文本 | 当前页 DOM | 开放平台 OAuth |
| 发现未观看 UP | 否 | 是（用户已知） | 是 | 是 | 按官方摘要：否，仅授权账号 |
| 真实 UID | 部分 | 仅格式 | 用户提供，未在线核验 | 可能（卡片链接） | 是（授权账号） |
| 真实标题 | 是 | 否 | 用户提供 | 通常是（可能截断） | 是（授权稿件） |
| 真实分区 | 部分 | 否 | 用户提供 | 通常否 | 可能（取决于 scope） |
| 标签 | 否（未采集） | 否 | 可选，用户提供 | 否 | 取决于接口 |
| 网络请求 | 否 | 否 | 否（纯本地导入） | 通常否（读页面） | 是 |
| 新增权限 | 否 | 否 | 否 | 可能不需要 host 权限，但新增采集 | 是（OAuth/网络/后端） |
| 用户授权 | 使用扩展/访问页面 | 主动输入 | 主动导入 | 隐含访问页面 | 明确 OAuth + UP 主授权 |
| 来源证据 | 平台观察 + 本地 | 用户自述 | 用户自述 | 页面观察（DOM 派生） | 官方授权 |
| 公开发布适用性 | 高 | 高 | **最高** | 中（需核实） | 低（个人不可行） |
| 无法获取时降级 | 未知桶/空 | 待核验 | 部分/缺失 | 跳过/空 | 回退 A/B/C |
| 本阶段结论 | 保留 | 保留 | **C2-4B 首选** | 暂缓 | 暂不采用 |

### 1.1 各来源要点

**A. 本地历史观看记录**

- 来自 `biliDailyRecords`，由 `content.js` 在当前视频页采集。
- 只能发现已观看/接触过的 UP 主，不能发现全新的 UP 主。
- UID、标题、分区来自平台页面；缺失时为空，不猜测。
- 无需网络、无需新增权限，现有 Edge 扩展可继续使用。
- 是本项目最可靠的“历史候选 + 兴趣画像”来源，但不是候选发现来源。

**B. 用户手动添加 UID**

- 只能证明“用户输入过这个 UID”，不能证明账号真实存在。
- 没有标题、分区、标签；C2-3 `featureStatus` 为 `missing`。
- 无需网络、无需权限；C2-2 资格为 `review`（`manual-unverified`）。
- 适合做身份种子，不适合单独构成“可推荐的新 UP 主”。

**C. 用户主动导入视频链接及元数据**

- 用户提供 UID、BV、标题、分区、可选标签和观察时间。
- 视频 URL 只含 BV，不含 UP 主 UID、标题或分区；这些必须由用户提供或另行取得。
- 纯本地导入，无需网络、无需新增权限；是 C2-4B 的首选。
- 所有内容标记为 `user-provided`，不等于平台观察或在线核验。

**D. 当前视频页已展示的相关推荐**

- 技术上可从 DOM 读取卡片，可能发现未观看 UP 主。
- UID 依赖卡片链接，标题可能截断，分区/标签通常没有。
- 需要新的页面采集逻辑；DOM 不稳定，卡片可能含广告/直播/课程。
- 现有 `content.js` 刻意不读取推荐/评论 mid，避免误配；采用 D 需要新的锚定与测试。
- 平台规则需进一步核实；本阶段不实现。

**E. B 站官方授权能力**

- 官方开放平台提供 OAuth 2.0、账号/视频管理、数据开放等能力。
- 官方文档摘要显示个人开发者入驻暂未开放，需企业资质、应用审核、后端密钥。
- 官方 API 围绕已授权用户/UP 主自己的账号与稿件，不是任意公开视频目录/搜索接口。
- 不能解决“发现任意新 UP 主”的问题；不适合作为 C2-4B 的最小原型。

---

## 2. 真实 UID 和内容特征的获取方式

### 2.1 URL 能提供什么

| 输入 | 可解析 | 不能解析 |
|---|---|---|
| `https://www.bilibili.com/video/BV1xx411c7mD` | BV | UID、标题、分区、标签 |
| `https://space.bilibili.com/123456` | UID | 视频标题、分区、标签 |
| `https://b23.tv/xxxx` | 短链，需网络跳转 | 本阶段不解析、不访问 |
| 仅 `av123456` | av 号 | 不能离线映射为 BV；本阶段不采用 |
| 仅昵称 | 无 | 不能作为身份 |

**结论：链接不是元数据。** 单独粘贴视频链接只能得到 BV；
要得到标题、分区、UP 主，必须另有来源（用户填写、页面观察或官方接口）。

### 2.2 内容元数据可信等级

| 等级 | 来源 | 本项目标记 | 能否称为“真实平台数据” |
|---|---|---|---|
| L0 | 用户凭记忆填写 | `user-provided` | 否，用户自述 |
| L1 | 用户从 B 站页面复制后导入 | `user-provided` + `sourceUrl` | 否，仍是用户自述；链接只作线索 |
| L2 | 扩展在当前页 DOM/结构化数据中观察 | `platform-observed`（未来） | 是，但受页面结构和时效限制 |
| L3 | B 站官方授权接口 | `official-authorized`（未来） | 是，受 scope 和授权范围限制 |

C2-4B 只实现 L0/L1。**L1 不会自动升级为 L2**：
“用户说它来自 B 站页面”不等于“扩展观察到了 B 站页面”。

### 2.3 不能做的事

- 不根据标题、昵称、封面或推荐卡片文字猜测 UID。
- 不根据标题猜测分区。
- 不把缺失字段填成默认值。
- 不把用户导入的内容写成观看记录。
- 不在没有授权的情况下调用 B 站接口或抓取页面。

---

## 3. 平台规则与隐私风险

### 3.1 核查方法与证据等级

- **已实际读取**：`https://www.bilibili.com/robots.txt`。
- **尝试读取但只取得标题（JS 渲染）**：
  - `https://openhome.bilibili.com/doc`
  - `https://openhome.bilibili.com/doc/4/eaf0e2b5-bde9-b9a0-9be1-019bb455701c`（账号授权）
  - `https://open.bilibili.com/agreement/developer-service`
  - `https://www.bilibili.com/protocal/licence.html`
- 对上述页面，使用搜索引擎返回的**官方页面摘要**作为线索，
  在本文标记“待人工复核”，不作为最终法律结论。
- 第三方 API 文档（Apifox 镜像、GitHub `bilibili-API-collect` 等）**没有**被用来认定官方授权能力。

### 3.2 robots.txt（已实际读取）

本次读取到的关键规则：

- `User-agent: *` 禁止 `/medialist/detail/`、`/index.html`、
  `/zh-Hant/`、`/en/`、`/ja/`、`/es/`、`/pt/`、`/id/`、`/th/`、`/ar/`。
- 针对 `facebookexternalhit`、`Facebot`、`Twitterbot`、`LinkedInBot`、
  `Slackbot`、`TelegramBot`、`Discordbot`、`WhatsApp`，只禁止
  `/medialist/detail/` 与 `/index.html`。
- 未看到 `Allow`；未看到对 `/video/*` 的禁止。

**解释边界：** robots.txt 不是授权，也不等于允许商业使用；
未禁止 `/video/*` 不代表可以批量抓取视频页。用户协议另有约束。

### 3.3 用户协议（官方页面摘要，待复核）

根据搜索引擎对官方《哔哩哔哩弹幕网用户使用协议》的条款摘录：

| 条款（摘要） | 内容要点 | 对本项目的含义 |
|---|---|---|
| §1.2 | 服务仅供非商业性使用；未经事先书面同意不得商业使用 | 免费本地工具风险较低，但发布前仍需确认 |
| §1.3 | 官方公布的方式是使用服务的唯一合法方式；其他途径获取可能被视为非法所得 | 不使用非官方接口、破解或绕过访问控制 |
| §5.6(3) | 未经事先明确书面许可，不得以机器人、蜘蛛、爬虫等自动程序获取平台服务、内容、数据 | 批量抓取页面/接口有明确风险；技术上可读不等于允许 |

> 以上为搜索摘要，未取得官方页面完整正文；发布前必须在浏览器中人工复核条款编号与原文。

### 3.4 开放平台（官方文档摘要，待复核）

- 提供 OAuth 2.0、用户管理、视频管理、数据开放等能力。
- 常见 scope：`USER_INFO`（授权用户基础信息）、`ARC_BASE`（稿件基础操作）、
  `ARC_DATA`（单个稿件数据）。
- 官方文档摘要显示：**“暂未开通个人开发者的申请入驻”**；入驻需要企业营业执照、
  申请公函、ICP 备案等资质；应用需审核，用户需在管理中心接受授权。
- 官方 API 的数据范围是**已授权用户/UP 主自己的账号与稿件**，
  不是任意公开视频/UP 主的目录或搜索接口。

**结论：**

- 官方授权能力可作为未来的高可信来源，但**不能解决 C2-4B 的“发现未知 UP 主”问题**。
- 个人开发者当前无法直接入驻；企业资质、服务端密钥、隐私合规都是硬门槛。
- 本文不把任何第三方镜像文档当作官方授权依据。

### 3.5 隐私风险

- 用户导入的 UID、标题、分区、备注可能构成个人信息或关联到个人；
  即使来自公开页面，也应本地处理、最小化、可删除。
- 不读取 Cookie、登录凭据、token；不采集 IP、设备信息、浏览器指纹。
- 不上传数据；不接入分析/广告 SDK；不保存原始页面 HTML、评论区、弹幕。
- 用户导入的 URL 可能含 `spm_id_from`、`vd_source` 等追踪参数；
  只保留 BV/UID，去掉 query/hash。
- 发布前需更新隐私说明，明确“本地处理、用户主动导入、未在线核验”。

### 3.6 四个层次必须分开

| 层次 | 例子 | 本项目结论 |
|---|---|---|
| 技术上能读取 | 当前页 DOM、内嵌 JSON、robots 未禁止的路径 | 不代表允许；D 暂缓 |
| 用户明确授权提供 | 手动 UID、导入文件 | 可作为 C2-4B 输入；标记 `user-provided` |
| 平台规则允许使用 | 官方 OAuth scope 内的授权数据 | 需企业资质/审核；当前不作为 C2-4B |
| 仍需进一步核实 | 读取推荐区是否属于“自动获取数据”；个人开发者入驻状态；条款最新版本 | 发布前人工/法务复核 |

### 3.7 红线

- 不读取 Cookie / 登录凭据 / token。
- 不调用非官方 B 站 API。
- 不设计绕过反爬、验证码、登录、频率限制或访问控制的方案。
- 不批量抓取页面；不滚动/等待推荐流。
- 不上传用户数据；不接入分析/广告 SDK。
- 不把用户导入数据说成“平台核验”或“官方授权”。
- 不在扩展中保存 client_secret / access_token；未来官方 API 必须服务端换 token。

---

## 4. 现有 C2 模块兼容性

### 4.1 字段语义

| 字段 | 现有语义 | 导入内容应如何表达 | 不能做什么 |
|---|---|---|---|
| `sources` | 固定 `watched` → `manual`；`mergePools` 只识别这两个 | 新增 `content-import` 需 C2-4B 明确扩展；原型阶段放 sidecar | 不能直接塞进现有池而不测试 |
| `evidence.fromWatchHistory` | 有本地观看记录 | 导入内容不设置 | 不能写成 `true` |
| `evidence.fromUserInput` | 用户手动提供 UID | 导入内容可设置 | 不能等同于平台观察 |
| `candidateType` | `returning` / `new` / `unknown` | 导入候选保持 `new` | 不能因导入内容改成 `returning` |
| `uidVerified` | 格式合法 + 有观看历史 | 导入候选仍为 `false` | 不能因 UID 格式对而设为 `true` |
| `onlineVerified` | 恒为 `false` | 仍为 `false` | 不能因导入/粘贴链接而设为 `true` |
| `eligibility` | C2-2：eligible / review / excluded | 导入候选在 C2-2 中仍是 `review` | 不能自动提升为 `eligible` |
| `featureStatus` | C2-3：ready / partial / missing，基于观看数据 | 导入-only 候选仍是 `missing` | 不能把“内容完整”写成 C2-3 `ready` |
| `partitionCoverage` | C2-3：已识别观看时长 / 总观看时长 | 导入-only 为 `null` / `no-data` | 不能用导入视频数伪造观看时长 |
| `titleCoverage` | C2-3：有 bigram 的视频数 / 观察视频数 | 导入-only 为 `null` / `no-data` | 不能把导入标题混入观看覆盖率 |

### 4.2 为什么不能写入 `biliDailyRecords`

如果把导入视频伪造成观看记录：

- 会改变 `watchMs`、`watchedVideoCount`、30 秒有效观看阈值；
- 会改变 C1 的 7 天 / 30 天窗口、分区占比、UP 主排名；
- 会改变 C2-1 的 `watchedBefore`、`candidateType`、`firstObservedAt`；
- 会改变 C2-2 的新鲜度、`fromWatchHistory`、`eligibility`；
- 会让 C2-3 的 `observedVideoCount`、`partitionCoverage`、`titleCoverage` 失真；
- 会让用户无法区分“我看过”和“我导入过”。

**因此：导入内容必须是独立 sidecar，不能进入观看记录。**

### 4.3 `sources` 扩展的兼容性问题

现有 `candidate-pool.js` 的 `mergePools` 只识别 `watched` 和 `manual`；
直接传 `sources: ["content-import"]` 会被忽略，候选可能变成 `unknown`。
因此：

- 原型阶段不要把导入候选合并进现有池；sidecar 独立存在。
- 未来合并需扩展 `SOURCE_ORDER`、`collectSources`、`classify`、`mergePools`
  和 C2-2 `assessCandidate`，并补测试。
- 这些修改属于 C2-4B 或更后阶段，本阶段不做。

### 4.4 与 C3 的输入关系

C3 需要两类特征：

1. **观看特征**：C2-3 的 `partitionFeatures`、`titleFeatures`、覆盖率、`featureStatus`；
2. **导入内容特征**：sidecar 的 `partitionCounts`、`titleTokens`、`contentStatus`、`provenance`。

C3 必须显式合并，并在输出/排序中保留来源标签；不能拼成一个不区分来源的向量。

---

## 5. 新候选身份资格设计

### 5.1 两轴模型：身份证据 × 内容证据

| 轴 | 取值 |
|---|---|
| 身份证据 | `watched` / `user-provided` / `platform-observed` / `official-authorized` / `conflicted` / `invalid` |
| 内容证据 | `complete` / `partial` / `missing` / `conflicted` |

> “可信内容”只指来源可追溯、内容完整、无冲突，不等于 B 站平台核验或官方授权。
> 题目中的“已取得可信内容信息的新 UP 主”在本报告中按此定义使用。

### 5.2 五类候选与 C3 准入

| 类别 | 身份证据 | 内容证据 | 现有 C2-2 资格 | C3 建议 |
|---|---|---|---|---|
| 历史观看 UP 主 | `watched` | C2-3 `ready/partial` | `eligible`（无冲突且新鲜） | 主排序（main lane） |
| 用户提供但未观看的 UP 主 | `user-provided` | `missing` | `review`（manual-unverified） | 不进入排序，等待内容 |
| 已取得内容信息的新 UP 主 | `user-provided` + sidecar | `complete` | 仍 `review` | 探索通道（exploration lane），低置信度、明确标注 |
| 数据不足的待核验候选 | `user-provided` | `partial/missing` | `review` | 不进入排序；保留，等待更多证据 |
| 身份冲突候选 | `conflicted` | `conflicted` | `review` / `excluded` | 不进入排序；冲突解决后再评估 |

**为什么历史候选和新候选不能混排：**

- 历史候选有真实观看时长和回访证据；新候选只有用户自述内容；
- 两者置信度不同，混排会让“用户自己导入的 UP 主”压过真实兴趣；
- C3 应使用两条通道或显式置信度权重，并标注来源。

**为什么不永久禁止未观看候选：**

- 用户主动导入说明存在探索意愿；
- 只要内容完整、来源明确、无冲突、时间新鲜，就应有机会进入探索通道；
- 数据不足只是“等待更多证据”，不是“永久排除”。

### 5.3 探索候选晋升条件（设计，未实现）

| 条件 | 建议阈值 | 说明 |
|---|---|---|
| UID 格式合法 | 必须 | 复用 `stats.cleanRecord` 的 UID 规则 |
| 用户明确确认导入 | `userConfirmed: true` | 没有确认则拒绝 |
| 来源记录 | `provenance: "user-provided"` | 不能声称平台核验 |
| 不同视频数 | ≥ 3 | 少于 3 个无法形成稳定内容特征；可配置 |
| 分区覆盖率 | ≥ 0.6 | 按导入视频数计算 |
| 标题覆盖率 | ≥ 0.6 | 按导入视频数计算 |
| 至少一个分区 | 必须 | 全部缺失分区则内容不足 |
| 至少一个标题 bigram | 必须 | 全部标题无法生成词元则内容不足 |
| 身份冲突 | 0 | 导入内部 + 与观看记录交叉检查 |
| 观察时间 | 合法、非未来、≤ 180 天 | 超过则 stale，进入待核验；不删除 |
| BV 去重 | 必须 | 同一 BV 只算一个视频；冲突元数据排除 |
| 在线核验声明 | 不允许 | `onlineVerified` 恒 false |

满足全部条件时，输出 `promotion.eligibleForExploration: true`；
否则输出 `false` + 结构化原因。C3 决定是否真正进入排序，C2-4B 只提供证据。

### 5.4 C3 两条通道

```text
main lane:
  C2-2 eligible（历史观看 + 无冲突 + 新鲜）
  + C2-3 ready/partial 观看特征
  → 正常内容相似度 / 时间衰减 / MMR

exploration lane:
  C2-2 review（用户提供，未观看）
  + C2-4B contentStatus complete
  + promotion.eligibleForExploration
  → 独立权重、独立配额、明确来源标签
```

建议：

- 探索通道单独配额（例如 10%–20%，由 C3 最终确定）；
- 不使用“观看时长”权重，改用内容完整度/新鲜度/来源置信度；
- 必须能一键关闭/清除；
- 不得伪装成“历史观看推荐”。

---

## 6. 最推荐的最小数据来源

**选择：C（用户主动导入视频链接与内容元数据）。**

理由：

- 本地：无网络、无 Cookie、无账号；
- 权限最小：不需要新增 manifest 权限；
- 用户可控：用户明确选择导入哪些候选；
- 可验证：结构化 JSON/文本，可严格校验、可测试；
- 可降级：缺字段/坏文件安全返回空结果；
- 不污染观看历史：独立 sidecar；
- 不依赖付费 API / 大型依赖：纯 JS 解析与校验。

**输入形态：**

1. JSON 文件导入（首选）：`<input type="file" accept="application/json,.json">`；
2. 文本框粘贴 JSON（备用，便于调试）；
3. 不接受任意网页 HTML、不接受自动抓取、不接受远程 URL 导入。

**输入必须包含：**

- `schemaVersion`、`kind`；
- `provenance: "user-provided"`；
- `userConfirmed: true`；
- 候选数组：`upUid`、`videos[]`；
- 每个视频：`bvid`（必需，用于去重）、`title` 或 `partition` 至少一个；
- 可选：`upName`、`tags`、`url`、`observedAt`、`sourceNote`。

**降级：**

| 情况 | 行为 |
|---|---|
| 文件为空 / 空候选 | `status: "empty"`，不抛异常 |
| JSON 解析失败 | `status: "invalid"`，`reason: "invalid-json"`，不回显原文 |
| 版本不支持 | `status: "invalid"`，`reason: "unsupported-schema"` |
| 候选 UID 非法 | 跳过该候选，计入 `invalidCandidates` |
| 视频无 BV | 跳过该视频，计入 `invalidVideos`；不猜测 |
| 标题/分区都缺失 | 保留视频但标记 `missing`，不虚构 |
| 观察时间非法/未来 | 标记 `unknown`/`invalid`，候选不晋升 |
| 超限 | 截断/拒绝并给出结构化原因，不崩溃 |
| 冲突 | 排除冲突视频，计数；候选 `contentStatus: "conflicted"` |

---

## 7. C2-4B 数据接口草案

> 设计草案，不是已实现代码。C2-4A 不创建任何运行时代码。

### 7.1 导入 JSON 草案

```json
{
  "schemaVersion": 1,
  "kind": "bili-daily-candidate-content-import",
  "provenance": "user-provided",
  "userConfirmed": true,
  "exportedAt": "2026-11-11T12:00:00+08:00",
  "sourceNote": "用户自述：从 B 站页面手动整理",
  "candidates": [
    {
      "upUid": "123456",
      "upName": "示例 UP",
      "observedAt": "2026-11-11T12:00:00+08:00",
      "videos": [
        {
          "bvid": "BV1xx411c7mD",
          "title": "示例标题",
          "partition": "科技",
          "tags": ["编程", "教程"],
          "url": "https://www.bilibili.com/video/BV1xx411c7mD"
        }
      ]
    }
  ]
}
```

### 7.2 校验规则

| 字段 | 规则 |
|---|---|
| `schemaVersion` | 必须为 `1`；其他版本拒绝 |
| `kind` | 必须精确匹配 |
| `provenance` | C2-4B 只接受 `"user-provided"`；其他值拒绝并说明未实现 |
| `userConfirmed` | 必须为 `true`；否则拒绝 |
| `candidates` | 数组，0..500；0 时返回 `empty` |
| `upUid` | 复用 `stats.cleanRecord` 的 UID 规则；非法跳过 |
| `upName` | 可选字符串，最长 100，仅展示 |
| `observedAt` | ISO 8601 或 epoch ms；非法/未来标记问题 |
| `videos` | 数组，1..50；候选总视频数 ≤ 2000 |
| `bvid` | 必需；去空格后匹配 `^BV[0-9A-Za-z]{10}$`（前缀 `BV` 大小写不敏感，规范化为大写；其余字符保留）；重复 BV 去重 |
| `title` / `partition` | 每个视频至少提供其一；两者都缺失则该视频无内容价值，计入诊断 |
| `title` | 可选字符串，最长 1000 UTF-16；控制/零宽字符清理 |
| `partition` | 可选字符串，最长 64 码点；空白/控制字符视为缺失 |
| `tags` | 可选字符串数组，最多 20 个，每个最长 50 |
| `url` | 可选，最长 2048；只接受 `https://` 的 B 站视频/空间链接；`b23.tv` 短链不解析；去掉 query/hash；不访问 |
| `sourceNote` | 可选，最长 500；仅记录，不参与特征 |
| 未知字段 | 不参与特征；计入 `unknownFields` 诊断，不执行 |

**安全规则：**

- 只接受 JSON，不执行 JS；不使用 `eval` / `new Function`。
- 拒绝 `__proto__`、`constructor`、`prototype` 作为动态键，或使用 `Map` / `Object.create(null)`。
- 拒绝 `javascript:`、`data:`、`file:` 等 URL scheme。
- 所有长度/数量上限在解析前检查；避免超大字符串/正则回溯。
- 不修改输入对象；返回新对象；结果可 `JSON.stringify` 往返。

### 7.3 输出 sidecar 草案

```js
buildCandidateContentEvidence(importDoc, options)
// → 只解析/校验导入文件本身，返回 sidecar（不读取观看记录）
//   options.now 可注入固定时间，便于测试

assessImportedContentCandidates(sidecar, records, options)
// → 与 biliDailyRecords 交叉检查同一 BV 的 UID 冲突
//   计算 promotion.eligibleForExploration
//   不修改 records，不写存储
```

顶层：

```js
{
  schemaVersion: 1,
  status: "ok" | "empty" | "invalid",
  reason: "",
  provenance: "user-provided",
  candidates: [ ... ],
  diagnostics: {
    candidatesIn, candidatesAccepted, candidatesInvalid,
    videosIn, videosAccepted, videosInvalid,
    duplicateVideos, conflictVideos,
    unknownFields, rejectedReasons
  },
  limits: { ... },
  note: "用户提供，未在线核验；不进入观看记录"
}
```

单候选：

```js
{
  upUid, upName,
  provenance: "user-provided",
  observedAt, observedAtState: "available" | "unknown" | "invalid",
  videos: [{ bvid, title, partition, tags, url, titleState, partitionState }],
  partitionCounts: [{ name, videoCount, shareOfImportedVideos }],
  titleTokens: [{ token, count, documentCount }],
  importedVideoCount,
  importedTitleCount,
  importedPartitionCount,
  importedTitleCoverage,
  importedPartitionCoverage,
  contentStatus: "complete" | "partial" | "missing" | "conflicted",
  promotion: {
    eligibleForExploration: false,
    reasons: [{ code, level, message }]
  },
  conflictVideoCount,
  reasons: []
}
```

> `contentStatus` 在 sidecar 中只表示**导入内部**的内容完整度。
> 与 `biliDailyRecords` 的跨来源冲突由 `assessImportedContentCandidates`
> 单独返回 `crossSourceConflictVideoCount` 并影响 `promotion`，
> 不修改 sidecar，也不修改观看记录。

### 7.4 适配边界

```text
C2-3 buildCandidateFeatures(records, pool)
  → 观看特征（watch-ms 基础）

C2-4B buildCandidateContentEvidence(importDoc)
  → 导入内容特征（video-count 基础）

C3 adapter
  → 按 upUid 连接两者
  → 保留 provenance / basis / confidence
  → main lane 与 exploration lane 分开
```

**明确不做：**

- 不把导入视频传给 `buildCandidateFeatures` 的 `records`；
- 不把导入视频合并进 `biliDailyRecords.days`；
- 不把 `importedPartitionCoverage` 写进 `partitionCoverage`；
- 不把 `contentStatus` 写进 `featureStatus`；
- 不把 `user-provided` 写成 `watched`。

### 7.5 存储策略

- **C2-4B 原型：不写 `chrome.storage.local`**；解析结果只在内存中返回。
- 如后续需要持久化，使用独立键（例如 `biliDailyCandidateImports`），
  与 `biliDailyRecords` 分离，并提供清除/导出。
- 原型阶段不新增 manifest 权限；文件导入使用标准 `<input type="file">`。
- 不在扩展中保存 OAuth token / client_secret；未来官方 API 需服务端方案。

---

## 8. 单元测试计划

C2-4B 建议至少 45 项，分为 8 组。以下为计划，**未执行**。

| 组 | 数量 | 覆盖 |
|---|---:|---|
| 结构与版本 | 6 | 合法最小输入、空输入、坏 JSON、版本、kind、userConfirmed |
| 身份与去重 | 7 | 非法 UID、规范化、重复 UID、重复 BV、元数据冲突、同名不同 UID、改名 |
| 内容特征 | 7 | 分区计数、bigram 规则、标点分段、缺失标题/分区、单字符、超长 |
| 来源与时间 | 6 | provenance 保留/拒绝、时间合法/缺失/未来/过期 |
| 冲突 | 5 | 导入内冲突、与观看记录冲突、冲突视频排除、状态、唯一计数 |
| 晋升条件 | 5 | 全满足、视频不足、分区不足、标题不足、冲突/过期 |
| 安全与不可变 | 5 | 原型污染、深度冻结、超限、危险 URL、JSON 往返 |
| 适配与隔离 | 4 | 不写观看记录、导入-only 仍 missing、C3 连接、空/坏输入 |

代表性用例：

1. 合法最小输入 → `status: "ok"`。
2. 空文件 → `status: "empty"`，不抛异常。
3. 坏 JSON → `status: "invalid"`，`invalid-json`。
4. `schemaVersion: 2` → 拒绝。
5. `provenance: "platform-observed"` → 拒绝并说明未实现。
6. 同一 BV 重复 → 只计一个视频。
7. 同一 BV 不同标题/分区 → `metadata-conflict`，不静默选择。
8. 同一 BV 两个 UID → 冲突，双方 `conflictVideoCount` 增加。
9. 导入 UID 与观看记录同一 BV 冲突 → 不修改观看记录。
10. 缺失标题 → 计入标题覆盖率分母。
11. 缺失分区 → 计入分区覆盖率分母。
12. 3 个视频、覆盖率 ≥ 0.6、无冲突、时间新鲜 → 可晋升探索。
13. 视频数不足 → 不可晋升，原因明确。
14. 超长标题/分区/tags → 有限上限，不崩溃。
15. `__proto__` 分区名 → 不污染原型。
16. 深度冻结输入 → 可处理且不被修改。
17. 危险 URL scheme → 拒绝。
18. 结果可 JSON 序列化往返。
19. 导入内容不改变 `biliDailyRecords`。
20. 导入-only 候选的 C2-3 `featureStatus` 仍为 `missing`。

> 完整 45 项清单见设计文档第 9 节。

---

## 9. 已知限制和待核查问题

### 9.1 已知限制

1. **用户自述数据可能不准确**：标题/分区/UID 可能过时、截断或误填；不做在线核验。
2. **没有平台侧身份验证**：除官方 OAuth 外，无法确认 UID 是否真实存在或属于该 UP 主。
3. **没有标签特征**：C2-3 不使用 tags；C2-4B 可保存但 C3 是否使用需另行设计。
4. **内容覆盖率是启发式**：3 个视频、0.6 覆盖率只是保守起点，未用真实分布校准。
5. **导入内容会过期**：180 天阈值是设计建议，需根据用户行为调整。
6. **无法发现用户不知道的 UP 主**：C 依赖用户主动提供；真正的“平台发现”需要 D/E，但当前不可行/未核实。
7. **D 的 DOM 不稳定**：B 站改版、广告卡、懒加载都会影响；本阶段不实现。
8. **E 的个人开发者路径不可用**：官方文档摘要显示个人入驻未开放；企业方案成本高。
9. **C3 尚未实现**：探索通道、权重、配额、MMR 都未设计完成；本阶段只提供输入边界。
10. **C1 没有用户级标题词向量**：C3 若要做内容相似度，需要从观看记录构建用户 token 画像；
    这是 C3 的新增数据需求。

### 9.2 待核查问题

| # | 问题 | 当前证据 | 核查方式 |
|---:|---|---|---|
| 1 | 官方开放平台个人开发者入驻是否仍关闭 | 官方文档搜索摘要称“暂未开通个人开发者申请入驻” | 浏览器打开官方入驻文档人工复核 |
| 2 | 是否存在可读取任意公开视频/UP 主目录的官方接口 | 搜索摘要显示 scope 围绕授权账号/稿件；未发现公开目录接口 | 逐页阅读开放平台“数据开放”文档 |
| 3 | 当前页推荐区 DOM 读取是否属于用户协议 §5.6(3) 的“自动获取数据” | 协议摘要禁止自动程序获取内容/数据 | 法务/平台书面确认 |
| 4 | 用户导入 B 站页面公开元数据并本地保存的合规性 | 用户主动、非商业、本地、最小化 | 发布前隐私/法务评审 |
| 5 | 用户协议/隐私政策最新版本与条款编号 | 搜索摘要显示不同更新日期 | 浏览器人工复核原文 |
| 6 | `tname` 分区体系是否稳定、是否需要映射 | 现有 C2-3 只按字符串；未做映射 | 抽样真实数据；C3 前评估 |
| 7 | tags 是否值得作为 C3 特征 | 当前未采集；导入可选 | C3 设计评审 |
| 8 | 180 天过期阈值是否合理 | 设计建议，无真实数据 | C2-4B/C3 真实数据观察 |
| 9 | Edge 商店对文件导入/本地数据的披露要求 | 未核查 | 发布前阅读 Edge 商店政策 |
| 10 | 是否需要隐私政策更新 | 新增导入数据类别 | 发布前更新并请用户确认 |

---

## 10. 是否可以进入 C2-4B

### 结论：**可以有条件进入 C2-4B。**

**推荐范围（最小原型）：**

- 只做“用户主动导入视频元数据”的解析、校验、sidecar 输出；
- 不联网、不抓页面、不调 API、不新增权限、不写 `chrome.storage.local`；
- 不修改 `candidate-pool.js`、`candidate-features.js`、`interest-profile.js`、
  `stats.js`、`storage.js`、`content.js`、popup、`manifest.json`；
- 新增独立模块（例如 `candidate-content-import.js`）与测试；
- 用独立测试证明：导入内容不进入观看记录、不改变 C2-1/C2-2/C2-3 结果。

**进入 C2-4B 前必须确认：**

1. 用户认可“用户自述、未在线核验”的产品语义；
2. 用户认可“导入内容不进入观看记录、不自动参与主排序”；
3. 用户认可“探索通道”是后续 C3 设计，不在 C2-4B 实现排序；
4. 平台条款的待核查项至少完成人工复核（尤其是 D/E 的合规性）；
5. C2-4B 的测试计划覆盖第 8 节的 45 项。

**不建议现在做：**

- 官方 API 接入（个人开发者不可行、需要企业资质/后端）；
- 当前页推荐区采集（DOM 不稳定、平台规则待核实、属于新采集）；
- 批量抓取、非官方 API、Cookie/登录信息读取；
- 把导入内容写入观看记录或直接混入 C2-2 `eligible`；
- 进入 C3 排序或 UI。

---

## 11. 实际执行结果

### 11.1 代码未修改验证

评审开始前与结束后，对现有文件做 SHA-256 比对：

| 文件 | 结果 |
|---|---|
| `candidate-pool.js` | 与 C2-3 回滚快照一致 |
| `stats.js` | 与 C2-3 回滚快照一致 |
| `interest-profile.js` | 与 C2-3 回滚快照一致 |
| `storage.js` | 与 C2-3 回滚快照一致 |
| `test-candidate-pool.js` | 与 C2-3 回滚快照一致 |
| `test-candidate-quality.js` | 与 C2-3 回滚快照一致 |
| `test-interest-profile.js` | 与 C2-3 回滚快照一致 |
| `test-stats.js` | 与 C2-3 回滚快照一致 |
| `test-uid.js` | 与 C2-3 回滚快照一致 |
| `test-up-stats.js` | 与 C2-3 回滚快照一致 |

- `candidate-features.js` SHA-256 前缀：`52b0086f49d4d949`；
- `test-candidate-features.js` SHA-256 前缀：`97f4ec4e92f953ab`；
- 本阶段未修改上述运行时代码；只新增/修改设计、验收与 HTML 文档。

### 11.2 测试执行情况

- **未运行 181 项测试。** 原因：本阶段要求仅研究设计，正式代码未修改；
  用户已在此前复核全部通过。
- 本报告不把“未运行”写成“通过”。

### 11.3 HTML 生成

- 源文件：`docs/acceptance/C2-4A/C2-4A-research-report.md`
- 输出：`docs/acceptance/C2-4A/C2-4A-research-report.html`
- 生成命令：

```powershell
node tools/build-report-html.js `
  docs/acceptance/C2-4A/C2-4A-research-report.md `
  docs/acceptance/C2-4A/C2-4A-research-report.html
```

- 实际执行结果：**文件已存在，但本会话无法复核生成过程。**
  用户已确认 Markdown 与 HTML 均已归档；本机文件系统中
  `docs/acceptance/C2-4A/C2-4A-research-report.html` 确实存在（已读取文件头验证）。
  但本次会话中的生成命令仍被工具层拒绝执行（安全分类器持续不可用），
  因此没有退出码、字节数与“由当前 Markdown 重新生成”的验证结果。
- 已确认的可执行部分：`node -v` → `v24.19.0`（Node.js 本身可用）。
- 待办：工具恢复后，在 `D:\Bili-Daily` 下重新执行上述命令，把实际退出码、
  文件字节数回填到文末“生成记录”，以确认 HTML 与当前 Markdown 同步。
- 本报告不把“文件存在”写成“已由本会话成功生成”，也不伪造退出码。

---

## 12. 回滚与停止

- 本阶段没有修改任何正式业务代码，因此不需要代码回滚。
- 如需移除本阶段文档：

```powershell
Remove-Item docs\design\C2-4A-candidate-source-review.md -ErrorAction SilentlyContinue
Remove-Item docs\acceptance\C2-4A -Recurse -ErrorAction SilentlyContinue
```

- 不触碰 `chrome.storage.local`，不删除任何真实观看数据。
- 本阶段到此停止，等待审核，不进入 C2-4B 或 C3。
- 阶段 E 的赛博二次元、原创动漫人物立绘与丰富动态效果设计规范继续保留，
  本阶段不涉及、不实施。

---

## 附录：参考来源

> 核查日期：2026-11-11。官方页面正文可能为 JS 渲染；标注“摘要”的条目来自搜索引擎返回的官方页面摘要，需人工复核。

| # | 来源 | 用途 | 读取情况 |
|---:|---|---|---|
| 1 | https://www.bilibili.com/robots.txt | robots 规则 | **已实际读取**关键规则 |
| 2 | https://www.bilibili.com/protocal/licence.html | 用户协议 §1.2/§1.3/§5.6(3) | 页面正文未直接取得；使用搜索摘要，待复核 |
| 3 | https://www.bilibili.com/blackboard/privacy-pc.html | 隐私政策 | 页面正文未直接取得；使用搜索摘要，待复核 |
| 4 | https://openhome.bilibili.com/doc | 开放平台文档目录 | 页面仅返回标题；使用搜索摘要，待复核 |
| 5 | https://openhome.bilibili.com/doc/4/eaf0e2b5-bde9-b9a0-9be1-019bb455701c | OAuth 2.0 / 账号授权 | 页面仅返回标题；使用搜索摘要，待复核 |
| 6 | https://openhome.bilibili.com/doc/4/cbdcee3b-f57e-5c7b-cf27-83892fb811c4 | 开发者入驻（个人未开放） | 使用官方页面搜索摘要，待复核 |
| 7 | https://openhome.bilibili.com/doc/4/d9554788-dcef-f139-6217-b487d41c3826 | 查询单一视频稿件详情 | 使用官方页面搜索摘要，待复核 |
| 8 | https://openhome.bilibili.com/doc/4/3f46ac2e-1318-3aa0-5548-0d9fd624d520 | 获取单个稿件数据 | 使用官方页面搜索摘要，待复核 |
| 9 | https://openhome.bilibili.com/doc/4/feb66f99-7d87-c206-00e7-d84164cd701c | 获取已授权用户基础公开信息 | 使用官方页面搜索摘要，待复核 |
| 10 | https://open.bilibili.com/agreement/developer-service | 开放平台开发者服务协议 | 页面仅返回标题；使用搜索摘要，待复核 |
| 11 | https://openhome.bilibili.com/agreement/privacy-policy | 开放平台隐私政策 | 搜索结果列出；未逐条读取，待复核 |

**未作为授权依据的第三方资料：**

- Apifox 镜像文档、GitHub `bilibili-API-collect`、第三方博客。
- 这些资料只能说明“存在非官方接口/社区整理”，不能证明官方授权；
  本项目不建议使用非官方接口。

---

## 生成记录

- 日期：2026-11-11
- 目标命令：

```powershell
node tools/build-report-html.js `
  docs/acceptance/C2-4A/C2-4A-research-report.md `
  docs/acceptance/C2-4A/C2-4A-research-report.html
```

- 执行状态：**本会话未能执行；文件由用户侧归档。**
  本次会话中所有需要执行脚本的 Bash 调用均被工具层拦截，命令没有真正运行；
  多次重试返回同一错误，因此没有可记录的退出码与字节数。
  用户随后确认 HTML 已归档，且文件系统中该文件确实存在（已读取文件头验证）。
- 原始错误信息（多次重试一致，原文）：

> DeepSeek-flash is temporarily unavailable (connection failed), so auto mode cannot determine the safety of Bash right now. Wait a moment and then try this action again. If it keeps failing, continue with other tasks that don't require this action and come back to it later.

- 旁证：`node -v` 可执行并返回 `v24.19.0`，说明 Node.js 环境正常，
  问题只出在命令执行通道，而非脚本本身。
- 后续处理：工具恢复后重新执行上面的命令，并在本节追加实际退出码、文件字节数，
  以确认归档 HTML 与当前 Markdown 同步。
- 事实声明：本报告与设计文档的全部研究内容均为已完成的阅读 / 设计工作；
  本会话未亲自执行 HTML 生成，已在第 0 节与 11.3 明确标注，未做任何伪造。
