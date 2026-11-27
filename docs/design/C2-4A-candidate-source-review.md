# C2-4A：新 UP 主候选来源技术评审（设计说明）

- **阶段**：C2-4A（仅研究与设计，不修改正式业务代码）
- **日期**：2026-11-11
- **项目**：Bili Daily（Edge MV3 扩展，本地记录 B 站观看情况）
- **前置阶段**：C1、C2-1、C2-2、C2-3 已验收；181 项自动化测试已由项目所有者复核通过
- **本阶段产出**：候选来源评审、平台规则与隐私风险、C2-4B 最小原型接口草案、测试计划
- **本阶段不做**：不写业务代码、不修改 manifest、不抓取页面、不调用外部 API、不进入 C2-4B / C3
- **阶段 E 说明**：赛博二次元、原创动漫人物立绘与丰富动态效果的设计规范继续保留，
  本阶段不涉及、不实施。

---

## 0. 结论摘要

1. **“拿到一个 UID”不等于“拿到一个可推荐的新 UP 主”。** 前者只是身份种子，
   后者至少还需要真实内容元数据（视频标题、分区、可选标签）、来源证据和内容完整度。
2. 五类来源中，**只有 C（用户主动导入视频链接与内容元数据）适合作为 C2-4B 的最小原型**：
   本地、无网络、无新增权限、用户可控、可严格校验。
3. **A（本地观看记录）不能发现未观看的新 UP 主**，只能提供历史候选与兴趣画像；
   B（手动 UID）只能提供身份种子，不提供内容特征；
   D（当前页相关推荐）技术上可读，但属于新的页面采集，DOM 不稳定且平台规则需进一步核实，本阶段不做；
   E（B 站官方授权能力）**按当前官方文档摘要不能用于发现任意公开的新 UP 主**：官方开放平台面向已授权账号/稿件，
   且当前官方文档显示个人开发者入驻未开放，需企业资质，不适合个人本地 Edge 扩展直接采用。
4. **不建议把用户导入的视频写入 `biliDailyRecords`。** 导入内容没有真实观看时长，
   写入观看记录会污染观看数、30 秒阈值、时间窗口、C1 画像、C2-1 召回和 C2-2 新鲜度。
5. 建议在 C2-4B 新增**独立的候选内容证据 sidecar**（按 UID 索引），
   与 C2-3 的观看特征并列，由 C3 显式合并；C2-1 / C2-2 / C2-3 现有字段和语义不改。
6. **用户主动导入仍然不是在线核验。** `onlineVerified` 必须保持 `false`，
   `uidVerified` 仍只表示“格式合法 + 有本地观看记录”；导入内容标记为 `user-provided`。
7. **不永久禁止未观看候选。** 设计一条可验证的 `exploration` 晋升路径：
   身份合法 + 用户明确确认 + 内容完整 + 无冲突 + 观察时间新鲜，才允许以“探索候选”身份进入 C3；
   数据不足的候选保持待核验，不删除、不伪造。

**结论：可以有条件进入 C2-4B。** 条件见第 12 节。

---

## 1. 问题拆解：五个必须分开的问题

| 问题 | 需要回答 | 失败时的典型错误 |
|---|---|---|
| 1. 获取候选 UID | 这个 UID 从哪里来？格式是否合法？ | 把昵称、标题或推荐卡片文字当成 UID |
| 2. 验证 UID 来源可信度 | 是平台观察到的，还是用户自述的？是否在线核验？ | 把“用户粘贴”写成“已核验” |
| 3. 获取内容信息 | 标题、分区、标签从哪里来？是真实字段还是猜测？ | 只拿到 UID 就声称有内容特征 |
| 4. 判断特征完整性 | 有多少视频、多少分区、多少标题？缺失如何计数？ | 用 0 或 100% 伪装“无数据” |
| 5. 为 C3 提供可靠输入 | 哪些候选可以进入排序？权重和来源如何区分？ | 把探索候选与历史候选混成一个分数 |

本评审后续所有设计都围绕这五个问题展开。

---

## 2. 五类候选来源逐项分析

### A. 本地历史观看记录

**数据从哪里来**

- `biliDailyRecords`：由 `content.js` 在当前视频页采集，经 `storage.js` 写入本地。
- 字段包括 `bvid`、`title`、`upName`、`upUid`、`partition`、`watchMs`、时间戳等。
- `content.js` 以当前 BV 为锚点，只读取当前 `videoData` 的 `owner.mid`；
  明确不读取评论区 / 相关推荐中的 mid（`test-uid.js` 第 4、5 条测试）。

**能否发现未观看过的新 UP 主**

- **不能。** 该来源只包含用户已经观看/接触过的视频和 UP 主。
- 可以用来做“回访候选”和兴趣画像，但不能扩大候选发现范围。

**UID / 标题 / 分区**

| 维度 | 能否获得 | 说明 |
|---|---|---|
| 真实 UID | 部分可以 | 页面 `owner.mid` 可读时才有；缺失则为 `null` |
| 真实标题 | 可以 | 当前视频标题，来自页面结构化数据或 DOM |
| 真实分区 | 部分可以 | 页面 `tname` / `tname_v2` 或 DOM；缺失为空 |
| 标签 | 当前未采集 | 不作为现有记录字段 |

**网络 / 权限 / 授权**

- 无需额外网络请求；现有 content script 在视频页运行。
- 现有 `manifest.json` 仅有 `storage` 权限，content script 匹配 `https://www.bilibili.com/video/*`。
- 用户通过使用扩展和访问页面间接提供；不需要新授权弹窗。

**来源证据**

- 这是本项目最可靠的本来源：平台页面观察 + 本地保存，但仍不是“B 站在线核验”。
- C2-1 的 `fromWatchHistory` / `uidVerified` 已表达该证据等级。

**公开发布的 Edge 扩展适用性**

- 高：现有架构已采用，权限最小，数据本地。

**数据无法获取时如何降级**

- UID 缺失：不生成候选，只计数；不按昵称猜测。
- 分区/标题缺失：进入 C2-3 的未知桶或缺失计数，不虚构。
- 页面结构变化：保留为空，不崩溃。

**结论：A 是“历史候选 + 兴趣画像”的来源，不是“新 UP 主发现”的来源。**

---

### B. 用户手动添加 UP 主 UID

**数据从哪里来**

- 用户在 popup 中输入 UID（可选昵称、时间），由 `buildFromManual` 校验。
- 只证明“用户输入过这个 UID”，不证明账号存在、活跃或属于该用户。

**能否发现未观看过的新 UP 主**

- **可以，但仅限用户已经知道的 UP 主。** 这不是平台推荐，也不扩大发现范围。

**UID / 标题 / 分区**

| 维度 | 能否获得 | 说明 |
|---|---|---|
| 真实 UID | 格式可验证，真实性未验证 | 只能确认正整数、安全整数、字符串规范 |
| 真实标题 | 不能 | 输入中没有视频 |
| 真实分区 | 不能 | 输入中没有视频 |
| 标签 | 不能 | 输入中没有标签 |

**网络 / 权限 / 授权**

- 仅 UID 时无需网络、无需新权限。
- 用户主动输入是明确的用户动作，但不是平台侧授权。

**来源证据**

- `sources: ["manual"]`、`evidence.fromUserInput: true`；
- `uidVerified: false`（因为没有观看历史）；
- `onlineVerified: false`（永远）；
- C2-2 `assessCandidate` 会给出 `manual-unverified`，资格为 `review`。

**公开发布的 Edge 扩展适用性**

- 高，适合作为“候选种子”，但 UI 必须明确写“未在线核验”。

**数据无法获取时如何降级**

- UID 非法：拒绝并给出结构化原因，不回显敏感输入。
- 没有内容：候选保留，`featureStatus: "missing"`，覆盖率 `null` / `no-data`，不进入 C3 主排序。

**结论：B 只是身份种子，不能单独构成“可推荐的新 UP 主”。**

---

### C. 用户主动导入视频链接及相关元数据

**数据从哪里来**

- 用户粘贴/导入一份结构化数据：候选 UID、视频 BV、标题、分区、可选标签、可选来源备注、观察时间。
- **视频 URL 本身只包含 BV，不包含 UP 主 UID、标题或分区。**
  - `https://www.bilibili.com/video/BV1xx411c7mD` → 只能解析出 BV。
  - `https://space.bilibili.com/123456` → 只能解析出 UID。
  - 标题、分区、UP 主身份必须由用户另外提供，或者由扩展访问页面/接口取得。
- 本方案**不访问页面、不调用接口**，因此所有内容元数据都标记为“用户自述”。

**能否发现未观看过的新 UP 主**

- **可以。** 用户可以选择任何自己知道的 UP 主/视频，包括从未观看过的。

**UID / 标题 / 分区**

| 维度 | 能否获得 | 说明 |
|---|---|---|
| 真实 UID | 用户提供，格式可校验 | 必须显式提供；不从标题/昵称猜测 |
| 真实标题 | 用户提供 | 不是平台观察值；可能过时、截断或不准确 |
| 真实分区 | 用户提供 | 同上 |
| 标签 | 可选，用户提供 | 本阶段不作为 C2-3 特征；C3 可评估 |

**网络 / 权限 / 授权**

- 纯本地导入：**无需网络、无需新增浏览器权限、无需 B 站账号授权**。
- 可通过 popup 的 `<input type="file">` + `FileReader`，或文本框粘贴实现；
  但 C2-4A 不实现 UI。
- 用户主动导入是明确动作；仍需在 UI 中说明“数据由你提供，平台未核验”。

**来源证据**

- `provenance: "user-provided"`；
- 可保留 `sourceNote`、`importedAt`、`observedAt`；
- 与 `fromWatchHistory` 严格分开，不能写成 `watched`；
- `onlineVerified` 仍为 `false`。

**公开发布的 Edge 扩展适用性**

- **最高（在五类中）。** 本地、无网络、无新增权限、用户可控、可严格校验。
- 风险主要是数据准确性和用户误用，而不是平台抓取。

**数据无法获取时如何降级**

- 没有 UID：拒绝为候选，不按昵称猜测。
- 没有 BV：拒绝该视频（无法可靠去重），或要求用户补充 BV；不虚构。
- 没有标题/分区：保留视频但计入缺失；候选为 `partial` / `missing`。
- 没有观察时间：标记 `unknown`，不伪造时间；候选进入待核验。
- 文件损坏/超限：安全返回空结果 + 结构化错误，不抛异常。

**结论：C 是 C2-4B 的最小原型来源。**

---

### D. 用户当前访问的视频页面中已经展示的相关推荐信息

**数据从哪里来**

- 当前视频页 DOM 中的“相关推荐”卡片、侧栏、播放结束推荐等。
- 卡片可能包含：标题、UP 主昵称、封面、播放量、时长、链接；
  链接可能包含 `space.bilibili.com/<uid>` 或视频 BV。
- 分区（`tname`）通常**不显示**在推荐卡片上；标签也不显示。

**能否发现未观看过的新 UP 主**

- **可以。** 相关推荐经常包含用户未观看过的 UP 主。

**UID / 标题 / 分区**

| 维度 | 能否获得 | 说明 |
|---|---|---|
| 真实 UID | 可能 | 需要卡片链接是个人空间链接；广告/直播/课程卡片可能没有 |
| 真实标题 | 通常可以 | 卡片标题可能被截断 |
| 真实分区 | 通常不能 | 卡片一般不展示分区；不能从标题猜 |
| 标签 | 不能 | 卡片不展示标签 |

**网络 / 权限 / 授权**

- 读取当前已加载页面的 DOM，通常不需要额外网络请求；
  但可能需要滚动/等待懒加载，属于新的页面采集逻辑。
- 现有 content script 已匹配视频页，理论上不需要新增 host 权限；
  但会增加对页面结构的依赖和隐私面。
- 用户访问页面是隐含动作，不等于用户明确同意扩展读取推荐区。

**来源证据**

- 属于“平台页面观察”，但来源是 DOM 派生、易变、可能被个性化/广告污染；
- 必须逐卡片锚定，不能把推荐卡片的 UID 误配给当前视频；
- 现有 `content.js` 刻意避免读取推荐/评论 mid，若要采用 D，需要新的采集器和新的测试。

**公开发布的 Edge 扩展适用性**

- **中等风险。** 技术上可行，但：
  - DOM 选择器不稳定，B 站改版会失效；
  - 推荐卡片可能含广告、直播、课程，不一定是有内容的 UP 主视频；
  - 分区/标签缺失，内容特征不完整；
  - 用户可能不希望扩展读取推荐区；
  - 平台用户协议对自动化获取数据有约束，需进一步核实。
- 本阶段明确不实现；不建议作为 C2-4B 的首选。

**数据无法获取时如何降级**

- 卡片没有 UID/标题：跳过，不猜测。
- 没有分区：只保留标题特征，分区覆盖率记 0/缺失。
- DOM 结构变化：返回空结果，不崩溃，不误配。

**结论：D 是未来的可选来源，不是 C2-4B 的最小风险来源。**

---

### E. 通过 Bilibili 正式授权能力获取候选数据

**数据从哪里来**

- 哔哩哔哩开放平台（`openhome.bilibili.com` / `open.bilibili.com`）的 OAuth 2.0 授权接口。
- 官方文档目录包含账号授权、用户管理、视频管理、数据开放等能力；
  常见 scope 包括 `USER_INFO`、`ARC_BASE`、`ARC_DATA` 等。
- 授权流程：应用申请与审核 → 用户/UP 主在授权页勾选 scope → 回调 code → 换取 access_token。

**能否发现未观看过的新 UP 主**

- **不能（按当前官方能力理解）。** 官方接口围绕“已授权用户/UP 主自己的账号与稿件”，
  不是任意公开视频/UP 主的目录或搜索接口。
- 因此它不能解决“为用户发现未知 UP 主”的核心问题；它最多能验证/读取用户自己授权的账号数据。

**UID / 标题 / 分区**

| 维度 | 能否获得 | 说明 |
|---|---|---|
| 真实 UID | 可以（授权账号） | 来自 OAuth 授权用户，不是任意 UP 主 |
| 真实标题 | 可以（授权账号的稿件） | 取决于 scope |
| 真实分区 | 可能可以 | 取决于稿件接口返回字段与 scope |
| 标签 | 取决于接口 | 需逐接口核实 |

**网络 / 权限 / 授权**

- 需要网络、应用审核、client_id/client_secret、OAuth 授权；
- 浏览器扩展**不应保存 client_secret**；通常需要后端服务做 code 换 token；
- 需要开放平台开发者资质；官方文档搜索摘要显示**个人开发者入驻暂未开放**，需企业资质；
- 需要 UP 主/用户明确授权，且数据使用受开发者协议约束。

**来源证据**

- 这是最强的官方授权证据；如果未来接入，`onlineVerified` 才可能对“已授权账号/scope”变为 true。
- 但本阶段没有接入，不能把任何现有数据标成官方核验。

**公开发布的 Edge 扩展适用性**

- **低（当前）。** 个人开发者无法直接入驻；企业资质、应用审核、后端密钥、隐私政策、
  数据删除机制都是硬门槛；且接口不能发现任意新 UP 主。
- 不适合作为 C2-4B 的最小原型。

**数据无法获取时如何降级**

- 没有企业资质/审核：不使用，回退到 A/B/C。
- 用户拒绝授权：不使用，不影响本地功能。
- token 失效：清理授权，不缓存敏感凭据。

**结论：E 是未来的合规增强选项，不是当前可行的候选发现来源。**

---

### 2.6 五类来源对比矩阵

| 维度 | A 本地历史 | B 手动 UID | C 用户导入视频+元数据 | D 当前页相关推荐 | E 官方授权 API |
|---|---|---|---|---|---|
| 数据来源 | 本地观看记录 | 用户输入 | 用户导入文件/文本 | 当前页 DOM | 开放平台 OAuth |
| 发现未观看 UP | 否 | 是（用户已知） | 是 | 是 | 否（仅授权账号） |
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

---

## 3. 真实 UID 与内容特征的获取方式

### 3.1 URL 能提供什么

| 输入 | 可解析 | 不能解析 |
|---|---|---|
| `https://www.bilibili.com/video/BV1xx411c7mD` | BV | UID、标题、分区、标签 |
| `https://space.bilibili.com/123456` | UID | 视频标题、分区、标签 |
| `https://b23.tv/xxxx` | 短链，需要网络跳转才能得到 BV/UID | 本阶段不解析、不访问 |
| 仅 `av123456` | av 号 | 不能离线映射为 BV；本阶段不采用 |
| 仅昵称 | 无 | 不能作为身份 |

**结论：链接不是元数据。** 单独粘贴视频链接只能得到 BV；
要得到标题、分区、UP 主，必须另有来源（用户填写、页面观察或官方接口）。

### 3.2 内容元数据的可信来源等级

| 等级 | 来源 | 本项目标记 | 能否称为“真实平台数据” |
|---|---|---|---|
| L0 | 用户凭记忆填写 | `user-provided` | 否，用户自述 |
| L1 | 用户从 B 站页面复制后导入 | `user-provided` + `sourceUrl` | 否，仍是用户自述；链接只作线索 |
| L2 | 扩展在当前页 DOM/结构化数据中观察 | `platform-observed`（未来） | 是，但受页面结构和时效限制 |
| L3 | B 站官方授权接口 | `official-authorized`（未来） | 是，受 scope 和授权范围限制 |

C2-4B 只实现 L0/L1，不实现 L2/L3。L1 也不能自动升级为 L2：
“用户说它来自 B 站页面”不等于“扩展观察到了 B 站页面”。

### 3.3 不能做的事

- 不根据标题、昵称、封面或推荐卡片文字猜测 UID。
- 不根据标题猜测分区。
- 不把缺失字段填成默认值（如“未知分区”“综合区”）。
- 不把用户导入的内容写成观看记录。
- 不在没有授权的情况下调用 B 站接口或抓取页面。

---

## 4. 平台规则、授权与隐私

### 4.1 核查方法与证据等级

本次核查遵循“官方域名优先、第三方仅作线索”的原则：

- 直接访问并读取：`https://www.bilibili.com/robots.txt`（成功）。
- 尝试访问但只取得页面标题（JS 渲染，正文未由 WebFetch 取得）：
  - `https://openhome.bilibili.com/doc`
  - `https://openhome.bilibili.com/doc/4/eaf0e2b5-bde9-b9a0-9be1-019bb455701c`（账号授权）
  - `https://open.bilibili.com/agreement/developer-service`
  - `https://www.bilibili.com/protocal/licence.html`
- 对上述页面，使用搜索引擎返回的官方页面摘要作为**线索**，
  在本文中明确标记“待人工复核”，不作为最终法律结论。
- 第三方 API 文档（Apifox 镜像、GitHub `bilibili-API-collect` 等）**没有被用来认定官方授权能力**；
  它们只用于理解非官方接口的存在与风险，本文不建议使用。

> 核查日期：2026-11-11。平台条款可能更新，发布前必须重新核对。

### 4.2 robots.txt（已实际读取）

本次读取到的 `https://www.bilibili.com/robots.txt` 关键规则：

- `User-agent: *` 禁止：
  - `/medialist/detail/`
  - `/index.html`
  - `/zh-Hant/`、`/en/`、`/ja/`、`/es/`、`/pt/`、`/id/`、`/th/`、`/ar/`
- 另一组针对 `facebookexternalhit`、`Facebot`、`Twitterbot`、`LinkedInBot`、
  `Slackbot`、`TelegramBot`、`Discordbot`、`WhatsApp`，只禁止 `/medialist/detail/`
  和 `/index.html`（不含上述语言根路径）。
- 未看到 `Allow` 指令；**未看到对 `/video/*` 的禁止**。

**解释边界：**

- robots.txt 只是爬虫偏好声明，**不是授权**，也不等于“允许商业使用”。
- 未禁止 `/video/*` 不代表可以批量抓取视频页；用户协议另有约束（见 4.3）。
- 本项目不设计批量爬虫，也不绕过任何访问控制。

### 4.3 用户协议（官方页面，正文待人工复核）

根据搜索引擎对官方《哔哩哔哩弹幕网用户使用协议》
（`https://www.bilibili.com/protocal/licence.html`，摘要显示更新 2025-04-30、
生效 2025-05-07）的条款摘录：

| 条款（摘要） | 内容要点 | 对本项目的含义 |
|---|---|---|
| §1.2 | 服务仅供用户非商业性使用；未经事先书面同意不得用于商业目的 | 免费、非商业的本地工具风险较低，但发布前仍需确认 |
| §1.3 | 官方公布的方式是使用服务的唯一合法方式；其他途径获取可能被视为非法所得 | 不应使用非官方接口、破解客户端或绕过访问控制 |
| §5.6(3) | 未经事先明确书面许可，不得以机器人、蜘蛛、爬虫等自动程序获取平台服务、内容、数据 | **批量抓取页面/接口有明确风险**；即使技术上可读，也不等于允许 |

> 以上为搜索摘要，未取得官方页面完整正文。发布前必须在浏览器中人工复核条款编号与原文。

### 4.4 开放平台（官方文档，正文待人工复核）

根据官方文档页面与搜索摘要：

- 开放平台提供 OAuth 2.0 授权、用户管理、视频管理、数据开放等能力。
- 常见 scope：
  - `USER_INFO`：获取已授权用户基础公开信息（如 `openid`、昵称、头像）；
  - `ARC_BASE`：视频稿件基础操作；
  - `ARC_DATA`：获取单个稿件数据（播放、点赞、评论等）。
- 官方文档摘要显示：**“暂未开通个人开发者的申请入驻”**，入驻需要企业营业执照、
  申请公函、ICP 备案等资质；应用需审核，用户需在管理中心接受授权。
- 官方 API 的数据范围是**已授权用户/UP 主自己的账号与稿件**，
  不是任意公开视频/UP 主的目录或搜索接口。

**结论：**

- 官方授权能力可以作为未来的“高可信来源”，但**不能解决 C2-4B 的“发现未知 UP 主”问题**。
- 个人开发者当前无法直接入驻；企业资质、服务端密钥、隐私合规都是硬门槛。
- 本文不把任何第三方镜像文档当作官方授权依据。

### 4.5 隐私政策（官方页面，正文待人工复核）

根据官方隐私政策页面与搜索摘要：

- B 站隐私政策区分“基础功能信息”和“扩展功能信息”，并说明会收集浏览/播放日志、
  设备信息、IP、网络信息等；公开信息（昵称、头像、IP 属地等）可能展示。
- 本项目不读取 Cookie、不读取登录凭据、不采集设备信息、不上传数据；
  只处理用户本地已有的观看记录和用户主动导入的候选元数据。
- 用户导入的标题、分区、UID、备注仍可能构成个人信息或关联到个人；
  必须本地处理、最小化、可删除，并在隐私说明中披露。

### 4.6 四个层次必须分开

| 层次 | 例子 | 本项目结论 |
|---|---|---|
| 技术上能读取 | 当前页 DOM、页面内嵌 JSON、robots 未禁止的路径 | 不代表允许；D 暂缓 |
| 用户明确授权提供 | 用户手动输入 UID、导入文件 | 可作为 C2-4B 输入；标记 `user-provided` |
| 平台规则允许使用 | 官方 OAuth scope 内的授权数据 | 需要企业资质/审核；当前不作为 C2-4B |
| 仍需进一步核实 | 读取当前页推荐区是否属于“自动获取数据”；个人开发者入驻状态；条款最新版本 | 发布前人工/法务复核 |

### 4.7 本项目的红线

- 不读取 Cookie、`document.cookie`、localStorage/sessionStorage 中的登录信息。
- 不调用非官方 B 站 API（包括 `api.bilibili.com/x/web-interface/view` 等）。
- 不设计绕过反爬、验证码、登录、频率限制或访问控制的方案。
- 不批量抓取页面；不等待/滚动加载推荐流。
- 不上传用户数据；不接入分析/广告 SDK。
- 不把用户导入的数据说成“平台核验”或“官方授权”。
- 不在扩展中保存 client_secret / access_token；未来如接官方 API，必须服务端换 token。

---

## 5. 与现有 C2 模块的兼容性

### 5.1 字段语义对照

| 字段 | 现有语义 | 导入内容应如何表达 | 不能做什么 |
|---|---|---|---|
| `sources` | 固定 `watched` → `manual`；`mergePools` 只识别这两个 | 新增 `content-import` 需要 C2-4B 明确扩展；原型阶段放 sidecar | 不能把 `content-import` 直接塞进现有池而不测试 |
| `evidence.fromWatchHistory` | 有本地观看记录 | 导入内容不设置 | 不能把导入写成 `true` |
| `evidence.fromUserInput` | 用户手动提供 UID | 导入内容可设置 | 不能等同于平台观察 |
| `candidateType` | `returning` / `new` / `unknown` | 导入候选保持 `new`（若已有 UID 候选） | 不能因为导入了内容就改成 `returning` |
| `uidVerified` | 格式合法 + 有观看历史 | 导入候选仍为 `false` | 不能因为 UID 格式对就设为 `true` |
| `onlineVerified` | 恒为 `false` | 仍为 `false` | 不能因为用户导入或粘贴链接就设为 `true` |
| `eligibility` | C2-2：eligible / review / excluded | 导入候选在 C2-2 中仍是 `review`（无观看历史） | 不能自动提升为 `eligible` |
| `featureStatus` | C2-3：ready / partial / missing，基于观看数据 | 导入-only 候选在 C2-3 中仍是 `missing` | 不能把“内容完整”写成 C2-3 的 `ready` |
| `partitionCoverage` | C2-3：已识别观看时长 / 总观看时长 | 导入-only 为 `null` / `no-data` | 不能用导入视频数伪造观看时长 |
| `titleCoverage` | C2-3：有 bigram 的视频数 / 观察视频数 | 导入-only 为 `null` / `no-data` | 不能把导入标题混入观看标题覆盖率 |

### 5.2 为什么不能把导入视频写入 `biliDailyRecords`

如果把导入视频伪造成观看记录：

- 会改变 `watchMs`、`watchedVideoCount`、30 秒有效观看阈值；
- 会改变 C1 的 7 天 / 30 天窗口、分区占比、UP 主排名；
- 会改变 C2-1 的 `watchedBefore`、`candidateType`、`firstObservedAt`；
- 会改变 C2-2 的新鲜度、`fromWatchHistory`、`eligibility`；
- 会让 C2-3 的 `observedVideoCount`、`partitionCoverage`、`titleCoverage` 失真；
- 会让用户无法区分“我看过”和“我导入过”。

**因此：导入内容必须是独立的证据通道，不能进入观看记录。**

### 5.3 推荐的 sidecar 结构

按 UID 索引的独立对象：

```js
{
  schemaVersion: 1,
  kind: "bili-daily-candidate-content",
  candidates: [
    {
      upUid: "123456",
      upName: "示例 UP",
      provenance: "user-provided",
      observedAt: 1762776000000,
      observedAtState: "available", // available | unknown | invalid
      videos: [
        {
          bvid: "BV1xx411c7mD",
          title: "示例标题",
          partition: "科技",
          tags: ["编程"],
          url: "https://www.bilibili.com/video/BV1xx411c7mD"
        }
      ],
      partitionCounts: [
        { name: "科技", videoCount: 3, shareOfImportedVideos: 0.75 }
      ],
      titleTokens: [
        { token: "科技", count: 2, documentCount: 1 }
      ],
      importedVideoCount: 4,
      importedTitleCount: 4,
      importedPartitionCount: 3,
      importedTitleCoverage: 1,
      importedPartitionCoverage: 0.75,
      contentStatus: "complete", // complete | partial | missing | conflicted
      conflictVideoCount: 0,
      reasons: []
    }
  ],
  diagnostics: {},
  limits: {}
}
```

关键点：

- `importedPartitionCoverage` 的分母是**导入视频数**，不是观看时长；
- `titleTokens` 复用 C2-3 的字符 bigram 规则，保证特征口径一致；
- `contentStatus` 是独立字段，不覆盖 C2-3 的 `featureStatus`；
- `provenance` 明确标记 `user-provided`；
- 所有动态键（分区名）用 `Object.defineProperty` 或 `Map`，避免 `__proto__` 污染。

### 5.4 `sources` 扩展的兼容性问题

现有 `candidate-pool.js` 的 `mergePools` 只识别 `watched` 和 `manual`；
如果直接把 `sources: ["content-import"]` 传给现有池，来源会被忽略，
候选可能变成 `unknown`。因此：

- **原型阶段不要把导入候选合并进现有池**；sidecar 独立存在。
- 如果未来要合并，必须先扩展 `SOURCE_ORDER`、`collectSources`、`classify`、
  `mergePools` 和 C2-2 的 `assessCandidate`，并补测试。
- 这些修改属于 C2-4B 或更后阶段，本阶段不做。

### 5.5 与 C3 的输入关系

C3 需要两类特征：

1. **观看特征**：C2-3 的 `partitionFeatures`、`titleFeatures`、覆盖率、`featureStatus`；
2. **导入内容特征**：sidecar 的 `partitionCounts`、`titleTokens`、`contentStatus`、`provenance`。

C3 必须显式合并，并在输出/排序中保留来源标签；
不能把两者拼成一个不区分来源的向量。

---

## 6. 新候选身份与资格设计

### 6.1 两轴模型：身份证据 × 内容证据

| 轴 | 取值 | 说明 |
|---|---|---|
| 身份证据 | `watched` | 有本地观看记录，C2-1 `fromWatchHistory` |
| 身份证据 | `user-provided` | 用户手动 UID 或导入内容，未在线核验 |
| 身份证据 | `platform-observed` | 未来：扩展在当前页观察到并锚定（未实现） |
| 身份证据 | `official-authorized` | 未来：B 站 OAuth 授权（未实现） |
| 身份证据 | `conflicted` | 同一 BV/候选出现多个 UID，待人工确认 |
| 身份证据 | `invalid` | UID 格式非法或缺失 |
| 内容证据 | `complete` | 样本量、分区/标题覆盖率达阈值，无冲突 |
| 内容证据 | `partial` | 有内容，但样本/覆盖率不足 |
| 内容证据 | `missing` | 没有可用内容 |
| 内容证据 | `conflicted` | 内容归属冲突，不可用于可信特征 |

### 6.2 五类候选与 C3 准入

> 下表中的“可信内容”仅指**来源可追溯、内容完整、无冲突**，
> 不等于 B 站平台核验或官方授权。

| 类别 | 身份证据 | 内容证据 | 现有 C2-2 资格 | C3 建议 |
|---|---|---|---|---|
| 历史观看 UP 主 | `watched` | C2-3 `ready/partial` | `eligible`（无冲突且新鲜） | 进入主排序（main lane） |
| 用户提供但未观看的 UP 主 | `user-provided` | `missing` | `review`（manual-unverified） | 不进入排序，等待内容 |
| 已取得用户提供内容信息的新 UP 主 | `user-provided` + 内容 sidecar | `complete` | 仍 `review` | 进入探索通道（exploration lane），低置信度、明确标注 |
| 数据不足的待核验候选 | `user-provided` | `partial/missing` | `review` | 不进入排序；保留，等待更多证据 |
| 身份冲突候选 | `conflicted` | `conflicted` | `review` / `excluded` | 不进入排序；冲突解决后再评估 |

**为什么历史候选和新候选不能混排：**

- 历史候选有真实观看时长和回访证据；新候选只有用户自述内容；
- 两者置信度不同，混排会让“用户自己导入的 UP 主”压过真实兴趣；
- C3 应使用两条通道或显式置信度权重，并在 UI/输出中标注来源。

**为什么不永久禁止未观看候选：**

- 用户主动导入说明存在探索意愿；
- 只要内容完整、来源明确、无冲突、时间新鲜，就应有机会进入探索通道；
- 数据不足只是“等待更多证据”，不是“永久排除”。

### 6.3 探索候选的晋升条件（设计，未实现）

建议 C2-4B/C3 采用以下**可测试**条件：

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

### 6.4 C3 的两条通道

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

探索通道的建议约束：

- 单独配额（例如最多占推荐结果的 10%–20%，具体由 C3 设计）；
- 不使用“观看时长”权重，改用内容完整度/新鲜度/来源置信度；
- 必须能一键关闭/清除；
- 不得伪装成“历史观看推荐”。

### 6.5 明确不做

- 不把 `user-provided` 自动升级为 `platform-observed` 或 `official-authorized`。
- 不因为内容完整就把 `onlineVerified` 设为 true。
- 不因为候选是 `new` 就永久排除。
- 不在 C2-4A 实现资格晋升代码。

---

## 7. C2-4B 最小数据来源

### 7.1 选择：C（用户主动导入视频链接与内容元数据）

理由：

- **本地**：无网络、无 Cookie、无账号；
- **权限最小**：不需要新增 manifest 权限；
- **用户可控**：用户明确选择导入哪些候选；
- **可验证**：输入是结构化 JSON/文本，可严格校验、可测试；
- **可降级**：缺字段/坏文件安全返回空结果；
- **不污染观看历史**：独立 sidecar；
- **不依赖付费 API/大依赖**：纯 JS 解析与校验。

### 7.2 输入形态

C2-4B 建议支持：

1. **JSON 文件导入**（首选）：`<input type="file" accept="application/json,.json">`；
2. **文本框粘贴 JSON**（备用，便于调试）；
3. 不接受任意网页 HTML、不接受自动抓取、不接受远程 URL 导入。

输入必须包含：

- `schemaVersion`、`kind`；
- `provenance: "user-provided"`；
- `userConfirmed: true`；
- 候选数组：`upUid`、`videos[]`；
- 每个视频：`bvid`（必需，用于去重）、`title` 或 `partition` 至少一个；
- 可选：`upName`、`tags`、`url`、`observedAt`、`sourceNote`。

### 7.3 降级策略

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

## 8. C2-4B 数据接口草案

> 本节是设计草案，不是已实现代码。C2-4A 不创建任何运行时代码。

### 8.1 导入 JSON 草案

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

### 8.2 校验规则

| 字段 | 规则 |
|---|---|
| `schemaVersion` | 必须为 `1`；其他版本拒绝 |
| `kind` | 必须精确匹配 |
| `provenance` | C2-4B 只接受 `"user-provided"`；`"platform-observed"` / `"official-authorized"` 拒绝并说明未实现 |
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
- 拒绝 `__proto__`、`constructor`、`prototype` 作为动态键（或使用 `Map`/`Object.create(null)`）。
- 拒绝 `javascript:`、`data:`、`file:` 等 URL scheme。
- 所有长度/数量上限在解析前检查；避免超大字符串/正则回溯。
- 不修改输入对象；返回新对象。
- 结果可 `JSON.stringify` 往返。

### 8.3 输出 sidecar 草案

```js
buildCandidateContentEvidence(importDoc, options)
// → 只解析/校验导入文件本身，返回 sidecar（不读取观看记录）
//   options.now 可注入固定时间，便于测试

assessImportedContentCandidates(sidecar, records, options)
// → 与 biliDailyRecords 交叉检查同一 BV 的 UID 冲突
//   计算 promotion.eligibleForExploration
//   不修改 records，不写存储
```

```js
// buildCandidateContentEvidence → {
//   schemaVersion: 1,
//   status: "ok" | "empty" | "invalid",
//   reason: "",
//   provenance: "user-provided",
//   candidates: [ ... ],
//   diagnostics: {
//     candidatesIn, candidatesAccepted, candidatesInvalid,
//     videosIn, videosAccepted, videosInvalid,
//     duplicateVideos, conflictVideos,
//     unknownFields, rejectedReasons
//   },
//   limits: { ... },
//   note: "用户提供，未在线核验；不进入观看记录"
// }
```

单候选输出：

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
> 与 `biliDailyRecords` 的跨来源冲突由 `assessImportedContentCandidates` 单独返回
> `crossSourceConflictVideoCount` 并影响 `promotion`，不修改 sidecar，也不修改观看记录。

### 8.4 适配边界

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

**明确不做的适配：**

- 不把导入视频传给 `buildCandidateFeatures` 的 `records`；
- 不把导入视频合并进 `biliDailyRecords.days`；
- 不把 `importedPartitionCoverage` 写进 `partitionCoverage`；
- 不把 `contentStatus` 写进 `featureStatus`；
- 不把 `user-provided` 写成 `watched`。

### 8.5 错误与诊断

所有错误返回结构化对象，不抛异常到 UI：

```js
{
  code: "invalid-json" | "unsupported-schema" | "too-large" |
        "invalid-candidate" | "invalid-video" | "conflict" | "no-data",
  level: "error" | "warning" | "info",
  message: "可读说明，不回显敏感原文",
  path: "candidates[2].videos[0].bvid"
}
```

诊断计数用于审计，不包含原始备注、URL query、Cookie 等敏感数据。

### 8.6 存储策略

- **C2-4B 原型：不写 `chrome.storage.local`。** 解析结果只在内存中返回。
- 如果后续需要持久化，使用**独立键**（例如 `biliDailyCandidateImports`），
  与 `biliDailyRecords` 分离，并提供清除/导出。
- 原型阶段不新增 manifest 权限；文件导入使用标准 `<input type="file">`。
- 不在扩展中保存 OAuth token / client_secret；未来官方 API 需服务端方案。

---

## 9. 单元测试计划（C2-4B，未实现）

建议至少 40 项，分为 8 组：

### 9.1 结构与版本（6 项）

1. 合法最小输入：1 候选、1 视频、UID/BV/标题/分区 → `status: "ok"`。
2. 空文件 / 空候选 → `status: "empty"`，不抛异常。
3. JSON 解析失败 → `status: "invalid"`，`invalid-json`。
4. 不支持的 `schemaVersion` → 拒绝，`unsupported-schema`。
5. `kind` 错误 → 拒绝。
6. 缺少 `userConfirmed` / 为 false → 拒绝。

### 9.2 身份与去重（7 项）

7. UID 非法（0、负数、小数、超长、非数字）→ 跳过该候选并计数。
8. UID 数字/字符串/前后空格 → 统一规范化。
9. 同一 UID 多候选 → 合并，来源/视频取并集。
10. 同一 BV 重复 → 只计一个视频，`duplicateVideos` 增加。
11. 同一 BV 不同标题/分区 → 标记 `metadata-conflict`，不静默选择。
12. 不同 UID 同名 → 保持分开，不按昵称合并。
13. 同一 UID 改名 → 合并，昵称仅展示。

### 9.3 内容特征（7 项）

14. 分区按视频数累计，`shareOfImportedVideos` 之和为 1。
15. 标题 bigram 与 C2-3 规则一致（中文/英文/数字/混合）。
16. 标点/空白不跨段拼接。
17. 缺失标题 → 计入 `importedTitleCoverage` 分母，不虚构。
18. 缺失分区 → 计入 `importedPartitionCoverage` 分母，不虚构。
19. 单字符标题 → 无 bigram，`tokenlessTitleCount` 增加。
20. 超长标题/分区/tags → 截断或拒绝，有限上限。

### 9.4 来源与时间（6 项）

21. `provenance: "user-provided"` 保留；不改成 watched。
22. `provenance: "platform-observed"` 在 C2-4B 拒绝并说明未实现。
23. `provenance: "official-authorized"` 拒绝并说明未实现。
24. `observedAt` 合法 → `available`。
25. `observedAt` 缺失/非法/未来 → `unknown`/`invalid`，不晋升。
26. 超过 180 天 → stale，保留但 `eligibleForExploration: false`。

### 9.5 冲突（5 项）

27. 同一 BV 在导入内出现两个 UID → 冲突，排除该视频，双方 `conflictVideoCount` 增加。
28. 导入 UID 与观看记录同一 BV 冲突 → 冲突，不修改观看记录。
29. 冲突视频不进入分区/标题特征。
30. 冲突候选 `contentStatus: "conflicted"`，不晋升。
31. 冲突计数跨候选使用唯一 BV，不重复计算。

### 9.6 晋升条件（5 项）

32. 3 个视频、分区/标题覆盖率 ≥ 0.6、无冲突、时间新鲜 → `eligibleForExploration: true`。
33. 视频数不足 → false，原因 `insufficient-videos`。
34. 分区覆盖率不足 → false，原因 `partition-coverage-low`。
35. 标题覆盖率不足 → false，原因 `title-coverage-low`。
36. 身份冲突/时间过期 → false，原因明确。

### 9.7 安全与不可变性（5 项）

37. `__proto__` / `constructor` 分区名不污染原型。
38. 输入对象深度冻结仍可处理，且不被修改。
39. 超大文件/超多候选/超长字符串安全拒绝，不崩溃。
40. `javascript:` / `data:` URL 被拒绝；B 站 HTTPS URL 的 query/hash 被去除。
41. 结果可 JSON 序列化往返，无 Map/Set/undefined。

### 9.8 适配与隔离（4 项）

42. 导入内容不会写入/修改 `biliDailyRecords`。
43. 导入-only 候选的 C2-3 `featureStatus` 仍为 `missing`，覆盖率 `null`。
44. C3 适配层能按 UID 连接观看特征与导入特征，并保留 `provenance`。
45. 空/坏输入不会产生任何候选或虚构特征。

> 以上为计划，不是执行结果。C2-4A 不实现、不运行这些测试。

---

## 10. 性能与数据限制

### 10.1 建议上限

| 项目 | 建议上限 | 理由 |
|---|---:|---|
| 导入文件大小 | 1 MiB | 本地文件，足以容纳数百候选；防止内存/解析压力 |
| 候选数 | 500 | 单用户探索候选的合理上限 |
| 每候选视频数 | 50 | 足够形成内容特征；避免单候选膨胀 |
| 总视频数 | 2,000 | 控制解析/分词总成本 |
| 标题原始长度 | 1,000 UTF-16 | 与 C2-3 `maxTitleRawLength` 一致 |
| 标题归一化长度 | 200 码点 | 与 C2-3 `maxTitleLength` 一致 |
| 分区名 | 64 码点 | 与 C2-3 `maxPartitionLength` 一致 |
| tags | 20 个 × 50 字符 | 可选字段，控制内存 |
| sourceNote | 500 字符 | 仅记录，不参与特征 |
| URL | 2,048 字符 | 防止异常长 URL |

所有上限应可配置，并在输出 `limits` 中回显，便于审计。

### 10.2 去重

- 身份：按规范化 UID；不按昵称。
- 视频：按规范化 BV；同一 BV 只算一个视频。
- 标题：不按标题去重（不同视频可能同名）。
- 分区：按字符串精确匹配；空白/控制字符视为缺失。
- 跨来源：导入与观看记录按 UID/BV 交叉检查冲突；不合并观看计数。

### 10.3 过期与刷新

- 默认 180 天；`observedAt` 超过阈值 → stale，保留但不可晋升。
- 无自动网络刷新；用户重新导入时更新 `lastObservedAt`。
- 同一 UID/BV 的新导入若与旧数据一致，更新观察时间；若冲突，保留冲突标记，不静默覆盖。
- 用户可清除全部导入数据；清除不影响观看记录。

### 10.4 错误输入与恶意内容

- JSON 解析错误、类型错误、超限、非法 UID/BV/URL；
- 原型污染键、控制字符、零宽字符、双向控制符；
- 超长字符串、深层嵌套、大量重复候选/视频；
- 未来时间戳、NaN/Infinity；导入 schema 不含观看时长，若未来加入时长字段需单独防御负值/溢出；
- HTML/脚本片段作为标题/备注：只作为文本存储，UI 必须转义；不执行；
- 不访问 URL；不解析短链；不跟随重定向。

### 10.5 隐私数据最小化

只保留：

- UID、可选昵称；
- BV、标题、分区、可选 tags；
- 可选 URL（去 query/hash，仅保留 BV/UID）；
- 观察时间、导入时间、来源备注（可选）。

不保留：

- Cookie、登录凭据、token；
- IP、设备信息、浏览器指纹；
- 原始页面 HTML、评论区、弹幕、观看历史；
- 用户未主动导入的其他数据。

### 10.6 本地计算性能

- 纯本地、无网络、无大型依赖；
- 解析与校验为 O(候选数 × 视频数)，受上限约束；
- 分词复用 C2-3 的线性字符扫描，避免复杂正则；
- **C2-4A 未实现 C2-4B，因此没有 C2-4B 的性能数字；不得编造。**
- C2-4B 实现后，应使用合成夹具（例如 500 候选 × 4 视频）运行 5 次，
  记录 min/median/max，并注明机器与 Node 版本；真实用户数据不参与基准。

---

## 11. 已知限制与待核查问题

### 11.1 已知限制

1. **用户自述数据可能不准确**：标题/分区/UID 可能过时、截断或误填；本项目不做在线核验。
2. **没有平台侧身份验证**：除官方 OAuth 外，无法确认 UID 是否真实存在或属于该 UP 主。
3. **没有标签特征**：C2-3 不使用 tags；C2-4B 可保存但 C3 是否使用需另行设计。
4. **内容覆盖率是启发式**：3 个视频、0.6 覆盖率只是保守起点，未用真实分布校准。
5. **导入内容会过期**：180 天阈值是设计建议，需根据用户行为调整。
6. **无法发现用户不知道的 UP 主**：C 依赖用户主动提供；真正的“平台发现”需要 D/E，但当前不可行/未核实。
7. **D 的 DOM 不稳定**：B 站改版、广告卡、懒加载都会影响；本阶段不实现。
8. **E 的个人开发者路径不可用**：官方文档摘要显示个人入驻未开放；企业方案成本高。
9. **C3 尚未实现**：探索通道、权重、配额、MMR 都未设计完成；本阶段只提供输入边界。
10. **C1 没有用户级标题词向量**：C3 若要做内容相似度，需要从观看记录构建用户 token 画像；
    这是 C3 的新增数据需求，不是 C2-4A 的交付。

### 11.2 待核查问题

| # | 问题 | 当前证据 | 核查方式 |
|---:|---|---|---|
| 1 | 官方开放平台个人开发者入驻是否仍关闭 | 官方文档搜索摘要称“暂未开通个人开发者申请入驻” | 浏览器打开 `openhome.bilibili.com/doc/4/cbdcee3b-...` 人工复核 |
| 2 | 是否存在可读取任意公开视频/UP 主目录的官方接口 | 搜索摘要显示 scope 围绕授权账号/稿件；未发现公开目录接口 | 逐页阅读开放平台“数据开放”文档 |
| 3 | 当前页推荐区 DOM 读取是否属于用户协议 §5.6(3) 的“自动获取数据” | 协议摘要禁止自动程序获取内容/数据 | 法务/平台书面确认；发布前复核 |
| 4 | 用户导入 B 站页面公开元数据并本地保存的合规性 | 用户主动、非商业、本地、最小化 | 发布前隐私/法务评审 |
| 5 | 用户协议/隐私政策最新版本与条款编号 | 搜索摘要显示 2025-04-30 / 2025-05-07 等日期 | 浏览器人工复核原文 |
| 6 | `tname` 分区体系是否稳定、是否需要映射 | 现有 C2-3 只按字符串；未做映射 | 抽样真实数据；C3 前评估 |
| 7 | tags 是否值得作为 C3 特征 | 当前未采集；导入可选 | C3 设计评审 |
| 8 | 180 天过期阈值是否合理 | 设计建议，无真实数据 | C2-4B/C3 真实数据观察 |
| 9 | Edge 商店对文件导入/本地数据的披露要求 | 未核查 | 发布前阅读 Edge 商店政策 |
| 10 | 是否需要隐私政策更新 | 新增导入数据类别 | 发布前更新并请用户确认 |

---

## 12. 是否进入 C2-4B

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
5. C2-4B 的测试计划覆盖第 9 节的 40+ 项。

**不建议现在做：**

- 官方 API 接入（个人开发者不可行、需要企业资质/后端）；
- 当前页推荐区采集（DOM 不稳定、平台规则待核实、属于新采集）；
- 批量抓取、非官方 API、Cookie/登录信息读取；
- 把导入内容写入观看记录或直接混入 C2-2 `eligible`；
- 进入 C3 排序或 UI。

**本阶段停止，等待审核。**

---

## 附录 A：参考来源

> 访问/核查日期：2026-11-11。官方页面正文可能为 JS 渲染；标注“摘要”的条目来自搜索引擎返回的官方页面摘要，需人工复核。

| # | 来源 | 用途 | 读取情况 |
|---:|---|---|---|
| 1 | https://www.bilibili.com/robots.txt | robots 规则 | **已实际读取**关键规则 |
| 2 | https://www.bilibili.com/protocal/licence.html | 用户协议 §1.2/§1.3/§5.6(3) | 页面正文未直接取得；使用搜索摘要，待复核 |
| 3 | https://www.bilibili.com/blackboard/privacy-pc.html | 隐私政策（收集范围/公开信息） | 页面正文未直接取得；使用搜索摘要，待复核 |
| 4 | https://openhome.bilibili.com/doc | 开放平台文档目录 | 页面仅返回标题；使用搜索摘要，待复核 |
| 5 | https://openhome.bilibili.com/doc/4/eaf0e2b5-bde9-b9a0-9be1-019bb455701c | 账号授权/OAuth 2.0 | 页面仅返回标题；使用搜索摘要，待复核 |
| 6 | https://openhome.bilibili.com/doc/4/cbdcee3b-f57e-5c7b-cf27-83892fb811c4 | 开发者入驻（个人未开放） | 使用官方页面搜索摘要，待复核 |
| 7 | https://openhome.bilibili.com/doc/4/d9554788-dcef-f139-6217-b487d41c3826 | 查询单一视频稿件详情（ARC_BASE） | 使用官方页面搜索摘要，待复核 |
| 8 | https://openhome.bilibili.com/doc/4/3f46ac2e-1318-3aa0-5548-0d9fd624d520 | 获取单个稿件数据（ARC_DATA） | 使用官方页面搜索摘要，待复核 |
| 9 | https://openhome.bilibili.com/doc/4/feb66f99-7d87-c206-00e7-d84164cd701c | 获取已授权用户基础公开信息（USER_INFO） | 使用官方页面搜索摘要，待复核 |
| 10 | https://open.bilibili.com/agreement/developer-service | 开放平台开发者服务协议 | 页面仅返回标题；使用搜索摘要，待复核 |
| 11 | https://openhome.bilibili.com/agreement/privacy-policy | 开放平台隐私政策 | 搜索结果列出；未逐条读取，待复核 |

**未作为授权依据的第三方资料：**

- Apifox 镜像文档、GitHub `bilibili-API-collect`、第三方博客。
- 这些资料只能说明“存在非官方接口/社区整理”，不能证明官方授权；
  本项目不建议使用非官方接口。

---

## 附录 B：本阶段代码未修改的验证

- C2-3 回滚快照 `rollback/before-c2-3-features/` 中的 10 个既有文件，
  与当前文件 SHA-256 全部一致。
- `candidate-features.js` 与 `test-candidate-features.js` 在本阶段未修改；
  评审期间只读取。
- 本阶段只新增/修改文档：
  - `docs/design/C2-4A-candidate-source-review.md`
  - `docs/acceptance/C2-4A/C2-4A-research-report.md`
  - `docs/acceptance/C2-4A/C2-4A-research-report.html`
  - `docs/acceptance/README.md`（追加 C2-4A 索引行）
- 未运行 181 项测试：因为正式代码没有变化；用户已在此前复核通过。
- 如后续发现任何运行时代码哈希变化，应停止并说明原因。

---

## 附录 C：C2-4B 最小原型的一页式检查清单

- [ ] 导入 JSON 有 `schemaVersion`、`kind`、`provenance: "user-provided"`、`userConfirmed: true`
- [ ] UID 复用 `stats.cleanRecord` 规则
- [ ] 每个视频有 BV；标题/分区至少一个
- [ ] 按 UID/BV 去重；冲突不静默
- [ ] 输出独立 sidecar；不写 `biliDailyRecords`
- [ ] `onlineVerified` 恒 false；`uidVerified` 不因导入变为 true
- [ ] `featureStatus` / `partitionCoverage` / `titleCoverage` 不被导入内容覆盖
- [ ] 内容覆盖率按导入视频数，不按观看时长
- [ ] 观察时间合法/非未来；过期不晋升
- [ ] 探索晋升条件可测试、有结构化原因
- [ ] 空/坏/超限输入安全返回空结果
- [ ] 原型不联网、不新增权限、不写存储
- [ ] 测试覆盖第 9 节 40+ 项
