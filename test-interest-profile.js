"use strict";

/**
 * Bili Daily —— interest-profile.js 独立测试（纯模拟数据，不读写真实用户数据）
 * 运行：node test-interest-profile.js
 *
 * 覆盖：单日 / 7 天 / 30 天 / 跨月 / 跨年窗口、分区占比与覆盖率、缺失分区、
 * 时长累计、30 秒阈值、同一 BV 不同分 P、UID 身份聚合、新旧混用、空数据、
 * 异常字段、原始数据不可变、数据不足降级、互不重叠的兴趣变化窗口。
 */

const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "stats.js"));
require(path.join(__dirname, "interest-profile.js"));

const Stats = globalThis.BiliDailyStats;
const IP = globalThis.BiliDailyInterestProfile;

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
      bvid: "BV1",
      page: 1,
      title: "测试视频",
      upName: "测试UP",
      partition: "科技",
      videoDuration: 600,
      watchMs: 0,
      watchMsByHour: {},
      startedAt: "2026-11-10T20:00:00.000+08:00",
      lastWatchedAt: "2026-11-10T20:01:00.000+08:00",
      updatedAt: "2026-11-10T20:01:00.000+08:00"
    },
    partial
  );
}

function root(days) {
  return { version: 1, days };
}

function dateAfter(dateKey, offset) {
  return Stats.shiftLocalDate(dateKey, offset);
}

/** 构造连续 N 天、每天一条记录的数据；recordFactory(dateKey, index) 返回记录。 */
function buildConsecutiveDays(startKey, count, recordFactory) {
  const days = {};
  for (let index = 0; index < count; index += 1) {
    const dateKey = dateAfter(startKey, index);
    const record = recordFactory(dateKey, index);
    days[dateKey] = { [record.bvid]: record };
  }
  return days;
}

const NOW = new Date(2026, 10, 10, 12, 0, 0); // 2026-11-10 本地时间
const END = "2026-11-10";
const OPTIONS = { now: NOW };
const PROFILE = { now: NOW };

function profileOf(days, options) {
  return IP.buildInterestProfile(root(days), Object.assign({}, PROFILE, options));
}

/* ---------------------------------------------------------------- 1. 单日数据 */

test("单日观看数据：窗口仍为完整 7 天，状态降级但不丢数据", () => {
  const days = {
    [END]: {
      BV1: rec({ bvid: "BV1", watchMs: 5 * 60 * 1000, upName: "UP甲", partition: "科技" })
    }
  };
  const profile = profileOf(days);
  assert.equal(profile.asOfDate, END);
  assert.deepEqual(profile.windowOrder, ["7d", "30d"]);

  const week = profile.windows["7d"];
  assert.equal(week.startDate, "2026-11-04");
  assert.equal(week.endDate, END);
  assert.equal(week.dateKeys.length, 7);
  assert.equal(week.activeDays, 1);
  assert.equal(week.hasData, true);
  assert.equal(week.totalWatchMs, 300000);
  assert.equal(week.effectiveVideoCount, 1);
  assert.equal(week.favoritePartition.name, "科技");
  assert.equal(week.topUp.upName, "UP甲");
  assert.equal(week.status, "insufficient");
  assert.ok(week.reasons.some((reason) => reason.includes("天")));

  const month = profile.windows["30d"];
  assert.equal(month.startDate, "2026-10-12");
  assert.equal(month.dateKeys.length, 30);
  assert.equal(month.activeDays, 1);
  assert.equal(month.totalWatchMs, 300000);
  assert.equal(profile.status, "insufficient");
});

/* ------------------------------------------------------------ 2. 连续 7 天数据 */

test("连续 7 天数据：七天全部计入 7 天窗口", () => {
  const days = buildConsecutiveDays("2026-11-04", 7, (dateKey, index) =>
    rec({
      bvid: `BV7${index}`,
      upName: "UP甲",
      partition: "科技",
      watchMs: 5 * 60 * 1000
    })
  );
  const profile = profileOf(days);
  const week = profile.windows["7d"];
  assert.equal(week.activeDays, 7);
  assert.equal(week.recordedDays, 7);
  assert.equal(week.videoCount, 7);
  assert.equal(week.effectiveVideoCount, 7);
  assert.equal(week.totalWatchMs, 7 * 5 * 60 * 1000);
  assert.equal(week.status, "ok");
  assert.equal(week.partitions.length, 1);
  assert.equal(week.partitions[0].watchMs, 7 * 5 * 60 * 1000);
  assert.equal(week.partitions[0].share, 1);
});

/* ----------------------------------------------------------- 3. 连续 30 天数据 */

test("连续 30 天数据：7 天与 30 天窗口嵌套且各自正确", () => {
  const days = buildConsecutiveDays("2026-10-12", 30, (dateKey, index) =>
    rec({ bvid: `BV30${index}`, upName: "UP甲", partition: "科技", watchMs: 2 * 60 * 1000 })
  );
  const profile = profileOf(days);
  const week = profile.windows["7d"];
  const month = profile.windows["30d"];

  assert.equal(week.totalWatchMs, 7 * 2 * 60 * 1000);
  assert.equal(week.activeDays, 7);
  assert.equal(month.totalWatchMs, 30 * 2 * 60 * 1000);
  assert.equal(month.activeDays, 30);
  assert.equal(month.effectiveVideoCount, 30);
  assert.equal(month.status, "ok");

  // 7 天窗口是 30 天窗口的后 7 个日期，两个窗口嵌套而非并列。
  assert.deepEqual(month.dateKeys.slice(-7), week.dateKeys);
  assert.match(profile.note, /嵌套/);
});

/* --------------------------------------------------------------- 4. 跨月日期 */

test("跨月日期：窗口正确覆盖上月末与本月", () => {
  const now = new Date(2026, 10, 3, 12, 0, 0); // 2026-11-03
  const days = {
    "2026-10-27": { BV1: rec({ bvid: "BV1", watchMs: 1 * 60 * 1000 }) },
    "2026-10-31": { BV2: rec({ bvid: "BV2", watchMs: 2 * 60 * 1000 }) },
    "2026-11-01": { BV3: rec({ bvid: "BV3", watchMs: 3 * 60 * 1000 }) }
  };
  const profile = IP.buildInterestProfile(root(days), { now });
  const week = profile.windows["7d"];
  assert.equal(week.startDate, "2026-10-28");
  assert.equal(week.endDate, "2026-11-03");
  assert.deepEqual(week.dateKeys, [
    "2026-10-28",
    "2026-10-29",
    "2026-10-30",
    "2026-10-31",
    "2026-11-01",
    "2026-11-02",
    "2026-11-03"
  ]);
  // 10-27 在窗口外，不参与统计
  assert.equal(week.activeDays, 2);
  assert.equal(week.totalWatchMs, 5 * 60 * 1000);
  assert.equal(profile.windows["30d"].startDate, "2026-10-05");
});

/* --------------------------------------------------------------- 5. 跨年日期 */

test("跨年日期：窗口正确跨过 12 月 31 日", () => {
  const now = new Date(2027, 0, 3, 12, 0, 0); // 2027-01-03
  const days = {
    "2026-12-27": { BV1: rec({ bvid: "BV1", watchMs: 1 * 60 * 1000 }) },
    "2026-12-31": { BV2: rec({ bvid: "BV2", watchMs: 2 * 60 * 1000 }) },
    "2027-01-01": { BV3: rec({ bvid: "BV3", watchMs: 3 * 60 * 1000 }) }
  };
  const profile = IP.buildInterestProfile(root(days), { now });
  const week = profile.windows["7d"];
  assert.equal(week.startDate, "2026-12-28");
  assert.equal(week.endDate, "2027-01-03");
  assert.equal(week.activeDays, 2);
  assert.equal(week.totalWatchMs, 5 * 60 * 1000);
  assert.equal(profile.windows["30d"].startDate, "2026-12-05");
});

/* ------------------------------------------------------------ 6. 分区占比 */

test("不同分区占比：按真实观看时长计算且总和为 1", () => {
  const days = {
    [END]: {
      A: rec({ bvid: "A", partition: "科技", watchMs: 60 * 60 * 1000 }),
      B: rec({ bvid: "B", partition: "游戏", watchMs: 30 * 60 * 1000 }),
      C: rec({ bvid: "C", partition: "音乐", watchMs: 10 * 60 * 1000 })
    }
  };
  const week = profileOf(days).windows["7d"];
  assert.deepEqual(
    week.partitions.map((entry) => entry.name),
    ["科技", "游戏", "音乐"]
  );
  assert.deepEqual(
    week.partitions.map((entry) => entry.share),
    [0.6, 0.3, 0.1]
  );
  assert.equal(week.favoritePartition.name, "科技");
  assert.equal(week.favoritePartition.identified, true);
  const sum = week.partitions.reduce((total, entry) => total + entry.share, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12);
});

/* ------------------------------------------------------------ 7. 分区缺失 */

test("分区缺失：归入「未知」并参与占比，不推断具体分区", () => {
  const days = {
    [END]: {
      A: rec({ bvid: "A", partition: "", watchMs: 40 * 60 * 1000 }),
      B: rec({ bvid: "B", partition: "科技", watchMs: 20 * 60 * 1000 })
    }
  };
  const week = profileOf(days).windows["7d"];
  const unknown = week.partitions.find((entry) => entry.name === IP.UNKNOWN_PARTITION);
  assert.ok(unknown);
  assert.equal(unknown.identified, false);
  assert.equal(unknown.watchMs, 40 * 60 * 1000);
  assert.ok(Math.abs(unknown.share - 2 / 3) < 1e-12);

  // 未知桶可以成为「观看时长最多的分区」，但不会被标记为已识别分区
  assert.equal(week.favoritePartition.name, IP.UNKNOWN_PARTITION);
  assert.equal(week.favoritePartition.identified, false);
  assert.equal(week.favoriteIdentifiedPartition.name, "科技");
  assert.equal(week.favoriteIdentifiedPartition.identified, true);
});

/* ---------------------------------------------------------- 8. 分区覆盖率 */

test("分区覆盖率：按观看时长计算，未知数据不会被悄悄排除", () => {
  const days = {
    [END]: {
      A: rec({ bvid: "A", partition: "科技", watchMs: 30 * 60 * 1000 }),
      B: rec({ bvid: "B", partition: "", watchMs: 10 * 60 * 1000 })
    }
  };
  const week = profileOf(days).windows["7d"];
  assert.equal(week.partitionCoverage.totalWatchMs, 40 * 60 * 1000);
  assert.equal(week.partitionCoverage.identifiedWatchMs, 30 * 60 * 1000);
  assert.equal(week.partitionCoverage.unknownWatchMs, 10 * 60 * 1000);
  assert.equal(week.partitionCoverage.ratio, 0.75);
  assert.equal(week.partitionCoverage.identifiedVideoCount, 1);
  assert.equal(week.partitionCoverage.unknownVideoCount, 1);
  assert.equal(week.partitionCoverage.videoRatio, 0.5);
  assert.ok(week.reasons.some((reason) => reason.includes("未知")));
});

test("全部缺少分区：覆盖率为 0，不虚构任何分区", () => {
  const days = {
    [END]: {
      A: rec({ bvid: "A", partition: "", watchMs: 30 * 60 * 1000 }),
      B: rec({ bvid: "B", partition: "   ", watchMs: 10 * 60 * 1000 })
    }
  };
  const week = profileOf(days).windows["7d"];
  assert.equal(week.partitionCoverage.ratio, 0);
  assert.equal(week.favoriteIdentifiedPartition, null);
  assert.equal(week.partitions.length, 1);
  assert.equal(week.partitions[0].name, IP.UNKNOWN_PARTITION);
});

/* -------------------------------------------------------- 9. 观看时长累计 */

test("观看时长累计：多个视频与多个 UP 的时长正确相加", () => {
  const days = {
    [END]: {
      A: rec({ bvid: "A", upName: "UP甲", watchMs: 5 * 60 * 1000 }),
      B: rec({ bvid: "B", upName: "UP甲", watchMs: 10 * 60 * 1000 }),
      C: rec({ bvid: "C", upName: "UP乙", watchMs: 15 * 60 * 1000 })
    }
  };
  const week = profileOf(days).windows["7d"];
  assert.equal(week.totalWatchMs, 30 * 60 * 1000);
  assert.equal(week.effectiveWatchMs, 30 * 60 * 1000);
  assert.equal(week.effectiveVideoCount, 3);
  assert.equal(week.ups.length, 2);
  // 两个 UP 的有效时长并列 15 分钟时，有效视频数更多的 UP甲 排在前
  assert.equal(week.ups[0].upName, "UP甲");
  assert.equal(week.ups[0].watchMs, 15 * 60 * 1000);
  assert.equal(week.ups[0].effectiveVideoCount, 2);
  assert.equal(week.ups[1].upName, "UP乙");
  assert.equal(week.ups[1].watchMs, 15 * 60 * 1000);
  assert.equal(week.topUp.upName, "UP甲");
});

test("观看时长使用 watchMs，不使用 videoDuration 代替", () => {
  const days = {
    [END]: {
      A: rec({ bvid: "A", videoDuration: 99999, watchMs: 45000 })
    }
  };
  const week = profileOf(days).windows["7d"];
  assert.equal(week.totalWatchMs, 45000);
  assert.equal(week.effectiveWatchMs, 45000);
});

/* ------------------------------------------------------------ 10. 30 秒阈值 */

test("30 秒有效观看阈值：29999ms 不计入，30000ms 计入", () => {
  const days = {
    [END]: {
      A: rec({ bvid: "A", watchMs: 29999 }),
      B: rec({ bvid: "B", watchMs: 30000 })
    }
  };
  const week = profileOf(days).windows["7d"];
  assert.equal(week.totalWatchMs, 59999);
  assert.equal(week.effectiveVideoCount, 1);
  assert.equal(week.effectiveWatchMs, 30000);
  assert.equal(week.belowThresholdVideoCount, 1);
  const tech = week.partitions[0];
  assert.equal(tech.watchMs, 59999);
  assert.equal(tech.effectiveVideoCount, 1);
  assert.equal(tech.effectiveWatchMs, 30000);
});

/* --------------------------------------------------- 11. 同一 BV 不同分 P */

test("同一 BV 不同分 P（同一天）：合并为一个视频并累加时长", () => {
  const days = {
    [END]: {
      k1: rec({ bvid: "BV1", page: 1, upName: "UP甲", watchMs: 20000 }),
      k2: rec({ bvid: "BV1", page: 2, upName: "UP甲", watchMs: 25000 })
    }
  };
  const week = profileOf(days).windows["7d"];
  assert.equal(week.recordedDays, 1);
  assert.equal(week.videoCount, 1);
  assert.equal(week.totalWatchMs, 45000);
  assert.equal(week.effectiveVideoCount, 1);
  assert.equal(week.ups.length, 1);
  assert.equal(week.ups[0].videoCount, 1);
});

test("同一 BV 跨天观看：窗口内仍只计一个视频，时长累加", () => {
  const days = {
    "2026-11-09": {
      BV1: rec({ bvid: "BV1", page: 1, upName: "UP甲", watchMs: 20000 })
    },
    [END]: {
      BV1: rec({ bvid: "BV1", page: 2, upName: "UP甲", watchMs: 25000 })
    }
  };
  const week = profileOf(days).windows["7d"];
  assert.equal(week.videoCount, 1);
  assert.equal(week.totalWatchMs, 45000);
  assert.equal(week.effectiveVideoCount, 1); // 两天累计达到 30 秒阈值
  assert.equal(week.ups[0].videoCount, 1);
});

/* ----------------------------------------------------- 12. 同 UID 不同昵称 */

test("同 UID 不同昵称：合并为一条，展示观看时长最多的昵称", () => {
  const days = {
    [END]: {
      A: rec({ bvid: "A", upUid: "12345", upName: "旧昵称", watchMs: 5 * 60 * 1000 }),
      B: rec({ bvid: "B", upUid: "12345", upName: "新昵称", watchMs: 10 * 60 * 1000 })
    }
  };
  const week = profileOf(days).windows["7d"];
  assert.equal(week.ups.length, 1);
  assert.equal(week.ups[0].upUid, "12345");
  assert.equal(week.ups[0].upName, "新昵称");
  assert.equal(week.ups[0].watchMs, 15 * 60 * 1000);
  assert.equal(week.ups[0].videoCount, 2);
  assert.equal(week.uidUpCount, 1);
  assert.equal(week.nameOnlyUpCount, 0);
});

/* ----------------------------------------------------- 13. 不同 UID 同名 */

test("不同 UID 同名：保持两条，不按昵称合并", () => {
  const days = {
    [END]: {
      A: rec({ bvid: "A", upUid: "111", upName: "同名UP", watchMs: 5 * 60 * 1000 }),
      B: rec({ bvid: "B", upUid: "222", upName: "同名UP", watchMs: 8 * 60 * 1000 })
    }
  };
  const week = profileOf(days).windows["7d"];
  assert.equal(week.ups.length, 2);
  assert.deepEqual(
    week.ups.map((item) => item.upUid),
    ["222", "111"]
  );
  assert.deepEqual(
    week.ups.map((item) => item.upName),
    ["同名UP", "同名UP"]
  );
});

/* -------------------------------------------------------- 14. 新旧记录混合 */

test("新旧记录混合：无 UID 的老记录按昵称聚合，不并入同名 UID 分组", () => {
  const days = {
    [END]: {
      A: rec({ bvid: "A", upName: "老UP", watchMs: 5 * 60 * 1000 }), // 老记录：无 upUid
      B: rec({ bvid: "B", upName: "老UP", watchMs: 3 * 60 * 1000 }), // 老记录：无 upUid
      C: rec({ bvid: "C", upUid: "999", upName: "老UP", watchMs: 10 * 60 * 1000 })
    }
  };
  const week = profileOf(days).windows["7d"];
  assert.equal(week.ups.length, 2);
  const uidItem = week.ups.find((item) => item.upUid === "999");
  const nameItem = week.ups.find((item) => item.upUid === null);
  assert.ok(uidItem);
  assert.ok(nameItem);
  assert.equal(uidItem.watchMs, 10 * 60 * 1000);
  assert.equal(uidItem.videoCount, 1);
  assert.equal(nameItem.watchMs, 8 * 60 * 1000);
  assert.equal(nameItem.videoCount, 2);
  assert.equal(week.uidUpCount, 1);
  assert.equal(week.nameOnlyUpCount, 1);
});

/* ------------------------------------------------------------- 15. 空数据 */

test("空数据：所有窗口明确标记 empty，不崩溃", () => {
  const cases = [null, undefined, {}, { version: 1, days: {} }, { days: null }, [], "x", 42];
  cases.forEach((input) => {
    const profile = IP.buildInterestProfile(input, OPTIONS);
    assert.equal(profile.status, "empty");
    assert.deepEqual(profile.windowOrder, ["7d", "30d"]);
    ["7d", "30d"].forEach((key) => {
      const window = profile.windows[key];
      assert.equal(window.status, "empty");
      assert.equal(window.hasData, false);
      assert.equal(window.totalWatchMs, 0);
      assert.equal(window.effectiveVideoCount, 0);
      assert.deepEqual(window.partitions, []);
      assert.deepEqual(window.ups, []);
      assert.equal(window.favoritePartition, null);
      assert.equal(window.partitionCoverage.ratio, 0);
      assert.equal(window.dateKeys.length, key === "7d" ? 7 : 30);
      assert.equal(profile.comparisons[key].status, "empty");
      assert.equal(profile.comparisons[key].reliable, false);
    });
  });
});

/* --------------------------------------------------------- 16. 异常字段 */

test("异常字段：非法记录被跳过并计数，其余数据照常统计", () => {
  const days = {
    [END]: {
      A: rec({ bvid: "A", upName: "", watchMs: "60000", partition: 123, upUid: "abc" }),
      B: rec({ bvid: "B", upName: "", watchMs: -1 }),
      C: null,
      D: [1, 2],
      E: rec({ bvid: "E", upName: "UP甲", watchMs: Number.NaN, watchMsByHour: "bad" })
    },
    "2026-11-08": "损坏的日期"
  };
  const week = profileOf(days).windows["7d"];
  assert.equal(week.invalidRecords, 2); // C、D
  assert.equal(week.invalidDays, 1); // 2026-11-08
  assert.equal(week.activeDays, 1); // 只有 A 有实际观看时长
  assert.equal(week.videoCount, 3); // A、B、E 被识别为记录
  assert.equal(week.watchedVideoCount, 1);
  assert.equal(week.totalWatchMs, 60000); // 字符串 "60000" 被规范为数字
  assert.equal(week.effectiveVideoCount, 1);
  assert.equal(week.partitionCoverage.totalWatchMs, 60000);
  assert.equal(week.partitionCoverage.ratio, 0); // partition: 123 不是有效名称
  assert.equal(week.favoritePartition.name, IP.UNKNOWN_PARTITION);
  assert.equal(week.ups.length, 1); // 只有 E 有有效昵称
  assert.equal(week.ups[0].upName, "UP甲");
  assert.equal(week.unknownUps.videoCount, 2); // A、B 既无 UID 也无昵称
  assert.equal(week.unknownUps.watchMs, 60000);
  assert.ok(week.reasons.some((reason) => reason.includes("结构异常")));
  assert.ok(week.reasons.some((reason) => reason.includes("日期数据异常")));
});

/* ---------------------------------------------------- 17. 原始数据不可变 */

test("原始数据不可变：深度冻结的输入也能正常生成画像", () => {
  const days = deepFreeze({
    "2026-11-09": {
      A: rec({ bvid: "A", upName: "UP甲", partition: "科技", watchMs: 10 * 60 * 1000 })
    },
    [END]: {
      B: rec({ bvid: "B", upName: "UP乙", partition: "游戏", watchMs: 20 * 60 * 1000 }),
      C: rec({ bvid: "B", page: 2, upName: "UP乙", partition: "游戏", watchMs: 5000 })
    }
  });
  const before = JSON.stringify(days);
  const profile = IP.buildInterestProfile(root(days), {
    now: NOW,
    windows: [7, 30]
  });
  assert.equal(JSON.stringify(days), before);
  assert.equal(profile.windows["7d"].totalWatchMs, 30 * 60 * 1000 + 5000);
  assert.equal(profile.windows["30d"].videoCount, 2);
  assert.equal(profile.windows["7d"].ups.length, 2);
});

/* ------------------------------------------------- 18. 数据不足的降级处理 */

test("数据不足：状态为 insufficient，并给出可读原因", () => {
  const days = {
    "2026-11-09": { A: rec({ bvid: "A", watchMs: 60 * 1000 }) },
    [END]: { B: rec({ bvid: "B", watchMs: 60 * 1000 }) }
  };
  const profile = profileOf(days);
  const week = profile.windows["7d"];
  assert.equal(week.activeDays, 2);
  assert.equal(week.totalWatchMs, 120000);
  assert.equal(week.status, "insufficient");
  assert.ok(week.reasons.some((reason) => reason.includes("分钟")));
  assert.equal(profile.comparisons["7d"].reliable, false);
  assert.ok(profile.comparisons["7d"].reasons.length > 0);
});

test("兴趣变化：使用互不重叠的等长窗口，数据充足时可靠", () => {
  const days = {
    "2026-10-31": { A: rec({ bvid: "A", partition: "游戏", watchMs: 6 * 60 * 1000 }) },
    "2026-11-01": { B: rec({ bvid: "B", partition: "游戏", watchMs: 6 * 60 * 1000 }) },
    "2026-11-09": { C: rec({ bvid: "C", partition: "科技", watchMs: 6 * 60 * 1000 }) },
    [END]: { D: rec({ bvid: "D", partition: "科技", watchMs: 6 * 60 * 1000 }) }
  };
  const comparison = profileOf(days).comparisons["7d"];

  // 最近 7 天：11-04 ~ 11-10；前 7 天：10-28 ~ 11-03，二者不重叠
  assert.equal(comparison.recent.startDate, "2026-11-04");
  assert.equal(comparison.recent.endDate, END);
  assert.equal(comparison.previous.startDate, "2026-10-28");
  assert.equal(comparison.previous.endDate, "2026-11-03");
  assert.equal(dateAfter(comparison.previous.endDate, 1), comparison.recent.startDate);

  assert.equal(comparison.recent.totalWatchMs, 12 * 60 * 1000);
  assert.equal(comparison.previous.totalWatchMs, 12 * 60 * 1000);
  assert.equal(comparison.reliable, true);
  assert.equal(comparison.status, "ok");

  const tech = comparison.partitions.find((entry) => entry.name === "科技");
  const game = comparison.partitions.find((entry) => entry.name === "游戏");
  assert.equal(tech.recentShare, 1);
  assert.equal(tech.previousShare, 0);
  assert.equal(tech.direction, "up");
  assert.equal(game.recentShare, 0);
  assert.equal(game.previousShare, 1);
  assert.equal(game.direction, "down");

  // 30 天对比的前 30 天在最近 30 天之前，同样不重叠
  assert.equal(
    dateAfter(profileOf(days).comparisons["30d"].previous.endDate, 1),
    profileOf(days).comparisons["30d"].recent.startDate
  );
});

/* -------------------------------------------------------- 参数与窗口配置 */

test("options：自定义窗口、endDate 与关闭对比", () => {
  const days = {
    [END]: { A: rec({ bvid: "A", watchMs: 60000 }) }
  };
  const profile = IP.buildInterestProfile(root(days), {
    endDate: "2026-11-09",
    windows: [3, 3, 0, -1, 999],
    includeComparisons: false
  });
  assert.equal(profile.asOfDate, "2026-11-09");
  assert.deepEqual(profile.windowOrder, ["3d"]);
  assert.equal(profile.windows["3d"].startDate, "2026-11-07");
  assert.equal(profile.windows["3d"].totalWatchMs, 0); // 11-10 不在窗口内
  assert.deepEqual(profile.comparisonOrder, []);
  assert.deepEqual(profile.comparisons, {});
});

test("options：非法窗口配置回退默认 7 / 30 天", () => {
  const profile = IP.buildInterestProfile(root({}), { windows: ["x", null, 0, 1.5] });
  assert.deepEqual(profile.windowOrder, ["7d", "30d"]);
});

/* ---------------------------------------------------------------- 输出 */

const failed = results.filter((item) => !item.ok);
results.forEach((item) => {
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}`);
  if (!item.ok) console.log(`      ${item.error && item.error.message}`);
});
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exitCode = failed.length === 0 ? 0 : 1;
