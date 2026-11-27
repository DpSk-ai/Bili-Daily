"use strict";

/**
 * Bili Daily —— 推荐排序 / MMR / 双通道（MVP 算法层）独立测试
 * 运行：node test-recommend-rank.js
 *
 * 覆盖：相关性排序、MMR 多样性与确定性、双通道配额、跨通道去重、
 * 冷启动降级、推荐理由来源、导入候选准入、近似比较标记、
 * 不可变、JSON 往返、异常与空状态。
 *
 * 全部使用内存模拟数据，不读写 chrome.storage.local，不联网。
 */

const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "stats.js"));
require(path.join(__dirname, "candidate-features.js"));
require(path.join(__dirname, "candidate-pool.js"));
require(path.join(__dirname, "candidate-content-import.js"));
require(path.join(__dirname, "recommend-core.js"));
require(path.join(__dirname, "recommend-quality.js"));
require(path.join(__dirname, "recommend-rank.js"));

const CP = globalThis.BiliDailyCandidatePool;
const CF = globalThis.BiliDailyCandidateFeatures;
const CI = globalThis.BiliDailyCandidateContentImport;
const Rank = globalThis.BiliDailyRecommendRank;

const NOW = new Date(2026, 10, 11, 12, 0, 0, 0).getTime();
const DAY_MS = 24 * 60 * 60 * 1000;
const D1 = "2026-11-10";
const D10 = "2026-11-01";

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

function roundTrip(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertStable(value, label) {
  assert.deepEqual(roundTrip(value), value, `${label || "输出"} 应能 JSON 往返`);
}

function iso(dateKey, hour) {
  const parts = dateKey.split("-").map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2], hour == null ? 12 : hour, 0, 0).toISOString();
}

function rec(bvid, upUid, upName, title, partition, watchMs, dateKey) {
  return {
    bvid,
    upUid,
    upName,
    title,
    partition,
    watchMs,
    videoDuration: watchMs + 60000,
    startedAt: iso(dateKey),
    lastWatchedAt: iso(dateKey)
  };
}

function baseRecords() {
  return {
    version: 1,
    days: {
      [D1]: {
        BV1: rec("BV1", "1001", "科技UP", "科技前沿教程", "科技", 600000, D1),
        BV2: rec("BV2", "1001", "科技UP", "数码评测入门", "科技", 300000, D1),
        BV3: rec("BV3", "1002", "生活UP", "生活日常记录", "生活", 300000, D1),
        BV4: rec("BV4", "1003", "编程UP", "编程入门课程", "科技", 60000, D1),
        BV5: rec("BV5", "1003", "编程UP", "算法基础讲解", "科技", 60000, D1)
      },
      [D10]: {
        BV6: rec("BV6", "1004", "知识UP", "历史知识科普", "知识", 120000, D10),
        BV7: rec("BV7", "1004", "知识UP", "地理知识讲解", "知识", 120000, D10)
      }
    }
  };
}

function buildInput(records, options) {
  const opts = options || {};
  const pool = CP.buildFromRecords(records);
  const features = CF.buildCandidateFeatures(records, pool, {
    thresholds: { minObservedVideos: 1, minObservedWatchMs: 0 }
  });
  return {
    records,
    pool: opts.pool || pool,
    features: opts.features || features,
    sidecar: opts.sidecar || null
  };
}

function importSidecar(upUid, upName, videos, observedAt) {
  const parsed = CI.parseCandidateContentImport({
    schemaVersion: 1,
    kind: "bili-daily-candidate-content-import",
    provenance: "user-provided",
    userConfirmed: true,
    candidates: [
      {
        upUid,
        upName,
        observedAt: observedAt == null ? NOW - 2 * DAY_MS : observedAt,
        videos
      }
    ]
  });
  assert.equal(parsed.status, "ok");
  return CI.buildCandidateContentEvidence(parsed, { now: NOW });
}

const IMPORT_VIDEOS = [
  { bvid: "BV1aa411c7mD", title: "科技前沿教程", partition: "科技" },
  { bvid: "BV1bb411c7mD", title: "数码评测入门", partition: "科技" },
  { bvid: "BV1cc411c7mD", title: "编程基础讲解", partition: "科技" }
];

/* ---------------------------------------------------------------- 1. 基本排序 */

test("1. 有历史数据时返回不超过 K 条推荐", () => {
  const result = Rank.buildRecommendations(buildInput(baseRecords()), {
    now: NOW,
    endDate: D1,
    windowDays: 30,
    K: 3
  });
  assert.equal(result.status, "ok");
  assert.ok(result.recommendations.length > 0);
  assert.ok(result.recommendations.length <= 3);
  assert.equal(result.mode, "similarity");
  assertStable(result, "推荐结果");
});

test("2. main lane 推荐带 watched 来源与真实 UID 空间链接", () => {
  const result = Rank.buildRecommendations(buildInput(baseRecords()), {
    now: NOW,
    endDate: D1,
    K: 5
  });
  const main = result.recommendations.filter((item) => item.lane === "main");
  assert.ok(main.length > 0);
  main.forEach((item) => {
    assert.equal(item.provenance, "watched");
    assert.equal(item.onlineVerified, false);
    assert.equal(item.spaceUrl, `https://space.bilibili.com/${item.upUid}`);
  });
});

test("3. 科技兴趣下科技候选排在生活候选之前", () => {
  const result = Rank.buildRecommendations(buildInput(baseRecords()), {
    now: NOW,
    endDate: D1,
    K: 5,
    decay: { enabled: false }
  });
  const byUid = new Map(result.recommendations.map((item) => [item.upUid, item]));
  assert.ok(byUid.has("1001") && byUid.has("1002"));
  const tech = result.recommendations.findIndex((item) => item.upUid === "1001");
  const life = result.recommendations.findIndex((item) => item.upUid === "1002");
  assert.ok(tech < life, "科技匹配应排在生活之前");
});

test("4. 推荐理由只引用真实存在的字段", () => {
  const result = Rank.buildRecommendations(buildInput(baseRecords()), {
    now: NOW,
    endDate: D1,
    K: 5
  });
  const entry = result.recommendations.find((item) => item.upUid === "1001");
  assert.ok(entry);
  const codes = entry.reasons.map((item) => item.code);
  assert.ok(codes.includes("watched-before"));
  assert.ok(codes.includes("partition-match"));
  const watched = entry.reasons.find((item) => item.code === "watched-before");
  assert.equal(watched.evidence.watchedVideoCount, 2);

  const text = JSON.stringify(result);
  assert.equal(text.includes("已认证"), false);
  assert.equal(text.includes("官方推荐"), false);
  assert.equal(text.includes("准确率"), false);
});

test("5. 输出包含可靠性、置信度与来源，且不含伪造字段", () => {
  const result = Rank.buildRecommendations(buildInput(baseRecords()), {
    now: NOW,
    endDate: D1,
    K: 5
  });
  result.recommendations.forEach((item) => {
    assert.ok(item.reliability);
    assert.equal(item.reliability.onlineVerified, false);
    assert.ok(["high", "medium", "low", "unavailable"].includes(item.confidence));
    assert.equal(Object.prototype.hasOwnProperty.call(item, "accuracy"), false);
  });
});

/* ---------------------------------------------------------------- 2. MMR */

function fakeEntry(upUid, score, partition) {
  return {
    upUid,
    score,
    partitionVector: {
      space: "partition",
      basis: "watch-ms",
      vector: { [partition]: 1 },
      dimensions: [partition],
      available: true
    },
    textVector: null
  };
}

test("6. λ=1 退化为纯相关性排序", () => {
  const entries = [
    fakeEntry("a", 1.0, "科技"),
    fakeEntry("b", 0.9, "科技"),
    fakeEntry("c", 0.8, "生活")
  ];
  const selected = Rank.mmrSelect(entries, 3, 1, 6);
  assert.deepEqual(selected.map((item) => item.upUid), ["a", "b", "c"]);
});

test("7. λ 较小时优先选择与已选不同的分区", () => {
  const entries = [
    fakeEntry("a", 1.0, "科技"),
    fakeEntry("b", 0.9, "科技"),
    fakeEntry("c", 0.8, "生活")
  ];
  const selected = Rank.mmrSelect(entries, 3, 0.3, 6);
  assert.equal(selected[0].upUid, "a");
  assert.equal(selected[1].upUid, "c", "多样性应把生活分区提前");
});

test("8. MMR 结果确定：输入顺序变化不改变输出", () => {
  const first = Rank.mmrSelect(
    [fakeEntry("a", 1, "科技"), fakeEntry("b", 0.9, "科技"), fakeEntry("c", 0.8, "生活")],
    3,
    0.3,
    6
  ).map((item) => item.upUid);
  const second = Rank.mmrSelect(
    [fakeEntry("c", 0.8, "生活"), fakeEntry("a", 1, "科技"), fakeEntry("b", 0.9, "科技")],
    3,
    0.3,
    6
  ).map((item) => item.upUid);
  assert.deepEqual(second, first);
});

test("9. MMR 对重复 UID 去重", () => {
  const entries = [fakeEntry("a", 1, "科技"), fakeEntry("a", 1, "科技")];
  const selected = Rank.mmrSelect(entries, 2, 0.7, 4);
  const uids = selected.map((item) => item.upUid);
  assert.equal(uids.length, 1);
  assert.equal(new Set(uids).size, 1);
});

/* ---------------------------------------------------------------- 3. 双通道 */

test("10. 探索候选需要满足 eligibleForExploration", () => {
  const records = baseRecords();
  const sidecar = importSidecar("2001", "导入UP", IMPORT_VIDEOS, NOW - 2 * DAY_MS);
  const input = buildInput(records, { sidecar });
  const result = Rank.buildRecommendations(input, { now: NOW, endDate: D1, K: 5 });
  const exploration = result.recommendations.filter(
    (item) => item.lane === "exploration"
  );
  assert.equal(exploration.length, 1);
  assert.equal(exploration[0].upUid, "2001");
  assert.equal(exploration[0].provenance, "user-provided");
  const codes = exploration[0].reasons.map((item) => item.code);
  assert.ok(codes.includes("user-imported"));
});

test("11. 导入视频不足门槛的候选不进入探索通道", () => {
  const records = baseRecords();
  const sidecar = importSidecar("2002", "不足UP", IMPORT_VIDEOS.slice(0, 2));
  const result = Rank.buildRecommendations(
    buildInput(records, { sidecar }),
    { now: NOW, endDate: D1, K: 5 }
  );
  assert.equal(
    result.recommendations.filter((item) => item.upUid === "2002").length,
    0
  );
});

test("12. 同一 UID 跨通道只出现一次，且以 main 为准", () => {
  const records = baseRecords();
  const sidecar = importSidecar("1001", "科技UP", IMPORT_VIDEOS);
  const result = Rank.buildRecommendations(
    buildInput(records, { sidecar }),
    { now: NOW, endDate: D1, K: 5 }
  );
  const hits = result.recommendations.filter((item) => item.upUid === "1001");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].lane, "main");
});

test("13. 身份冲突的 UID 在两条通道都不出现", () => {
  const records = baseRecords();
  const pool = CP.buildFromRecords(records);
  const conflicted = pool.candidates.map((candidate) =>
    candidate.upUid === "1001"
      ? Object.assign({}, candidate, {
          hasUidConflict: true,
          evidence: Object.assign({}, candidate.evidence, {
            conflictVideoCount: 1,
            conflicts: [{ otherUid: "9999", dateKey: D1 }]
          })
        })
      : candidate
  );
  const features = CF.buildCandidateFeatures(records, pool, {
    thresholds: { minObservedVideos: 1, minObservedWatchMs: 0 }
  });
  const sidecar = importSidecar("1001", "科技UP", IMPORT_VIDEOS);
  const result = Rank.buildRecommendations(
    { records, pool: conflicted, features, sidecar },
    { now: NOW, endDate: D1, K: 5 }
  );
  assert.equal(
    result.recommendations.filter((item) => item.upUid === "1001").length,
    0
  );
});

test("14. 探索配额默认只有 1 条，且不填充不合格候选", () => {
  const records = baseRecords();
  const sidecar = importSidecar("2001", "导入UP", IMPORT_VIDEOS);
  const result = Rank.buildRecommendations(
    buildInput(records, { sidecar }),
    { now: NOW, endDate: D1, K: 5, explorationQuota: 1 }
  );
  const exploration = result.recommendations.filter(
    (item) => item.lane === "exploration"
  );
  assert.equal(exploration.length, 1);
  assert.equal(result.lanes.exploration.quota, 1);
});

test("15. 探索候选的分区近似比较被显式标记", () => {
  const records = baseRecords();
  const sidecar = importSidecar("2001", "导入UP", IMPORT_VIDEOS);
  const result = Rank.buildRecommendations(
    buildInput(records, { sidecar }),
    { now: NOW, endDate: D1, K: 5 }
  );
  const entry = result.recommendations.find((item) => item.lane === "exploration");
  assert.ok(entry);
  assert.equal(entry.similarity.approximate, true);
  assert.equal(entry.similarity.basis, "video-count");
  assert.equal(entry.confidence, "low");
});

/* ---------------------------------------------------------------- 4. 冷启动 */

test("16. 没有观看记录时返回空状态，不生成推荐", () => {
  const result = Rank.buildRecommendations(
    { records: { version: 1, days: {} }, pool: [], features: [], sidecar: null },
    { now: NOW, endDate: D1 }
  );
  assert.equal(result.status, "empty");
  assert.equal(result.mode, "none");
  assert.deepEqual(result.recommendations, []);
  assert.ok(result.reasons.some((item) => item.code === "no-watch-history"));
});

test("17. 数据不足时只做回访列表，不做相似度", () => {
  const records = {
    version: 1,
    days: {
      [D1]: {
        BV1: rec("BV1", "1001", "科技UP", "科技前沿教程", "科技", 60000, D1)
      }
    }
  };
  const result = Rank.buildRecommendations(buildInput(records), {
    now: NOW,
    endDate: D1,
    K: 5
  });
  assert.equal(result.mode, "returning-only");
  assert.equal(result.coldStart.status, "insufficient");
  result.recommendations.forEach((item) => {
    assert.equal(item.confidence, "low");
    assert.equal(item.similarity.partition, null);
    assert.equal(item.similarity.title, null);
  });
  assert.equal(
    result.recommendations.filter((item) => item.lane === "exploration").length,
    0
  );
});

test("18. 数据不足时仍不伪造探索推荐", () => {
  const records = {
    version: 1,
    days: {
      [D1]: { BV1: rec("BV1", "1001", "科技UP", "科技前沿教程", "科技", 60000, D1) }
    }
  };
  const sidecar = importSidecar("2001", "导入UP", IMPORT_VIDEOS);
  const result = Rank.buildRecommendations(
    buildInput(records, { sidecar }),
    { now: NOW, endDate: D1 }
  );
  assert.equal(result.mode, "returning-only");
  assert.equal(
    result.recommendations.filter((item) => item.lane === "exploration").length,
    0
  );
});

/* ---------------------------------------------------------------- 5. 配置与边界 */

test("19. 关闭衰减与开启衰减都可运行，且配置随结果输出", () => {
  const off = Rank.buildRecommendations(buildInput(baseRecords()), {
    now: NOW,
    endDate: D1,
    K: 5,
    decay: { enabled: false }
  });
  const on = Rank.buildRecommendations(buildInput(baseRecords()), {
    now: NOW,
    endDate: D1,
    K: 5,
    decay: { enabled: true, halfLifeDays: 7 }
  });
  assert.equal(off.config.decay.enabled, false);
  assert.equal(on.config.decay.enabled, true);
  assert.equal(on.config.decay.halfLifeDays, 7);
  assert.ok(off.recommendations.length > 0);
  assert.ok(on.recommendations.length > 0);
});

test("20. 非法配置回退默认值，不抛异常", () => {
  const result = Rank.buildRecommendations(buildInput(baseRecords()), {
    now: NOW,
    endDate: D1,
    K: 0,
    lambda: 5,
    explorationQuota: 99,
    decay: { enabled: "yes", halfLifeDays: -3 }
  });
  assert.equal(result.config.K, 5);
  assert.equal(result.config.lambda, 1);
  assert.equal(result.config.explorationQuota, 5);
  assert.equal(result.config.decay.enabled, true);
  assert.equal(result.config.decay.halfLifeDays, 14);
});

test("21. 非法输入安全降级", () => {
  assert.equal(Rank.buildRecommendations(null, { now: NOW }).status, "invalid");
  assert.equal(
    Rank.buildRecommendations({ records: null }, { now: NOW }).status,
    "invalid"
  );
  assert.equal(
    Rank.buildRecommendations(buildInput(baseRecords()), { now: "bad" }).status,
    "invalid"
  );
});

test("22. 没有候选池时返回空状态而不是虚构推荐", () => {
  const result = Rank.buildRecommendations(
    {
      records: baseRecords(),
      pool: [],
      features: [],
      sidecar: null
    },
    { now: NOW, endDate: D1 }
  );
  assert.equal(result.status, "empty");
  assert.deepEqual(result.recommendations, []);
});

test("23. 输入顺序变化不改变推荐结果", () => {
  const records = baseRecords();
  const input = buildInput(records);
  const shuffled = {
    records,
    pool: input.pool.candidates.slice().reverse(),
    features: input.features.candidates.slice().reverse(),
    sidecar: null
  };
  const first = JSON.stringify(
    Rank.buildRecommendations(input, { now: NOW, endDate: D1, K: 5 })
  );
  const second = JSON.stringify(
    Rank.buildRecommendations(shuffled, { now: NOW, endDate: D1, K: 5 })
  );
  assert.equal(second, first);
});

test("24. 输入不可变：深度冻结仍可处理", () => {
  const records = deepFreeze(baseRecords());
  const input = buildInput(records);
  const sidecar = deepFreeze(importSidecar("2001", "导入UP", IMPORT_VIDEOS));
  const snapshot = JSON.stringify(input.pool);
  const result = Rank.buildRecommendations(
    { records, pool: input.pool, features: input.features, sidecar },
    { now: NOW, endDate: D1, K: 5 }
  );
  assert.equal(JSON.stringify(input.pool), snapshot);
  assert.ok(result);
});

test("25. 推荐结果可 JSON 往返且无 NaN / Infinity", () => {
  const result = Rank.buildRecommendations(buildInput(baseRecords()), {
    now: NOW,
    endDate: D1,
    K: 5
  });
  assertStable(result, "推荐结果");
  const text = JSON.stringify(result);
  assert.equal(text.includes("NaN"), false);
  assert.equal(text.includes("Infinity"), false);
  assert.equal(text.includes("undefined"), false);
});

test("26. 固定 now 下结果可复现", () => {
  const first = JSON.stringify(
    Rank.buildRecommendations(buildInput(baseRecords()), {
      now: NOW,
      endDate: D1,
      K: 5
    })
  );
  const second = JSON.stringify(
    Rank.buildRecommendations(buildInput(baseRecords()), {
      now: NOW,
      endDate: D1,
      K: 5
    })
  );
  assert.equal(second, first);
});

test("27. 推荐数量上限与配额一致", () => {
  const result = Rank.buildRecommendations(buildInput(baseRecords()), {
    now: NOW,
    endDate: D1,
    K: 2,
    explorationQuota: 0
  });
  assert.ok(result.recommendations.length <= 2);
  assert.equal(result.lanes.exploration.selected, 0);
});

test("28. 探索候选不会继承任何观看时长", () => {
  const records = baseRecords();
  const sidecar = importSidecar("2001", "导入UP", IMPORT_VIDEOS);
  const result = Rank.buildRecommendations(
    buildInput(records, { sidecar }),
    { now: NOW, endDate: D1, K: 5 }
  );
  const entry = result.recommendations.find((item) => item.lane === "exploration");
  assert.ok(entry);
  assert.equal(textOf(entry).includes("看过该 UP 主"), false);
  assert.ok(entry.reasons.some((item) => item.code === "user-imported"));
});

function textOf(entry) {
  return entry.reasons.map((item) => item.message).join("；");
}

/* ---------------------------------------------------------------- 输出 */

const failed = results.filter((item) => !item.ok);
results.forEach((item) => {
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}`);
  if (!item.ok) console.log(`      ${item.error && item.error.stack}`);
});
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exitCode = failed.length === 0 ? 0 : 1;
