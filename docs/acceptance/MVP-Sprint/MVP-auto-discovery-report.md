# MVP 自动发现新 UP 主开发报告

日期：2026-11-12
项目：Bili Daily（个人自用版）
范围：自动观察视频页「相关推荐」卡片 → 独立存储 → 内容证据适配 → 探索推荐 → 弹窗状态与操作

## 0. 执行状态（先读）

本轮开发已完成代码与测试文件的编写，但**命令执行通道在验证阶段被阻断**：
`node --check`、`node test-*.js`、`curl`、`WebFetch` 均返回
`qwen/qwen-flash is temporarily unavailable (connection failed), so auto mode cannot determine the safety of Bash/WebFetch right now.`
只有 `node --version`（v24.19.0）与只读文件操作成功。

因此：

| 项目 | 状态 |
|---|---|
| 代码实现 | 已完成（静态审查） |
| 语法检查 | **未执行**（命令通道阻断） |
| 新增 4 个测试套件 | **未执行** |
| 既有 422 项测试回归 | **本轮未执行**；422/422 为用户此前在本机确认的历史基线 |
| 真实 B 站页面 DOM 核验 | **未执行**（WebFetch 阻断，且未打开真实浏览器页面） |
| 性能测试 | **未执行** |
| 单文件 HTML | **已生成**：`MVP-auto-discovery-report.html`。`tools/build-report-html.js` 被命令通道阻断，未能执行；该 HTML 为按本 Markdown 内容手工整理的单文件版本，Markdown 仍是事实来源 |

**不得把本报告理解为“测试已通过”。** 本机回填命令见第 9.3 节。
对应单文件 HTML：`docs/acceptance/MVP-Sprint/MVP-auto-discovery-report.html`（手工等价整理，非 `tools/build-report-html.js` 输出）。

后续本机跑出 3 个失败套件后的修复记录见
`docs/acceptance/MVP-Sprint/MVP-auto-discovery-test-fix-report.md`
（补 `stats.js` require、修复服务层 observations 数组判断）；495 项仍待本机回填。

## 1. 目标与范围

本轮目标：

1. 在**不新增 host_permissions、不引入后台爬虫**的前提下，自动观察用户正常打开的视频页上已经渲染的「相关推荐」卡片。
2. 只把 BV + UP UID 能可靠配对的卡片作为证据；字段缺失保留缺失，不猜测。
3. 使用独立存储键保存页面观察候选，不碰 `biliDailyRecords` 与 `biliDailyCandidateImports`。
4. 把合格候选适配成探索通道内容证据；已观看 UP 仍走 main。
5. 弹窗增加默认关闭的自动发现区域、状态、计数、整理与单独清除。
6. 保留既有推荐算法、手动导入与观看记录采集行为。

明确不在本轮范围：

- 自动点击、自动滚动、批量打开视频；
- 绕过验证码、风控或访问限制；
- 读取 Cookie / token / 账号凭据；
- 新增站点权限或远端上传；
- 在线核验 UP 主身份。

## 2. 新增与修改文件

### 2.1 新增

| 文件 | 作用 |
|---|---|
| `candidate-discovery.js` | 视频页 DOM 观察器（内容脚本） |
| `discovered-candidate-store.js` | 独立候选存储 + page-observed 证据适配器 |
| `test-candidate-discovery.js` | 22 项解析 / DOM / 控制器测试 |
| `test-discovered-candidate-store.js` | 26 项存储 / 冲突 / 准入 / 容量测试 |
| `test-auto-discovery-integration.js` | 22 项排序 / 服务 / 去重 / 安全测试 |
| `test-auto-discovery-performance.js` | 3 项上限与可复现性能测试 |
| `rollback/before-auto-discovery/README.md` | 本轮回滚说明 |
| `docs/acceptance/MVP-Sprint/MVP-auto-discovery-report.md` | 本报告 |

### 2.2 修改

| 文件 | 修改点 |
|---|---|
| `manifest.json` | 内容脚本按依赖顺序增加 `discovered-candidate-store.js`、`candidate-discovery.js`；权限仍只有 `"storage"`，匹配范围仍只有 `https://www.bilibili.com/video/*` |
| `recommend-rank.js` | 探索通道同时接收手动导入与自动发现；同 UID 手动导入优先；page-observed 来源、理由、低置信度与近似标记 |
| `recommend-service.js` | 可选读取 `BiliDailyDiscoveredCandidateStore`；构建 discovery 视图状态；新增 page-observed 来源标签 |
| `popup.html` | 新增「自动发现新 UP 主」区域；加载 `discovered-candidate-store.js` |
| `popup.css` | 新区域、状态 pill、三列计数、页面观察徽标、按钮换行 |
| `popup.js` | 读取发现存储/设置、渲染状态与计数、默认关闭开关、手动整理、单独清除、页面观察徽标、存储变化监听 |
| `recommend-quality.js` | 可靠性评估中保留 `page-observed` 来源标记，不再把页面观察统一写成 `user-provided`；`onlineVerified` 仍恒为 false |

未修改：

- `storage.js`（观看记录结构不变）
- `candidate-store.js`（手动导入结构不变）
- `candidate-content-import.js`、`recommend-core.js`
- 既有测试断言

## 3. 数据来源与真实页面观察

### 3.1 来源

仅在以下条件同时满足时观察：

1. 用户在弹窗中主动开启自动发现；
2. 当前页面是 `https://www.bilibili.com/video/*`；
3. 页面已经渲染出视频链接卡片；
4. 卡片内能可靠找到**恰好一个视频 BV**与**恰好一个 UP UID**。

不发起额外网络请求，不请求页面接口，不读取登录态。

### 3.2 真实 DOM 核验结果

**未执行。**

原因：WebFetch 与命令通道均被安全分类器阻断，本轮没有在真实浏览器中打开 B 站视频页核查当前 DOM。
因此本实现**故意不写死 B 站 CSS 类名**，而是使用通用结构：

- 视频链接：`a[href*="/video/"]`，只接受 `bilibili.com` / `www.bilibili.com` 的 `/video/BV...`；
- UP 链接：`space.bilibili.com/<正整数 UID>`；
- 卡片：从视频链接向上寻找最近的、只包含一个不同 BV 且至少有一个 UP 空间链接的祖先；
- 遇到多个 BV 或多于一个 UID 的祖先立即停止，不猜测；
- 标题：优先 `title` / `aria-label`，其次同 BV 锚文本与 `data-title`；
- UP 昵称：空间链接文本或显式 `data-up-name` / `data-author` / `data-uname`；
- 分区：**只**读取显式 `data-tname` / `data-partition`，不读面包屑或猜测。

这条路径仍需 Edge 真实页面验收。若真实页面卡片没有 UP 空间链接、或 UP 信息只有一个不可点击昵称、或推荐区并非以视频链接卡片渲染，则观察器会得到 0 条观察，弹窗显示「已开启」但计数为 0，而不会编造数据。这属于明确降级，不是测试通过。

### 3.3 观察范围限制

当前扫描入口是整页文档（`document`），再按“单 BV + 单 UID 的最近祖先”识别卡片。这样可以避免依赖易变类名，但尚未用真实页面确认推荐区之外是否也存在同类卡片。若验收发现误收，应优先收窄到真实「相关推荐」容器；在收窄前，`observationScope` 的语义应理解为“页面内符合卡片结构的观察”，并应以真实页面验收结论为准。本报告不声称已完成该范围的 DOM 证明。

## 4. 独立存储结构

### 4.1 存储键

| 键 | 内容 |
|---|---|
| `biliDailyDiscoveredCandidates` | 页面观察候选 |
| `biliDailyDiscoverySettings` | 开关与容量/保留配置 |

不读取、不写入：

- `biliDailyRecords`
- `biliDailyCandidateImports`

### 4.2 候选记录

```json
{
  "version": 1,
  "kind": "bili-daily-discovered-candidates",
  "updatedAt": "2026-11-12T...",
  "observations": [
    {
      "upUid": "2001",
      "upName": "示例UP",
      "bvid": "BV1xxxxxxxxx",
      "title": "页面显示的标题",
      "partition": "科技",
      "observedAt": "2026-11-12T...",
      "firstObservedAt": "2026-11-10T...",
      "sourcePageBvid": "BV1yyyyyyyyy",
      "provenance": "page-observed",
      "observationScope": "related-recommendation-card",
      "evidenceStatus": "valid",
      "fieldStates": {
        "upName": "present",
        "title": "present",
        "partition": "missing"
      },
      "metadataConflictFields": [],
      "conflictUids": []
    }
  ]
}
```

写入前经过严格白名单复制：HTML、脚本、Cookie、token、任意未知字段不会进入存储。

### 4.3 去重、冲突、过期、容量

- 同一 `upUid + bvid`：合并缺失字段、更新时间，不重复计数。
- 同一 `bvid` 出现不同 `upUid`：所有相关记录标 `evidenceStatus: "uid-conflict"`，记录排序后的 `conflictUids`，**不为任何一方选定身份**。
- 同一 `upUid + bvid` 的标题/分区互相矛盾：记为 `metadataConflictFields`，该视频不进入内容特征。
- `retentionDays`：默认 180 天，允许 1–3650 天；过期记录在写入与证据适配时剔除。
- `maxCandidates`：默认 300，上限 500；按最近观察时间保留。
- 单条文本长度与整库字节数有上限；超限时淘汰最旧记录。

### 4.4 默认设置

```json
{
  "enabled": false,
  "maxCandidates": 300,
  "retentionDays": 180,
  "maxObservationsPerPage": 100,
  "minImportedVideos": 3,
  "minTitleCoverage": 0.6,
  "minPartitionCoverage": 0.6,
  "allowPartitionDegradation": true
}
```

默认关闭。关闭后 `addObservations()` 直接返回且**不产生任何写入**，即使内容脚本仍有排队观察。

## 5. 内容证据适配与探索准入

`discovered-candidate-store.js` 的 `buildDiscoveredEvidence()` 输出两套结构：

- `sidecar`：供排序层读取的候选内容特征；
- `assessment`：正式评估层，包含身份证据、内容证据与晋升状态。

准入规则：

1. 至少 `minImportedVideos` 个不同 BV（默认 3）；
2. 标题覆盖率达到阈值，且至少 3 个视频有可用标题；
3. 分区覆盖率达到阈值，**或**在 `allowPartitionDegradation: true` 时按标题做低可信探索；
4. 身份冲突直接阻断，状态 `pending-review`；
5. 已观看 UID 从自动发现候选中排除，继续走 main；
6. 页面观察候选固定 `provenance: "page-observed"`；
7. `identityEvidence.onlineVerified` **恒为 false**，`fromUserInput: false`、`fromWatchHistory: false`；
8. 不生成观看时长、播放量或不存在的分区。

分区缺失时的安全降级：

- `partitionCounts: []`，不填“未知”或猜测分区；
- `contentStatus: "partial"`；
- `promotion.partitionDegraded: true`；
- 推荐层只使用标题相似度，并标记 `approximate: true`、`confidence: "low"`。

## 6. 推荐引擎接入

### 6.1 排序层

`recommend-rank.js` 的探索通道现在分别收集：

- 手动导入 draft，`provenance: "user-provided"`；
- 自动发现 draft，`provenance: "page-observed"`。

规则：

- 两者可单独工作，不要求手动导入先存在；
- 同一 UID 同时出现在手动导入和自动发现时，**手动导入优先**，自动发现该 UID 不再进入；
- 已观看 UID 仍由 main 通道处理；
- 继续使用既有时间衰减、冷启动、可靠性、MMR 与探索配额；
- 默认 K=5，探索配额仍可配置。

page-observed 推荐理由：

```text
该候选来自你在 B 站视频页「相关推荐」中实际观察到的页面卡片，
共 N 个不同视频；本地未观看过；
只记录页面当时展示的信息，不代表账号经过平台验证
```

理由数据包含 `provenance: "page-observed"`、`observedVideoCount`、`onlineVerified: false`，不包含“官方认证”等表述。

### 6.2 服务层

`recommend-service.js`：

- 可选读取 `BiliDailyDiscoveredCandidateStore`；
- 将 `{sidecar, assessment}` 传给排序层；
- 新增来源标签：`来源：页面相关推荐发现（本地观察，未在线核验）`；
- 新增 `view.discovery` 状态：`disabled` / `enabled` / `insufficient` / `has-candidates` / `unavailable`；
- 计数：已发现、可推荐、数据不足、待复核；
- 没有发现存储时不影响既有手动导入和 main 推荐。

## 7. 弹窗

新增「自动发现新 UP 主」卡片：

- 状态 pill：读取中 / 已关闭 / 已开启 / 数据不足 / 已有可推荐候选 / 不可用；
- 三个计数：新发现 UP 主、可进入探索、数据不足；
- 默认关闭开关；
- 「手动重新整理」：执行过期与容量清理；
- 「清除页面观察候选」：只清空 `biliDailyDiscoveredCandidates`，不影响观看记录与手动导入；
- 说明候选只在开启功能期间、正常浏览视频页并出现相关推荐卡片时积累；
- 推荐卡片增加「页面相关推荐发现」徽标，UP 名称仍可打开经过 UID 校验的空间链接；
- 刷新只读取本地存储，不发起网络请求；
- 弹窗打开/刷新本身不写入任何候选。

## 8. 权限与安全边界

- `manifest.json` 权限仍为 `["storage"]`；
- 内容脚本匹配仍为 `https://www.bilibili.com/video/*`；
- 未新增 `host_permissions`；
- 未新增后台脚本、远程代码或 `chrome.tabs` 权限；
- 不使用 `innerHTML` 写入外部文本；
- 不使用 `eval` / `new Function` / 字符串执行；
- 不读取 Cookie、token、localStorage 登录凭据；
- 不保存页面 HTML、脚本、不必要的用户信息；
- 不上传观看历史或候选数据；
- 自动发现存储与观看记录、手动导入完全分离；
- `onlineVerified` 不会被设为 true。

## 9. 测试

### 9.1 历史基线

用户此前在本机确认：13 个既有测试套件全部退出码 0，共 **422/422** 通过；Edge 基础功能正常。
这是本轮改动前的历史基线，**不是本轮修改后的回归结果**。本轮未执行这 422 项。

### 9.2 新增测试文件与声明数量

| 文件 | 声明测试数 | 覆盖 |
|---|---:|---|
| `test-candidate-discovery.js` | 22 | BV/UID 解析、恶意链接、字段归属、缺失字段、卡片歧义、同卡去重、默认关闭、节流、停止后不写入、SPA 切换、页面上限 |
| `test-discovered-candidate-store.js` | 26 | 默认关闭、白名单字段、UID+BV 去重、跨页累积、冲突、过期、容量、准入、分区降级、已观看排除、空状态、不可变、稳定 JSON |
| `test-auto-discovery-integration.js` | 22 | 独立探索、手动优先去重、main 保留、低置信度、理由/来源一致、服务状态、空状态、稳定排序、恶意字段、无网络调用 |
| `test-auto-discovery-performance.js` | 3 | 400 卡片扫描上限与耗时、300 条证据适配、500 条输入规模 |

新增合计 **73** 项；若全部通过，连同历史基线为 **495** 项。
由于本轮未执行，以上仅为声明数量，**不是通过数**；新增套件的实际退出码与 `N/M 通过` 均为**未执行**，需按第 9.3 节在本机回填。

### 9.3 本机回填命令（未执行）

在 `D:\Bili-Daily` 下执行：

```powershell
node --check candidate-discovery.js
node --check discovered-candidate-store.js
node --check recommend-rank.js
node --check recommend-quality.js
node --check recommend-service.js
node --check popup.js
node --check test-candidate-discovery.js
node --check test-discovered-candidate-store.js
node --check test-auto-discovery-integration.js
node --check test-auto-discovery-performance.js

node test-candidate-discovery.js
node test-discovered-candidate-store.js
node test-auto-discovery-integration.js
node test-auto-discovery-performance.js
```

既有 13 个套件：

```powershell
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
  "test-recommend-service.js"
)
foreach ($file in $files) {
  node $file
  "EXIT=$LASTEXITCODE FILE=$file"
}
```

把每个 `EXIT=` 与最终 `N/M 通过` 回填到本报告，不要只保留“目标通过”。

## 10. 性能

性能测试已编写但**未执行**：

- 单次扫描最多 400 个视频锚点、40 张卡片；
- 单页最多 100 条观察（可配置，上限 200）；
- 库容量默认 300、上限 500；
- MutationObserver 回调只调度扫描，最小扫描间隔 1.5 秒，变更延迟 0.7 秒；
- 测试阈值各 5000ms，仅用于发现明显退化。

真实页面上的观察器 CPU 占用仍以 Edge 验收为准。

## 11. 已知限制与风险

1. **真实 DOM 未核验**：当前结构可能在实际 B 站页面上匹配不到卡片；若如此会显示 0 条观察，不会伪造。
2. **观察范围未收窄**：整页扫描可能包含推荐区之外的同类卡片；需真实页面验收确认，必要时收窄。
3. **UP 链接依赖**：卡片必须存在可解析的 `space.bilibili.com/<uid>` 链接；仅有昵称文本时不产生观察。
4. **标题可能混入非标题文本**：为不依赖类名，标题优先取锚点 `title` / `aria-label`，其次取同 BV 锚文本；只清理明确的时钟样式时长，播放量等页面统计文本若与标题同处一个文本节点，可能被保留并进入标题词元。真实页面验收应检查这一点。
5. **分区多数可能缺失**：真实卡片若不暴露 `data-tname` / `data-partition`，会走标题降级；这是设计内行为。
6. **关闭后已有候选仍参与推荐**：关闭停止新增观察，但不会自动删除已积累候选；用户可单独清除。
7. **HTML 报告生成**：`tools/build-report-html.js` 本轮**未执行**（命令通道阻断）；已按 Markdown 内容手工生成等价单文件 HTML，格式与内容以 Markdown 为准。
8. **测试未执行**：任何“通过”结论都必须以本机输出为准。

## 12. 回滚

快照：`rollback/before-auto-discovery/`（含 README）。
回滚步骤见该目录 README。核心是恢复：

- `manifest.json`
- `content.js`
- `popup.html` / `popup.css` / `popup.js`
- `recommend-rank.js` / `recommend-service.js`
- `candidate-store.js` / `candidate-content-import.js` / `recommend-quality.js`

观看记录键 `biliDailyRecords` 结构未变。自动发现的两个新键在回滚后会留在本地，但旧代码不会读取；需要时可在扩展 DevTools 中单独删除。

## 13. Edge 手动验收清单

1. 在 Edge 扩展页重新加载 Bili Daily，确认无加载错误。
2. 打开弹窗，确认「自动发现新 UP 主」显示“已关闭”，开关默认关闭，计数为 0。
3. 打开一个 B 站视频页，等待相关推荐渲染；确认开启前没有新增观察记录。
4. 在弹窗开启自动发现，回到/刷新同一视频页。
5. 正常滚动页面，使更多相关推荐卡片渲染；不要使用自动滚动或批量打开。
6. 再次打开弹窗，确认「新发现 UP 主」增加；若为 0，记录页面实际卡片结构并判断是否为降级。
7. 继续浏览至少 3 个不同视频页，确认同一 UP 的不同视频可累积；确认同一 UID+BV 不重复计数。
8. 当某个未观看 UP 达到 3 个不同视频且标题覆盖达标时，确认「可进入探索」增加。
9. 查看推荐列表：该 UP 应出现在探索通道，带「页面相关推荐发现」徽标，理由写明页面观察且不代表平台验证。
10. 点击 UP 名称，确认打开 `https://space.bilibili.com/<uid>`；确认没有官方认证文案。
11. 关闭自动发现，刷新视频页并等待，确认不再新增观察；已积累候选仍保留。
12. 点击「清除页面观察候选」，确认只清除自动发现数据，观看记录和手动导入不变；检查控制台无报错、Network 面板无新增扩展请求。

若第 6 步为 0，或第 9 步没有推荐，请记录：
- 当时视频页 URL 与页面是否登录；
- 相关推荐卡片中视频链接、UP 链接的实际 `href`；
- 是否能看到分区字段；
- 弹窗计数与控制台错误。

## 14. 下一步

1. 在本机执行第 9.3 节命令并回填真实结果。
2. 用 Edge 按第 13 节验收，重点确认真实 DOM 是否能产出观察。
3. 若真实页面匹配不到卡片，依据实际 `href` 结构做最小适配，不引入类名硬编码和额外权限。
4. 若推荐未出现，检查准入计数与 `no-eligible-discovered` 原因，不通过放宽断言或伪造数据解决。
