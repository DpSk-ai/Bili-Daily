"use strict";

/**
 * Bili Daily —— 推荐质量层（C3-2）独立测试
 * 运行：node test-recommend-quality.js
 *
 * 覆盖：时间衰减边界、逐日加权、跨天标题文档去重、
 * 用户证据与冷启动、候选可靠性、重复曝光信号、
 * 不可变、JSON 往返、可复现、无网络与存储。
 *
 * 全部使用内存模拟数据，不读写 chrome.storage.local，不联网。
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

require(path.join(__dirname, "stats.js"));
require(path.join(__dirname, "candidate-features.js"));
require(path.join(__dirname, "recommend-core.js"));
require(path.join(__dirname, "recommend-quality.js"));

const RC = globalThis.BiliDailyRecommendCore;
const Q = globalThis.BiliDailyRecommendQuality;

// 测试固定"本地时间 2026-11-11 12:00"，与日期键同处本地时区，避免时区漂移。
const NOW = new Date(2026, 10, 11, 12, 0, 0, 0).getTime();
const DAY_MS = 24 * 60 * 60 * 1000;
const END = "2026-11-11";
const WIN = { endDate: END, windowDays: 30 };

const D0 = "2026-11-11";
const D1 = "2026-11-10";
const D10 = "2026-11-01";
const D14 = "2026-10-28";
const D20 = "2026-10-22";
const D28 = "2026-10-14";

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

function closeTo(actual, expected, epsilon) {
  const eps = epsilon == null ? 1e-9 : epsilon;
  assert.equal(typeof actual, "number", "应为数字");
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `期望 ${expected}，实际 ${actual}`
  );
}

function weightAt(ageDays, halfLife) {
  return Math.pow(0.5, ageDays / (halfLife == null ? 14 : halfLife));
}

function reasonCodes(list) {
  return list.map((item) => item.code);
}

function rec(bvid, title, partition, watchMs, extra) {
  return Object.assign(
    {
      bvid,
      title,
      partition,
      watchMs,
      upName: "示例UP",
      upUid: "1001",
      videoDuration: watchMs + 1000
    },
    extra || {}
  );
}

function root(days) {
  return { version: 1, days };
}

/* ---------------------------------------------------------------- 1. 时间衰减 */

test("1. ageDays = 0 时权重为 1", () => {
  const result = Q.computeTimeDecay(NOW, { now: NOW });
  assert.equal(result.status, "ok");
  assert.equal(result.ageDays, 0);
  assert.equal(result.weight, 1);
  assert.equal(result.ageBasis, "ms");
  assert.equal(result.timeSource, "timestamp");
  assert.equal(result.formula, "0.5^(ageDays/H)");
  assertStable(result, "衰减结果");
});

test("2. 恰好一个半衰期（14 天）权重 0.5", () => {
  const result = Q.computeTimeDecay(NOW - 14 * DAY_MS, {
    now: NOW,
    halfLifeDays: 14
  });
  closeTo(result.ageDays, 14);
  closeTo(result.weight, 0.5);
});

test("3. 两个半衰期（28 天）权重 0.25", () => {
  const result = Q.computeTimeDecay(NOW - 28 * DAY_MS, {
    now: NOW,
    halfLifeDays: 14
  });
  closeTo(result.weight, 0.25);
});

test("4. 自定义半衰期生效", () => {
  const result = Q.computeTimeDecay(NOW - 7 * DAY_MS, {
    now: NOW,
    halfLifeDays: 7
  });
  assert.equal(result.halfLifeDays, 7);
  closeTo(result.weight, 0.5);
});

test("5. 非法半衰期被拒绝，且不抛异常", () => {
  [0, -1, NaN, Infinity, "14"].forEach((value) => {
    const result = Q.computeTimeDecay(NOW, { now: NOW, halfLifeDays: value });
    assert.equal(result.status, "invalid-half-life");
    assert.equal(result.weight, null);
  });
});

test("6. 未来时间戳不得获得高权重", () => {
  const result = Q.computeTimeDecay(NOW + DAY_MS, { now: NOW });
  assert.equal(result.status, "future-time");
  assert.equal(result.weight, null);
  assert.ok(reasonCodes(result.reasons).includes("future-time"));
});

test("7. 缺失时间不得假装为刚刚观看", () => {
  [null, undefined, "", { time: null }].forEach((value) => {
    const result = Q.computeTimeDecay(value, { now: NOW });
    assert.equal(result.status, "missing-time");
    assert.equal(result.weight, null);
  });
});

test("8. ISO 字符串与 epoch 毫秒等价", () => {
  const time = new Date(2026, 9, 28, 12, 0, 0, 0).getTime();
  const iso = Q.computeTimeDecay(new Date(time).toISOString(), { now: NOW });
  const ms = Q.computeTimeDecay(time, { now: NOW });
  assert.equal(iso.status, "ok");
  assert.equal(ms.status, "ok");
  closeTo(iso.weight, ms.weight);
  closeTo(iso.ageDays, ms.ageDays);
});

test("9. 本地日期键按日历日差计算", () => {
  const result = Q.computeTimeDecay({ dateKey: D14 }, { now: NOW });
  assert.equal(result.ageBasis, "local-date");
  assert.equal(result.timeSource, "date-key");
  assert.equal(result.ageDays, 14);
  closeTo(result.weight, 0.5);

  const today = Q.computeTimeDecay(D0, { now: NOW });
  assert.equal(today.ageDays, 0);
  assert.equal(today.weight, 1);
});

test("10. 极久远的数据权重趋近 0，不产生 NaN / Infinity", () => {
  const result = Q.computeTimeDecay(NOW - 1e15 * DAY_MS, { now: NOW });
  assert.equal(result.status, "ok");
  assert.ok(Number.isFinite(result.weight));
  assert.equal(result.weight, 0);
});

/* ---------------------------------------------------------------- 2. 逐日加权 */

test("11. 同一 BV 多日观看只算一个视频", () => {
  const records = root({
    [D1]: { BV1: rec("BV1", "科技前沿", "科技", 60000) },
    [D10]: { BV1: rec("BV1", "科技前沿", "科技", 60000) }
  });
  const result = Q.buildDecayedUserPartitionVector(records, {
    ...WIN,
    decayEnabled: true,
    now: NOW
  });
  assert.equal(result.status, "ok");
  assert.equal(result.sample.videoCount, 1);
  assert.deepEqual(result.dimensions, ["科技"]);
  closeTo(result.vector["科技"], 1);
});

test("12. 跨天时长按各自日期加权，而不是归到最新一次", () => {
  const records = root({
    [D1]: { BV1: rec("BV1", "科技视频", "科技", 60000) },
    [D10]: { BV2: rec("BV2", "生活视频", "生活", 60000) }
  });
  const result = Q.buildDecayedUserPartitionVector(records, {
    ...WIN,
    decayEnabled: true,
    now: NOW
  });
  const w1 = weightAt(1);
  const w10 = weightAt(10);
  const expected = (60000 * w1) / (60000 * w1 + 60000 * w10);
  closeTo(result.vector["科技"], expected);
  closeTo(result.vector["生活"], 1 - expected);
  // 若不衰减，二者应是 0.5 / 0.5；这里必须明显不同
  assert.ok(Math.abs(result.vector["科技"] - 0.5) > 0.05);
});

test("13. 跨天标题只生成一个内容文档", () => {
  const records = root({
    [D1]: { BV1: rec("BV1", "科技前沿", "科技", 60000) },
    [D10]: { BV1: rec("BV1", "科技前沿", "科技", 60000) }
  });
  const result = Q.buildDecayedUserTextCounts(records, {
    ...WIN,
    decayEnabled: true,
    now: NOW
  });
  assert.equal(result.sample.videoCount, 1);
  assert.equal(result.tokenCount, 3);
  // 一个文档、权重取最近的 D1：科技只加一次 w(1)
  closeTo(result.counts["科技"], weightAt(1));
  closeTo(result.totalTokenCount, 3 * weightAt(1));
});

test("14. 用户分区向量随关闭/开启衰减而不同", () => {
  const records = root({
    [D1]: { BV1: rec("BV1", "科技视频", "科技", 60000) },
    [D10]: { BV1: rec("BV1", "科技视频", "科技", 60000) },
    [D20]: { BV2: rec("BV2", "生活视频", "生活", 60000) }
  });
  const off = Q.buildDecayedUserPartitionVector(records, WIN);
  const on = Q.buildDecayedUserPartitionVector(records, {
    ...WIN,
    decayEnabled: true,
    now: NOW
  });
  assert.equal(off.decay, "none");
  assert.equal(on.decay, "time-decay");
  assert.notDeepEqual(on.vector, off.vector);
  assert.ok(on.vector["科技"] > off.vector["科技"]);
});

test("15. 用户标题词频随衰减变化", () => {
  const records = root({
    [D1]: { BV1: rec("BV1", "科技前沿", "科技", 60000) },
    [D20]: { BV2: rec("BV2", "生活日常", "生活", 60000) }
  });
  const on = Q.buildDecayedUserTextCounts(records, {
    ...WIN,
    decayEnabled: true,
    now: NOW
  });
  closeTo(on.counts["科技"], weightAt(1));
  closeTo(on.counts["生活"], weightAt(20));
  assert.ok(on.counts["科技"] > on.counts["生活"]);
});

test("16. 关闭衰减时与 C3-1 结果完全一致", () => {
  const records = root({
    [D1]: {
      BV1: rec("BV1", "科技前沿", "科技", 60000),
      BV2: rec("BV2", "生活日常", "生活", 30000)
    },
    [D10]: { BV3: rec("BV3", "编程入门", "知识", 20000) }
  });
  const offPartition = Q.buildDecayedUserPartitionVector(records, WIN);
  const corePartition = RC.buildUserPartitionVector(records, WIN);
  assert.deepEqual(offPartition.vector, corePartition.vector);
  assert.deepEqual(offPartition.coverage, corePartition.coverage);
  assert.deepEqual(offPartition.sample, corePartition.sample);
  assert.equal(offPartition.status, corePartition.status);
  assert.equal(offPartition.decay, "none");

  const offText = Q.buildDecayedUserTextCounts(records, WIN);
  const coreText = RC.buildUserTextCounts(records, WIN);
  assert.deepEqual(offText.counts, coreText.counts);
  assert.deepEqual(offText.coverage, coreText.coverage);
  assert.deepEqual(offText.sample, coreText.sample);
  assert.equal(offText.status, coreText.status);
  assertStable(offText, "关闭衰减的词频");
});

test("17. 衰减配置随结果输出", () => {
  const records = root({
    [D1]: { BV1: rec("BV1", "科技前沿", "科技", 60000) }
  });
  const result = Q.buildDecayedUserPartitionVector(records, {
    ...WIN,
    decayEnabled: true,
    now: NOW,
    halfLifeDays: 7
  });
  assert.equal(result.decayConfig.enabled, true);
  assert.equal(result.decayConfig.halfLifeDays, 7);
  assert.equal(result.decayConfig.timeBasis, "local-date");
  assert.equal(result.decayConfig.appliedTo, "per-local-day watch-ms");
  assert.equal(result.coverage.weighting, "time-decay");
  assert.equal(result.basis, "watch-ms");
});

/* ---------------------------------------------------------------- 3. 用户证据 */

test("18. 无观看历史：empty 状态与降级建议", () => {
  const evidence = Q.assessUserEvidence(root({}), WIN);
  assert.equal(evidence.status, "empty");
  assert.equal(evidence.available, false);
  assert.equal(evidence.metrics.totalWatchMs, 0);
  assert.equal(evidence.coldStart.status, "empty");
  assert.equal(evidence.coldStart.guidance[0].code, "no-watch-data");
  assertStable(evidence, "空证据");
});

test("19. 单个视频不能宣称可靠推荐", () => {
  const records = root({
    [D1]: { BV1: rec("BV1", "科技前沿", "科技", 60000) }
  });
  const evidence = Q.assessUserEvidence(records, WIN);
  assert.equal(evidence.status, "insufficient");
  assert.equal(evidence.metrics.effectiveVideoCount, 1);
  assert.equal(evidence.metrics.activeDays, 1);
  const codes = reasonCodes(evidence.coldStart.reasons);
  assert.ok(codes.includes("watch-time-below-threshold"));
  assert.equal(evidence.coldStart.guidance[0].code, "only-returning");
});

test("20. 有效观看阈值固定为 30 秒", () => {
  const records = root({
    [D1]: {
      BV1: rec("BV1", "A", "科技", 29000),
      BV2: rec("BV2", "B", "科技", 30000)
    }
  });
  const evidence = Q.assessUserEvidence(records, WIN);
  assert.equal(evidence.metrics.videoCount, 2);
  assert.equal(evidence.metrics.effectiveVideoCount, 1);
  assert.equal(evidence.metrics.effectiveWatchMs, 30000);
  assert.equal(evidence.thresholds.effectiveWatchMs, 30000);
});

test("21. 多天观看进入 limited 状态", () => {
  const records = root({
    [D1]: { BV1: rec("BV1", "科技前沿", "科技", 600000) },
    [D10]: { BV2: rec("BV2", "生活日常", "生活", 600000) }
  });
  const evidence = Q.assessUserEvidence(records, WIN);
  assert.equal(evidence.status, "limited");
  assert.equal(evidence.metrics.activeDays, 2);
  assert.equal(evidence.metrics.effectiveVideoCount, 2);
  assert.equal(evidence.coldStart.guidance[0].code, "limited-matching");
});

test("22. 同一 BV 跨天只计一个有效视频", () => {
  const records = root({
    [D1]: { BV1: rec("BV1", "科技前沿", "科技", 20000) },
    [D10]: { BV1: rec("BV1", "科技前沿", "科技", 20000) }
  });
  const evidence = Q.assessUserEvidence(records, WIN);
  assert.equal(evidence.metrics.videoCount, 1);
  assert.equal(evidence.metrics.effectiveVideoCount, 1);
  assert.equal(evidence.metrics.totalWatchMs, 40000);
});

test("23. 覆盖率边界：0 / 1 / 无数据", () => {
  const allUnknown = Q.assessUserEvidence(
    root({ [D1]: { BV1: rec("BV1", "A", "未知", 60000) } }),
    WIN
  );
  assert.equal(allUnknown.metrics.partitionCoverage.ratio, 0);
  assert.equal(allUnknown.metrics.partitionCoverage.basis, "watch-ms");

  const allIdentified = Q.assessUserEvidence(
    root({ [D1]: { BV1: rec("BV1", "A", "科技", 60000) } }),
    WIN
  );
  assert.equal(allIdentified.metrics.partitionCoverage.ratio, 1);

  const empty = Q.assessUserEvidence(root({}), WIN);
  assert.equal(empty.metrics.partitionCoverage.ratio, null);
  assert.equal(empty.metrics.titleCoverage.ratio, null);
});

test("24. 未知分区不进入衰减向量但仍计入覆盖率", () => {
  const records = root({
    [D1]: {
      BV1: rec("BV1", "科技", "科技", 60000),
      BV2: rec("BV2", "未知视频", "未知", 20000)
    }
  });
  const result = Q.buildDecayedUserPartitionVector(records, {
    ...WIN,
    decayEnabled: true,
    now: NOW
  });
  assert.deepEqual(result.dimensions, ["科技"]);
  closeTo(result.vector["科技"], 1);
  closeTo(result.coverage.unknownWeightMs, 20000 * weightAt(1));
  assert.ok(result.coverage.ratio < 1);
});

test("25. 缺失/过短标题：标题覆盖率按视频数统计，且不虚构词元", () => {
  const records = root({
    [D1]: {
      BV1: rec("BV1", "", "科技", 60000),
      BV2: rec("BV2", "猫", "生活", 60000)
    }
  });
  const evidence = Q.assessUserEvidence(records, WIN);
  // 两个视频里只有一个有标题 → 0.5；单字符标题仍算"有标题"，但产不出词元
  assert.equal(evidence.metrics.titleCoverage.ratio, 0.5);
  assert.equal(evidence.metrics.titleCoverage.basis, "video-count");

  const text = Q.buildDecayedUserTextCounts(records, {
    ...WIN,
    decayEnabled: true,
    now: NOW
  });
  assert.equal(text.status, "unavailable");
  assert.deepEqual(text.counts, {});
  assert.equal(text.sample.missingTitleCount, 1);
  assert.equal(text.sample.tokenlessVideoCount, 1);
});

test("26. 证据包含时间范围、缺失时间与身份冲突", () => {
  const records = root({
    [D1]: { BV1: rec("BV1", "科技前沿", "科技", 60000, { upUid: "1001" }) },
    [D10]: { BV1: rec("BV1", "科技前沿", "科技", 60000, { upUid: "1002" }) }
  });
  const evidence = Q.assessUserEvidence(records, WIN);
  assert.equal(evidence.metrics.timeRange.firstDateKey, D10);
  assert.equal(evidence.metrics.timeRange.lastDateKey, D1);
  assert.equal(evidence.metrics.conflictVideoCount, 1);
  assert.equal(evidence.metrics.missingTimestampRecords, 2);
});

test("27. 自定义冷启动阈值生效", () => {
  const records = root({
    [D1]: { BV1: rec("BV1", "科技前沿", "科技", 60000) }
  });
  const cold = Q.assessColdStart(records, {
    ...WIN,
    thresholds: {
      insufficientMinWatchMs: 0,
      insufficientMinActiveDays: 0,
      readyMinEffectiveVideos: 1,
      readyMinActiveDays: 1
    }
  });
  assert.equal(cold.status, "ready");
  assert.equal(cold.thresholds.readyMinEffectiveVideos, 1);
});

/* ---------------------------------------------------------------- 4. 候选可靠性 */

function mainCandidate(extra) {
  return Object.assign(
    {
      upUid: "1001",
      upName: "科技UP",
      featureStatus: "ready",
      partitionCoverage: 0.9,
      titleCoverage: 0.8,
      partitionFeatures: { partitions: [], vector: {} },
      titleFeatures: { tokens: [] }
    },
    extra || {}
  );
}

function explorationCandidate(extra) {
  return Object.assign(
    {
      upUid: "2001",
      provenance: "user-provided",
      contentStatus: "complete",
      partitionCoverage: 0.6,
      titleCoverage: 0.6,
      partitionCounts: [],
      titleTokens: []
    },
    extra || {}
  );
}

test("28. main lane 可靠性：高覆盖 + ready 才是 high", () => {
  const result = Q.assessFeatureReliability(mainCandidate(), { lane: "main" });
  assert.equal(result.status, "ok");
  assert.equal(result.lane, "main");
  assert.equal(result.provenance, "watched");
  assert.equal(result.level, "high");
  assert.equal(result.coverage.partition.basis, "watch-ms");
  assert.equal(result.coverage.title.basis, "video-count");
});

test("29. exploration lane 可靠性使用 video-count 口径", () => {
  const result = Q.assessFeatureReliability(explorationCandidate(), {
    lane: "exploration"
  });
  assert.equal(result.lane, "exploration");
  assert.equal(result.provenance, "user-provided");
  assert.equal(result.coverage.partition.basis, "video-count");
  assert.equal(result.coverage.title.basis, "video-count");
  assert.equal(result.level, "medium");
});

test("30. 探索候选没有任何在线核验", () => {
  const result = Q.assessFeatureReliability(
    explorationCandidate({ identityEvidence: { onlineVerified: true } }),
    { lane: "exploration" }
  );
  assert.equal(result.identity.onlineVerified, false);
  assert.equal(result.identity.uidVerified, false);
  assert.equal(JSON.stringify(result).includes("官方认证"), false);
  assert.equal(JSON.stringify(result).includes("已认证"), false);
});

test("31. 身份冲突阻止未来排序资格", () => {
  const result = Q.assessFeatureReliability(
    mainCandidate({ hasUidConflict: true }),
    { lane: "main" }
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.level, "unavailable");
  assert.equal(result.identity.rankingBlocked, true);
});

test("32. 高相似度不等于高可靠性", () => {
  const candidate = mainCandidate({
    partitionCoverage: 0.2,
    titleCoverage: 0.2,
    similarity: 0.99
  });
  const result = Q.assessFeatureReliability(candidate, { lane: "main" });
  assert.equal(result.level, "low");
  assert.equal(Object.prototype.hasOwnProperty.call(result, "similarity"), false);
  assertStable(result, "可靠性结果");
});

test("33. 可靠性不覆盖上游资格字段", () => {
  const candidate = mainCandidate({ eligibility: "review" });
  const result = Q.assessFeatureReliability(candidate, { lane: "main" });
  assert.equal(result.passthrough.c2Eligibility, "review");

  const exploration = Q.assessFeatureReliability(
    explorationCandidate({
      promotion: { eligibleForExploration: true }
    }),
    { lane: "exploration" }
  );
  assert.equal(exploration.passthrough.eligibleForExploration, true);
});

/* ---------------------------------------------------------------- 5. 重复曝光 */

function watchedCandidate(extra) {
  return Object.assign(
    {
      upUid: "1001",
      upName: "科技UP",
      sources: ["watched"],
      watchedBefore: true,
      lastObservedAt: NOW - 2 * DAY_MS
    },
    extra || {}
  );
}

test("34. 最近观看在窗口内 → 抑制信号", () => {
  const result = Q.assessExposureRecency(watchedCandidate(), {
    enabled: true,
    now: NOW,
    windowDays: 7
  });
  assert.equal(result.status, "ok");
  assert.equal(result.suppressed, true);
  closeTo(result.ageDays, 2);
  closeTo(result.remainingDays, 5);
  assert.equal(result.applied, false);
});

test("35. 重复曝光信号默认关闭", () => {
  const result = Q.assessExposureRecency(watchedCandidate(), { now: NOW });
  assert.equal(result.status, "disabled");
  assert.equal(result.enabled, false);
  assert.equal(result.suppressed, null);
  assert.equal(result.applied, false);
});

test("36. 导入-only 候选没有真实曝光", () => {
  const result = Q.assessExposureRecency(
    explorationCandidate({ observedAt: NOW }),
    { enabled: true, now: NOW }
  );
  assert.equal(result.status, "not-applicable");
  assert.equal(result.suppressed, null);
  assert.ok(reasonCodes(result.reasons).includes("never-watched"));
});

test("37. 缺失最近观看时间返回 unknown，不做推断", () => {
  const result = Q.assessExposureRecency(
    { upUid: "1001", sources: ["watched"] },
    { enabled: true, now: NOW }
  );
  assert.equal(result.status, "unknown");
  assert.equal(result.ageDays, null);
  assert.equal(result.suppressed, null);
});

test("38. 自定义抑制窗口与未来时间", () => {
  const outside = Q.assessExposureRecency(
    watchedCandidate({ lastObservedAt: NOW - 10 * DAY_MS }),
    { enabled: true, now: NOW, windowDays: 7 }
  );
  assert.equal(outside.status, "ok");
  assert.equal(outside.suppressed, false);

  const future = Q.assessExposureRecency(
    watchedCandidate({ lastObservedAt: NOW + DAY_MS }),
    { enabled: true, now: NOW, windowDays: 7 }
  );
  assert.equal(future.status, "unknown");
  assert.equal(future.suppressed, null);
});

test("39. 曝光信号不修改候选，也不产生相似度或排名", () => {
  const candidate = deepFreeze(watchedCandidate());
  const snapshot = JSON.stringify(candidate);
  const result = Q.assessExposureRecency(candidate, {
    enabled: true,
    now: NOW
  });
  assert.equal(JSON.stringify(candidate), snapshot);
  ["similarity", "score", "rank", "recommendations"].forEach((key) => {
    assert.equal(Object.prototype.hasOwnProperty.call(result, key), false);
  });
});

/* ---------------------------------------------------------------- 6. 稳定性与约束 */

test("40. 固定 now 下结果可复现", () => {
  const records = root({
    [D1]: { BV1: rec("BV1", "科技前沿", "科技", 60000) },
    [D20]: { BV2: rec("BV2", "生活日常", "生活", 60000) }
  });
  const first = JSON.stringify(
    Q.buildDecayedUserPartitionVector(records, {
      ...WIN,
      decayEnabled: true,
      now: NOW
    })
  );
  const second = JSON.stringify(
    Q.buildDecayedUserPartitionVector(records, {
      ...WIN,
      decayEnabled: true,
      now: NOW
    })
  );
  assert.equal(second, first);
});

test("41. 输入不可变：深度冻结仍可处理", () => {
  const records = deepFreeze(
    root({
      [D1]: { BV1: rec("BV1", "科技前沿", "科技", 60000) },
      [D10]: { BV2: rec("BV2", "生活日常", "生活", 30000) }
    })
  );
  const snapshot = JSON.stringify(records);
  Q.assessUserEvidence(records, WIN);
  Q.buildDecayedUserPartitionVector(records, { ...WIN, decayEnabled: true, now: NOW });
  Q.buildDecayedUserTextCounts(records, { ...WIN, decayEnabled: true, now: NOW });
  assert.equal(JSON.stringify(records), snapshot);

  const candidate = deepFreeze(mainCandidate());
  const candidateSnapshot = JSON.stringify(candidate);
  Q.assessFeatureReliability(candidate, { lane: "main" });
  assert.equal(JSON.stringify(candidate), candidateSnapshot);
});

test("42. 所有输出可 JSON 序列化往返", () => {
  const records = root({
    [D1]: { BV1: rec("BV1", "科技前沿", "科技", 60000) },
    [D10]: { BV2: rec("BV2", "生活日常", "生活", 30000) }
  });
  const outputs = [
    Q.computeTimeDecay(NOW - DAY_MS, { now: NOW }),
    Q.buildDecayedUserPartitionVector(records, {
      ...WIN,
      decayEnabled: true,
      now: NOW
    }),
    Q.buildDecayedUserTextCounts(records, {
      ...WIN,
      decayEnabled: true,
      now: NOW
    }),
    Q.assessUserEvidence(records, WIN),
    Q.assessColdStart(records, WIN),
    Q.assessFeatureReliability(mainCandidate(), { lane: "main" }),
    Q.assessExposureRecency(watchedCandidate(), { enabled: true, now: NOW })
  ];
  outputs.forEach((output, index) => {
    assertStable(output, `输出 ${index}`);
    const text = JSON.stringify(output);
    assert.equal(text.includes("NaN"), false);
    assert.equal(text.includes("Infinity"), false);
  });
});

test("43. 非法输入安全降级，不抛异常", () => {
  const nullRecords = Q.assessUserEvidence(null, WIN);
  assert.equal(nullRecords.status, "empty");
  assert.equal(nullRecords.available, false);

  const badCandidate = Q.assessFeatureReliability(null, {});
  assert.equal(badCandidate.status, "invalid");
  assert.equal(badCandidate.level, "unavailable");

  const badExposure = Q.assessExposureRecency(null, { enabled: true, now: NOW });
  assert.equal(badExposure.status, "invalid");

  const badNow = Q.computeTimeDecay(NOW, { now: "not-a-date" });
  assert.equal(badNow.status, "invalid-now");

  const invalidTime = Q.computeTimeDecay("not-a-date", { now: NOW });
  assert.equal(invalidTime.status, "invalid-time");
  assert.equal(invalidTime.weight, null);

  // 配置项非法值时回退默认值，但不会静默改变语义
  const evidence = Q.assessUserEvidence(root({}), {
    ...WIN,
    thresholds: { effectiveWatchMs: "x", readyMinActiveDays: -1 }
  });
  assert.equal(evidence.thresholds.effectiveWatchMs, 30000);
  assert.equal(evidence.thresholds.readyMinActiveDays, 14);
});

test("44. 无网络、无浏览器存储、无 DOM、无文件系统", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "recommend-quality.js"),
    "utf8"
  );
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  [
    "chrome.",
    "fetch(",
    "XMLHttpRequest",
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "require(",
    "process.",
    "document."
  ].forEach((token) => {
    assert.equal(stripped.includes(token), false, `模块不应引用 ${token}`);
  });
});

test("45. 不提供排序 / 综合分入口", () => {
  Object.keys(Q).forEach((name) => {
    assert.equal(
      /rank|mmr|score|topk|recommendlist/i.test(name),
      false,
      `不应导出排序相关入口：${name}`
    );
  });
  const evidence = Q.assessUserEvidence(root({}), WIN);
  ["score", "rank", "recommendations", "mmr"].forEach((key) => {
    assert.equal(Object.prototype.hasOwnProperty.call(evidence, key), false);
  });
});

test("46. 时间衰减与重复曝光是两套独立输出", () => {
  const records = root({
    [D1]: { BV1: rec("BV1", "科技前沿", "科技", 60000) }
  });
  const decayed = Q.buildDecayedUserPartitionVector(records, {
    ...WIN,
    decayEnabled: true,
    now: NOW
  });
  const exposure = Q.assessExposureRecency(watchedCandidate(), {
    enabled: true,
    now: NOW
  });
  // 衰减结果里没有任何曝光字段；曝光结果里没有任何向量字段
  ["suppressed", "exposure", "remainingDays"].forEach((key) => {
    assert.equal(Object.prototype.hasOwnProperty.call(decayed, key), false);
  });
  ["vector", "counts", "weight"].forEach((key) => {
    assert.equal(Object.prototype.hasOwnProperty.call(exposure, key), false);
  });
  assert.equal(exposure.applied, false);
});

test("47. 覆盖率口径在用户证据中显式区分", () => {
  const records = root({
    [D1]: { BV1: rec("BV1", "科技前沿", "科技", 60000) }
  });
  const evidence = Q.assessUserEvidence(records, WIN);
  assert.equal(evidence.metrics.partitionCoverage.basis, "watch-ms");
  assert.equal(evidence.metrics.titleCoverage.basis, "video-count");
  assert.equal(evidence.metrics.titleCoverage.ratio, 1);
});

/* ---------------------------------------------------------------- 输出 */

const failed = results.filter((item) => !item.ok);
results.forEach((item) => {
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}`);
  if (!item.ok) console.log(`      ${item.error && item.error.stack}`);
});
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exitCode = failed.length === 0 ? 0 : 1;
