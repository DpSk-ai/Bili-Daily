"use strict";

/**
 * Bili Daily —— UP 主 UID 专项测试（纯模拟数据，不读写真实用户数据）
 * 运行：node test-uid.js
 *
 * 覆盖：content.js 的 UID 提取纯函数、storage.js 的 UID 合并规则、
 * stats.js summarizeUps 的 UID / 昵称身份聚合。
 */

const assert = require("node:assert/strict");
const path = require("node:path");

/* ------------------------------------------------------------ 内存版 chrome.storage.local */

const memory = Object.create(null);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

globalThis.chrome = {
  storage: {
    local: {
      get(key, callback) {
        const result = {};
        result[key] = memory[key] === undefined ? undefined : clone(memory[key]);
        callback(result);
      },
      set(items, callback) {
        Object.keys(items).forEach((key) => {
          memory[key] = clone(items[key]);
        });
        if (callback) callback();
      }
    }
  },
  runtime: {}
};

require(path.join(__dirname, "storage.js"));
require(path.join(__dirname, "stats.js"));
require(path.join(__dirname, "content.js"));

const Store = globalThis.BiliDailyStorage;
const Stats = globalThis.BiliDailyStats;
const Content = globalThis.BiliDailyContent;

const KEY = Store.STORAGE_KEY;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.getOwnPropertyNames(value).forEach((key) => deepFreeze(value[key]));
    Object.freeze(value);
  }
  return value;
}

function reset(seed) {
  Object.keys(memory).forEach((key) => delete memory[key]);
  if (seed !== undefined) memory[KEY] = clone(seed);
}

const START = new Date(2026, 10, 9, 20, 0, 0).getTime();
const MINUTE = 60 * 1000;
const DAY = Store.formatLocalDate(START);
const HOUR = Store.pad(new Date(START).getHours());

function payload(partial) {
  return Object.assign(
    {
      bvid: "BV1",
      page: 1,
      title: "测试视频",
      upName: "UP甲",
      upUid: "123456",
      partition: "科技",
      videoDuration: 600
    },
    partial
  );
}

function seedRecord(partial) {
  return Object.assign(
    {
      bvid: "BV1",
      page: 1,
      title: "旧标题",
      upName: "UP甲",
      partition: "科技",
      videoDuration: 600,
      watchMs: 10000,
      watchMsByHour: { [HOUR]: 10000 },
      startedAt: "2026-11-09T20:00:00.000+08:00",
      lastWatchedAt: "2026-11-09T20:01:00.000+08:00",
      updatedAt: "2026-11-09T20:01:00.000+08:00"
    },
    partial
  );
}

function rec(partial) {
  return Object.assign(
    {
      bvid: "BV1",
      page: 1,
      title: "测试视频",
      upName: "测试UP",
      upUid: null,
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

/* ================================================================ content.js 提取 */

test("正常 UID 提取：从当前 BV 的 videoData.owner.mid 读取", () => {
  const text =
    'window.__INITIAL_STATE__={"videoData":{"bvid":"BV1xx411c7mD","title":"标题 {含括号}",' +
    '"owner":{"mid":123456,"name":"UP主"}},"related":{"owner":{"mid":999999}}}';
  assert.equal(Content.extractUidFromVideoDataText(text, "BV1xx411c7mD"), "123456");
  assert.equal(Content.extractOwnerUid('"owner":{"mid":123456,"name":"UP主"}'), "123456");
});

test("UID 缺失：没有 owner 或没有 mid 时返回 null", () => {
  assert.equal(
    Content.extractUidFromVideoDataText('{"videoData":{"bvid":"BV1xx","title":"x"}}', "BV1xx"),
    null
  );
  assert.equal(Content.extractOwnerUid('"owner":{"name":"UP主"}'), null);
  assert.equal(Content.extractOwnerUid(""), null);
});

test("非法 UID：0、负数、非数字、超长数字都返回 null", () => {
  assert.equal(Content.extractOwnerUid('"owner":{"mid":0}'), null);
  assert.equal(Content.extractOwnerUid('"owner":{"mid":-5}'), null);
  assert.equal(Content.extractOwnerUid('"owner":{"mid":"abc"}'), null);
  assert.equal(Content.extractOwnerUid('"owner":{"mid":"123"}'), null);
  assert.equal(Content.extractOwnerUid('"owner":{"mid":9007199254740993}'), null);

  assert.equal(Content.normalizeUpUid("123"), "123");
  assert.equal(Content.normalizeUpUid(123), "123");
  ["", " ", "0", "-1", "1.5", "abc", "00123", "9007199254740993", null, undefined, 1.5, -5].forEach(
    (value) => assert.equal(Content.normalizeUpUid(value), null)
  );
});

test("UID 与 BV 锚定：同一脚本里的多个 videoData 不会串号", () => {
  const text =
    '{"videoData":{"bvid":"BV1","owner":{"mid":111}}}' +
    '{"videoData":{"bvid":"BV2","owner":{"mid":222}}}';
  assert.equal(Content.extractUidFromVideoDataText(text, "BV1"), "111");
  assert.equal(Content.extractUidFromVideoDataText(text, "BV2"), "222");
  assert.equal(Content.extractUidFromVideoDataText(text, "BV3"), null);
});

test("不采用评论区 / 相关推荐的 mid：videoData 外部的 owner 不算", () => {
  const text =
    '{"user":{"mid":888},"videoData":{"bvid":"BV1","title":"x"},' +
    '"related":{"owner":{"mid":999}}}';
  assert.equal(Content.extractUidFromVideoDataText(text, "BV1"), null);
});

test("只从明确的个人空间链接提取 UID，拒绝无关链接", () => {
  assert.equal(Content.extractUidFromSpaceHref("//space.bilibili.com/123456"), "123456");
  assert.equal(Content.extractUidFromSpaceHref("https://space.bilibili.com/123456/"), "123456");
  assert.equal(Content.extractUidFromSpaceHref("https://space.bilibili.com/123456?spm=x"), "123456");
  assert.equal(Content.extractUidFromSpaceHref("https://space.bilibili.com/"), null);
  assert.equal(Content.extractUidFromSpaceHref("https://space.bilibili.com/abc"), null);
  assert.equal(Content.extractUidFromSpaceHref("https://space.bilibili.com/0"), null);
  assert.equal(Content.extractUidFromSpaceHref("https://www.bilibili.com/space/123456"), null);
  assert.equal(Content.extractUidFromSpaceHref("https://space.bilibili.com.evil.com/123"), null);
  assert.equal(Content.extractUidFromSpaceHref("javascript:alert(1)"), null);
});

test("SPA 切换：DOM 未确认属于当前视频时绝不使用 DOM UID", () => {
  assert.equal(Content.selectUpUid("111", "222", false), "111");
  assert.equal(Content.selectUpUid(null, "222", false), null);
  assert.equal(Content.selectUpUid(null, "222", true), "222");
  assert.equal(Content.selectUpUid("abc", "222", true), "222");
  assert.equal(Content.selectUpUid(111, null, false), "111");
});

/* ================================================================ storage.js 合并 */

test("新记录保存字符串 UID，数字输入会被规范化", async () => {
  reset();
  await Store.addWatch(payload({ upUid: 123456 }), START, START + MINUTE);
  const record = memory[KEY].days[DAY].BV1;
  assert.equal(record.upUid, "123456");
  assert.equal(typeof record.upUid, "string");
});

test("老记录没有 upUid 时保持兼容，再次观看可回填且不改动其他字段", async () => {
  const legacy = { version: 1, days: { [DAY]: { BV1: seedRecord() } } };
  const normalized = Store.normalizeRoot(clone(legacy));
  assert.equal(Object.prototype.hasOwnProperty.call(normalized.days[DAY].BV1, "upUid"), false);

  reset(legacy);
  await Store.addWatch(payload({ title: "新标题", upUid: "123456" }), START, START + MINUTE);
  const record = memory[KEY].days[DAY].BV1;
  assert.equal(record.upUid, "123456");
  assert.equal(record.bvid, "BV1");
  assert.equal(record.title, "旧标题");
  assert.equal(record.startedAt, "2026-11-09T20:00:00.000+08:00");
  assert.equal(record.watchMs, 70000);
});

test("null 不会覆盖已有有效 UID", async () => {
  reset({ version: 1, days: { [DAY]: { BV1: seedRecord({ upUid: "123" }) } } });
  await Store.addWatch(payload({ upUid: null }), START, START + MINUTE);
  assert.equal(memory[KEY].days[DAY].BV1.upUid, "123");
});

test("UID 冲突：保留原始值并明确打印警告", async () => {
  reset({ version: 1, days: { [DAY]: { BV1: seedRecord({ upUid: "123" }) } } });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await Store.addWatch(payload({ upUid: "456" }), START, START + MINUTE);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(memory[KEY].days[DAY].BV1.upUid, "123");
  assert.ok(warnings.some((line) => line.includes("UID 冲突")));
  assert.ok(warnings.some((line) => line.includes("123") && line.includes("456")));
});

test("同一 BV 多分 P：合并为一条，UID 与观看时长正确保留", async () => {
  reset();
  await Store.addWatch(payload({ page: 1, upUid: "123456" }), START, START + MINUTE);
  await Store.addWatch(payload({ page: 2, upUid: "123456" }), START + 2 * MINUTE, START + 3 * MINUTE);
  const day = memory[KEY].days[DAY];
  assert.equal(Object.keys(day).length, 1);
  assert.equal(day.BV1.page, 2);
  assert.equal(day.BV1.upUid, "123456");
  assert.equal(day.BV1.watchMs, 120000);
});

test("非法 UID 存 null，且不影响其他日期 / 视频的原始数据", async () => {
  const other = { version: 1, days: { "2026-11-08": { OTHER: seedRecord({ bvid: "OTHER" }) } } };
  reset(other);
  await Store.addWatch(payload({ bvid: "BV2", upUid: "abc" }), START, START + MINUTE);
  assert.equal(memory[KEY].days[DAY].BV2.upUid, null);
  assert.deepEqual(memory[KEY].days["2026-11-08"], other.days["2026-11-08"]);
});

/* ================================================================ stats.js 聚合 */

const STAT_DAY = "2026-11-09";

test("不同 UID 的同名 UP 主必须分开统计", () => {
  const day = {
    A: rec({ bvid: "A", upName: "同名", upUid: "111", watchMs: 60000 }),
    B: rec({ bvid: "B", upName: "同名", upUid: "222", watchMs: 30000 })
  };
  const result = Stats.summarizeUps(day, STAT_DAY);
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items.map((item) => item.upUid), ["111", "222"]);
  assert.deepEqual(result.items.map((item) => item.upName), ["同名", "同名"]);
  assert.equal(result.uidUpCount, 2);
  assert.equal(result.nameOnlyUpCount, 0);
});

test("同一 UID 的不同昵称必须合并，展示观看最多的昵称", () => {
  const day = {
    A: rec({ bvid: "A", upName: "旧昵称", upUid: "111", watchMs: 60000 }),
    B: rec({ bvid: "B", upName: "新昵称", upUid: "111", watchMs: 30000 })
  };
  const result = Stats.summarizeUps(day, STAT_DAY);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].upUid, "111");
  assert.equal(result.items[0].upName, "旧昵称");
  assert.equal(result.items[0].videoCount, 2);
  assert.equal(result.items[0].effectiveWatchMs, 90000);
});

test("新旧记录混合：缺失 UID 的老记录不会凭昵称并入 UID 分组", () => {
  const day = {
    A: rec({ bvid: "A", upName: "UP甲", upUid: "111", watchMs: 60000 }),
    B: rec({ bvid: "B", upName: "UP甲", upUid: null, watchMs: 45000 })
  };
  const result = Stats.summarizeUps(day, STAT_DAY);
  assert.equal(result.items.length, 2);
  assert.equal(result.uidUpCount, 1);
  assert.equal(result.nameOnlyUpCount, 1);
  assert.deepEqual(result.items.map((item) => item.upUid), ["111", null]);
  assert.deepEqual(result.items.map((item) => item.upName), ["UP甲", "UP甲"]);
});

test("同一 BV 多分 P：按 UID 合并后只计一次", () => {
  const day = {
    k1: rec({ bvid: "BV1", page: 1, upName: "UP甲", upUid: "111", watchMs: 40000 }),
    k2: rec({ bvid: "BV1", page: 2, upName: "UP甲", upUid: "111", watchMs: 50000 })
  };
  const result = Stats.summarizeUps(day, STAT_DAY);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].videoCount, 1);
  assert.equal(result.items[0].watchMs, 90000);
  assert.equal(result.items[0].upUid, "111");
});

test("同一 BV 出现不同有效 UID：保留原始记录，不静默覆盖", () => {
  const day = {
    k1: rec({ bvid: "BV1", page: 1, upName: "UP甲", upUid: "111", watchMs: 40000 }),
    k2: rec({ bvid: "BV1", page: 2, upName: "UP乙", upUid: "222", watchMs: 60000 })
  };
  const result = Stats.summarizeUps(day, STAT_DAY);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].upUid, "111");
  assert.equal(result.items[0].watchMs, 100000);
});

test("非法 UID 按缺失处理，继续使用昵称兼容统计", () => {
  const day = {
    A: rec({ bvid: "A", upName: "UP甲", upUid: "abc", watchMs: 60000 }),
    B: rec({ bvid: "B", upName: "UP甲", upUid: 0, watchMs: 30000 })
  };
  const result = Stats.summarizeUps(day, STAT_DAY);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].upUid, null);
  assert.equal(result.items[0].upName, "UP甲");
  assert.equal(result.items[0].effectiveWatchMs, 90000);
  assert.equal(result.nameOnlyUpCount, 1);
});

test("UID 数据同样不可变：深度冻结输入可正常统计", () => {
  const root = deepFreeze({
    version: 1,
    days: {
      [STAT_DAY]: {
        A: rec({ bvid: "A", upName: "UP甲", upUid: "111", watchMs: 60000 })
      }
    }
  });
  const before = JSON.stringify(root);
  const result = Stats.summarizeUps(root, STAT_DAY);
  assert.equal(result.items[0].upUid, "111");
  assert.equal(JSON.stringify(root), before);
});

test("数据不足 / 无身份信息时返回正常空状态，不虚构 UP 主", () => {
  const empty = Stats.summarizeUps({}, STAT_DAY);
  assert.equal(empty.hasData, false);
  assert.equal(empty.items.length, 0);
  assert.equal(empty.reason, "当日没有观看记录");

  const unknown = Stats.summarizeUps(
    { [STAT_DAY]: { A: rec({ bvid: "A", upName: "", upUid: null, watchMs: 60000 }) } },
    STAT_DAY
  );
  assert.equal(unknown.hasData, true);
  assert.equal(unknown.items.length, 0);
  assert.match(unknown.reason, /缺少 UP 主信息/);
});

/* ================================================================ 输出 */

(async () => {
  const results = [];
  for (const item of tests) {
    try {
      await item.fn();
      results.push({ name: item.name, ok: true });
    } catch (error) {
      results.push({ name: item.name, ok: false, error });
    }
  }

  const failed = results.filter((item) => !item.ok);
  results.forEach((item) => {
    console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}`);
    if (!item.ok) console.log(`      ${item.error && item.error.message}`);
  });
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exitCode = failed.length === 0 ? 0 : 1;
})();
