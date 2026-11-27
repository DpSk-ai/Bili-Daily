"use strict";

/**
 * Bili Daily —— stats.js summarizeUps() 独立测试（纯模拟数据，不读写真实用户数据）
 * 运行：node test-up-stats.js
 */

const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "stats.js"));
const U = globalThis.BiliDailyStats;

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

const DAY = "2026-11-09";

/* ---------------------------------------------------------------- 基础聚合 */

test("单个 UP 主：聚合有效时长与视频数", () => {
  const day = {
    A: rec({ bvid: "A", upName: "UP甲", watchMs: 60000 }),
    B: rec({ bvid: "B", upName: "UP甲", watchMs: 45000 })
  };
  const result = U.summarizeUps(day, DAY);
  assert.equal(result.hasData, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].upName, "UP甲");
  assert.equal(result.items[0].watchMs, 105000);
  assert.equal(result.items[0].effectiveWatchMs, 105000);
  assert.equal(result.items[0].videoCount, 2);
  assert.equal(result.items[0].effectiveVideoCount, 2);
});

test("多个 UP 主：按有效观看时长降序排序", () => {
  const day = {
    A: rec({ bvid: "A", upName: "UP甲", watchMs: 60000 }),
    B: rec({ bvid: "B", upName: "UP乙", watchMs: 120000 }),
    C: rec({ bvid: "C", upName: "UP丙", watchMs: 30000 })
  };
  const result = U.summarizeUps(day, DAY);
  assert.deepEqual(result.items.map((item) => item.upName), ["UP乙", "UP甲", "UP丙"]);
  assert.deepEqual(result.items.map((item) => item.effectiveWatchMs), [120000, 60000, 30000]);
});

test("同一 UP 主多个视频：只生成一条且时长累加", () => {
  const day = {
    A: rec({ bvid: "A", upName: "UP甲", watchMs: 20000 }),
    B: rec({ bvid: "B", upName: "UP甲", watchMs: 40000 }),
    C: rec({ bvid: "C", upName: "UP甲", watchMs: 70000 })
  };
  const result = U.summarizeUps(day, DAY);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].watchMs, 130000);
  assert.equal(result.items[0].effectiveWatchMs, 110000);
  assert.equal(result.items[0].videoCount, 3);
  assert.equal(result.items[0].effectiveVideoCount, 2);
});

test("同一 BV 号不同分 P：合并为一条，避免重复计数", () => {
  const day = {
    k1: rec({ bvid: "BV1", page: 1, upName: "UP甲", watchMs: 40000 }),
    k2: rec({ bvid: "BV1", page: 2, upName: "UP甲", watchMs: 50000 })
  };
  const result = U.summarizeUps(day, DAY);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].upName, "UP甲");
  assert.equal(result.items[0].videoCount, 1);
  assert.equal(result.items[0].watchMs, 90000);
  assert.equal(result.items[0].effectiveWatchMs, 90000);
  assert.equal(result.items[0].effectiveVideoCount, 1);
});

/* ---------------------------------------------------------------- 阈值 */

test("30 秒有效观看阈值：29999ms 不计入，30000ms 计入", () => {
  const day = {
    A: rec({ bvid: "A", upName: "UP甲", watchMs: 29999 }),
    B: rec({ bvid: "B", upName: "UP甲", watchMs: 30000 })
  };
  const result = U.summarizeUps(day, DAY);
  assert.equal(result.items[0].watchMs, 59999);
  assert.equal(result.items[0].effectiveWatchMs, 30000);
  assert.equal(result.items[0].effectiveVideoCount, 1);
  assert.equal(result.belowThresholdVideoCount, 1);
});

test("有效观看时长使用 watchMs，而不是 videoDuration", () => {
  const day = {
    A: rec({ bvid: "A", upName: "UP甲", videoDuration: 600, watchMs: 45000 })
  };
  const result = U.summarizeUps(day, DAY);
  assert.equal(result.items[0].effectiveWatchMs, 45000);
  assert.equal(result.items[0].effectiveVideoCount, 1);
});

/* ---------------------------------------------------------------- 缺失与异常 */

test("缺失 UP 主名称：归入 unknown，不参与排名", () => {
  const day = {
    A: rec({ bvid: "A", upName: "UP甲", watchMs: 60000 }),
    B: rec({ bvid: "B", upName: "", watchMs: 45000 }),
    C: rec({ bvid: "C", upName: undefined, watchMs: 20000 })
  };
  const result = U.summarizeUps(day, DAY);
  assert.equal(result.hasData, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].upName, "UP甲");
  assert.equal(result.unknown.videoCount, 2);
  assert.equal(result.unknown.watchMs, 65000);
  assert.equal(result.unknown.effectiveWatchMs, 45000);
  assert.equal(result.unknown.effectiveVideoCount, 1);
});

test("全部缺失 UP 主名称：不给排名，并说明原因", () => {
  const day = {
    A: rec({ bvid: "A", upName: "", watchMs: 60000 }),
    B: rec({ bvid: "B", upName: "", watchMs: 45000 })
  };
  const result = U.summarizeUps(day, DAY);
  assert.equal(result.hasData, true);
  assert.equal(result.items.length, 0);
  assert.match(result.reason, /UP 主信息/);
  assert.match(result.reason, /2 个视频/);
});

test("缺失 / 异常字段：不崩溃，按真实数据统计", () => {
  const day = {
    A: rec({ bvid: "A", upName: "UP甲", watchMs: "60000", partition: 123, watchMsByHour: "bad" }),
    B: rec({ bvid: "B", upName: "", watchMs: -1 }),
    C: null,
    D: rec({ bvid: "D", upName: "", watchMs: NaN }),
    E: [1, 2]
  };
  const result = U.summarizeUps(day, DAY);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].effectiveWatchMs, 60000);
  assert.equal(result.unknown.videoCount, 2);
  assert.equal(result.belowThresholdVideoCount, 2);
});

test("异常重复 BV：按观看时长较多的一条取名称，只计一次", () => {
  const day = {
    k1: rec({ bvid: "BV1", page: 1, upName: "UP甲", watchMs: 40000 }),
    k2: rec({ bvid: "BV1", page: 2, upName: "UP乙", watchMs: 60000 })
  };
  const result = U.summarizeUps(day, DAY);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].upName, "UP乙");
  assert.equal(result.items[0].videoCount, 1);
  assert.equal(result.items[0].watchMs, 100000);
});

/* ---------------------------------------------------------------- 身份聚合 */

test("同名 UP 主：暂按名称合并为一条（身份识别局限已注明）", () => {
  const day = {
    A: rec({ bvid: "A", upName: "同名UP", watchMs: 40000 }),
    B: rec({ bvid: "B", upName: "同名UP", watchMs: 50000 })
  };
  const result = U.summarizeUps(day, DAY);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].upName, "同名UP");
  assert.equal(result.items[0].videoCount, 2);
  assert.equal(result.items[0].effectiveWatchMs, 90000);
});

/* ---------------------------------------------------------------- 日期与空数据 */

test("日期过滤：只统计指定日期，其他日期不参与", () => {
  const root = {
    version: 1,
    days: {
      "2026-11-09": { A: rec({ bvid: "A", upName: "UP甲", watchMs: 60000 }) },
      "2026-11-10": { B: rec({ bvid: "B", upName: "UP乙", watchMs: 90000 }) }
    }
  };
  const first = U.summarizeUps(root, "2026-11-09");
  assert.deepEqual(first.items.map((item) => item.upName), ["UP甲"]);
  assert.equal(first.items[0].effectiveWatchMs, 60000);

  const second = U.summarizeUps(root, "2026-11-10");
  assert.deepEqual(second.items.map((item) => item.upName), ["UP乙"]);

  const missing = U.summarizeUps(root, "2026-11-08");
  assert.equal(missing.hasData, false);
  assert.equal(missing.items.length, 0);
  assert.equal(missing.reason, "当日没有观看记录");
});

test("同时接受根结构与「日期 → 记录」映射", () => {
  const day = { A: rec({ bvid: "A", upName: "UP甲", watchMs: 60000 }) };
  const fromRoot = U.summarizeUps({ version: 1, days: { [DAY]: day } }, DAY);
  const fromMap = U.summarizeUps(day, DAY);
  assert.equal(fromRoot.items[0].effectiveWatchMs, 60000);
  assert.deepEqual(fromMap.items, fromRoot.items);
});

test("空数据与非法日期：明确标记无数据或日期无效", () => {
  [{}, { version: 1, days: {} }, { days: { [DAY]: {} } }, null].forEach((records) => {
    const result = U.summarizeUps(records, DAY);
    assert.equal(result.hasData, false);
    assert.equal(result.items.length, 0);
    assert.equal(typeof result.reason, "string");
  });

  const invalid = U.summarizeUps({}, "2026-02-30");
  assert.equal(invalid.validDate, false);
  assert.equal(invalid.hasData, false);
  assert.equal(invalid.reason, "日期格式无效，无法统计");
});

/* ---------------------------------------------------------------- 不可变与排序 */

test("原始数据不可变：深度冻结的输入也能正常统计", () => {
  const root = deepFreeze({
    version: 1,
    days: {
      [DAY]: {
        A: rec({ bvid: "A", upName: "UP甲", watchMs: 60000 }),
        B: rec({ bvid: "B", upName: "UP乙", watchMs: 30000 })
      }
    }
  });
  const before = JSON.stringify(root);
  const result = U.summarizeUps(root, DAY);
  assert.equal(result.items.length, 2);
  assert.equal(JSON.stringify(root), before);
});

test("排序稳定性：完全并列时按名称码点排序且每次一致", () => {
  const build = () => ({
    A: rec({ bvid: "A", upName: "乙", watchMs: 60000 }),
    B: rec({ bvid: "B", upName: "甲", watchMs: 60000 }),
    C: rec({ bvid: "C", upName: "丙", watchMs: 60000 })
  });
  const expected = ["丙", "乙", "甲"];
  for (let index = 0; index < 5; index += 1) {
    const result = U.summarizeUps(build(), DAY);
    assert.deepEqual(result.items.map((item) => item.upName), expected);
  }
});

test("有效时长并列时：有效视频数更多者优先", () => {
  const day = {
    A1: rec({ bvid: "A1", upName: "UP甲", watchMs: 30000 }),
    A2: rec({ bvid: "A2", upName: "UP甲", watchMs: 30000 }),
    B: rec({ bvid: "B", upName: "UP乙", watchMs: 60000 })
  };
  const result = U.summarizeUps(day, DAY);
  assert.equal(result.items[0].effectiveWatchMs, result.items[1].effectiveWatchMs);
  assert.deepEqual(result.items.map((item) => item.upName), ["UP甲", "UP乙"]);
});

/* ---------------------------------------------------------------- 输出 */

const failed = results.filter((item) => !item.ok);
results.forEach((item) => {
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}`);
  if (!item.ok) console.log(`      ${item.error && item.error.message}`);
});
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exitCode = failed.length === 0 ? 0 : 1;
