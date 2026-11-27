"use strict";

/**
 * Bili Daily —— stats.js 独立测试（纯模拟数据，不读写真实用户数据）
 * 运行：node test-stats.js
 */

const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "stats.js"));
const S = globalThis.BiliDailyStats;

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.getOwnPropertyNames(value).forEach((key) => deepFreeze(value[key]));
    Object.freeze(value);
  }
  return value;
}

function rec(partial) {
  return Object.assign(
    {
      bvid: "BV1xx411c7mD",
      page: 1,
      title: "测试视频",
      upName: "测试UP",
      partition: "科技",
      videoDuration: 600,
      watchMs: 0,
      watchMsByHour: {},
      startedAt: "2026-11-09T20:00:00.000+08:00",
      lastWatchedAt: "2026-11-09T20:01:00.000+08:00",
      updatedAt: "2026-11-09T20:01:00.000+08:00"
    },
    partial
  );
}

/* ---------------------------------------------------------------- 日期工具 */

test("localDateKey 使用本地时区（午夜前后不跨日）", () => {
  assert.equal(S.localDateKey(new Date(2026, 0, 1, 0, 30)), "2026-01-01");
  assert.equal(S.localDateKey(new Date(2026, 0, 1, 23, 59)), "2026-01-01");
  assert.equal(S.localDateKey(new Date(2026, 11, 31, 23, 0)), "2026-12-31");
});

test("yesterdayKey 返回本地时区的昨天（跨月 / 跨年）", () => {
  assert.equal(S.yesterdayKey(new Date(2026, 10, 10, 0, 5)), "2026-11-09");
  assert.equal(S.yesterdayKey(new Date(2026, 2, 1, 0, 5)), "2026-02-28");
  assert.equal(S.yesterdayKey(new Date(2026, 0, 1, 12, 0)), "2025-12-31");
  assert.equal(S.yesterdayKey(new Date(2026, 10, 10, 0, 0, 1)), "2026-11-09");
});

test("parseDateKey 拒绝非法日期", () => {
  assert.equal(S.parseDateKey("2026-11-09").day, 9);
  assert.equal(S.parseDateKey("2026-13-01"), null);
  assert.equal(S.parseDateKey("2026-02-30"), null);
  assert.equal(S.parseDateKey("2026-2-1"), null);
  assert.equal(S.parseDateKey(20261109), null);
  assert.equal(S.parseDateKey("2026-11-09T00:00:00Z"), null);
});

test("shiftLocalDate 跨月 / 跨年正确", () => {
  assert.equal(S.shiftLocalDate("2026-03-01", -1), "2026-02-28");
  assert.equal(S.shiftLocalDate("2024-03-01", -1), "2024-02-29");
  assert.equal(S.shiftLocalDate("2026-01-01", -1), "2025-12-31");
  assert.equal(S.shiftLocalDate("2026-12-31", 1), "2027-01-01");
});

/* ---------------------------------------------------------------- 空 / 异常值 */

test("空输入安全返回空结构", () => {
  const cases = [null, undefined, {}, { days: {} }, { days: null }, [], "x", 42];
  for (const input of cases) {
    const result = S.summarizeDay(input, "2026-11-09");
    assert.equal(result.hasData, false);
    assert.equal(result.videoCount, 0);
    assert.equal(result.effectiveVideoCount, 0);
    assert.equal(result.totalWatchMs, 0);
    assert.equal(result.favoritePartition, null);
    assert.equal(result.periodsAvailable, false);
  }
});

test("日期非法时不统计", () => {
  const data = { days: { "2026-11-09": { BV1: rec({ watchMs: 60000 }) } } };
  for (const date of ["2026-11-9", "2026-13-09", "", null, undefined, 20261109]) {
    const result = S.summarizeDay(data, date);
    assert.equal(result.validDate, false);
    assert.equal(result.hasData, false);
    assert.equal(result.totalWatchMs, 0);
  }
});

test("缺失字段 / 异常值不会污染统计", () => {
  const data = {
    days: {
      "2026-11-09": {
        A: rec({ bvid: "BV_A", watchMs: 60000, watchMsByHour: { "20": 60000 }, partition: "科技" }),
        B: { bvid: "BV_B" },
        C: rec({ bvid: "BV_C", watchMs: -5000, watchMsByHour: { "21": -1 } }),
        D: rec({ bvid: "BV_D", watchMs: Number.NaN, watchMsByHour: { "22": Number.POSITIVE_INFINITY } }),
        E: rec({ bvid: "BV_E", watchMs: "99999", watchMsByHour: { "99": 5000, "ab": 5000, "7": 20000 } }),
        F: null,
        G: 123,
        H: rec({ bvid: "", watchMs: 45000, watchMsByHour: { "07": 45000 } })
      }
    }
  };
  const result = S.summarizeDay(data, "2026-11-09");
  assert.equal(result.totalWatchMs, 60000 + 99999 + 45000);
  assert.equal(result.videoCount, 6);
  assert.equal(result.effectiveVideoCount, 3);
  assert.equal(result.invalidRecords, 2);
  assert.equal(result.periods.find((p) => p.key === "morning").watchMs, 65000);
  assert.equal(result.periods.find((p) => p.key === "evening").watchMs, 60000);
  assert.equal(result.periods.find((p) => p.key === "afternoon").watchMs, 0);
});

test("不修改原始记录（深度冻结也不会抛错）", () => {
  const data = deepFreeze({
    version: 1,
    days: {
      "2026-11-09": {
        BV1: rec({ bvid: "BV1", watchMs: 90000, watchMsByHour: { "09": 30000, "20": 60000 } }),
        BV2: rec({ bvid: "BV2", watchMs: 20000, watchMsByHour: { "20": 20000 }, partition: "游戏" })
      }
    }
  });
  const snapshot = JSON.stringify(data);
  const result = S.summarizeDay(data, "2026-11-09");
  assert.equal(JSON.stringify(data), snapshot);
  assert.equal(result.totalWatchMs, 110000);
});

/* ---------------------------------------------------------------- 数量 / 时长 */

test("30 秒阈值：29999ms 不计入，30000ms 计入", () => {
  const data = {
    days: {
      "2026-11-09": {
        BV1: rec({ bvid: "BV1", watchMs: 29999, watchMsByHour: { "20": 29999 } }),
        BV2: rec({ bvid: "BV2", watchMs: 30000, watchMsByHour: { "20": 30000 } })
      }
    }
  };
  const result = S.summarizeDay(data, "2026-11-09");
  assert.equal(result.effectiveVideoCount, 1);
  assert.equal(result.videoCount, 2);
  assert.equal(result.totalWatchMs, 59999);
});

test("同一 BV 的不同分 P 只算一个视频，时长累加", () => {
  const data = {
    days: {
      "2026-11-09": {
        BV1: rec({ bvid: "BV1", page: 1, watchMs: 20000, watchMsByHour: { "20": 20000 } }),
        "BV1#2": rec({ bvid: "BV1", page: 2, watchMs: 25000, watchMsByHour: { "21": 25000 } })
      }
    }
  };
  const result = S.summarizeDay(data, "2026-11-09");
  assert.equal(result.videoCount, 1);
  assert.equal(result.effectiveVideoCount, 1);
  assert.equal(result.totalWatchMs, 45000);
  assert.equal(result.periods.find((p) => p.key === "evening").watchMs, 45000);
});

test("累计时长使用真实观看时长，不用视频总长度", () => {
  const data = {
    days: {
      "2026-11-09": {
        BV1: rec({ bvid: "BV1", videoDuration: 3600, watchMs: 42000, watchMsByHour: { "20": 42000 } })
      }
    }
  };
  const result = S.summarizeDay(data, "2026-11-09");
  assert.equal(result.totalWatchMs, 42000);
});

/* ---------------------------------------------------------------- 跨日期 */

test("跨日期只统计指定日期，不把今天算进昨天", () => {
  const data = {
    days: {
      "2026-11-08": { BV0: rec({ bvid: "BV0", watchMs: 40000, watchMsByHour: { "20": 40000 } }) },
      "2026-11-09": {
        BV1: rec({ bvid: "BV1", watchMs: 60000, watchMsByHour: { "09": 60000 }, partition: "科技" }),
        BV2: rec({ bvid: "BV2", watchMs: 70000, watchMsByHour: { "20": 70000 }, partition: "游戏" })
      },
      "2026-11-10": { BV3: rec({ bvid: "BV3", watchMs: 80000, watchMsByHour: { "10": 80000 } }) }
    }
  };
  const yesterday = S.summarizeDay(data, "2026-11-09");
  assert.equal(yesterday.totalWatchMs, 130000);
  assert.equal(yesterday.effectiveVideoCount, 2);
  assert.equal(yesterday.favoritePartition.name, "游戏");
  assert.equal(S.summarizeDay(data, "2026-11-10").totalWatchMs, 80000);
  assert.equal(S.summarizeDay(data, "2026-11-07").hasData, false);
});

/* ---------------------------------------------------------------- 分区 */

test("最喜欢的分区按观看时长计算", () => {
  const data = {
    days: {
      "2026-11-09": {
        A: rec({ bvid: "A", partition: "科技", watchMs: 120000, watchMsByHour: { "20": 120000 } }),
        B: rec({ bvid: "B", partition: "游戏", watchMs: 60000, watchMsByHour: { "21": 60000 } }),
        C: rec({ bvid: "C", partition: "游戏", watchMs: 30000, watchMsByHour: { "22": 30000 } }),
        D: rec({ bvid: "D", partition: "", watchMs: 50000, watchMsByHour: { "23": 50000 } })
      }
    }
  };
  const result = S.summarizeDay(data, "2026-11-09");
  assert.equal(result.favoritePartition.name, "科技");
  assert.equal(result.favoritePartition.watchMs, 120000);
  assert.ok(Math.abs(result.favoritePartition.share - 120000 / 210000) < 1e-9);
  assert.equal(result.missingPartitionVideos, 1);
  assert.match(result.partitionReason, /缺少分区信息/);
});

test("分区并列时结果稳定", () => {
  const data = {
    days: {
      "2026-11-09": {
        A: rec({ bvid: "A", partition: "游戏", watchMs: 60000, watchMsByHour: { "20": 60000 } }),
        B: rec({ bvid: "B", partition: "科技", watchMs: 60000, watchMsByHour: { "21": 60000 } })
      }
    }
  };
  const first = S.summarizeDay(data, "2026-11-09");
  const second = S.summarizeDay(data, "2026-11-09");
  assert.equal(first.favoritePartition.name, second.favoritePartition.name);
  assert.ok(["科技", "游戏"].includes(first.favoritePartition.name));
});

test("全部分区缺失时明确说明无法统计，不伪造", () => {
  const data = {
    days: {
      "2026-11-09": {
        A: rec({ bvid: "A", partition: "", watchMs: 60000, watchMsByHour: { "20": 60000 } })
      }
    }
  };
  const result = S.summarizeDay(data, "2026-11-09");
  assert.equal(result.favoritePartition, null);
  assert.equal(result.partitionAvailable, false);
  assert.match(result.partitionReason, /缺少分区信息/);
  assert.equal(result.totalWatchMs, 60000);
});

/* ---------------------------------------------------------------- 时段 */

test("四个时段按真实小时桶统计", () => {
  const data = {
    days: {
      "2026-11-09": {
        A: rec({ bvid: "A", watchMs: 45000, watchMsByHour: { "03": 15000, "08": 30000 } }),
        B: rec({ bvid: "B", watchMs: 90000, watchMsByHour: { "13": 45000, "20": 45000 } }),
        C: rec({ bvid: "C", watchMs: 60000, watchMsByHour: { "23": 60000 } })
      }
    }
  };
  const result = S.summarizeDay(data, "2026-11-09");
  assert.equal(result.periodsAvailable, true);
  const byKey = Object.fromEntries(result.periods.map((p) => [p.key, p]));
  assert.equal(byKey.dawn.watchMs, 15000);
  assert.equal(byKey.morning.watchMs, 30000);
  assert.equal(byKey.afternoon.watchMs, 45000);
  assert.equal(byKey.evening.watchMs, 105000);
  const shareSum = result.periods.reduce((sum, p) => sum + p.share, 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-9);
});

test("缺少时间戳时时段分布不可用，并说明原因", () => {
  const data = {
    days: {
      "2026-11-09": {
        A: rec({ bvid: "A", watchMs: 60000, watchMsByHour: null }),
        B: { bvid: "B", watchMs: 30000 }
      }
    }
  };
  const result = S.summarizeDay(data, "2026-11-09");
  assert.equal(result.periodsAvailable, false);
  assert.equal(result.periodsReason, "记录中缺少精确观看时间戳（watchMsByHour），无法统计观看时段分布");
  assert.equal(result.periods.every((p) => p.watchMs === 0), true);
  assert.equal(result.totalWatchMs, 90000);
});

test("部分视频缺时间戳时，时段基于已有数据并提示", () => {
  const data = {
    days: {
      "2026-11-09": {
        A: rec({ bvid: "A", watchMs: 60000, watchMsByHour: { "20": 60000 } }),
        B: { bvid: "B", watchMs: 30000 }
      }
    }
  };
  const result = S.summarizeDay(data, "2026-11-09");
  assert.equal(result.periodsAvailable, true);
  assert.match(result.periodsReason, /1 个视频缺少时间戳/);
});

/* ---------------------------------------------------------------- 兼容性 */

test("既接受根结构也接受「日期 → 记录」映射", () => {
  const day = { BV1: rec({ bvid: "BV1", watchMs: 45000, watchMsByHour: { "20": 45000 } }) };
  assert.equal(S.summarizeDay({ version: 1, days: { "2026-11-09": day } }, "2026-11-09").totalWatchMs, 45000);
  assert.equal(S.summarizeDay({ "2026-11-09": day }, "2026-11-09").totalWatchMs, 45000);
});

test("formatDuration / formatPercent 展示正确", () => {
  assert.equal(S.formatDuration(0), "0 分钟");
  assert.equal(S.formatDuration(29999), "30 秒");
  assert.equal(S.formatDuration(65000), "1 分 5 秒");
  assert.equal(S.formatDuration(3600000), "1 小时");
  assert.equal(S.formatDuration(4980000), "1 小时 23 分钟");
  assert.equal(S.formatPercent(0.625), "62.5%");
  assert.equal(S.formatPercent(0.005), "<1%");
  assert.equal(S.formatPercent(0), "0%");
});

/* ---------------------------------------------------------------- 输出 */

const failed = results.filter((item) => !item.ok);
results.forEach((item) => {
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}`);
  if (!item.ok) console.log(`      ${item.error && item.error.message}`);
});
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exitCode = failed.length === 0 ? 0 : 1;
