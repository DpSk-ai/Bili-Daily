# 候选持久化测试启动失败修复记录

- 日期：2026-11-12
- 范围：`test-candidate-store.js` 模块加载顺序
- 修改文件：仅 `test-candidate-store.js`
- 业务逻辑：未修改 `candidate-store.js`
- 既有测试：未修改
- 断言：未删除、未放宽
- 测试执行状态：**Claude Code 未执行**（命令通道被阻断）；下文保留用户提供的原始失败信息与本机验证命令

---

## 1. 原始失败记录（用户提供）

运行 `node test-candidate-store.js` 时，在进入任何测试之前立即抛出：

```text
Error: Bili Daily candidate-content-import.js 需要先加载 candidate-features.js
```

定位：`test-candidate-store.js` 第 15～17 行的 `require` 区块。

原始加载顺序（修复前）：

```js
require(path.join(__dirname, "stats.js"));
require(path.join(__dirname, "candidate-content-import.js"));
require(path.join(__dirname, "candidate-store.js"));
```

---

## 2. 依赖审查

逐个检查源码顶部声明，不按猜测补依赖：

| 模块 | 源码位置 | 实际依赖 |
|---|---|---|
| `candidate-features.js` | 第 10 行注释、第 47～56 行校验 | 只依赖 `stats.js`；要求 `Stats.cleanRecord`、`Stats.mergeByBvid`、`Stats.parseDateKey` |
| `candidate-content-import.js` | 第 9～12 行注释、第 57～72 行校验 | 依赖 `stats.js` 与 `candidate-features.js`；要求 `Features.extractTitleBigrams` |
| `candidate-store.js` | 第 32～37 行 | 依赖 `candidate-content-import.js`；缺失时直接抛错 |

`candidate-content-import.js` 的启动校验：

```js
const Stats = global.BiliDailyStats;
const Features = global.BiliDailyCandidateFeatures;

if (!Stats || typeof Stats.cleanRecord !== "function" || typeof Stats.parseDateKey !== "function") {
  throw new Error("Bili Daily candidate-content-import.js 需要先加载 stats.js");
}
if (!Features || typeof Features.extractTitleBigrams !== "function") {
  throw new Error(
    "Bili Daily candidate-content-import.js 需要先加载 candidate-features.js"
  );
}
```

因此，测试脚本必须先加载 `stats.js`，再加载 `candidate-features.js`，然后才能加载 `candidate-content-import.js` 与 `candidate-store.js`。

---

## 3. 最小修复

`test-candidate-store.js` 顶部只调整 require 顺序，新增一行：

```diff
 require(path.join(__dirname, "stats.js"));
+require(path.join(__dirname, "candidate-features.js"));
 require(path.join(__dirname, "candidate-content-import.js"));
 require(path.join(__dirname, "candidate-store.js"));
```

最终顺序：

```js
require(path.join(__dirname, "stats.js"));
require(path.join(__dirname, "candidate-features.js"));
require(path.join(__dirname, "candidate-content-import.js"));
require(path.join(__dirname, "candidate-store.js"));
```

说明：

- 没有修改 `candidate-store.js` 的任何业务逻辑。
- 没有修改旧的 372 项测试。
- 没有删除或放宽测试 1～28 的断言。
- `test-recommend-service.js` 原本已经按 `stats.js` → `candidate-features.js` → `candidate-content-import.js` 的顺序加载，无需改动。

---

## 4. 修复前快照

目录：`rollback/before-candidate-store-test-fix/`

| 文件 | 说明 |
|---|---|
| `test-candidate-store.js` | 修复前的测试脚本（缺少 `candidate-features.js`） |
| `README.md` | 回滚说明 |

回滚：

```powershell
cd D:\Bili-Daily
Copy-Item rollback\before-candidate-store-test-fix\test-candidate-store.js . -Force
```

---

## 5. 测试执行状态

### 5.1 Claude Code 侧

本轮**没有执行** `node --check test-candidate-store.js` 与 `node test-candidate-store.js`。命令工具持续返回：

```text
qwen/qwen-flash is temporarily unavailable (connection failed), so auto mode cannot determine the safety of Bash right now.
```

因此：

- 不宣称 28/28 通过；
- 不宣称 422/422 通过；
- 后续业务断言是否仍有失败，当前无法判断。

### 5.2 本机 PowerShell 验证命令

```powershell
cd D:\Bili-Daily

node --check test-candidate-store.js
node test-candidate-store.js

# 新增测试
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

目标：

- `test-candidate-store.js`：**28/28 通过**；
- 全部新增与既有测试：**422/422 通过**（既有 372 + 新增 28 + 22）。

### 5.3 如果出现后续失败

依赖加载错误已经消除后，任何新失败都必须根据真实断言输出定位：

- 如果是测试预期与模块真实行为不一致，修测试预期或修对应模块，**不得归因于依赖顺序**；
- 不得删除测试、跳过测试或放宽断言；
- 不得伪造通过结果。

请把 `node test-candidate-store.js` 的完整输出回填，以便继续处理真实的业务断言失败。

---

## 6. 当前状态

- 代码修复：完成（仅一处 require 顺序）。
- 回滚快照：已保存。
- 自动化验证：待本机执行。
- Edge 验收：仍待项目所有者执行。
