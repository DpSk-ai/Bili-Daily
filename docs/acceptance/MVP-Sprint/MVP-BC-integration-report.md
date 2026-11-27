# MVP 工作包 B + C 一体化开发报告

- 日期：2026-11-12
- 范围：本地候选持久化、导入体验、推荐计算接线、Edge popup UI、自动化测试补充、陌生 UP 主发现可行性预留
- 代码状态：已完成本轮计划内改动
- 测试状态：**未执行**（Claude Code 的命令执行通道被安全分类器阻断，见第 6 节）
- 浏览器验收状态：**未执行**，需要项目所有者在 Edge 中手工完成（见第 9 节）

---

## 0. 执行摘要与诚实声明

本轮在 `D:\Bili-Daily` 完成了 B + C 的代码层一体化：

1. 新增独立候选存储层 `candidate-store.js`，使用独立键 `biliDailyCandidateImports`，不触碰 `biliDailyRecords`。
2. 新增推荐编排层 `recommend-service.js`，把观看记录、7 天画像、候选池、特征、C2-4B 导入证据与 C3-2 排序串成一条真实数据流。
3. 重写 `popup.html` / `popup.css` / `popup.js`，实现昨日总结、7 天画像、今日推荐、候选导入 / 删除 / 清空 / 刷新与全部状态反馈。
4. 新增 `test-candidate-store.js`（28 项）与 `test-recommend-service.js`（22 项）测试脚本。
5. 未修改 `manifest.json`：没有新增权限、没有新增网络访问、没有引入 CDN 或远程脚本。
6. 未修改任何已验收的算法模块（C1 / C2 / C3-1 / C3-2 的评分、MMR、配额、冷启动逻辑）。

**本轮没有运行任何测试或语法检查命令（仅确认了 Node 版本号）。** 命令执行工具持续返回：

```text
qwen/qwen-flash is temporarily unavailable (connection failed), so auto mode cannot determine the safety of Bash right now.
```

因此：

- 下方所有“预期通过”都只是静态审查结论，**不构成测试通过**；
- 测试结果一栏统一写“未执行”；
- 第 6.3 节给出可在本机 PowerShell 直接执行的验证命令，请回填真实输出。

---

## 1. 实际改动清单

### 1.1 新增文件

| 文件 | 作用 |
|---|---|
| `candidate-store.js` | 候选导入持久化：校验、白名单复制、原子写入、删除、清空、sidecar 构建 |
| `recommend-service.js` | 推荐数据流编排与弹窗视图模型；安全空间链接校验 |
| `test-candidate-store.js` | 候选持久化测试（28 项，内存模拟 chrome.storage.local） |
| `test-recommend-service.js` | 推荐接线测试（22 项，纯内存） |

### 1.2 修改文件

| 文件 | 改动 |
|---|---|
| `popup.html` | 新增 7 天画像、今日推荐、候选导入与管理三个区块；按依赖顺序加载 13 个脚本 |
| `popup.css` | 深色赛博二次元样式；画像柱状条、推荐卡、通道 / 可信度标签、导入列表、轻量进场动画、`prefers-reduced-motion` |
| `popup.js` | 完全重写：真实读取两类存储、渲染画像与推荐、完整导入 / 删除 / 清空 / 刷新交互、安全链接、错误与空状态 |

### 1.3 未修改

- `manifest.json`：仍只有 `"permissions": ["storage"]`，content script 仍只匹配 `https://www.bilibili.com/video/*`。
- `storage.js`、`stats.js`、`interest-profile.js`、`candidate-pool.js`、`candidate-features.js`、`candidate-content-import.js`、`recommend-core.js`、`recommend-quality.js`、`recommend-rank.js`。
- 任何既有测试文件与断言。

### 1.4 回滚快照

开发前已创建 `rollback/before-mvp-bc-integration/`，包含修改前的 `popup.html`、`popup.js`、`popup.css`、`manifest.json`、`storage.js`、`recommend-rank.js`、`acceptance-README.md` 与回滚说明。

---

## 2. 数据结构

### 2.1 候选存储（`chrome.storage.local` → `biliDailyCandidateImports`）

```json
{
  "version": 1,
  "kind": "bili-daily-candidate-store",
  "updatedAt": "2026-11-12T03:00:00.000Z",
  "batches": [
    {
      "id": "batch-<base36>-<8位随机>",
      "importedAt": "2026-11-12T03:00:00.000Z",
      "sourceName": "候选.json",
      "provenance": "user-provided",
      "candidates": [
        {
          "upUid": "2001",
          "upName": "探索UP",
          "observedAt": 1762900000000,
          "videos": [
            {
              "bvid": "BV1aa411c7mD",
              "title": "科技前沿教程",
              "partition": "科技",
              "tags": ["科技"],
              "url": "https://www.bilibili.com/video/BV1aa411c7mD"
            }
          ]
        }
      ]
    }
  ]
}
```

存储上限：

| 限制 | 值 |
|---|---|
| 单次导入文本 | 1 MiB |
| 存储序列化总量 | 2 MiB |
| 批次数量 | 50 |
| 候选总数 | 500 |
| 单候选视频数 | 50（由 C2-4B 限制） |
| 全库视频数 | 2000（由 C2-4B 限制） |
| 来源文件名长度 | 120 |

### 2.2 导入文档（外部 JSON，必须由用户确认）

```json
{
  "schemaVersion": 1,
  "kind": "bili-daily-candidate-content-import",
  "provenance": "user-provided",
  "userConfirmed": true,
  "exportedAt": "2026-11-12T03:00:00.000Z",
  "sourceNote": "手工整理的候选",
  "candidates": [
    {
      "upUid": "2001",
      "upName": "探索UP",
      "observedAt": "2026-11-10T12:00:00.000Z",
      "videos": [
        {
          "bvid": "BV1aa411c7mD",
          "title": "科技前沿教程",
          "partition": "科技",
          "tags": ["科技", "教程"],
          "url": "https://www.bilibili.com/video/BV1aa411c7mD"
        }
      ]
    }
  ]
}
```

`provenance` 不是 `user-provided`、`userConfirmed` 不是 `true`、`schemaVersion` 不是 `1`、`kind` 不匹配时一律拒绝，且不写入。

### 2.3 推荐视图模型（`recommend-service.js` 输出）

```js
{
  ok: true,
  generatedAt: 1762900000000,
  endDate: "2026-11-11",
  mode: "similarity",          // 或 "returning-only"
  coldStart: { status, label, message, thresholds },
  profile: {
    status, hasData, activeDays, totalWatchMs, effectiveVideoCount,
    favoritePartition: { name, share } | null,
    bars: [{ name, share, watchMs }],
    topUp: { upUid, upName, effectiveWatchMs, effectiveVideoCount } | null,
    reasons: []
  },
  recommendations: [{
    upUid, upName,
    lane: "main" | "exploration",
    laneLabel, provenance, provenanceLabel,
    confidence, confidenceLabel, score,
    reasons: [{ code, message }],
    similarity: { partition, title, basis, approximate },
    reliability: { level, partitionCoverage, titleCoverage, onlineVerified: false },
    spaceUrl: "https://space.bilibili.com/<uid>" | null
  }],
  statusText, footnote, counts, diagnostics, lanes
}
```

失败时返回 `{ ok: false, error: { code, message } }`，代码为 `missing-script` / `invalid-records` / `invalid-date` / `compute-failed`。弹窗据此显示错误，而不是伪装成空数据。

---

## 3. 完整推荐数据流

```text
biliDailyRecords（本地观看记录，只读）
        │
        ├─→ stats.js          昨日总结
        └─→ interest-profile  7 天兴趣画像
                    │
                    ▼
            candidate-pool    本地 UP 候选与身份质量
                    │
                    ▼
          candidate-features  候选内容特征（缺特征不推荐）
                    │
                    ▼
biliDailyCandidateImports ──→ C2-4B 证据 / 探索准入
        （独立键，只有用户确认才写入）        │
                    └──────────┬────────────┘
                               ▼
                    recommend-rank（C3-2）
                    main 通道 + exploration 通道
                    MMR、时间衰减、K=5、探索配额=1
                               ▼
                    recommend-service 视图模型
                               ▼
                         popup 推荐卡
```

关键约束：

- 导入候选只进入 `exploration` 通道，`provenance` 固定为 `user-provided`，`onlineVerified` 恒为 `false`。
- 没有通过 C2-2 身份质量、C2-3 特征完整性或 C2-4B 探索准入的候选，不会占用探索名额。
- 每次构造 sidecar 都重新走一遍 `parseCandidateContentImport`，手工改坏的存储不会被送进排序。
- `K` 默认 5，`explorationQuota` 默认 1，均由 `recommend-service.js` 常量控制，弹窗不写死结果。

---

## 4. 安全边界

| 风险 | 处理 |
|---|---|
| 修改观看记录 | 候选使用独立键，`candidate-store.js` 从不读写 `biliDailyRecords` |
| 未确认写入 | 文件选择后只做预览；只有点击「确认导入」才调用 `importText` |
| 导入失败覆盖旧数据 | 读取 → 校验 → 合并 → 单次 `area.set`；任一步失败都不写入 |
| 原型污染 | 候选与视频逐字段白名单重建，丢弃 `__proto__` / `constructor` 等未知键 |
| 恶意 HTML | 弹窗全部使用 `textContent` 与 DOM API，不使用 `innerHTML`；导入文本按纯文本展示 |
| 恶意跳转 | `safeSpaceUrl` 只接受 `https://space.bilibili.com/<uid>`，且 UID 必须与卡片一致；`target="_blank" rel="noopener noreferrer"` |
| 凭据泄露 | 不读取 Cookie / token / 登录态；无网络请求；无远程脚本 |
| 超大文件 | 1 MiB 输入上限、2 MiB 存储上限、批次 / 候选数量上限 |
| 脏数据 | 读取时 `normalizeStore` 跳过损坏批次并返回警告；不会把损坏结构写回 |

---

## 5. 弹窗 UI 与真实交互

### 5.1 区块

1. **头部**：本地兴趣标识、开发日期切换（仅 `dev-config.js` 开启时显示）。
2. **昨日观看总结**：有效视频数、观看时长、偏好分区、时段摘要、Top 3 UP 主。
3. **最近 7 天兴趣画像**：状态标签、最常看分区、分区占比柱状条、常看 UP 主。
4. **今日 UP 主推荐**：刷新按钮、状态文案、推荐卡（序号、通道标签、可信度、UP 名、来源、理由、可靠性说明）。
5. **候选导入与管理**：文件选择 → 预览 → 确认 / 取消；已导入批次与候选列表；删除单个候选 / 删除批次 / 清空全部。

### 5.2 每个按钮的实际行为

| 控件 | 行为 |
|---|---|
| 刷新 | 重新读取观看记录与候选存储，重新运行完整推荐流程，更新时间戳 |
| 选择文件 | 校验体积、读取 UTF-8、`previewImport` 校验；失败显示原因，不写入 |
| 确认导入 | `importText` 原子写入 → 成功提示 → 重新渲染推荐与导入列表 |
| 取消 | 丢弃预览，不写入 |
| 删除（候选） | `deleteCandidate(batchId, upUid)`，只删指定候选 |
| 删除批次 | `deleteBatch(batchId)`，只删指定批次 |
| 清空全部 | 原生确认框；取消不写入；确认后仅清空候选键 |
| 推荐卡 UP 名 | 经安全校验的 UP 主空间链接，新标签页打开 |
| 开发日期切换 | 仅切换昨日总结读取的日期键，不写存储 |

### 5.3 状态反馈

- `empty`：没有观看记录 → 提示先观看视频，不生成推荐。
- `insufficient`：数据不足 → 只显示回访候选，说明探索通道未参与。
- `limited`：画像积累中 → 按较低置信度展示。
- `ready`：画像就绪 → 按内容相似度排序。
- 无候选 / 无合格导入 / 导入失败 / 计算失败 / 存储读取失败：均有独立文案，并说明下一步操作。
- 所有推荐理由来自 `recommend-rank` 实际生成的 `reasons`，弹窗不拼接虚构理由。

---

## 6. 测试

### 6.1 新增测试覆盖

`test-candidate-store.js`（28 项）：

- 预览不写存储、导入后读回、独立键、观看记录不被修改；
- 重复导入追加批次；
- 非法 JSON / schemaVersion / provenance / userConfirmed / 全部 UID 无效 / 超过 1 MiB → 旧数据不变；
- 非法 BV 视频被丢弃、候选保留；
- 写入失败 / 读取失败 → 不覆盖旧数据；
- 删除指定候选、不存在候选、删除指定批次、清空；
- 原型污染键、恶意 HTML 文本、损坏存储、未知字段白名单过滤；
- 来源文件名清洗、50 批次上限、统计摘要、导入文档回转、sidecar 重建、同 UID 跨批次合并。

`test-recommend-service.js`（22 项）：

- 冷启动 `empty` / `insufficient` / `limited`，四类文案完整性；
- 7 天画像字段来自真实记录；
- main 通道来源、空间链接、默认 K / 探索配额；
- 推荐理由来源与禁止伪造字段；
- 合规导入候选进入 exploration、不合格候选不占名额、探索名额 ≤1；
- 无 store / 损坏 store 降级；
- 安全 URL 全部拒绝分支；
- 状态文案、脚注、无效 endDate 回退、ISO now、输入不可变、JSON 往返。

### 6.2 执行状态：未执行

| 项目 | 状态 | 说明 |
|---|---|---|
| `node --check`（新增与修改文件） | **未执行** | 命令通道被阻断 |
| `test-candidate-store.js`（28 项） | **未执行** | 同上 |
| `test-recommend-service.js`（22 项） | **未执行** | 同上 |
| 既有 372 项回归 | **未执行** | 同上 |
| Edge 真实浏览器验收 | **未执行** | 需要所有权 owner 手工操作 |

如果全部通过，预期总计为 **422 项**（既有 372 + 新增 50）。这只是预期值，不是结果。

### 6.3 本机 PowerShell 验证命令

```powershell
cd D:\Bili-Daily

node --check candidate-store.js
node --check recommend-service.js
node --check popup.js
node --check test-candidate-store.js
node --check test-recommend-service.js

node test-candidate-store.js
node test-recommend-service.js

# 既有回归
node test-recommend-rank.js
node test-recommend-quality.js
node test-stats.js
node test-up-stats.js
node test-uid.js
node test-interest-profile.js
node test-candidate-pool.js
node test-candidate-quality.js
node test-candidate-features.js
node test-candidate-content-import.js
node test-recommend-core.js
```

请把每个脚本末尾的 `N/M 通过` 与退出码回填到本报告或新的测试结果文件中。**在真实输出出现前，本报告不宣称任何测试通过。**

---

## 7. 自动发现陌生 UP 主：可行性验证与权限申请

本轮**没有新增网络能力、没有新增权限、没有绕过验证码或风控**。以下是候选方案，需项目所有者明确批准后才能实施。

### 7.1 可选数据来源

| 方案 | 数据来源 | 新增权限 | 风险 / 限制 | 结论 |
|---|---|---|---|---|
| A. 已打开视频页的“相关推荐” DOM | 当前已授权的 `https://www.bilibili.com/video/*` 页面中用户可见的相关视频卡片 | 无新增 host 权限；只需在既有 content script 内读取同页 DOM | 只能拿到当前页面已渲染的内容；需要 `page-observed` 新来源类型；不得自动点击 / 自动加载更多 / 绕过风控 | **推荐作为下一阶段方案，待批准** |
| B. 公开 Web 接口（如 `api.bilibili.com` 相关推荐 / 搜索） | 网络 API | `"host_permissions": ["https://api.bilibili.com/*"]` | 可能需要 WBI 签名、Cookie、频率限制与风控；实现复杂；存在封禁风险 | 需批准；不得绕过风控 |
| C. 搜索页 DOM | `https://search.bilibili.com/*` 页面 | 新增 content script 匹配（相当于新增站点访问） | 结果列表依赖页面渲染；频繁抓取有风控风险 | 需批准 |
| D. B 站开放平台官方 API | 官方开放接口 | 需要 app key / secret 与账号授权 | 个人自用扩展没有现成资质；不引入第三方凭据 | 暂不采用 |
| E. 用户手工导入 JSON | 用户自己整理 | 无 | 已验证、最安全；但需要人工成本 | **当前已实现，保留** |

### 7.2 若选择方案 B，需要明确批准的权限

```json
"host_permissions": [
  "https://api.bilibili.com/*"
]
```

用途：只读请求公开的相关推荐 / 搜索结果，用于生成 `page-observed` 候选。

替代方案：

1. 方案 A：只读用户已经打开的视频页 DOM，不新增 host 权限、不发额外请求；
2. 方案 E：继续手工导入；
3. 方案 C：仅在用户主动打开搜索页时读取可见结果（仍需新增匹配与批准）。

### 7.3 架构预留

- 候选存储目前只接受 `provenance: "user-provided"`；未来新增 `page-observed` 时，应在 C2-4B 中新增独立来源与在线核验字段，**不得复用 `user-provided` 伪装成用户导入**。
- 自动发现候选必须经过与手工导入相同的 C2-4B 准入与探索配额；不得直接进入 main 通道。
- 任何自动发现功能都必须默认关闭、显式开启、可随时清空，并显示来源标签。

**本轮未修改 manifest，也未实现任何自动抓取。等待项目所有者批准后再排期。**

---

## 8. 用户操作方法

1. Edge 打开 `edge://extensions`，开启“开发人员模式”，选择“加载解压缩的扩展”，指向 `D:\Bili-Daily`。
2. 正常观看 B 站视频（每个视频至少 30 秒才会被计为有效观看）。
3. 点击工具栏 Bili Daily 图标：昨日总结与 7 天画像来自本地观看记录。
4. 在「候选导入与管理」点击“选择候选 JSON 文件”，选择符合第 2.2 节结构的文件。
5. 预览显示候选数 / 视频数后，点击“确认导入”。只有这一步会写入本地。
6. 导入成功后，合格候选会出现在「今日 UP 主推荐」的“探索推荐”通道；不合格候选不会占用名额，脚注会说明原因。
7. 点击推荐卡上的 UP 主名称，会在新标签页打开其 B 站个人空间。
8. 删除某个候选 / 某个批次 / 清空全部，均在弹窗内完成；清空不影响观看记录。
9. 关闭并重新打开弹窗，已导入候选仍在（`biliDailyCandidateImports`）。

---

## 9. Edge 手工验收清单（必须由所有者亲自完成）

> 自动化测试通过不等于浏览器验收通过。以下每一项都需要在真实 Edge 中观察。

### 9.1 加载与基础

- [ ] 扩展能在 Edge 中成功加载，无 manifest 错误。
- [ ] 弹窗打开后宽度约 380px，深色赛博风格，区块层次清晰，无横向滚动。
- [ ] 控制台没有红色报错；Network 面板没有 popup 发起的外部请求。

### 9.2 数据展示

- [ ] 昨日总结的视频数、时长、分区、时段与本地记录一致。
- [ ] 7 天画像的状态标签与柱状条显示真实分区，不是占位数据。
- [ ] 数据不足时显示“数据不足 / 画像积累中”等真实降级文案，而不是空白或假推荐。
- [ ] 推荐卡的“回访推荐 / 探索推荐”“来源”“可信度”标签正确。
- [ ] 推荐理由文字与实际观看记录一致，没有“已认证”“官方推荐”等虚构表述。

### 9.3 导入流程

- [ ] 选择非法 JSON：显示错误原因，已导入列表不变。
- [ ] 选择 `userConfirmed: false` 的文件：被拒绝，列表不变。
- [ ] 选择超过 1 MiB 的文件：被拒绝，列表不变。
- [ ] 选择合法文件：先出现预览（候选数 / 视频数），此时尚未写入。
- [ ] 点击“取消”：不写入，列表不变。
- [ ] 点击“确认导入”：成功提示，列表出现新批次与候选。
- [ ] 关闭弹窗再打开：导入列表仍在。
- [ ] 重新加载扩展后再打开：导入列表仍在。

### 9.4 探索通道

- [ ] 导入 3 个以上同分区、标题相关的视频后，推荐区出现“探索推荐”，来源为“用户导入（未在线核验）”。
- [ ] 导入信息缺失 / 过期 / 身份冲突的候选时，不出现该候选，脚注说明未通过探索准入。
- [ ] 探索推荐最多占 1 个名额（默认配额）。
- [ ] 点击探索推荐卡：打开的仍是 `https://space.bilibili.com/<UID>`，不是视频链接或第三方站点。

### 9.5 删除与刷新

- [ ] 删除单个候选：只消失该候选，同批次其他候选保留。
- [ ] 删除批次：只消失该批次。
- [ ] 清空全部：出现确认框；取消后无变化；确认后候选为空，观看记录仍在。
- [ ] 点击“刷新”：推荐重新计算，时间戳更新，没有假数据闪回。
- [ ] 关闭再打开弹窗：删除结果保持。

### 9.6 隔离与隐私

- [ ] DevTools → Application → Storage 中 `biliDailyRecords` 与 `biliDailyCandidateImports` 是两个独立键。
- [ ] 导入 / 删除候选后，`biliDailyRecords` 内容没有变化。
- [ ] 扩展没有读取 Cookie / token 的代码路径，也没有新增 host 权限。

---

## 10. 回滚方法

快照目录：`rollback/before-mvp-bc-integration/`。

```powershell
cd D:\Bili-Daily
Copy-Item rollback\before-mvp-bc-integration\popup.html . -Force
Copy-Item rollback\before-mvp-bc-integration\popup.js . -Force
Copy-Item rollback\before-mvp-bc-integration\popup.css . -Force
Copy-Item rollback\before-mvp-bc-integration\manifest.json . -Force
Copy-Item rollback\before-mvp-bc-integration\storage.js . -Force
Copy-Item rollback\before-mvp-bc-integration\recommend-rank.js . -Force
Copy-Item rollback\before-mvp-bc-integration\acceptance-README.md docs\acceptance\README.md -Force
Remove-Item candidate-store.js, recommend-service.js, test-candidate-store.js, test-recommend-service.js -ErrorAction SilentlyContinue
```

如需只删除候选数据、保留观看记录（在扩展 DevTools 控制台执行）：

```js
chrome.storage.local.remove("biliDailyCandidateImports");
```

回滚不会影响 `biliDailyRecords`。

---

## 11. 已知限制

1. 本轮测试与 Edge 验收均未执行，所有“预期”结论待本机回填。
2. 推荐只使用本地观看记录与用户导入候选；没有任何在线核验，`onlineVerified` 恒为 false。
3. 用户导入候选只进入探索通道，且必须满足 C2-4B 准入条件；不保证一定会出现。
4. 自动发现陌生 UP 主尚未实现；需要先在三种数据来源中做出选择并批准权限（第 7 节）。
5. 弹窗运行在本地脚本环境，不使用模块打包；新增文件必须按 `popup.html` 中的顺序加载。
6. 候选存储上限为 50 批次 / 500 候选 / 2 MiB；达到上限时需要先删除旧批次。
