# 自动发现三个失败测试套件修复报告

日期：2026-11-12
项目：Bili Daily（个人自用版）
范围：修复 `test-discovered-candidate-store.js`、`test-auto-discovery-integration.js`、`test-auto-discovery-performance.js` 的真实失败

## 0. 执行状态（先读）

本轮在 Claude Code 环境中的 `node --check` / `node test-*.js` **未执行**：

```text
qwen/qwen-flash is temporarily unavailable (connection failed),
so auto mode cannot determine the safety of Bash/WebFetch right now.
```

只有只读文件检查、`node --version`（v24.19.0）和回滚快照复制成功。

因此本报告的结论来源分为三类，必须区分：

| 类型 | 内容 |
|---|---|
| **用户本机实际执行** | 17 个套件中 14 个通过、3 个失败；10 个 JS 文件 `node --check` 通过 |
| **真实失败日志** | `discovery-debug.txt` 记录了 store 启动异常与 integration 套件 17/22 的完整断言输出 |
| **本轮静态推导** | 修复后各测试的预期结果；**不是已通过结果**，必须以本机重跑为准 |

**不得把本报告理解为“495 项已通过”。** 重跑命令见第 6 节。

## 1. 本机真实失败

用户本机结果：

- 17 个测试套件：14 通过，3 失败。
- 10 个 JS 文件语法检查：全部通过。
- 失败套件：
  1. `test-discovered-candidate-store.js`
  2. `test-auto-discovery-integration.js`
  3. `test-auto-discovery-performance.js`

`discovery-debug.txt` 中可确认的内容：

### 1.1 store 套件启动即失败

```text
D:\Bili-Daily\candidate-features.js:55
throw new Error("Bili Daily candidate-features.js 需要先加载 stats.js");
    at D:\Bili-Daily\test-discovered-candidate-store.js:41:1
```

### 1.2 integration 套件 17/22，失败第 14–18 项

```text
FAIL 14. buildView 在观察不足时显示 insufficient 与真实数量
  actual: 'enabled'  expected: 'insufficient'

FAIL 15. buildView 在候选可推荐时显示 has-candidates 并生成页面来源卡片
  actual: 'enabled'  expected: 'has-candidates'

FAIL 16. 关闭开关后已积累候选仍可推荐，但状态明确为关闭
  assert.ok(view.recommendations.some((item) => item.upUid === "3001"))

FAIL 17. 重复打开弹窗不改变存储输入，也不产生额外候选
  0 !== 1

FAIL 18. 恶意额外字段不会出现在服务视图或推荐理由里
  assert.ok(card)
```

### 1.3 performance 套件

用户本机确认失败；但当前只取得 store 与 integration 的独立日志，**没有取得 performance 套件的独立错误文本**。
其 require 列表同样缺少 `stats.js`，而 `candidate-features.js` 在加载时硬性检查
`BiliDailyStats.cleanRecord / mergeByBvid / parseDateKey`，缺失即抛错。
因此按实际依赖链做最小修复，不把“未取得日志”写成“已定位完整堆栈”。

## 2. 根因与修复

### 2.1 依赖顺序（store / performance）

实际依赖链：

```text
stats.js
  ← candidate-features.js（加载时检查 Stats.cleanRecord / mergeByBvid / parseDateKey）
  ← discovered-candidate-store.js（调用 Features.extractTitleBigrams）
```

`storage.js` 只提供 `BiliDailyStorage`，不能替代 `stats.js`。

修复：

- `test-discovered-candidate-store.js`：

  ```js
  require(storage.js);
  require(stats.js);              // 新增
  require(candidate-features.js);
  require(discovered-candidate-store.js);
  ```

- `test-auto-discovery-performance.js`：

  ```js
  require(stats.js);              // 新增
  require(candidate-features.js);
  require(discovered-candidate-store.js);
  require(candidate-discovery.js);
  ```

只改测试加载顺序，未修改业务模块来掩盖初始化错误。

### 2.2 服务层把观察数组误判为非对象（integration 14–18）

`recommend-service.js` 原代码：

```js
const discoveredStore =
  isPlainObject(source.discoveredStore) &&
  isPlainObject(source.discoveredStore.observations)   // 数组永远不满足
    ? source.discoveredStore
    : DiscoveredStore.emptyStore();
```

`discoveredStore.observations` 是数组，`isPlainObject([])` 为 `false`，
所以服务层**永远使用空存储**构建 discovery 证据：

- `summary.total = 0` → 状态只能是 `enabled`，不能是 `insufficient` / `has-candidates`；
- 推荐层收不到 3001 → test 16 / 17 / 18 失败；
- test 12 / 13 恰好只检查空存储或关闭状态，所以此前通过。

修复：

```js
const discoveredStore =
  isPlainObject(source.discoveredStore) &&
  Array.isArray(source.discoveredStore.observations)
    ? source.discoveredStore
    : DiscoveredStore.emptyStore();
```

这是服务层对真实数据契约的错误判断，不是测试断言问题。
修复未改变候选准入规则、身份冲突规则、观看记录结构或手动导入结构。

## 3. 修改文件

| 文件 | 修改 |
|---|---|
| `test-discovered-candidate-store.js` | 在 `storage.js` 后补 `stats.js` require |
| `test-auto-discovery-performance.js` | 在 `candidate-features.js` 前补 `stats.js` require |
| `recommend-service.js` | `isPlainObject(observations)` → `Array.isArray(observations)` |
| `test-auto-discovery-integration.js` | **未修改**（保留原断言） |

回滚快照：`rollback/before-auto-discovery-test-fixes/`，含 README 与上述文件修改前副本。

## 4. 修复后的静态核对

已逐项核对，不修改断言：

- `page-observed` 来源：store 适配层固定 `provenance: "page-observed"`；排序层 `collectDiscoveredDrafts` 保留该来源。
- 准入：`eligibleForExploration` 由视频数、标题覆盖、分区覆盖/降级、身份冲突共同决定；服务层修复后能收到非空 `summary`。
- 数据结构：服务层向排序层传 `{sidecar, assessment}`，测试使用同一结构。
- 同 UID 去重：排序层以手动导入 UID 集合排除自动发现同 UID（test 5 / 21 已通过）。
- 已观看 UP：适配层从自动发现候选中排除；排序层跨通道去重保证 main 优先（test 4 / 22 已通过）。
- 低置信度：page-observed 统一 `approximate: true`、`confidence: "low"`（test 2 / 8 已通过）。
- 推荐理由：`page-observed` 理由由真实观察视频数生成，不包含官方认证表述（test 3 / 11 已通过）。

## 5. 预期修复结果（未执行，需本机确认）

| 套件 | 声明测试数 | 修复前 | 修复后预期 |
|---|---:|---|---|
| `test-discovered-candidate-store.js` | 26 | 启动失败，0 项执行 | 26/26 |
| `test-auto-discovery-integration.js` | 22 | 17/22 | 22/22 |
| `test-auto-discovery-performance.js` | 3 | 启动失败 | 3/3 |
| `test-candidate-discovery.js` | 22 | 用户本机通过 | 22/22 |
| 新增合计 | 73 | — | 73/73（预期） |
| 既有 13 套件 | 422 | 用户本机通过 | 422/422（预期） |
| 总计 | 495 | — | 495/495（预期，未验证） |

**以上“修复后预期”不是通过数。** 任何 495/495 结论都必须以本机输出为准。

## 6. 本机复核命令

在 `D:\Bili-Daily` 下：

```powershell
node --check recommend-service.js
node --check test-discovered-candidate-store.js
node --check test-auto-discovery-performance.js

node test-discovered-candidate-store.js
node test-auto-discovery-integration.js
node test-auto-discovery-performance.js
node test-candidate-discovery.js
```

新增 4 个套件应输出各自的 `N/N 通过` 且退出码为 0。

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

请把每个 `EXIT=` 与 `N/M 通过` 回填到本报告，不要只保留“预期”。

## 7. 约束核对

- 未修改 `biliDailyRecords` 结构与写入逻辑。
- 未修改候选准入、身份冲突、在线核验规则。
- 未新增浏览器权限、host_permissions、后台脚本或网络请求。
- 未删除、跳过或放宽任何测试断言。
- 未修改已通过套件的业务逻辑。
- 未伪造测试结果；未执行项均标记“未执行”。

## 8. 对 Edge popup 的影响

本次只修改服务层一个数组判断和两个测试文件的 require 顺序。
popup 仍通过 `DiscoveredStore.readStore()` 读取存储并把 `discoveredResult.store`
传给 `RecommendService.buildView()`；修复后该存储第一次能真正进入 discovery 证据构建。
弹窗结构、按钮、存储键与权限均未变化。

## 9. 回滚

```powershell
Copy-Item -Force rollback\before-auto-discovery-test-fixes\recommend-service.js recommend-service.js
Copy-Item -Force rollback\before-auto-discovery-test-fixes\test-discovered-candidate-store.js test-discovered-candidate-store.js
Copy-Item -Force rollback\before-auto-discovery-test-fixes\test-auto-discovery-performance.js test-auto-discovery-performance.js
Copy-Item -Force rollback\before-auto-discovery-test-fixes\test-auto-discovery-integration.js test-auto-discovery-integration.js
```

`test-auto-discovery-integration.js` 当前未修改，快照中的副本仅为对照。

## 10. 下一步

1. 在本机执行第 6 节命令并回填真实 `N/M` 与退出码。
2. 若仍有失败，提供该套件的完整错误输出；不要先改断言。
3. 495/495 确认后，再按《自动发现新 UP 主开发报告》第 13 节做 Edge 真实页面验收。
