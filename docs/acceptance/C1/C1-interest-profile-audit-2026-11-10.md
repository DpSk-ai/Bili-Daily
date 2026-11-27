# Bili Daily 阶段 C1 兴趣画像逻辑验收报告

- **项目**：Bili Daily（本地 B 站观看记录扩展）
- **阶段**：C1 —— 本地用户兴趣画像引擎（仅计算逻辑，不含候选 UP 主发现 / 推荐 UI）
- **审核日期**：2026-11-10
- **报告文件**：`C1-interest-profile-audit-2026-11-10.md`
- **结论摘要**：未发现需要修改代码的安全缺陷；本次审核未修改任何项目文件；未进入 C2。

> **验证声明**
>
> - 24 项 C1 测试、58 项既有测试和 JavaScript 语法检查已由项目所有者执行并确认通过。
> - 本会话的自动模式安全分类服务不可用，`node` 执行在本会话被拦截，因此本报告中的模拟数据结果是**按当前代码逐行推导的期望值**，不是本会话的运行输出。
> - 模拟数据只验证函数逻辑，**不代表真实浏览器 `chrome.storage.local` 数据已验证**。
> - 本报告未伪造任何测试或运行结果。

---

## 0. 审核结论

- C1 的 `interest-profile.js` 是纯函数、只读计算，没有网络、Cookie、浏览器配置或存储写入行为，可以用于真实数据的**只读画像计算**。
- 逻辑层面已覆盖：输入兼容、输出结构、7/30 天窗口、本地时区、30 秒阈值、同 BV 不同分 P、UID/旧昵称聚合、未知分区与覆盖率、数据不足降级、非重叠趋势窗口。
- 真实 `chrome.storage.local` 数据、扩展页面加载方式、真实时区/DST 仍需要按第 6 节在浏览器中复核。
- 本次审核未修改代码，未新增权限，未修改 popup，未进入 C2。

---

## 1. 本次审核涉及的文件

| 文件 | 状态 | 说明 |
|---|---|---|
| `interest-profile.js` | C1 新增 | 592 行，纯函数画像引擎 |
| `test-interest-profile.js` | C1 新增 | 24 项测试 |
| `stats.js` | C1 最小修改 | 仅提取 `aggregateUps` 并新增 3 个导出 |
| `rollback/before-interest-profile/stats.js` | 新增快照 | 与改动前文件逐行一致（已 diff 验证） |
| `rollback/before-interest-profile/README.md` | 新增 | 回滚说明 |

未修改：`storage.js`、`content.js`、`popup.js`、`popup.html`、`popup.css`、`manifest.json`、原有三个测试文件。

`stats.js` 的相对改动：

- 新增 `aggregateUps(videos)`：把原 `summarizeUps` 内部的 UP 主身份聚合逻辑原样提取为可复用函数。
- `summarizeUps` 改为调用 `aggregateUps`，输出字段与口径不变。
- 新增导出 `cleanRecord`、`mergeByBvid`、`aggregateUps`。

---

## 2. `buildInterestProfile` 的输入、输出与调用方式

### 2.1 函数签名

```js
BiliDailyInterestProfile.buildInterestProfile(records, options)
```

### 2.2 输入

`records` 支持两种形态：

1. 根结构：

```js
{
  version: 1,
  days: {
    "YYYY-MM-DD": {
      "BVxxxx": {
        bvid, page, title, upName, upUid, partition,
        videoDuration, watchMs, watchMsByHour,
        startedAt, lastWatchedAt, updatedAt
      }
    }
  }
}
```

2. 直接传入日期映射：`{ "YYYY-MM-DD": { BV号: 记录 } }`

> 注意：不要把 `readRootSafe()` 的返回值 `{ ok, root, error }` 整体传入；应传入其中的 `root`。

`options`：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `now` | `Date \| number` | 当前时间 | 计算“今天”的基准，测试可注入 |
| `endDate` | `"YYYY-MM-DD"` | `now` 的本地日期 | 优先于 `now` |
| `windows` | `number[]` | `[7, 30]` | 1..366 的整数，去重升序 |
| `includeComparisons` | `boolean` | `true` | 是否计算互不重叠的趋势对比 |

### 2.3 输出（核心结构）

```js
{
  asOfDate, generatedAt, timezoneOffsetMinutes, inputKind,
  status, reasons,
  windows: {
    "7d": {
      startDate, endDate, dateKeys, dayCount,
      status, reasons, hasData,
      activeDays, recordedDays, invalidRecords, invalidDays,
      videoCount, watchedVideoCount, effectiveVideoCount, belowThresholdVideoCount,
      totalWatchMs, effectiveWatchMs,
      partitions: [
        { name, identified, watchMs, effectiveWatchMs,
          videoCount, effectiveVideoCount, share }
      ],
      favoritePartition, favoriteIdentifiedPartition,
      partitionCoverage: {
        totalWatchMs, identifiedWatchMs, unknownWatchMs,
        identifiedVideoCount, unknownVideoCount, videoCount,
        ratio, videoRatio
      },
      ups: [
        { upName, upUid, watchMs, effectiveWatchMs,
          videoCount, effectiveVideoCount }
      ],
      topUp, unknownUps, uidUpCount, nameOnlyUpCount
    },
    "30d": { /* 同结构 */ }
  },
  windowOrder,
  comparisons: {
    "7d": {
      windowDays, recent, previous, partitions,
      reliable, status, reasons, note
    },
    "30d": { /* 同结构 */ }
  },
  comparisonOrder,
  thresholds, note
}
```

### 2.4 调用方注意

- **正确调用**：`buildInterestProfile(root, { windows: [7, 30] })`。
- **错误输入不会崩溃**：`null`、`{}`、空 `days`、数组、字符串等都会返回 `status: "empty"` 的结构。
- **`endDate` 非法时会静默回退到今天**。这是为了容错，但真实验收时建议显式使用默认值或确认日期。
- **依赖加载顺序**：必须先加载 `stats.js`，否则模块在加载时抛出明确错误。浏览器中把 `interest-profile.js` 放在 `stats.js` 之后；Node 测试中先 `require("stats.js")`。
- **旧版 `stats.js` 兼容性**：如果 `stats.js` 是不含 `aggregateUps` 的旧快照，`interest-profile.js` 会在调用时因 `Stats.aggregateUps is not a function` 失败。回滚时必须同时删除 `interest-profile.js`（回滚 README 已注明）。

---

## 3. 关键统计规则核对

### 3.1 7 天 / 30 天窗口边界与本地时区

- 窗口含首尾：最近 7 天 = 今天往前 6 天到今天；最近 30 天 = 今天往前 29 天到今天。
- 日期全部通过 `stats.js` 的 `localDateKey` / `parseDateKey` / `shiftLocalDate` 计算，使用本地日历，不使用 UTC。
- 跨月、跨年由 `Date` 的本地日历运算处理；测试已覆盖 10 月/11 月与 2026/2027 年边界。
- 7 天窗口是 30 天窗口的后 7 天，二者**嵌套**，代码在 `profile.note` 和 `comparisons.note` 中明确提示不能直接当作两个独立周期计算增长率。
- **局限**：今天算入窗口，最后一天是尚未结束的“部分日”，7 天窗口不是完整的 7×24 小时。

### 3.2 30 秒有效观看阈值

- 复用 `Stats.EFFECTIVE_WATCH_MS = 30000`。
- `effectiveVideoCount` / `effectiveWatchMs` 只统计窗口内合并后 `watchMs >= 30000` 的视频。
- `totalWatchMs`、分区占比仍包含未达阈值的真实观看时长，不会把短视频时长从总时长中删掉。
- 同一 BV 跨天观看会先合并再判断阈值：20 秒 + 25 秒 = 45 秒，窗口内计为 1 个有效视频。这是**窗口级阈值**语义，已在文件头注释中写明；如果业务要求“按天分别判断阈值”，需要另行确认，当前 C1 没有这样做。

### 3.3 同一 BV 不同分 P

- 先按天调用 `Stats.mergeByBvid`，与 `summarizeDay` 的口径一致；再在窗口内对同一 BV 跨天合并。
- `page` 不参与身份判断，所以同一天的分 P 记录、跨天的同一 BV 都只计为一个视频，时长累加。
- 不会重复计数：每天的记录是互不重叠的时间片，跨天合并只是把同一视频的多天时长相加。
- **局限**：如果历史数据中同一 BV 在不同天记录了不同分区/UP，合并时按观看时长较多的那天优先，缺失时回退；这是异常数据下的近似归因，正常 B 站数据不会出现。

### 3.4 UP 主 UID 与旧昵称聚合

- 直接复用 `stats.js` 的 `aggregateUps`（由原 `summarizeUps` 内部逻辑原样提取）。
- 有 `upUid`：按 UID 聚合，同一 UID 的多个昵称合并；展示窗口内观看时长最多的昵称。
- 无 `upUid`：按昵称兼容聚合，不会凭昵称并入任何已知 UID 分组。
- 不同 UID 的同名 UP 主保持分开。
- 既无 UID 也无昵称：进入 `unknownUps`，不参与排名，不虚构 UP 主。
- 跨天合并时，某天缺失 UID、另一天有 UID，会补全 UID；如果同一天/跨天出现两个不同有效 UID，保留先出现的值（不静默覆盖存储，但画像读取层没有额外冲突警告）。

### 3.5 缺失分区、未知桶与覆盖率

- 分区只使用记录中真实存在的 `partition` 字段；代码没有根据标题、UP 主或其他字段推断分区。
- 缺失、空白或字面名为“未知”的分区统一归入保留桶 `「未知」`。
- `「未知」` 会出现在 `partitions` 数组中，参与占比，**不会被悄悄排除**。
- `partitionCoverage.ratio` = 有分区视频的观看时长 / 全部实际观看时长；未知时长越大，覆盖率越低。
- `videoRatio` = 有分区视频数 / 有实际观看时长的视频数，供交叉参考。
- `favoritePartition` 可能是 `「未知」`；下游如果只想要真实分区，应使用 `favoriteIdentifiedPartition`，并检查 `identified` 标志。
- 覆盖率的视频计数只统计 `watchMs > 0` 的视频；`window.videoCount` 会包含 0 时长的异常记录，两者口径不同。

### 3.6 兴趣变化（非嵌套窗口）

- `comparisons` 不使用“7 天 vs 30 天”直接相减。
- 对每个窗口 N，使用：
  - 最近窗口：今天往前 N-1 天到今天；
  - 前一个窗口：最近窗口开始日的前一天往前 N-1 天。
- 两个窗口等长、互不重叠。
- `reliable = false` 时给出具体原因：任一侧无数据、有效天数不足 2 天、观看时长不足 10 分钟、分区覆盖率低于 50%。
- 30 天对比需要最近 60 天的数据；真实用户通常不足，会得到 `reliable: false`，这是预期的保守行为，不是 bug。

---

## 4. 复用与浏览器 / Node 兼容性

### 4.1 复用了哪些 `stats.js` 公共函数

| 复用项 | 用途 |
|---|---|
| `Stats.EFFECTIVE_WATCH_MS` | 30 秒阈值 |
| `Stats.localDateKey` / `parseDateKey` / `shiftLocalDate` | 本地日期与窗口边界 |
| `Stats.cleanRecord` | 清洗单条记录（新导出） |
| `Stats.mergeByBvid` | 同 BV 合并（新导出） |
| `Stats.aggregateUps` | UP 身份聚合（新提取并导出） |

没有重复实现 UP 身份规则、日期规则或 30 秒阈值。分区聚合是 C1 的新统计口径（包含未知桶与覆盖率），因此没有直接复用 `summarizeDay` 的“只返回最喜欢分区”结果。

### 4.2 浏览器扩展环境

- `interest-profile.js` 不调用 `chrome.*`、DOM、`fetch`、`XMLHttpRequest`、Cookie、文件系统或 Node API。
- 使用 `globalThis` 挂载 `BiliDailyInterestProfile`，与 `stats.js`、`storage.js` 的写法一致。
- 兼容 Manifest V3 默认 CSP：没有 `eval`、`new Function`、远程脚本。
- 当前 `manifest.json` 和 `popup.html` **没有引用** `interest-profile.js`，所以扩展现有功能不受影响；C2 接入时需要显式加载，且必须放在 `stats.js` 之后。
- 没有增加任何浏览器权限。

### 4.3 Node.js 测试环境

- 模块本身没有 `require` / `module.exports` / `process`，测试文件通过 `require` 加载。
- 测试先加载 `stats.js`，再加载 `interest-profile.js`，顺序正确。
- 使用 `globalThis`，在 Node 24 和 Edge Chromium 中都可用。

### 4.4 兼容性风险

- 加载顺序错误会立即抛错（明确提示依赖 `stats.js`）。
- 旧版 `stats.js` 缺少 `aggregateUps` 时，错误信息是普通的 `TypeError`，不是定制提示；回滚时需同时删除 `interest-profile.js`。
- 如果未来把画像脚本放进 content script，必须确认 `stats.js` 先加载；当前没有这样做。

---

## 5. 模拟数据演示（模拟数据，不是真实存储）

> **重要声明**
>
> - 全部为手工构造的模拟数据，不读取 `chrome.storage.local`，不代表任何真实用户数据。
> - 本会话的 Node 执行被环境拦截，下面的数值是按当前代码逐行推导的**期望结果**，不是本会话的运行输出。
> - 第 5.3 节给出了可复现的 PowerShell 命令；请以实际输出为准。

### 5.1 模拟数据

基准日：`2026-11-10`（本地时间），窗口 `[7, 30]`。

| 日期 | BV | 分P | UP 主 | UID | 分区 | 观看 |
|---|---|---|---|---|---|---|
| 2026-10-12 | BV9 | 1 | UP丁 | 3003 | 音乐 | 20 分钟 |
| 2026-10-20 | BV10 | 1 | UP丙 | 2002 | 游戏 | 20 分钟 |
| 2026-10-25 | BV11 | 1 | UP甲 | 1001 | 科技 | 10 分钟 |
| 2026-10-28 | BV6 | 1 | UP丙 | 2002 | 游戏 | 10 分钟 |
| 2026-10-29 | BV7 | 1 | UP丙 | 2002 | 游戏 | 10 分钟 |
| 2026-10-31 | BV8 | 1 | UP甲 | 1001 | 科技 | 6 分钟 |
| 2026-11-04 | BV1 | 1 | UP甲 | 1001 | 科技 | 10 分钟 |
| 2026-11-05 | BV2 | 1 | UP甲 | 1001 | 科技 | 10 分钟 |
| 2026-11-06 | BV3 | 1 | UP丙 | 2002 | 游戏 | 15 分钟 |
| 2026-11-07 | BV4 | 1 | UP乙 | 无 | （空） | 5 分钟 |
| 2026-11-08 | BV1 | 2 | UP甲 | 1001 | 科技 | 2 分钟 |
| 2026-11-09 | BV5 | 1 | UP乙 | 无 | 音乐 | 8 分钟 |

这份数据特意包含：同日/跨天同一 BV、不同分 P、缺失 UID、缺失分区、多个分区、跨月边界。

### 5.2 期望结果（代码审查推导，未运行）

| 指标 | 最近 7 天 | 最近 30 天 |
|---|---|---|
| 窗口 | 2026-11-04 ~ 2026-11-10 | 2026-10-12 ~ 2026-11-10 |
| `status` | `ok` | `ok` |
| 有观看天数 | 6 | 12 |
| 总实际观看 | 50 分钟 | 126 分钟 |
| 有效视频数 | 5 | 11 |
| 分区覆盖率 | 90.0% | 96.0% |
| 最常观看分区 | 科技，22 分钟，44.0% | 游戏，55 分钟，43.7% |
| 最常观看 UP 主 | UP甲 / 1001，22 分钟，2 个视频 | UP丙 / 2002，55 分钟，4 个视频 |

**7 天分区：**

| 分区 | 已识别 | 时长 | 占比 |
|---|---|---|---|
| 科技 | 是 | 22 分钟 | 44.0% |
| 游戏 | 是 | 15 分钟 | 30.0% |
| 音乐 | 是 | 8 分钟 | 16.0% |
| 未知 | 否 | 5 分钟 | 10.0% |

**7 天 UP 主：**

| UP 主 | UID | 时长 | 视频数 |
|---|---|---|---|
| UP甲 | 1001 | 22 分钟 | 2 |
| UP丙 | 2002 | 15 分钟 | 1 |
| UP乙 | 无 | 13 分钟 | 2 |

**30 天分区：**

| 分区 | 已识别 | 时长 | 占比 |
|---|---|---|---|
| 游戏 | 是 | 55 分钟 | 43.7% |
| 科技 | 是 | 38 分钟 | 30.2% |
| 音乐 | 是 | 28 分钟 | 22.2% |
| 未知 | 否 | 5 分钟 | 4.0% |

**30 天 UP 主：**

| UP 主 | UID | 时长 | 视频数 |
|---|---|---|---|
| UP丙 | 2002 | 55 分钟 | 4 |
| UP甲 | 1001 | 38 分钟 | 4 |
| UP丁 | 3003 | 20 分钟 | 1 |
| UP乙 | 无 | 13 分钟 | 2 |

**趋势对比：**

- 7 天：最近 `2026-11-04~11-10` vs 前 `2026-10-28~11-03`，两侧均满足数据量/覆盖率要求，`reliable: true`。
- 30 天：最近 `2026-10-12~11-10` vs 前 `2026-09-12~10-11`，前一窗口无数据，`reliable: false`，原因为“前一个窗口没有观看数据”等。

### 5.3 可复现的 PowerShell 命令（模拟数据）

在 PowerShell 中执行；脚本写到系统临时目录，不修改项目。

```powershell
chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$demoPath = Join-Path $env:TEMP "bili-daily-c1-demo.js"

@'
"use strict";
const path = require("node:path");
const ROOT = "D:\\Bili-Daily";
require(path.join(ROOT, "stats.js"));
require(path.join(ROOT, "interest-profile.js"));

const IP = globalThis.BiliDailyInterestProfile;
const MIN = 60 * 1000;

function rec(bvid, page, upName, upUid, partition, minutes, date) {
  return {
    bvid,
    page,
    title: "模拟视频 " + bvid,
    upName,
    upUid,
    partition,
    videoDuration: 600,
    watchMs: minutes * MIN,
    watchMsByHour: {},
    startedAt: date + "T20:00:00.000+08:00",
    lastWatchedAt: date + "T20:30:00.000+08:00",
    updatedAt: date + "T20:30:00.000+08:00"
  };
}

const days = {
  "2026-10-12": { BV9: rec("BV9", 1, "UP丁", "3003", "音乐", 20, "2026-10-12") },
  "2026-10-20": { BV10: rec("BV10", 1, "UP丙", "2002", "游戏", 20, "2026-10-20") },
  "2026-10-25": { BV11: rec("BV11", 1, "UP甲", "1001", "科技", 10, "2026-10-25") },
  "2026-10-28": { BV6: rec("BV6", 1, "UP丙", "2002", "游戏", 10, "2026-10-28") },
  "2026-10-29": { BV7: rec("BV7", 1, "UP丙", "2002", "游戏", 10, "2026-10-29") },
  "2026-10-31": { BV8: rec("BV8", 1, "UP甲", "1001", "科技", 6, "2026-10-31") },
  "2026-11-04": { BV1: rec("BV1", 1, "UP甲", "1001", "科技", 10, "2026-11-04") },
  "2026-11-05": { BV2: rec("BV2", 1, "UP甲", "1001", "科技", 10, "2026-11-05") },
  "2026-11-06": { BV3: rec("BV3", 1, "UP丙", "2002", "游戏", 15, "2026-11-06") },
  "2026-11-07": { BV4: rec("BV4", 1, "UP乙", null, "", 5, "2026-11-07") },
  "2026-11-08": { BV1: rec("BV1", 2, "UP甲", "1001", "科技", 2, "2026-11-08") },
  "2026-11-09": { BV5: rec("BV5", 1, "UP乙", null, "音乐", 8, "2026-11-09") }
};

const profile = IP.buildInterestProfile(
  { version: 1, days },
  { now: new Date(2026, 10, 10, 12, 0, 0), windows: [7, 30] }
);

const min = (ms) => Math.round((ms / MIN) * 10) / 10;
const pct = (share) => Math.round(share * 1000) / 10;

function summary(w) {
  return {
    startDate: w.startDate,
    endDate: w.endDate,
    status: w.status,
    activeDays: w.activeDays,
    totalMinutes: min(w.totalWatchMs),
    effectiveVideoCount: w.effectiveVideoCount,
    partitionCoveragePercent: pct(w.partitionCoverage.ratio),
    favoritePartition: w.favoritePartition && {
      name: w.favoritePartition.name,
      identified: w.favoritePartition.identified,
      minutes: min(w.favoritePartition.watchMs),
      sharePercent: pct(w.favoritePartition.share)
    },
    topUp: w.topUp && {
      name: w.topUp.upName,
      uid: w.topUp.upUid,
      minutes: min(w.topUp.watchMs),
      videos: w.topUp.videoCount
    },
    partitions: w.partitions.map((p) => ({
      name: p.name,
      identified: p.identified,
      minutes: min(p.watchMs),
      sharePercent: pct(p.share)
    })),
    ups: w.ups.map((u) => ({
      name: u.upName,
      uid: u.upUid,
      minutes: min(u.watchMs),
      videos: u.videoCount
    }))
  };
}

console.log(JSON.stringify({
  mock: true,
  note: "全部为手工模拟数据，不读取 chrome.storage.local。",
  asOfDate: profile.asOfDate,
  status: profile.status,
  windows: {
    "7d": summary(profile.windows["7d"]),
    "30d": summary(profile.windows["30d"])
  },
  comparisons: {
    "7d": {
      reliable: profile.comparisons["7d"].reliable,
      status: profile.comparisons["7d"].status,
      previousStart: profile.comparisons["7d"].previous.startDate,
      previousEnd: profile.comparisons["7d"].previous.endDate,
      reasons: profile.comparisons["7d"].reasons
    },
    "30d": {
      reliable: profile.comparisons["30d"].reliable,
      status: profile.comparisons["30d"].status,
      reasons: profile.comparisons["30d"].reasons
    }
  }
}, null, 2));
'@ | Set-Content -LiteralPath $demoPath -Encoding UTF8

node $demoPath
Remove-Item -LiteralPath $demoPath
```

---

## 6. 真实数据的只读验收方法

### 6.1 执行上下文（重要）

必须在**扩展自己的 popup 页面上下文**执行，不能在 Bilibili 视频页面的主世界控制台执行。

- 方式 A：点击扩展图标打开 popup，在弹窗内右键 → “检查”。DevTools 的 Console 上下文应显示为 `popup.html`。
- 方式 B（推荐，避免 popup 因失焦关闭）：打开 `edge://extensions` → 开启开发人员模式 → 复制 Bili Daily 的扩展 ID → 新标签页打开 `chrome-extension://<扩展ID>/popup.html` → 在该页 DevTools 的 Console 执行。上下文是扩展页面，不是 `www.bilibili.com`。

`popup.html` 已加载 `storage.js` 和 `stats.js`，所以 `BiliDailyStorage`、`BiliDailyStats` 可用；`interest-profile.js` 未加载，下面用动态 `import()` 加载。

### 6.2 只读验收代码

```js
(async () => {
  // 只读：下面只调用 chrome.storage.local.get，不调用 set
  if (!globalThis.BiliDailyInterestProfile) {
    await import(chrome.runtime.getURL("interest-profile.js"));
  }

  const { ok, root, error } = await BiliDailyStorage.readRootSafe();
  if (!ok) {
    console.error("读取本地数据失败：", error);
    return;
  }

  const profile = BiliDailyInterestProfile.buildInterestProfile(root, {
    windows: [7, 30]
  });

  const min = (ms) => Math.round(ms / 6000) / 10;
  const pct = (v) => Math.round(v * 1000) / 10;

  const brief = (w) => ({
    开始: w.startDate,
    结束: w.endDate,
    状态: w.status,
    有观看天数: w.activeDays,
    实际观看分钟: min(w.totalWatchMs),
    有效视频数: w.effectiveVideoCount,
    分区覆盖率: pct(w.partitionCoverage.ratio) + "%",
    最常分区: w.favoritePartition ? w.favoritePartition.name : null,
    最常UP: w.topUp
      ? `${w.topUp.upName || "(无昵称)"}${w.topUp.upUid ? " / " + w.topUp.upUid : ""}`
      : null
  });

  console.table([
    Object.assign({ 窗口: "最近7天" }, brief(profile.windows["7d"])),
    Object.assign({ 窗口: "最近30天" }, brief(profile.windows["30d"]))
  ]);

  console.table(
    profile.windows["7d"].partitions.map((p) => ({
      分区: p.name,
      已识别: p.identified,
      分钟: min(p.watchMs),
      占比: pct(p.share) + "%"
    }))
  );

  console.table(
    profile.windows["7d"].ups.slice(0, 10).map((u) => ({
      UP主: u.upName || "(无昵称)",
      UID: u.upUid || "(无)",
      分钟: min(u.watchMs),
      有效视频: u.effectiveVideoCount
    }))
  );

  console.log("7天趋势可靠：", profile.comparisons["7d"].reliable, profile.comparisons["7d"].reasons);
  console.log("30天趋势可靠：", profile.comparisons["30d"].reliable, profile.comparisons["30d"].reasons);

  return profile;
})();
```

### 6.3 只读性验证

在运行画像代码前后，各执行一次下面的读取比较（仍然只调用 `get`）：

```js
(async () => {
  const before = JSON.stringify(
    (await chrome.storage.local.get("biliDailyRecords")).biliDailyRecords
  );

  // 在这里调用上面的画像代码

  const after = JSON.stringify(
    (await chrome.storage.local.get("biliDailyRecords")).biliDailyRecords
  );
  console.log("存储未变化：", before === after);
})();
```

### 6.4 验收时重点核对

1. `asOfDate` 是否等于今天的本地日期。
2. 7 天 `startDate` 是否为今天往前 6 天；30 天是否为今天往前 29 天。
3. 任选一天，手工把该天记录的 `watchMs` 相加，与窗口 `totalWatchMs` 对比。
4. 检查 `partitions` 中是否存在 `「未知」`；如果存在，`partitionCoverage.ratio` 应小于 100%。
5. 检查 `ups`：同一个 UID 是否只出现一次；无 UID 的老记录是否单独成组；不同 UID 同名是否分开。
6. 检查 `comparisons["7d"].reliable` 与 `reasons`，不要在不满足条件时解读趋势。
7. 检查存储前后 JSON 一致。

### 6.5 如果动态 `import()` 被 CSP 拦截

在同一个 popup 页面控制台，打开项目中的 `interest-profile.js`，全选复制，粘贴到 Console 执行一次（`stats.js` 已加载），再运行 6.2 的代码（可去掉 `import` 分支）。这仍然是只读操作。

另一种备选：在 Console 用 `copy(JSON.stringify(biliDailyRecords))` 导出到剪贴板，写入临时 JSON 文件后用 Node 调用 `buildInterestProfile`。这会把真实数据落到磁盘，验收后请删除临时文件；不是首选。

---

## 7. 验证状态分类

### A. 已由测试验证（依据项目所有者提供的执行结果）

- `test-interest-profile.js`：24/24 通过。
- `test-uid.js`：21/21 通过。
- `test-up-stats.js`：17/17 通过。
- `test-stats.js`：20/20 通过。
- `interest-profile.js`、`stats.js`、`test-interest-profile.js` 语法检查通过。
- 覆盖场景包括：单日、7 天、30 天、跨月、跨年、分区占比、分区缺失、覆盖率、时长累计、30 秒阈值、同 BV 分 P（同日与跨天）、同 UID 异名、异 UID 同名、新旧记录混合、空数据、异常字段、不可变、数据不足降级、非重叠趋势窗口、参数校验。

> 本会话未能亲自重新执行 Node；以上采用项目所有者确认的结果，未伪造。

### B. 已由代码审查确认

- 输入/输出结构、默认参数和错误降级路径。
- 7/30 天窗口边界、本地时区日期运算、跨月/跨年。
- 30 秒阈值只在有效视频统计中生效，总时长不被裁剪。
- 同 BV 分 P 的单日合并与跨天合并，视频数不重复。
- UID 优先、无 UID 昵称兼容、异 UID 同名分离、缺失身份进入 unknown。
- 缺失分区归入「未知」，覆盖率分母包含未知时长；没有分区推断。
- `stats.js` 公共函数的复用方式；没有重复实现 UP/日期/阈值规则。
- 纯函数无副作用：不修改输入、不写 `chrome.storage`、不联网、不读 Cookie/配置文件。
- 未修改 `popup.*`、`content.js`、`storage.js`、`manifest.json`，未新增权限。

### C. 仍待真实浏览器 / 真实数据验证

- popup 页面中动态 `import()` 是否能被 MV3 CSP 正常放行。
- 真实 `chrome.storage.local` 中 `biliDailyRecords` 的实际数据形状、日期覆盖和分区字段完整度。
- 真实用户时区、夏令时或跨时区使用时的窗口归属。
- 真实历史数据规模下的内存与耗时。
- C2 正式把 `interest-profile.js` 接入 popup 时的脚本加载顺序与扩展重新加载。
- 真实数据下的分区覆盖率、未知桶比例是否符合预期。

### D. 本会话未能执行（环境限制）

- 本会话的自动模式安全分类服务不可用，`node`、`Agent`、`Monitor` 均被拦截；只有 `echo`、`pwd`、`diff`、`wc` 等只读命令可用。
- 因此第 5 节的模拟结果是**手工推导**，不是运行输出；第 5.3 节提供了 PowerShell 命令，可在项目所有者环境中得到真实输出。
- 本报告没有宣称模拟数据验证了真实 `chrome.storage.local`。

---

## 8. 已知问题与局限

1. **今天计入窗口**：最后一天是部分日，7 天窗口不是完整 7×24 小时。
2. **跨天同 BV 合并**：有效阈值按窗口累计判断；分区/UP 冲突时按观看时长较多的那天归因。正常数据不会出现分区变化，异常数据下属于近似处理。
3. **`videoCount` 与覆盖率视频数口径不同**：`videoCount` 包含 0 时长记录；覆盖率只统计 `watchMs > 0` 的视频。
4. **`favoritePartition` 可能是「未知」**：下游应使用 `favoriteIdentifiedPartition` 或检查 `identified`。
5. **状态阈值是启发式的**：10 分钟、2 天、50% 覆盖率只影响 `status` / `reliable`，不影响数值本身；阈值已写入 `thresholds` 字段，便于调整。
6. **30 天趋势通常不可靠**：需要最近 60 天数据；这是保守设计，不是错误。
7. **时区变化会影响窗口归属**：记录按写入时的本地日期归档；用户跨时区使用时，历史日期键不会重算。
8. **非法 `options.endDate` 静默回退到今天**：便于容错，但验收时应确认日期。
9. **「未知」是保留桶名**：真实分区如果字面叫「未知」，会被当作未识别处理。
10. **无 UID 老记录按昵称聚合**：不同 UP 主同名时会被合并；这是阶段 B 已确认的兼容规则，不是 C1 新增问题。
11. **混合版本风险**：旧版 `stats.js` 没有 `aggregateUps` 时，必须同时删除 `interest-profile.js`；回滚 README 已注明。
12. **测试时区单一**：测试在本机本地时区运行，没有矩阵化验证多个时区/DST；代码路径使用本地日期运算，但真实跨时区仍需浏览器验证。

---

## 9. 是否修复缺陷

**本次未修改代码。** 审核未发现默认 7/30 使用场景下的功能性缺陷，因此没有触发“备份—修复—重跑测试”流程。

两个非阻塞的低风险改进建议（留待 C2 或后续清理，不建议现在改）：

- 自定义 `windows` 时，`profile.note` 仍固定写“7 天 / 30 天”，措辞可以改得更通用；默认用法不受影响。
- 在加载时检查 `Stats.aggregateUps` 等依赖是否存在，把混合版本下的 `TypeError` 变成更明确的错误提示。

---

## 10. 停止

本次只完成 C1 逻辑审核与真实数据验收方法设计，**未进入 C2**，未开发候选 UP 主发现、推荐算法或推荐 UI。等待审核。

---

## 附录 A：测试执行记录

项目所有者确认的执行结果：

```text
test-interest-profile.js   24/24 通过
test-uid.js                21/21 通过
test-up-stats.js           17/17 通过
test-stats.js              20/20 通过
JavaScript 语法检查        通过
```

新增测试覆盖的 18 个指定场景：

1. 单日观看数据
2. 连续 7 天数据
3. 连续 30 天数据
4. 跨月日期
5. 跨年日期
6. 不同分区占比
7. 分区缺失
8. 分区覆盖率
9. 观看时长累计
10. 30 秒有效观看阈值
11. 同一 BV 号不同分 P
12. 同 UID 不同昵称
13. 不同 UID 同名
14. 新旧记录混合
15. 空数据
16. 异常字段
17. 原始数据不可变
18. 数据不足的降级处理

额外覆盖：互不重叠的 7 天/30 天趋势窗口、参数校验与窗口配置。

---

## 附录 B：回滚方式

本阶段新增文件：

- `interest-profile.js`
- `test-interest-profile.js`

本阶段修改文件：

- `stats.js`（UP 聚合逻辑提取 + 3 个新导出）

回滚：

1. 把 `rollback/before-interest-profile/stats.js` 复制回 `D:\Bili-Daily\stats.js` 覆盖。
2. 删除 `interest-profile.js` 和 `test-interest-profile.js`。
3. 在 Edge 扩展管理页点击“重新加载”。
4. 运行 `node test-stats.js`、`node test-uid.js`、`node test-up-stats.js`，应恢复 58 项通过。

回滚不会触碰 `chrome.storage.local` 中的 `biliDailyRecords`。
