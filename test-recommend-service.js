"use strict";

/**
 * Bili Daily —— 推荐数据流编排（MVP 工作包 C）独立测试
 * 运行：node test-recommend-service.js
 *
 * 覆盖：冷启动 empty / insufficient / limited 降级、main 与 exploration 通道接线、
 * 导入候选准入、K 与探索配额、安全空间链接、推荐来源与理由、状态与错误输出、
 * 输出稳定性与不修改输入。
 *
 * 全部使用内存数据，不读写 chrome.storage.local，不联网。
 */

const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "stats.js"));
require(path.join(__dirname, "interest-profile.js"));
require(path.join(__dirname, "candidate-features.js"));
require(path.join(__dirname, "candidate-pool.js"));
require(path.join(__dirname, "candidate-content-import.js"));
require(path.join(__dirname, "recommend-core.js"));
require(path.join(__dirname, "recommend-quality.js"));
require(path.join(__dirname, "recommend-rank.js"));
require(path.join(__dirname, "candidate-store.js"));
require(path.join(__dirname, "recommend-service.js"));

const Service = globalThis.BiliDailyRecommendService;
const CandidateStore = globalThis.BiliDailyCandidateStore;
const Import = globalThis.BiliDailyCandidateContentImport;

const NOW = new Date(2026, 10, 11, 12, 0, 0, 0).getTime();
const DAY_MS = 24 * 60 * 60 * 1000;
const D_READY = "2026-11-10";
const D_PREV = "2026-11-09";

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

function rec(bvid, upUid, upName, title, partition, watchMs, dateKey) {
  const parts = dateKey.split("-").map(Number);
  const iso = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0).toISOString();
  return {
    bvid,
    upUid,
    upName,
    title,
    partition,
    watchMs,
    videoDuration: watchMs + 60000,
    startedAt: iso,
    lastWatchedAt: iso
  };
}

function readyRecords() {
  return {
    version: 1,
    days: {
      [D_PREV]: {
        BV6: rec("BV6", "1004", "知识UP", "历史知识科普", "知识", 600000, D_PREV),
        BV7: rec("BV7", "1004", "知识UP", "地理知识讲解", "知识", 600000, D_PREV)
      },
      [D_READY]: {
        BV1: rec("BV1", "1001", "科技UP", "科技前沿教程", "科技", 600000, D_READY),
        BV2: rec("BV2", "1001", "科技UP", "数码评测入门", "科技", 300000, D_READY),
        BV3: rec("BV3", "1002", "生活UP", "生活日常记录", "生活", 300000, D_READY),
        BV4: rec("BV4", "1003", "编程UP", "编程入门课程", "科技", 300000, D_READY),
        BV5: rec("BV5", "1003", "编程UP", "算法基础讲解", "科技", 300000, D_READY)
      }
    }
  };
}

function importDocument(candidates) {
  return {
    schemaVersion: 1,
    kind: "bili-daily-candidate-content-import",
    provenance: "user-provided",
    userConfirmed: true,
    candidates
  };
}

function importCandidate(upUid, upName, videos) {
  return {
    upUid,
    upName,
    observedAt: NOW - 2 * DAY_MS,
    videos
  };
}

function eligibleVideos(startIndex) {
  return [
    {
      bvid: `BV1aa411c7m${startIndex}`,
      title: "科技前沿教程",
      partition: "科技"
    },
    {
      bvid: `BV1bb411c7m${startIndex}`,
      title: "数码评测入门",
      partition: "科技"
    },
    {
      bvid: `BV1cc411c7m${startIndex}`,
      title: "编程基础讲解",
      partition: "科技"
    }
  ];
}

function storeFromCandidates(candidates) {
  const parsed = Import.parseCandidateContentImport(importDocument(candidates));
  assert.equal(parsed.status, "ok");
  const added = CandidateStore.addDocument(CandidateStore.emptyStore(), parsed.document, {
    now: NOW - 1000,
    sourceName: "test.json"
  });
  assert.equal(added.ok, true);
  return added.store;
}

function run(records, options) {
  const opts = options || {};
  return Service.buildView({
    records: opts.records || records,
    store: opts.store === undefined ? null : opts.store,
    now: opts.now === undefined ? NOW : opts.now,
    endDate: opts.endDate === undefined ? D_READY : opts.endDate,
    options: opts.options
  });
}

function mainCards(view) {
  return view.recommendations.filter((card) => card.lane === "main");
}

/* ---------------------------------------------------------------- 1. 冷启动 */

test("1. 没有观看记录时返回 empty 冷启动且不生成推荐", () => {
  const view = run({ version: 1, days: {} });
  assert.equal(view.ok, true);
  assert.equal(view.coldStart.status, "empty");
  assert.equal(view.recommendations.length, 0);
  assert.equal(view.profile.hasData, false);
  assert.ok(view.statusText.includes("还没有观看记录"));
});

test("2. 无效观看记录返回明确错误而不是伪装成空数据", () => {
  const view = Service.buildView({ records: null });
  assert.equal(view.ok, false);
  assert.equal(view.error.code, "invalid-records");
  assert.ok(view.error.message.length > 0);
});

test("3. 单个短视频记录降级为数据不足", () => {
  const records = {
    version: 1,
    days: {
      [D_READY]: {
        BV1: rec("BV1", "1001", "科技UP", "科技前沿教程", "科技", 30000, D_READY)
      }
    }
  };
  const view = run(records);
  assert.equal(view.ok, true);
  assert.equal(view.coldStart.status, "insufficient");
  assert.equal(view.mode, "returning-only");
  view.recommendations.forEach((card) => {
    assert.equal(card.lane, "main", "数据不足时不应出现探索推荐");
  });
});

test("4. 四类冷启动文案都包含可展示的标签与说明", () => {
  ["empty", "insufficient", "limited", "ready"].forEach((status) => {
    const copy = Service.COLD_START_COPY[status];
    assert.ok(copy, `${status} 缺少文案`);
    assert.ok(copy.label.length > 0);
    assert.ok(copy.message.length > 0);
  });
});

/* ---------------------------------------------------------------- 2. 画像 */

test("5. 7 天画像来自真实记录：偏好分区、柱状分布与常看 UP 主", () => {
  const view = run(readyRecords());
  assert.equal(view.ok, true);
  assert.equal(view.profile.hasData, true);
  assert.equal(view.profile.favoritePartition.name, "科技");
  assert.ok(view.profile.bars.length >= 2);
  view.profile.bars.forEach((bar) => {
    assert.ok(bar.name.length > 0);
    assert.ok(bar.share > 0 && bar.share <= 1);
  });
  assert.equal(view.profile.topUp.upUid, "1004");
  assert.ok(view.profile.topUp.effectiveWatchMs > 0);
});

/* ---------------------------------------------------------------- 3. 主通道 */

test("6. main 通道推荐带真实 UID 空间链接与 watched 来源", () => {
  const view = run(readyRecords());
  const cards = mainCards(view);
  assert.ok(cards.length > 0);
  cards.forEach((card) => {
    assert.equal(card.provenance, "watched");
    assert.equal(card.provenanceLabel, "来源：本地观看记录");
    assert.equal(card.reliability.onlineVerified, false);
    assert.equal(card.spaceUrl, `https://space.bilibili.com/${card.upUid}`);
  });
});

test("7. 默认 K=5 且探索配额默认 1", () => {
  assert.equal(Service.DEFAULT_K, 5);
  assert.equal(Service.DEFAULT_EXPLORATION_QUOTA, 1);
  const view = run(readyRecords());
  assert.ok(view.recommendations.length <= 5);
  const exploration = view.recommendations.filter((card) => card.lane === "exploration");
  assert.ok(exploration.length <= 1);
});

test("8. options.K 生效", () => {
  const view = run(readyRecords(), { options: { K: 1, explorationQuota: 0 } });
  assert.equal(view.recommendations.length, 1);
});

test("9. 推荐理由只引用实际存在的字段", () => {
  const view = run(readyRecords());
  const entry = view.recommendations.find((card) => card.upUid === "1001");
  assert.ok(entry);
  assert.ok(entry.reasons.length > 0);
  entry.reasons.forEach((reason) => {
    assert.equal(typeof reason.code, "string");
    assert.ok(reason.message.length > 0);
  });
  const codes = entry.reasons.map((reason) => reason.code);
  assert.ok(codes.includes("watched-before") || codes.includes("partition-match"));

  const text = JSON.stringify(view);
  assert.equal(text.includes("已认证"), false);
  assert.equal(text.includes("官方推荐"), false);
  assert.equal(text.includes("准确率"), false);
});

test("10. 卡片包含来源与可信度标签，且不包含伪造字段", () => {
  const view = run(readyRecords());
  view.recommendations.forEach((card) => {
    assert.ok(["main", "exploration"].includes(card.lane));
    assert.ok(card.laneLabel.length > 0);
    assert.ok(card.confidenceLabel.length > 0);
    assert.equal(Object.prototype.hasOwnProperty.call(card, "accuracy"), false);
    assert.equal(typeof card.similarity.approximate, "boolean");
  });
});

/* ---------------------------------------------------------------- 4. 探索通道 */

test("11. 合规导入候选进入 exploration 通道并标明 user-provided", () => {
  const store = storeFromCandidates([importCandidate("2001", "探索UP", eligibleVideos(1))]);
  const view = run(readyRecords(), { store });
  const exploration = view.recommendations.filter((card) => card.lane === "exploration");
  assert.equal(exploration.length, 1);
  const card = exploration[0];
  assert.equal(card.upUid, "2001");
  assert.equal(card.provenance, "user-provided");
  assert.equal(card.provenanceLabel, "来源：用户导入（未在线核验）");
  assert.equal(card.reliability.onlineVerified, false);
  assert.ok(card.spaceUrl);
});

test("12. 不合格导入候选不占用探索名额", () => {
  const store = storeFromCandidates([
    importCandidate("3001", "信息缺失UP", [
      { bvid: "BV1dd411c7m1", title: "", partition: "" },
      { bvid: "BV1dd411c7m2", title: "", partition: "" },
      { bvid: "BV1dd411c7m3", title: "", partition: "" }
    ])
  ]);
  const view = run(readyRecords(), { store });
  assert.equal(
    view.recommendations.some((card) => card.upUid === "3001"),
    false
  );
  assert.ok(view.footnote.includes("未通过探索准入"));
});

test("13. 探索配额默认只占 1 个名额", () => {
  const store = storeFromCandidates([
    importCandidate("2101", "探索甲", eligibleVideos(4)),
    importCandidate("2102", "探索乙", eligibleVideos(7))
  ]);
  const view = run(readyRecords(), { store, options: { K: 5 } });
  const exploration = view.recommendations.filter((card) => card.lane === "exploration");
  assert.equal(exploration.length, 1);
  assert.ok(view.recommendations.length <= 5);
});

test("14. 不传 store 时探索通道为空且有说明", () => {
  const view = run(readyRecords());
  assert.equal(view.recommendations.filter((card) => card.lane === "exploration").length, 0);
  assert.ok(view.footnote.includes("还没有导入候选"));
});

test("15. 损坏的 store 不会让推荐崩溃", () => {
  const view = run(readyRecords(), { store: { kind: "bad", batches: [] } });
  assert.equal(view.ok, true);
  assert.equal(view.recommendations.filter((card) => card.lane === "exploration").length, 0);
});

/* ---------------------------------------------------------------- 5. 安全链接 */

test("16. safeSpaceUrl 只接受 UID 拼出的空间地址", () => {
  assert.equal(Service.safeSpaceUrl("https://space.bilibili.com/1001", "1001"), "https://space.bilibili.com/1001");
  assert.equal(Service.safeSpaceUrl("https://space.bilibili.com/1001", "2002"), null);
  assert.equal(Service.safeSpaceUrl("https://space.bilibili.com/0", "0"), null);
  assert.equal(Service.safeSpaceUrl("http://space.bilibili.com/1001", "1001"), null);
  assert.equal(Service.safeSpaceUrl("https://space.bilibili.com/1001/video", "1001"), null);
  assert.equal(Service.safeSpaceUrl("https://evil.example.com/1001", "1001"), null);
  assert.equal(Service.safeSpaceUrl("javascript:alert(1)", "1001"), null);
  assert.equal(Service.safeSpaceUrl(null, "1001"), null);
});

test("17. 所有卡片链接都指向 space.bilibili.com 且与 UID 一致", () => {
  const store = storeFromCandidates([importCandidate("2001", "探索UP", eligibleVideos(1))]);
  const view = run(readyRecords(), { store });
  assert.ok(view.recommendations.length > 0);
  view.recommendations.forEach((card) => {
    if (card.spaceUrl === null) return;
    assert.equal(card.spaceUrl, `https://space.bilibili.com/${card.upUid}`);
    assert.ok(card.spaceUrl.startsWith("https://space.bilibili.com/"));
  });
});

/* ---------------------------------------------------------------- 6. 状态与稳定性 */

test("18. 状态文案与脚注说明本地计算和通道数量", () => {
  const view = run(readyRecords());
  assert.ok(/共 \d+ 条/.test(view.statusText));
  assert.ok(view.footnote.includes("本地计算，不上传"));
  assert.ok(view.footnote.includes("不代表平台核验"));
  assert.equal(view.counts.total, view.recommendations.length);
  assert.equal(view.counts.main, mainCards(view).length);
  assert.equal(
    view.counts.exploration,
    view.recommendations.filter((card) => card.lane === "exploration").length
  );
});

test("19. endDate 无效时回退到 now 的本地日期而不是报错", () => {
  const view = run(readyRecords(), { endDate: "not-a-date" });
  assert.equal(view.ok, true);
  assert.equal(view.endDate, "2026-11-11");
});

test("20. now 接受 ISO 字符串并反映到 generatedAt", () => {
  const iso = new Date(NOW).toISOString();
  const view = run(readyRecords(), { now: iso });
  assert.equal(view.ok, true);
  assert.equal(view.generatedAt, NOW);
});

test("21. buildView 不修改传入的观看记录与候选存储", () => {
  const records = deepFreeze(readyRecords());
  const store = deepFreeze(
    storeFromCandidates([importCandidate("2001", "探索UP", eligibleVideos(1))])
  );
  const view = run(records, { store });
  assert.equal(view.ok, true);
  assert.ok(view.recommendations.length > 0);
});

test("22. 输出可 JSON 往返，字段稳定", () => {
  const view = run(readyRecords());
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view);
});

/* ---------------------------------------------------------------- 汇总 */

const failed = results.filter((item) => !item.ok);
results.forEach((item) => {
  if (item.ok) {
    console.log(`PASS ${item.name}`);
  } else {
    console.log(`FAIL ${item.name}`);
    console.log(item.error && item.error.stack ? item.error.stack : String(item.error));
  }
});
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) process.exitCode = 1;
