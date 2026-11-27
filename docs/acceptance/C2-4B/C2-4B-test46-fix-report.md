# Bili Daily C2-4B 第 46 项测试失败修复报告

- 日期：2026-11-11
- 项目路径：`D:\Bili-Daily`
- 阶段：C2-4B 修复轮（不进入 C3）
- 失败项：`test-candidate-content-import.js` 第 46 项
- 判定：**业务实现缺陷**（不是排序不稳定，也不是测试预期错误）
- 结论：**修复完成，`241/241` 全部通过**（60 项新增 + 181 项回归），`node --check` 退出码 0

---

## 0. 执行状态总表

> 本报告严格区分“已执行 / 未执行 / 静态审查”。**未执行的命令不会写成通过。**

| 项目 | 状态 | 说明 |
|---|---|---|
| 阅读第 46 项测试 | 已执行 | 源码定位到第 825–830 行 |
| 阅读失败上下文 | 已执行 | `C2-4B-test-debug.txt`（UTF-16LE，已解码） |
| 定位根因 | 已执行 | 静态追踪 `parseVideo` → `resolveVideo` → `buildCandidateEvidence` |
| 代码修复 | 已执行 | 仅改 `candidate-content-import.js` |
| 回滚快照 | 已执行 | `rollback/before-c2-4b-test46-fix/`（2 个源文件 + README） |
| `node --check`（修改文件） | 已执行 | 退出码 `0` |
| `node test-candidate-content-import.js` | 已执行 | `60/60 通过`，退出码 `0` |
| 原有 181 项回归（7 个测试文件） | 已执行 | `181/181 通过`，逐个退出码 `0` |
| 单文件 HTML 报告 | 已执行 | `C2-4B-test46-fix-report.html` |

执行说明：本会话早段 Bash 安全分类通道持续不可用（原文见下），导致首轮无法执行任何
`node` 命令；该通道在后续恢复，上述结果均为**通道恢复后真实执行**所得，非推断。

> claude-opus-5-5 is temporarily unavailable (connection failed), so auto mode cannot determine the safety of Bash right now.

旁证：故障期间只读命令（`ls`、`grep`、`cat`）与 `node -v`（`v24.19.0`）仍可执行，
说明 Node 环境与项目本身没有问题。

---

## 1. 第 46 项测试

### 1.1 测试名称与源码

**名称**：`46. 结果可 JSON 序列化往返`

```js
test("46. 结果可 JSON 序列化往返", () => {
  const sidecar = freshSidecar();
  const assessment = CI.assessImportedContentCandidates(sidecar, {}, { now: NOW });
  assert.deepEqual(JSON.parse(JSON.stringify(sidecar)), sidecar);
  assert.deepEqual(JSON.parse(JSON.stringify(assessment)), assessment);
});
```

该测试验证的是 C2-4B 的一个硬性设计约束：产出的证据结构必须能被浏览器存储（`chrome.storage.local`）
原样序列化并读回，读回结果与内存对象**完全深等**。

### 1.2 expected 与 actual 的差异

失败发生在第 828 行（`node:assert` 报告位置 `test-candidate-content-import.js:828:10`）。
按 Node 的 `+ actual / - expected` 标记，差异为：

```
   url: '',
-  urlState: undefined      ← expected（原始 sidecar）中存在该键
   }                          ← actual（JSON 往返后）中该键消失
```

- **expected**：`sidecar.candidates[*].videos[*]` 含键 `urlState`，值为 `undefined`。
- **actual**：`JSON.parse(JSON.stringify(sidecar))` 中该键**不存在**。

原因在于 `JSON.stringify` 的规范行为：对象自有属性若值为 `undefined`，会被直接省略。
于是“往返”丢掉了这个键，`deepEqual` 判为不等。

`C2-4B-test-debug.txt` 中三个视频（`BV1xx411c7mD` / `BV1yy411c7mD` / `BV1zz411c7mD`）
逐个重复了同一行差异，与上述判断一致。

---

## 2. 根本原因

调用链：

```
parseVideo(raw, ...)        → 返回 { bvid, title, partition, tags, url, urlState }   ✅ 有 urlState
   ↓ variants.push(video)
resolveVideo(bvid, variants) → 返回 { bvid, title, partition, tags, url,
                                      titleState, partitionState, titleTruncated,
                                      status, conflictFields }                      ❌ 漏了 urlState
   ↓
buildCandidateEvidence(...)  → videos.map(v => ({ ..., urlState: v.urlState, ... }))  → undefined
```

`candidate-content-import.js` 中 `urlState` 只出现两处：

| 行 | 位置 | 作用 |
|---|---|---|
| 512 | `parseVideo` 返回对象 | 写入 `urlResult.state` |
| 1081 | `buildCandidateEvidence` 映射 | 读取 `video.urlState` |

中间的**合并层 `resolveVideo()` 既没有透传也没有重算 `urlState`**。
因此只要走“解析 → 去重合并 → 构建证据”这条主链路（即所有正常调用），
sidecar 里的每个视频都会得到 `urlState: undefined`。

### 2.1 为什么判定为业务实现缺陷

`docs/acceptance/C2-4B/C2-4B-import-report.md` 第 2.4 节明确规定 sidecar 视频结构为：

```js
bvid, title, partition, tags, url, urlState,
titleState, partitionState, titleTruncated,
status: "usable" | "metadata-conflict" | "uid-conflict",
conflictFields
```

其中 `urlState` 的取值域为 `"missing" | "accepted" | "rejected" | "short-link" | "not-video-url"`。

也就是说：**sidecar 缺少 `urlState` 本身就是违反已确认设计规范的**，
第 46 项只是把这个问题暴露出来的那个断言。
按“优先只改业务实现”的要求，正确修法是补上实现，而不是放宽测试。

同时排除的另外三种可能：

| 可能性 | 结论 | 依据 |
|---|---|---|
| 排序不稳定 | 排除 | 差异是“键存在 vs 键不存在”，与顺序无关；第 47 项（顺序无关）此前通过 |
| 数据结构差异 | 排除 | 表现为 `undefined` 键被序列化丢弃，不是值的类型问题 |
| 测试预期错误 | 排除 | 预期与设计文档 2.4 节一致；往返稳定是存储层的前提 |

---

## 3. 修改内容

只修改了一个文件：`candidate-content-import.js`。
**测试文件未改动**（不删测试、不跳断言、不改预期）。

### 3.1 新增：确定性的 URL 状态合并规则

```js
const URL_STATE_PRECEDENCE = [
  "accepted",
  "short-link",
  "not-video-url",
  "rejected",
  "missing"
];

function resolveUrlState(url, states) {
  if (url) return "accepted";
  for (let i = 0; i < URL_STATE_PRECEDENCE.length; i += 1) {
    if (states.has(URL_STATE_PRECEDENCE[i])) return URL_STATE_PRECEDENCE[i];
  }
  return "missing";
}
```

规则语义：

1. 只要任一变体提供了合法 URL（此时 `url` 已是去参数的规范地址），合并结果为 `accepted`；
2. 否则按固定优先级取第一个实际出现过的状态，保证**与输入顺序无关**（复用第 47 项的约束）；
3. 全部未提供才是 `missing`。

### 3.2 修改：`resolveVideo()` 收集并输出 `urlState`

```diff
   const tags = new Set();
+  const urlStates = new Set();
   let url = "";
@@
     if (variant.url && (!url || variant.url < url)) url = variant.url;
+    if (variant.urlState) urlStates.add(variant.urlState);
@@
     tags: Array.from(tags).sort(compareText).slice(0, limits.maxTags),
     url,
+    urlState: resolveUrlState(url, urlStates),
     titleState: title ? "available" : "missing",
```

`buildCandidateEvidence()`（第 1081 行）无需改动，它现在拿到的是确定值而不是 `undefined`。

### 3.3 未改动的文件

`interest-profile.js`、`candidate-pool.js`、`candidate-features.js`、`stats.js`、
`storage.js`、`content.js`、`manifest.json`、`popup.*` 全部未改。
未新增权限、未接入网络、未触碰任何观看记录。

---

## 4. 为什么修复不会破坏既有功能

1. **只补字段，不改判定**：`urlState` 是描述性字段，不参与 `usableVideoCount`、
   `partitionCoverage`、`titleCoverage`、`contentStatus` 或 `eligibleForExploration` 的任何计算。
   内容的取舍仍完全由 `computeContentFeatures()` 依据 `status` / `title` / `partition` 决定。
2. **不改变去重与冲突语义**：`title` / `partition` / `tags` / `url` 的合并逻辑一行未动，
   `metadata-conflict`、`uid-conflict` 的判定条件未变。
3. **确定性**：新增规则只用固定优先级表与集合，不含时间、随机数或输入顺序依赖，
   与第 47 项“输入顺序变化不改变输出”一致。
4. **不修改入参**：仍在合并阶段新建对象，不写回调用方传入的导入文档（第 45 项要求深度冻结仍可处理）。
5. **跨模块隔离**：全项目只有 `test-candidate-content-import.js` 引用本模块，
   其余 7 个测试文件不依赖它，因此既有 181 项的行为不受影响。
6. **值域不扩大**：新增输出值只可能落在设计文档规定的 5 个枚举内，不会引入新状态。

---

## 5. 测试结果

以下全部为真实执行所得，命令均在 `D:\Bili-Daily` 下运行。

### 5.1 修复后关键项

```
PASS  46. 结果可 JSON 序列化往返
PASS  47. 结果确定：输入顺序变化不改变输出
60/60 通过
```

第 46 项由 **FAIL → PASS**，第 47 项（顺序无关）保持 PASS，说明新增的
`urlState` 合并规则确实是确定性的。

### 5.2 C2-4B 新增 60 项

`60/60 通过`，退出码 `0`。

### 5.3 原有 181 项回归

| 测试文件 | 通过数 | 退出码 |
|---|---|---|
| `test-candidate-features.js` | 38/38 | 0 |
| `test-candidate-quality.js` | 28/28 | 0 |
| `test-candidate-pool.js` | 33/33 | 0 |
| `test-interest-profile.js` | 24/24 | 0 |
| `test-uid.js` | 21/21 | 0 |
| `test-up-stats.js` | 17/17 | 0 |
| `test-stats.js` | 20/20 | 0 |
| **合计** | **181/181** | 全部 0 |

合计：`60 + 181 = 241/241`。

### 5.4 语法检查

```
node --check candidate-content-import.js
CHECK_EXIT=0
```

### 5.5 禁止修改的文件

| 文件 | 最后修改时间 | 结论 |
|---|---|---|
| `interest-profile.js` | 2026-11-10 23:17 | 本轮未改 |
| `candidate-pool.js` | 2026-11-11 09:42 | 本轮未改 |
| `candidate-features.js` | 2026-11-11 13:55 | 本轮未改 |
| `stats.js` | 2026-11-10 23:14 | 本轮未改 |
| `storage.js` | 2026-11-10 21:51 | 本轮未改 |
| `content.js` | 2026-11-10 21:58 | 本轮未改 |
| `manifest.json` | 2026-11-10 16:58 | 本轮未改 |
| `popup.js` / `popup.html` / `popup.css` | 2026-11-10 21:35 – 21:55 | 本轮未改 |

所有条目时间均早于本轮修改（2026-11-11 15:55:39），未被触碰。

字节级校验：`interest-profile.js`、`candidate-pool.js`、`candidate-features.js`、`stats.js`、
`storage.js`、`content.js`、`manifest.json` 与 `rollback/before-c2-4b-import/` 中的 C2-4B 前快照
逐文件 `diff -q` 结果均为相同。`popup.js` / `popup.html` / `popup.css` 的最后修改时间仍为
2026-11-10，早于本轮，未参与本次修改。

`test-candidate-content-import.js` 亦未修改（最后修改时间仍为 2026-11-11 14:53，即 C2-4B 原始状态）。

---

## 6. 回滚方法

快照目录：`rollback/before-c2-4b-test46-fix/`

| 文件 | 大小 | 说明 |
|---|---|---|
| `candidate-content-import.js` | 63580 字节 | 修复前原样副本 |
| `test-candidate-content-import.js` | 41487 字节 | 本次未修改，一并留档 |
| `README.md` | — | 快照说明与恢复命令 |

恢复（PowerShell，在 `D:\Bili-Daily` 下）：

```powershell
Copy-Item rollback\before-c2-4b-test46-fix\candidate-content-import.js . -Force
Copy-Item rollback\before-c2-4b-test46-fix\test-candidate-content-import.js . -Force
```

恢复后 `node test-candidate-content-import.js` 应回到修复前的 `59/60`（第 46 项失败）状态。

---

## 7. 当前结论

- 第 46 项失败的原因已定位并修复，修改范围仅 `candidate-content-import.js` 一个文件。
- 修复后：C2-4B `60/60`、既有回归 `181/181`、合计 `241/241`，`node --check` 退出码 `0`。
- 修复前该断言暴露的是 sidecar 缺 `urlState` 的规范违反，现在该字段按设计文档 2.4 节输出。
- 第 46 项之外未发现新的失败项，允许的 59 项测试语义未变。
- 附注：C2-4B 的验收完成判定属于用户决定，本报告只陈述测试事实，不自行宣布阶段验收。
- 停在本阶段，不进入 C3。
