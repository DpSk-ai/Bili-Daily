# Bili Daily 个人自用 MVP v1.0 最终验收归档

- 日期：2026-11-12
- 版本标识：`personal-mvp-v1.0`
- 阶段：MVP 最终验收与稳定版封存
- 结论：**封存当前可工作的个人自用 MVP，不新增功能。**
- 适用对象：项目所有者本人；不计划公开发布、不面向多用户或生产环境。

> 本报告严格区分“用户本机实际执行”“用户此前报告”“Claude 只读静态审计”和“未验证”。
> 不把用户的结果写成 Claude 执行；不声称已完成长期稳定性、推荐准确率或全面安全审计。

---

## 0. 证据分级与执行状态

| 证据类别 | 内容 | 本报告的引用方式 |
|---|---|---|
| **A. 用户本机实际执行** | 项目所有者在 Windows PowerShell 执行全部 17 个测试套件，495/495 项通过 | 记为“项目所有者本机执行”，不记为 Claude 执行 |
| **A. 用户真实 Edge 验收** | 项目所有者在 Edge 加载插件并实际使用；自动发现从 B 站页面获得陌生 UP 主候选，候选成功进入推荐列表 | 记为“用户报告通过”，不声称 Claude 现场观察 |
| **B. 用户此前报告** | 自动发现相关 JavaScript 语法检查通过 | 记为“用户此前报告”，本次未独立重跑 |
| **C. Claude 本次只读审计** | 阅读 `manifest.json`、运行代码、测试文件与文档，核对权限、存储键、来源标识、去重/冲突、推荐理由、网络路径、观察器与 HTML 渲染 | 记为“静态审计”，不代表运行时验证 |
| **D. 未验证** | 长期稳定性、内存/性能长跑、真实推荐准确率、全面安全审计、B 站页面改版兼容性 | 明确列为未验证，不作结论 |

本轮 Claude Code 环境中：

- `node --version` 可用（`v24.19.0`）。
- `node --check` 与 `node test-*.js` 多次尝试均被命令分类通道阻断，**未获得任何本轮独立 PASS/FAIL 输出**。
- `node tools/build-report-html.js ...` 同样被阻断，**最终 HTML 本轮未生成**；Markdown 已落盘，
  生成命令见第 11.1 节。未使用手工 HTML 替代。
- 因此第 4 节的 495/495 是**项目所有者本机执行结果**，不是 Claude 本次执行结果。
- 本轮未修改任何扩展运行代码、测试代码或测试断言。

命令通道阻断的典型原文：

> claude-opus-5-5 is temporarily unavailable (connection failed), so auto mode cannot determine the safety of Bash right now.

最新修改的三个文件时间为 2026-11-12 17:45：

- `recommend-service.js`
- `test-auto-discovery-performance.js`
- `test-discovered-candidate-store.js`

项目所有者报告的 495/495 是这三个文件修复后的最终运行结果。**本轮没有单独重跑这三个文件的 `node --check`**；
测试套件运行会加载这些文件，但“套件运行通过”不等同于“本轮单独执行过语法检查”，故按实际情况标记。

---

## 1. 封存结论

1. 项目**未配置 Git**：`D:\Bili-Daily` 及其父目录均无 `.git`，`git status` 返回
   `fatal: not a git repository`。因此没有创建 Git 提交，也没有 `personal-mvp-v1.0` 标签。
2. 已建立**完整、独立的稳定版快照**：
   `D:\Bili-Daily\snapshots\personal-mvp-v1.0-2026-11-12`
3. 快照包含 94 个运行/测试/文档文件，并生成 `SHA256SUMS.txt`；封存时在快照目录内执行
   `sha256sum -c SHA256SUMS.txt`，全部文件返回 `OK`（Claude 实际执行）。
4. **未覆盖、未移动、未删除**任何既有 `rollback/` 快照。
5. **未读取、未写入、未清空**真实 `chrome.storage.local` 用户数据。
6. 未为封版做无关重构；17 个测试套件与 495 项测试基线保持原样。
7. 发现一处发布卫生问题但**按“不新增改动”原则未修改**：`dev-config.js` 当前
   `enabled: true`，弹窗会显示开发用日期切换入口。个人自用可接受；若以后要“干净正式版”，
   应在下一版本改为 `false` 后再验收，而不是直接改当前冻结快照。

---

## 2. v1.0 功能清单

| # | 功能 | 状态 | 证据 |
|---:|---|---|---|
| 1 | B 站视频页观看时长采集（仅 `www.bilibili.com/video/*`） | 已实现 | `manifest.json` 的 content script；`content.js` |
| 2 | 昨日观看总结：有效视频数、观看时长、分区、UP 主排行 | 已实现 | `stats.js`、`popup.js`；用户此前实际运行检查 |
| 3 | 最近 7 天兴趣画像：分区与 UP 主占比、数据充分度 | 已实现 | `interest-profile.js`；用户此前实际运行检查 |
| 4 | 回访推荐（main 通道）：基于本地观看记录的 UP 主推荐 | 已实现 | `recommend-service.js`、`recommend-rank.js`；用户此前实际运行检查 |
| 5 | 探索推荐（exploration 通道）：手动导入的新 UP 主候选 | 已实现 | `candidate-store.js`、`candidate-content-import.js`；用户此前实际运行检查 |
| 6 | 自动发现新 UP 主（opt-in，页面相关推荐卡片） | 已实现 | `candidate-discovery.js`、`discovered-candidate-store.js`；用户 Edge 实机报告通过 |
| 7 | 导入候选管理：预览、校验、批次列表、删除批次 | 已实现 | `popup.js`、`candidate-store.js`；用户此前实际运行检查 |
| 8 | 推荐冷启动提示与置信度展示 | 已实现 | `recommend-quality.js`、`recommend-service.js` |
| 9 | 全部数据只存本地，不上传 | 已实现（静态核对） | 仅有 `storage` 权限；无 `fetch`/XHR/WebSocket；无 host permissions |
| 10 | 自动发现开关，默认关闭 | 已实现 | `DEFAULT_SETTINGS.enabled = false`；弹窗可切换 |

### 2.1 默认值与开关

- 自动发现默认值：`enabled: false`（`discovered-candidate-store.js` 的 `DEFAULT_SETTINGS`）。
- 设置存储键：`biliDailyDiscoverySettings`。
- 关闭时：内容脚本不启动观察器；`addObservations()` 即使收到排队观察也直接返回、不写入。
- 开启方式：弹窗「自动发现新 UP 主」区域的开关；切换后通过 `chrome.storage.onChanged` 同步到内容脚本。
- 观看记录采集（`content.js`）与自动发现开关**相互独立**：即使自动发现关闭，观看记录仍按原有逻辑运行。

---

## 3. 最终工程审计

### 3.1 manifest 权限与匹配范围

| 项目 | 实际值 | 评价 |
|---|---|---|
| Manifest 版本 | MV3 | 符合当前 Edge 扩展模型 |
| `permissions` | `["storage"]` | 仅本地存储，无 `tabs`、`history`、`cookies`、`downloads` |
| `host_permissions` | 未声明 | 无跨站访问权限 |
| content script 匹配 | `https://www.bilibili.com/video/*` | 只进入视频页，不进首页、动态、直播、个人空间 |
| content script 文件 | `storage.js`、`discovered-candidate-store.js`、`candidate-discovery.js`、`content.js` | 依赖顺序固定 |
| background / service worker | 无 | 无常驻后台 |
| `web_accessible_resources` | 无 | 不向页面暴露扩展资源 |
| `version` | `0.0.1` | 未在封版时修改；见第 10 节建议 |

结论：权限面很小，符合“个人自用、本地记录”的定位。`storage` 权限本身可读整个扩展的
`chrome.storage.local`，但代码只访问第 7 节列出的四个键。

### 3.2 自动发现开关与默认值

- 默认关闭，用户必须主动开启；没有“首次安装自动开启”的逻辑。
- 开关状态写入独立键，不混入观看记录或导入批次。
- 关闭后，内容脚本的 `syncSettings()` 调用 `stop()`，断开 MutationObserver、清理定时器与监听器。
- `addObservations()` 在 `settings.enabled !== true` 时返回 `disabled: true` 且不写存储。
- 弹窗在设置读取失败或存储读取失败时禁用开关，避免误写。

### 3.3 `page-observed` 来源标识

- `candidate-discovery.js` 与 `discovered-candidate-store.js` 均固定：
  `PROVENANCE = "page-observed"`、`SCOPE = "related-recommendation-card"`。
- 存储层注释明确：**绝不复用 `user-provided`**，固定 `onlineVerified: false`。
- 推荐卡会显示「页面相关推荐发现」徽标；推荐理由使用 `page-observed` 理由码，
  文案明确“本地观察、未在线核验、不代表平台认证”。
- 证据适配输出 `identityEvidence.sources = ["page-observed"]`。

### 3.4 已观看候选与陌生候选的区分

- 自动发现适配层从 `biliDailyRecords` 收集已观看 UP UID，并将这些 UID 从观察候选中排除
  （`collectWatchedUids` → 冲突/排除逻辑）；统计中单独记录 `watchedUpExcluded`。
- 推荐分两条通道：
  - `main`：本地观看记录中的回访 UP 主，理由是 `watched-before`，可带真实观看视频数与时长。
  - `exploration`：未在本地观看过的候选，来源只能是 `user-provided` 或 `page-observed`。
- 跨通道同 UID 去重时 `main` 优先，避免同一个 UP 主同时以“看过”和“陌生”出现。

### 3.5 UID / BV 去重与冲突阻断

- 观察记录以 `UID|BV` 合并；同一 UID + 同一 BV 重复观察只保留一条并更新时间。
- 同一 BV 出现不同 UID：标记 `uid-conflict`，记录 `conflictUids`；
  冲突候选不进入探索通道，界面提示“待人工复核，不会进入推荐”。
- 同一 UID 跨来源（手动导入 + 页面观察）：排序层用导入 UID 集合排除自动发现同 UID，
  手动导入优先，最终推荐中只出现一次。
- 同一 BV 同 UID 但标题/分区矛盾：不采用矛盾标题，按元数据冲突处理。
- 导入批次内部也做 UID/BV 校验；无效观察整条拒绝，不因一条坏数据写入空存储。

### 3.6 导入数据与自动观察数据隔离

四个存储键彼此独立：

| 键 | 写入方 | 内容 |
|---|---|---|
| `biliDailyRecords` | `storage.js` / `content.js` | 观看记录 |
| `biliDailyCandidateImports` | `candidate-store.js` | 用户主动确认导入的批次 |
| `biliDailyDiscoveredCandidates` | `discovered-candidate-store.js` | 页面观察候选 |
| `biliDailyDiscoverySettings` | `discovered-candidate-store.js` | 自动发现设置 |

- `discovered-candidate-store.js` 只写后两个键；观看记录仅作为只读输入传入，用于排除已观看 UP。
- 自动发现不写 `biliDailyCandidateImports`，导入也不写 `biliDailyDiscoveredCandidates`。
- 删除/重建自动发现候选不会删除导入批次；清除操作只清空观察候选，设置保持开启（测试 25）。

### 3.7 推荐理由真实性

- `watched-before`：使用真实 `watchedVideoCount` 与 `watchedWatchMs`，文案给出视频数与约分钟数。
- `page-observed`：使用真实 `importedVideoCount`（观察到的不同视频数），明确说明“本地未观看过”
  与“不代表账号经过平台验证”。
- `user-imported`：使用真实导入视频数，明确“未经平台在线核验”。
- 分区/标题匹配理由只在确实存在对应向量与相似度时生成；覆盖不足时使用 `low-coverage`。
- 代码中多处明确写明“证据等级是工程启发式，不是概率，也不是预测准确率”；
  未发现“官方认证”“已验证准确率”等虚假表述。
- 限制：理由描述的是**证据来源与匹配依据**，不是对推荐质量的保证。

### 3.8 是否存在意外的远程发送路径

静态核对结果：

- 运行代码中未发现 `fetch(`、`XMLHttpRequest`、`WebSocket`、`sendBeacon`、
  `chrome.runtime.sendMessage`、`chrome.cookies`、`document.cookie`。
- `manifest.json` 无 `host_permissions`，无远程脚本、无外部样式、无 CDN 依赖。
- 代码中出现的 `https://www.bilibili.com/...` 与 `https://space.bilibili.com/...` 仅用于：
  - 解析页面链接中的 BV / UID；
  - 生成推荐卡跳转链接（经 UID 正则校验后使用）。
- 报告生成脚本 `tools/build-report-html.js` 只读本地 Markdown、写本地 HTML，不联网。
- 测试 `test-auto-discovery-integration.js` 第 20 项会对五个关键文件做同样的静态字符串检查。

结论：**未发现扩展主动向远程发送用户数据的路径。** 这是静态审计结论，不是网络抓包或全面安全审计。

### 3.9 内容脚本的观察器与性能

| 项目 | 实际实现 | 评价 |
|---|---|---|
| MutationObserver 数量 | 每个控制器最多 1 个；`started` 防重入，重复 `start()` 直接返回 | 未发现重复观察器 |
| 观察回调 | 只调用节流 `schedule()`，不在回调内遍历 DOM | 避免同步回调抖动 |
| 节流 | 变更延迟 700 ms；两次扫描最小间隔 1500 ms | 有明确上限 |
| 扫描范围 | 每次最多 400 个锚点、40 张卡片；每页最多 100 条观察 | 有硬上限 |
| 页面检查 | 2 s 检查一次 URL 变化（仅开启自动发现时） | 轻量 |
| 暂停 | 页面隐藏时跳过扫描；`pagehide` 停止 | 降低后台开销 |
| 观看记录 | `content.js` 每 1 s 执行一次 `sync()`；每次会查询主 `<video>` 并读取页面元数据 | 既有设计，不是 DOM 观察器；属于可优化点，未在本轮实测 CPU |
| 性能测试 | 400 卡片扫描、300/500 条证据适配，单次阈值 5 s | **合成数据、宽阈值**，只能发现明显退化，不能证明真实页面流畅 |

结论：未发现“重复观察器”这一明显缺陷；存在一个既有的 1 秒轮询（每次读取视频元素与页面元数据），
长期 CPU/内存影响未测量，建议下一版本改为事件驱动或降低空闲时的读取频率。封版未改动。
真实 B 站页面的长跑性能、SPA 切换、多标签页并发均未验证。

### 3.10 HTML 是否安全渲染不可信文本

- `popup.js` 明确不使用 `innerHTML`；所有外部文本（UP 名称、分区、导入文件名、推荐理由）
  通过 `textContent` 写入。
- 推荐卡链接只接受 `safeSpaceUrl()` 校验后的 `https://space.bilibili.com/<uid>`，
  且 UID 必须与候选 UID 一致；链接带 `rel="noopener noreferrer"`。
- 存储层对文本做控制字符清理、长度截断和字段白名单；恶意额外字段不会进入存储（测试 8）。
- 报告生成脚本在插入 Markdown 文本前统一 `escapeHtml`，转义 `& < > "`。
- 未发现 `eval`、`new Function`、`document.write`、`insertAdjacentHTML`。

结论：当前渲染路径使用安全 DOM API，未发现明显的 HTML 注入面。

### 3.11 审计总体结论

| 审计项 | 结论 |
|---|---|
| 权限与匹配范围 | 通过（仅 `storage`，仅视频页） |
| 自动发现默认关闭 | 通过 |
| `page-observed` 来源标识 | 通过 |
| 已观看 / 陌生候选区分 | 通过 |
| UID / BV 去重与冲突阻断 | 通过 |
| 导入与观察数据隔离 | 通过 |
| 推荐理由真实性 | 通过（有“证据≠质量保证”的限制） |
| 意外远程发送 | 未发现（静态） |
| 重复观察器 / 明显性能缺陷 | 未发现重复观察器；长跑性能未验证 |
| HTML 安全渲染 | 通过（静态） |

以上“通过”仅指代码审查层面的核对，不等同于渗透测试、长期运行或推荐效果验收。

---

## 4. 自动化测试基线

### 4.1 17 个测试套件与声明测试数

测试数由测试文件中的顶层 `test(...)` 静态计数得出，用于核对总数；**通过数来自项目所有者本机运行**。

| # | 套件 | 声明测试数 | 项目所有者本机结果 |
|---:|---|---:|---|
| 1 | `test-stats.js` | 20 | 通过 |
| 2 | `test-up-stats.js` | 17 | 通过 |
| 3 | `test-uid.js` | 21 | 通过 |
| 4 | `test-interest-profile.js` | 24 | 通过 |
| 5 | `test-candidate-pool.js` | 33 | 通过 |
| 6 | `test-candidate-quality.js` | 28 | 通过 |
| 7 | `test-candidate-features.js` | 38 | 通过 |
| 8 | `test-candidate-content-import.js` | 60 | 通过 |
| 9 | `test-candidate-store.js` | 28 | 通过 |
| 10 | `test-recommend-core.js` | 56 | 通过 |
| 11 | `test-recommend-quality.js` | 47 | 通过 |
| 12 | `test-recommend-rank.js` | 28 | 通过 |
| 13 | `test-recommend-service.js` | 22 | 通过 |
| 14 | `test-candidate-discovery.js` | 22 | 通过 |
| 15 | `test-discovered-candidate-store.js` | 26 | 通过 |
| 16 | `test-auto-discovery-integration.js` | 22 | 通过 |
| 17 | `test-auto-discovery-performance.js` | 3 | 通过 |
| | **合计** | **495** | **495/495 通过（用户本机执行）** |

分组核对：

- 既有 13 个套件：422 项。
- 自动发现相关 4 个套件：73 项（22 + 26 + 22 + 3）。
- 合计：495 项。

### 4.2 结果归属

> **495/495 由项目所有者在 Windows PowerShell 中实际执行并通过。**
> Claude 本轮未能运行测试；不得把该结果表述为 Claude 本轮独立验证。

### 4.3 复现命令（PowerShell）

```powershell
cd D:\Bili-Daily
$files = @(
  "test-stats.js",
  "test-up-stats.js",
  "test-uid.js",
  "test-interest-profile.js",
  "test-candidate-pool.js",
  "test-candidate-quality.js",
  "test-candidate-features.js",
  "test-candidate-content-import.js",
  "test-candidate-store.js",
  "test-recommend-core.js",
  "test-recommend-quality.js",
  "test-recommend-rank.js",
  "test-recommend-service.js",
  "test-candidate-discovery.js",
  "test-discovered-candidate-store.js",
  "test-auto-discovery-integration.js",
  "test-auto-discovery-performance.js"
)
foreach ($file in $files) {
  node $file
  "EXIT=$LASTEXITCODE FILE=$file"
}
```

每个套件应以 `N/N 通过` 结束且退出码为 `0`；17 个套件合计 495 项。

### 4.4 语法检查

- 项目所有者此前报告：自动发现相关 10 个 JavaScript 文件的 `node --check` 全部通过。
- 本轮未独立重跑 `node --check`。
- 最新修改文件（17:45）未单独补做语法检查；项目所有者报告的 495/495 是修复后的最终运行结果。
- **不把“此前语法检查通过”扩大为“本轮所有文件都已检查”。**

---

## 5. 真实验收证据（用户报告）

以下均为**项目所有者报告的实际使用结果**，不是 Claude 现场观察：

| 验收项 | 结果 | 说明 |
|---|---|---|
| Edge 加载未打包扩展 | 用户报告通过 | 扩展可加载、弹窗可打开 |
| 自动发现从 B 站页面获得陌生 UP 主候选 | 用户报告通过 | 在真实视频页「相关推荐」中观察到候选 |
| 陌生 UP 主进入推荐列表 | 用户报告通过 | 候选最终出现在推荐卡中 |
| 观看统计 | 用户报告此前已实际运行检查 | 记录、汇总、展示可用 |
| 兴趣画像 | 用户报告此前已实际运行检查 | 7 天画像可用 |
| 推荐功能 | 用户报告此前已实际运行检查 | 推荐列表可生成 |
| 导入功能 | 用户报告此前已实际运行检查 | 导入与批次管理可用 |

**证据缺口（如实记录）：**

- 本轮未附最终 Edge 验收的截图、录屏、时间戳或控制台日志。
- 未记录候选数量、推荐排名、观察耗时等可量化现场数据。
- 因此本报告只能写“用户报告通过”，不能写“Claude 已验证通过”。

---

## 6. 未验证项目与已知限制

### 6.1 未验证

1. 长期稳定性：连续多天、多标签页、长时间挂机下的内存、CPU、存储增长未测量。
2. 推荐准确率 / 点击率 / 满意度：没有离线指标、A/B 或真实反馈数据；“可信度高/中/低”是工程启发式，不是准确率。
3. 全面安全审计：未做渗透测试、依赖审计、威胁建模或网络抓包；只做了静态字符串与代码路径核对。
4. B 站页面改版兼容性：观察器依赖页面 DOM 结构与链接形态；B 站改版后可能需要维护。
5. 真实页面性能：性能测试使用合成 DOM 与宽阈值（5 s），不能代表真实页面的流畅度。
6. `chrome.storage.local` 容量边界：有 1.5 MB 上限与 300/500 条容量限制，但未在真实大数据下压测。
7. 多浏览器：只在 Edge 实机使用；Chrome/Firefox 未验证。
8. 数据导出/恢复流程：本报告给出方案，但**本轮未实际执行导出或恢复演练**。
9. 最新三个文件（17:45）的单独 `node --check`：本轮未重跑。
10. `dev-config.js` 当前 `enabled: true`，弹窗会显示开发日期切换入口；未在封版时修改。

### 6.2 已知限制

- 自动发现只读取“页面已经渲染出来”的相关推荐卡片，不自动滚动、不自动点击、不批量打开视频；
  懒加载或未渲染的卡片不会被发现。
- 观察数据有保留期（默认 180 天）和容量上限（默认 300，硬上限 500）；旧数据会被裁剪。
- 探索通道的分区相似度存在跨口径近似，统一按低可信度处理。
- 标题匹配是无语义的 token/bigram 相似度，不理解内容含义。
- 冷启动门槛（50 个有效视频、14 个活跃日等）来自调研与实验值，不是实测最优参数。
- 推荐理由只解释“为什么出现”，不保证“推荐一定合适”。
- `content.js` 每秒执行一次元数据同步，长时间停留视频页时的 CPU 影响未测量；
  这是既有实现，封版未改动。
- 未打包扩展的存储与扩展 ID / 加载路径相关；更换加载路径可能导致看不到原数据。

---

## 7. 本地数据键与备份注意事项

### 7.1 数据键

| 键 | 内容 | 是否包含在扩展目录快照中 |
|---|---|---|
| `biliDailyRecords` | 观看记录（按日期、BV 组织） | **否** |
| `biliDailyCandidateImports` | 手动导入的候选批次 | **否** |
| `biliDailyDiscoveredCandidates` | 页面观察候选 | **否** |
| `biliDailyDiscoverySettings` | 自动发现开关与容量配置 | **否** |

**扩展目录备份不等于用户数据备份。** 快照只包含代码、测试和文档；
真实数据在 Edge 的 `chrome.storage.local`（LevelDB）中，不在 `D:\Bili-Daily` 的任何目录里。

### 7.2 数据导出方案（需用户本人操作）

Claude 本轮**没有读取或覆盖**真实存储。建议用户在需要时手动导出：

1. 打开 Bili Daily 弹窗。
2. 在弹窗内右键 →「检查」打开 DevTools。
3. 在 Console 中执行（只读，不修改数据）：

```js
chrome.storage.local.get(null, (all) => {
  const text = JSON.stringify(all, null, 2);
  console.log(text);
  copy(text); // 复制到剪贴板
});
```

4. 粘贴到本地文本文件，例如 `D:\Bili-Daily-data-backup\bili-daily-storage-2026-11-12.json`，
   不要放进扩展目录快照。

### 7.3 数据恢复方案（需用户确认后执行）

恢复会覆盖同名键，执行前必须先完成 7.2 的导出并确认文件内容。

1. 打开弹窗 DevTools Console。
2. 把备份 JSON 赋给变量：

```js
const backup = { /* 粘贴 7.2 导出的完整 JSON */ };
chrome.storage.local.set(backup, () => console.log("restored"));
```

3. 关闭并重新打开弹窗，确认观看记录、导入批次、自动发现候选数量与备份一致。
4. 若只想恢复部分键，先 `delete backup.biliDailyDiscoveredCandidates` 等，再执行 `set`。

### 7.4 Edge 配置目录级备份（可选，风险更高）

真实数据通常位于 Edge 用户配置下的扩展 Local Extension Settings 目录，
例如 `%LOCALAPPDATA%\Microsoft\Edge\User Data\Default\Local Extension Settings\<扩展ID>`。
这是 LevelDB 目录，**必须在 Edge 完全退出后整目录复制**；不要在运行中复制，也不要用它覆盖
正在使用的数据。该方式依赖扩展 ID，恢复后 ID 不一致则无效。普通用户优先使用 7.2/7.3 的
显式 JSON 导出。

### 7.5 注意事项

- 卸载扩展、删除 Edge 用户配置、切换 Edge 配置文件都可能使数据不可见。
- 不要把 `biliDailyRecords` 等键写进扩展目录快照，也不要在快照恢复命令中触碰它们。
- 恢复代码（第 9 节）与恢复数据（7.3）是两件独立的事，先后顺序建议：先备份数据 → 再恢复代码 → 重载扩展 → 确认数据仍在。

---

## 8. 安装、启动与重新加载

### 8.1 首次安装（Edge）

1. 打开 `edge://extensions/`。
2. 打开左下角「开发人员模式」。
3. 点击「加载解压缩的扩展」。
4. 选择 `D:\Bili-Daily`（不要选择 `snapshots` 子目录）。
5. 固定 Bili Daily 图标，打开弹窗确认四个区域能加载。

### 8.2 日常启动

- 正常打开 B 站视频页即可采集观看记录。
- 打开弹窗查看昨日总结、7 天画像和推荐。
- 需要自动发现时，在弹窗中点击「开启自动发现」，然后正常浏览视频页；不需要时关闭。

### 8.3 修改代码后重新加载

1. 打开 `edge://extensions/`。
2. 找到 Bili Daily，点击「重新加载」。
3. 已打开的 B 站页面需要刷新一次，内容脚本才会用新代码重新注入。
4. 重新打开弹窗。

### 8.4 开发日期切换

`dev-config.js` 当前 `enabled: true`，弹窗标题栏会显示「昨日 / 今天」开发切换。
该选择只影响本次弹窗的展示日期，不写存储，也不影响采集。若不需要，改为 `false` 后重载；
本次封存**未修改**该文件。

---

## 9. 版本快照位置与恢复方法

### 9.1 快照位置

```text
D:\Bili-Daily\snapshots\personal-mvp-v1.0-2026-11-12\
```

- `SNAPSHOT-README.md`：快照说明。
- `SHA256SUMS.txt`：94 个文件的 SHA-256 清单（另含说明文件自身，共 95 行）。
- 94 个文件 = 41 个根目录文件 + 51 个 `docs/` 文件 + `tools/build-report-html.js` + `reports/` 文件。
- 未包含 `rollback/`（历史过程快照，原目录保持原样）与 `chrome.storage.local` 数据。
- 无 Git 提交、无 Git 标签；快照目录名 `personal-mvp-v1.0-2026-11-12` 即版本标识。

### 9.2 完整性校验

```bash
cd /d/Bili-Daily/snapshots/personal-mvp-v1.0-2026-11-12
sha256sum -c SHA256SUMS.txt
```

封存时 Claude 已实际执行，全部返回 `OK`。

### 9.3 恢复代码到原目录

```powershell
# 建议先关闭所有 Bili Daily 弹窗
Copy-Item -Path "D:\Bili-Daily\snapshots\personal-mvp-v1.0-2026-11-12\*" `
          -Destination "D:\Bili-Daily" -Recurse -Force
```

然后在 `edge://extensions/` 点击「重新加载」，刷新 B 站页面。

说明：

- 该命令只覆盖同名代码/文档文件，不删除工作目录中后来新增的文件。
- 不触碰 `chrome.storage.local`。
- 不要把扩展改为从快照目录加载；那可能产生新的扩展 ID，导致看不到原有数据。

### 9.4 只回滚运行代码

如果只想恢复扩展运行文件，不恢复文档：

```powershell
$snapshot = "D:\Bili-Daily\snapshots\personal-mvp-v1.0-2026-11-12"
Copy-Item "$snapshot\manifest.json" "D:\Bili-Daily\" -Force
Copy-Item "$snapshot\popup.html" "D:\Bili-Daily\" -Force
Copy-Item "$snapshot\popup.css" "D:\Bili-Daily\" -Force
Copy-Item "$snapshot\popup.js" "D:\Bili-Daily\" -Force
Copy-Item "$snapshot\dev-config.js" "D:\Bili-Daily\" -Force
Copy-Item "$snapshot\storage.js" "D:\Bili-Daily\" -Force
Copy-Item "$snapshot\stats.js" "D:\Bili-Daily\" -Force
Copy-Item "$snapshot\content.js" "D:\Bili-Daily\" -Force
Copy-Item "$snapshot\interest-profile.js" "D:\Bili-Daily\" -Force
Copy-Item "$snapshot\candidate-pool.js" "D:\Bili-Daily\" -Force
Copy-Item "$snapshot\candidate-features.js" "D:\Bili-Daily\" -Force
Copy-Item "$snapshot\candidate-content-import.js" "D:\Bili-Daily\" -Force
Copy-Item "$snapshot\candidate-store.js" "D:\Bili-Daily\" -Force
Copy-Item "$snapshot\candidate-discovery.js" "D:\Bili-Daily\" -Force
Copy-Item "$snapshot\discovered-candidate-store.js" "D:\Bili-Daily\" -Force
Copy-Item "$snapshot\recommend-core.js" "D:\Bili-Daily\" -Force
Copy-Item "$snapshot\recommend-quality.js" "D:\Bili-Daily\" -Force
Copy-Item "$snapshot\recommend-rank.js" "D:\Bili-Daily\" -Force
Copy-Item "$snapshot\recommend-service.js" "D:\Bili-Daily\" -Force
```

### 9.5 回滚到更早阶段

既有 `rollback/` 目录未修改，仍可用于阶段回滚。各子目录的 `README.md` 说明了复制哪些文件。
回滚代码同样不会触碰 `chrome.storage.local`。

---

## 10. 后续开发建议

按优先级排列，均为**下一版本**的工作，不在本次封存中执行：

1. **配置 Git 并提交当前冻结版本**：以本快照为基线建立首个提交与标签，之后所有改动可追踪。
2. **发布卫生**：把 `dev-config.js` 的 `enabled` 改为 `false`，移除开发日期入口；
   同时把 `manifest.json` 的 `version` 从 `0.0.1` 提升到明确的个人版本号（如 `1.0.0`）。
3. **数据导出/恢复 UI**：在弹窗内提供显式导出/导入按钮，避免依赖 DevTools 控制台；
   导出内容应带 schema 版本与时间戳，导入前预览差异。
4. **长期稳定性观察**：连续使用 1–2 周，记录候选数量、存储增长、弹窗打开耗时、
   多标签页下的内存占用；发现异常再优化，不预先重构。
5. **真实推荐评估**：记录推荐曝光与是否点击/观看，做简单的离线命中率统计；
   不要把“可信度”当作准确率。
6. **B 站 DOM 兼容维护**：定期在真实视频页检查相关推荐卡片结构；
   观察器已尽量避免依赖固定类名，但页面结构变化仍可能降低发现率。
7. **性能测量**：在真实页面上记录 MutationObserver 回调频率、扫描耗时、写入频率；
   合成测试的 5 秒阈值只用于发现明显退化。
8. **数据恢复演练**：在非关键数据上实际走一遍 7.2/7.3，确认 JSON 备份可恢复后再依赖它。
9. **保持冻结**：任何新功能都应在新的快照/分支上进行；不要直接修改
   `snapshots/personal-mvp-v1.0-2026-11-12`。

---

## 11. 封存检查清单

### 11.1 生成最终 HTML

本轮命令通道阻断，HTML 未生成。请在 `D:\Bili-Daily` 下执行现有生成脚本（不要手工复制 HTML）：

```powershell
node tools/build-report-html.js `
  docs/acceptance/MVP-Sprint/MVP-v1.0-final-acceptance.md `
  docs/acceptance/MVP-Sprint/MVP-v1.0-final-acceptance.html
```

生成后检查：标题、目录、表格、代码块完整；浏览器可离线打开；打印预览无明显溢出。

### 11.2 检查清单

| 检查项 | 状态 |
|---|---|
| 检查 Git 状态并确认未配置 Git | 已完成（`fatal: not a git repository`） |
| 未创建错误的 Git 提交/标签 | 已完成（无 Git，不伪造标签） |
| 建立独立完整快照 | 已完成 |
| 生成并验证 SHA-256 清单 | 已完成（94 个文件全部 `OK`） |
| 未覆盖既有 `rollback/` | 已完成 |
| 未删除/清空真实用户数据 | 已完成（未访问真实存储） |
| 未修改运行代码与测试断言 | 已完成 |
| 17 个套件 / 495 项基线记录 | 已完成（用户本机结果） |
| 工程审计 10 项 | 已完成（静态） |
| 真实 Edge 验收记录 | 已完成（标记“用户报告通过”） |
| 明确未验证项 | 已完成 |
| 最终 Markdown 报告 | 已创建 |
| 最终 HTML 报告 | **未生成**（本轮命令通道阻断）；命令见 11.1，需本机执行 |
| 更新 `docs/acceptance/README.md` 索引 | 已完成 |

---

## 12. 最终结论

当前版本满足个人自用 MVP 的封存条件：

- 核心功能已实现，并由项目所有者在 Edge 中实际使用过；
- 17 个测试套件、495 项测试在项目所有者本机全部通过；
- 权限范围小，数据只存本地，未发现远程发送路径；
- 自动发现默认关闭，来源标识、去重、冲突阻断和导入/观察隔离均有代码与测试覆盖；
- 已建立独立、可校验、可恢复的稳定版快照。

同时必须保留以下限定：

- 本报告不代表长期稳定性、推荐准确率或全面安全审计已完成；
- 本轮 Claude 未独立运行测试，495/495 是项目所有者本机结果；
- 真实 Edge 验收是“用户报告通过”，没有本轮现场日志或截图；
- `dev-config.js` 的开发入口仍为开启状态，建议下一版本关闭。

**封存完成。不新增功能，不进入视觉重构。**
