"use strict";

/**
 * Bili Daily —— 候选质量评估（C2-2）独立测试
 * 运行：node test-candidate-quality.js
 *
 * 全部时间由 NOW 常量注入，不依赖真实当前日期。
 * 覆盖：身份证据、UID 冲突、来源合并、昵称冲突、新鲜度阈值与边界、
 * eligible / review / excluded 筛选、异常输入、不可变、可复现、序列化。
 */

const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "stats.js"));
require(path.join(__dirname, "candidate-pool.js"));

const CP = globalThis.BiliDailyCandidatePool;

/* 固定基准时间：2026-11-11T12:00:00Z。所有断言都相对它计算。 */
const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const OPTS = { now: NOW };

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

function iso(ms) {
  return new Date(ms).toISOString();
}

function rec(partial) {
  return Object.assign(
    {
      bvid: "BV1",
      page: 1,
      title: "测试视频",
      upName: "UP甲",
      upUid: null,
      partition: "科技",
      videoDuration: 600,
      watchMs: 60000,
      watchMsByHour: {},
      startedAt: iso(NOW - 3 * DAY),
      lastWatchedAt: iso(NOW - 3 * DAY),
      updatedAt: iso(NOW - 3 * DAY)
    },
    partial
  );
}

function root(days) {
  return { version: 1, days };
}

/** 一个结构完整的 watched 候选，便于直接构造时间边界。 */
function fakeCandidate(partial) {
  return Object.assign(
    {
      upUid: "1001",
      upName: "UP甲",
      sources: ["watched"],
      firstObservedAt: NOW - 3 * DAY,
      lastObservedAt: NOW - 3 * DAY,
      watchedBefore: true,
      candidateType: "returning",
      uidVerified: true,
      evidence: {
        uidFormatValid: true,
        fromWatchHistory: true,
        fromUserInput: false,
        onlineVerified: false,
        watchedVideoCount: 1,
        watchedWatchMs: 60000,
        names: ["UP甲"],
        nameSource: "watch-history",
        conflictVideoCount: 0,
        conflicts: [],
        nameConflict: false
      }
    },
    partial
  );
}

/** 同一 BV 被记录成两个 UID 的冲突池。 */
function conflictPool() {
  return CP.buildFromRecords(
    root({
      "2026-11-09": {
        BV1: rec({ bvid: "BV1", upUid: "1001", upName: "UP甲", startedAt: iso(NOW - 5 * DAY), lastWatchedAt: iso(NOW - 5 * DAY) })
      },
      "2026-11-10": {
        BV1: rec({ bvid: "BV1", upUid: "2002", upName: "UP乙", startedAt: iso(NOW - 4 * DAY), lastWatchedAt: iso(NOW - 4 * DAY) })
      }
    })
  );
}

function reasonCodes(assessment) {
  return assessment.reasons.map((reason) => reason.code);
}

/* ---------------------------------------------------------------- 身份与来源 */

test("1. 合法历史 UID：新鲜的回访候选为 eligible", () => {
  const pool = CP.buildFromRecords(
    root({ "2026-11-10": { BV1: rec({ upUid: "1001", upName: "UP甲" }) } })
  );
  const assessment = CP.assessCandidate(pool.candidates[0], OPTS);
  assert.equal(assessment.eligibility, "eligible");
  assert.deepEqual(assessment.reasons, []);
  assert.equal(assessment.identityEvidence.evidenceLevel, "watch-history");
  assert.equal(assessment.identityEvidence.fromWatchHistory, true);
  assert.equal(assessment.hasUidConflict, false);
  assert.equal(assessment.stale, false);
  assert.equal(assessment.freshness.state, "fresh");
});

test("2. 合法手动 UID：只能作为待核验候选，不伪装成历史观看 UP 主", () => {
  const pool = CP.buildFromManual([
    { upUid: "2002", upName: "UP乙", observedAt: NOW - 2 * DAY }
  ]);
  const candidate = pool.candidates[0];
  assert.equal(candidate.candidateType, "new");
  const assessment = CP.assessCandidate(candidate, OPTS);
  assert.equal(assessment.eligibility, "review", "手动来源默认需要复核，而不是直接排除");
  assert.deepEqual(reasonCodes(assessment), ["manual-unverified"]);
  assert.equal(assessment.identityEvidence.evidenceLevel, "user-input");
  assert.equal(assessment.identityEvidence.fromWatchHistory, false);
});

test("3. 非法 UID 与非对象候选被 excluded", () => {
  const badUid = CP.assessCandidate(fakeCandidate({ upUid: "abc" }), OPTS);
  assert.equal(badUid.eligibility, "excluded");
  assert.deepEqual(reasonCodes(badUid), ["invalid-uid"]);

  const notObject = CP.assessCandidate(null, OPTS);
  assert.equal(notObject.eligibility, "excluded");
  assert.deepEqual(reasonCodes(notObject), ["invalid-candidate"]);

  const empty = CP.assessCandidate({}, OPTS);
  assert.equal(empty.eligibility, "excluded");
  assert.deepEqual(reasonCodes(empty), ["invalid-uid"]);
});

test("4. 未经在线核验：onlineVerified 恒为 false，调用方声明也不采信", () => {
  const normal = CP.assessCandidate(fakeCandidate(), OPTS);
  assert.equal(normal.onlineVerified, false);
  assert.equal(normal.identityEvidence.onlineVerified, false);

  const claiming = fakeCandidate({
    evidence: Object.assign({}, fakeCandidate().evidence, { onlineVerified: true })
  });
  const assessment = CP.assessCandidate(claiming, OPTS);
  assert.equal(assessment.onlineVerified, false, "不得采信调用方自称的在线核验");

  const manual = CP.assessCandidate(CP.buildFromManual(["3003"]).candidates[0], OPTS);
  assert.equal(manual.onlineVerified, false);
});

/* ---------------------------------------------------------------- UID 冲突 */

test("5. 同一 BV 两个 UID：保留冲突证据且不猜测谁正确", () => {
  const pool = conflictPool();
  assert.equal(pool.candidates.length, 2);
  assert.equal(pool.diagnostics.uidConflictVideos, 1);

  const primary = CP.getCandidate(pool, "1001");
  const other = CP.getCandidate(pool, "2002");
  assert.equal(primary.evidence.conflictVideoCount, 1);
  assert.deepEqual(primary.evidence.conflicts, [{ otherUid: "2002", dateKey: "2026-11-10" }]);
  assert.equal(other.evidence.conflictVideoCount, 1);
  assert.deepEqual(other.evidence.conflicts, [{ otherUid: "1001", dateKey: "2026-11-09" }]);

  // 冲突与正常观看分开统计：被合并掉的那个 UID 视频数为 0
  assert.equal(primary.evidence.watchedVideoCount, 1);
  assert.equal(other.evidence.watchedVideoCount, 0);
});

test("6. 冲突候选被标记为 review，原因结构化", () => {
  const pool = conflictPool();
  pool.candidates.forEach((candidate) => {
    const assessment = CP.assessCandidate(candidate, OPTS);
    assert.equal(assessment.eligibility, "review");
    assert.equal(assessment.hasUidConflict, true);
    assert.deepEqual(reasonCodes(assessment), ["uid-conflict"]);
    assert.equal(assessment.identityEvidence.hasUidConflict, true);
    assert.equal(assessment.identityEvidence.conflictVideoCount, 1);
  });
});

test("7. 冲突候选不会静默进入正常推荐集合", () => {
  const result = CP.filterEligibleCandidates(conflictPool(), OPTS);
  assert.equal(result.eligible.length, 0);
  assert.equal(result.review.length, 2);
  assert.equal(result.excluded.length, 0);
  assert.equal(result.diagnostics.conflictCandidates, 2);
  assert.equal(result.diagnostics.reasonCounts["uid-conflict"], 2);
});

test("8. 无冲突候选正常保留为 eligible", () => {
  const pool = CP.buildFromRecords(
    root({
      "2026-11-09": { BV1: rec({ bvid: "BV1", upUid: "1001", upName: "UP甲" }) },
      "2026-11-10": { BV2: rec({ bvid: "BV2", upUid: "2002", upName: "UP乙" }) }
    })
  );
  const result = CP.filterEligibleCandidates(pool, OPTS);
  assert.equal(result.summary.total, 2);
  assert.equal(result.eligible.length, 2);
  assert.equal(result.review.length, 0);
  assert.equal(result.diagnostics.conflictCandidates, 0);
});

test("9. 同 UID 多来源合并：来源合并但观看数据不重复统计", () => {
  const watched = CP.buildFromRecords(
    root({ "2026-11-10": { BV1: rec({ upUid: "1001", upName: "UP甲" }) } })
  );
  const merged = CP.mergePools([watched, CP.buildFromManual(["1001"])]);
  const candidate = merged.candidates[0];
  assert.deepEqual(candidate.sources, ["watched", "manual"]);
  assert.equal(candidate.evidence.watchedVideoCount, 1);
  assert.equal(candidate.evidence.watchedWatchMs, 60000);
  assert.equal(candidate.evidence.nameConflict, false);

  const assessment = CP.assessCandidate(candidate, OPTS);
  assert.equal(assessment.eligibility, "eligible", "有观看证据的候选不应因手动来源被降级");
  assert.equal(assessment.identityEvidence.fromUserInput, true);
  assert.equal(assessment.identityEvidence.sourceCount, 2);
});

test("10. 手动昵称与历史昵称不一致：只提示，不覆盖 UID 身份", () => {
  const watched = CP.buildFromRecords(
    root({ "2026-11-10": { BV1: rec({ upUid: "1001", upName: "UP甲" }) } })
  );
  const merged = CP.mergePools([
    watched,
    CP.buildFromManual([{ upUid: "1001", upName: "别名", observedAt: NOW - DAY }])
  ]);
  const candidate = merged.candidates[0];
  assert.equal(candidate.upUid, "1001");
  assert.equal(candidate.upName, "UP甲", "展示昵称仍以观看记录为准");
  assert.deepEqual(candidate.evidence.names, ["UP甲", "别名"]);
  assert.equal(candidate.evidence.nameConflict, true);

  const assessment = CP.assessCandidate(candidate, OPTS);
  assert.deepEqual(reasonCodes(assessment), ["nickname-mismatch"]);
  assert.equal(assessment.reasons[0].level, "info", "昵称差异不改变身份资格");
  assert.equal(assessment.eligibility, "eligible");
});

/* ---------------------------------------------------------------- 新鲜度 */

test("11. 缺少时间字段：状态为 unknown，不能当作新鲜", () => {
  const candidate = fakeCandidate({ firstObservedAt: null, lastObservedAt: null });
  const freshness = CP.assessCandidateFreshness(candidate, OPTS);
  assert.equal(freshness.state, "unknown");
  assert.equal(freshness.ageDays, null);
  assert.equal(freshness.reason, "missing-observation-time");

  const assessment = CP.assessCandidate(candidate, OPTS);
  assert.equal(assessment.stale, false, "unknown 不等于 stale");
  assert.equal(assessment.eligibility, "review");
  assert.deepEqual(reasonCodes(assessment), ["missing-observation-time"]);
});

test("12. 90 天以内：fresh 且 eligible", () => {
  const candidate = fakeCandidate({ lastObservedAt: NOW - 89 * DAY });
  const freshness = CP.assessCandidateFreshness(candidate, OPTS);
  assert.equal(freshness.state, "fresh");
  assert.equal(freshness.ageDays, 89);
  const assessment = CP.assessCandidate(candidate, OPTS);
  assert.equal(assessment.eligibility, "eligible");
  assert.equal(assessment.stale, false);
});

test("13. 超过 90 天：stale 且进入 review，但不删除", () => {
  const candidate = fakeCandidate({ lastObservedAt: NOW - 91 * DAY });
  const freshness = CP.assessCandidateFreshness(candidate, OPTS);
  assert.equal(freshness.state, "stale");
  assert.equal(freshness.ageDays, 91);

  const pool = CP.filterEligibleCandidates({ candidates: [candidate] }, OPTS);
  assert.equal(pool.summary.total, 1, "stale 候选仍然保留在结果里");
  assert.equal(pool.review.length, 1);
  assert.equal(pool.eligible.length, 0);
  assert.deepEqual(reasonCodes(pool.review[0].assessment), ["stale-observation"]);
});

test("14. 恰好达到 90 天阈值：仍算 fresh（只有超过才算 stale）", () => {
  const candidate = fakeCandidate({ lastObservedAt: NOW - 90 * DAY });
  const freshness = CP.assessCandidateFreshness(candidate, OPTS);
  assert.equal(freshness.ageDays, 90);
  assert.equal(freshness.state, "fresh");
  assert.equal(CP.assessCandidate(candidate, OPTS).eligibility, "eligible");
});

test("15. 未来时间戳：conservative unknown，不当作新鲜", () => {
  const candidate = fakeCandidate({ lastObservedAt: NOW + DAY });
  const freshness = CP.assessCandidateFreshness(candidate, OPTS);
  assert.equal(freshness.state, "unknown");
  assert.equal(freshness.reason, "future-observation-time");
  assert.equal(CP.assessCandidate(candidate, OPTS).stale, false);
  assert.deepEqual(reasonCodes(CP.assessCandidate(candidate, OPTS)), ["future-observation-time"]);
});

test("16. 非法时间戳：unknown，不猜测", () => {
  const candidate = fakeCandidate({ lastObservedAt: "not-a-date" });
  const freshness = CP.assessCandidateFreshness(candidate, OPTS);
  assert.equal(freshness.state, "unknown");
  assert.equal(freshness.reason, "invalid-observation-time");
  assert.equal(CP.assessCandidate(candidate, OPTS).eligibility, "review");
});

test("24. stale 不等于账号注销：提示文案与保留策略", () => {
  const candidate = fakeCandidate({ lastObservedAt: NOW - 200 * DAY });
  const assessment = CP.assessCandidate(candidate, OPTS);
  assert.equal(assessment.stale, true);
  const reason = assessment.reasons.find((item) => item.code === "stale-observation");
  assert.ok(reason, "必须给出 stale-observation 原因");
  assert.match(reason.message, /不代表账号已注销/);
  assert.match(assessment.freshness.note, /不代表账号已注销/);
  assert.equal(CP.getCandidate({ candidates: [candidate] }, "1001").upUid, "1001");
});

/* ---------------------------------------------------------------- 筛选与边界 */

test("17. 空候选池：结构完整、计数为零", () => {
  [null, [], { candidates: [] }, CP.buildFromRecords(null)].forEach((pool) => {
    const result = CP.filterEligibleCandidates(pool, OPTS);
    assert.deepEqual(result.summary, { total: 0, eligible: 0, review: 0, excluded: 0 });
    assert.deepEqual(result.eligible, []);
    assert.deepEqual(result.review, []);
    assert.deepEqual(result.excluded, []);
    assert.equal(result.diagnostics.conflictCandidates, 0);
  });

  const freshness = CP.assessCandidateFreshness(null, OPTS);
  assert.equal(freshness.state, "unknown");
});

test("18. 异常候选结构：逐条 excluded，不抛异常", () => {
  const result = CP.filterEligibleCandidates(
    { candidates: [null, "x", {}, { upUid: "abc" }] },
    OPTS
  );
  assert.deepEqual(result.summary, { total: 4, eligible: 0, review: 0, excluded: 4 });
  assert.equal(result.diagnostics.malformedCandidates, 4);
  assert.equal(result.diagnostics.reasonCounts["invalid-candidate"], 2);
  assert.equal(result.diagnostics.reasonCounts["invalid-uid"], 2);
});

test("19. 结果可 JSON 序列化并往返一致", () => {
  const pool = CP.mergePools([
    conflictPool(),
    CP.buildFromManual([{ upUid: "3003", observedAt: NOW - 2 * DAY }])
  ]);
  const result = CP.filterEligibleCandidates(pool, OPTS);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("20. 原始输入不被修改", () => {
  const pool = CP.mergePools([
    conflictPool(),
    CP.buildFromManual([{ upUid: "3003", observedAt: NOW - 2 * DAY }])
  ]);
  deepFreeze(pool);
  const snapshot = JSON.stringify(pool);
  CP.filterEligibleCandidates(pool, OPTS);
  assert.equal(JSON.stringify(pool), snapshot);
});

test("21. 结果顺序稳定且与池内顺序一致", () => {
  const pool = CP.mergePools([
    CP.buildFromRecords(
      root({
        "2026-11-09": { BV1: rec({ bvid: "BV1", upUid: "1001", upName: "UP甲" }) },
        "2026-10-01": {
          BV2: rec({
            bvid: "BV2",
            upUid: "2002",
            upName: "UP乙",
            startedAt: iso(NOW - 100 * DAY),
            lastWatchedAt: iso(NOW - 100 * DAY)
          })
        }
      })
    ),
    CP.buildFromManual([{ upUid: "3003", observedAt: NOW - 2 * DAY }])
  ]);

  const first = CP.filterEligibleCandidates(pool, OPTS);
  const second = CP.filterEligibleCandidates(pool, OPTS);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.eligible.map((entry) => entry.candidate.upUid),
    ["1001"]
  );
  assert.deepEqual(
    first.review.map((entry) => entry.candidate.upUid),
    ["2002", "3003"]
  );
});

test("22. returning 候选：有观看历史且新鲜 → eligible", () => {
  const candidate = fakeCandidate();
  const assessment = CP.assessCandidate(candidate, OPTS);
  assert.equal(candidate.candidateType, "returning");
  assert.equal(assessment.eligibility, "eligible");
  assert.equal(assessment.identityEvidence.fromWatchHistory, true);
  assert.equal(assessment.identityEvidence.fromUserInput, false);
});

test("23. new 候选：未被直接排除，进入 review 待核验", () => {
  const candidate = CP.buildFromManual([
    { upUid: "4004", upName: "新UP", observedAt: NOW - DAY }
  ]).candidates[0];
  assert.equal(candidate.candidateType, "new");
  const assessment = CP.assessCandidate(candidate, OPTS);
  assert.equal(assessment.eligibility, "review");
  assert.notEqual(assessment.eligibility, "excluded");
});

test("25. 筛选数量与诊断结果一致", () => {
  const pool = CP.mergePools([
    conflictPool(),
    CP.buildFromManual([{ upUid: "3003", observedAt: NOW - 2 * DAY }])
  ]);
  const result = CP.filterEligibleCandidates(pool, OPTS);
  assert.equal(result.summary.total, pool.candidates.length);
  assert.equal(result.summary.eligible, result.eligible.length);
  assert.equal(result.summary.review, result.review.length);
  assert.equal(result.summary.excluded, result.excluded.length);
  assert.equal(
    result.summary.total,
    result.summary.eligible + result.summary.review + result.summary.excluded
  );
  assert.equal(result.diagnostics.conflictCandidates, 2);
  assert.equal(result.diagnostics.manualOnlyCandidates, 1);
  assert.equal(result.diagnostics.onlineVerified, 0);
});

test("26. 冲突证据与普通来源证据分开记录", () => {
  const pool = CP.mergePools([
    conflictPool(),
    CP.buildFromManual([{ upUid: "3003", observedAt: NOW - 2 * DAY }])
  ]);
  const result = CP.filterEligibleCandidates(pool, OPTS);

  const conflicted = result.review.find((entry) => entry.candidate.upUid === "1001");
  const manual = result.review.find((entry) => entry.candidate.upUid === "3003");
  assert.deepEqual(reasonCodes(conflicted.assessment), ["uid-conflict"]);
  assert.deepEqual(reasonCodes(manual.assessment), ["manual-unverified"]);
  assert.equal(result.diagnostics.reasonCounts["uid-conflict"], 2);
  assert.equal(result.diagnostics.reasonCounts["manual-unverified"], 1);
});

test("27. 过期阈值可配置，默认 90 天", () => {
  assert.equal(CP.DEFAULT_STALE_DAYS, 90);
  const candidate = fakeCandidate({ lastObservedAt: NOW - 10 * DAY });
  assert.equal(CP.assessCandidateFreshness(candidate, { now: NOW }).state, "fresh");
  assert.equal(
    CP.assessCandidateFreshness(candidate, { now: NOW, staleDays: 7 }).state,
    "stale"
  );
  assert.equal(
    CP.assessCandidateFreshness(candidate, { now: NOW, staleDays: 7 }).thresholdDays,
    7
  );
});

test("28. 重复合并同一冲突池不会把冲突证据翻倍", () => {
  const once = conflictPool();
  const twice = CP.mergePools([once, once]);
  const candidate = CP.getCandidate(twice, "1001");
  assert.equal(candidate.evidence.conflictVideoCount, 1);
  assert.equal(candidate.evidence.conflicts.length, 1);
});

/* ---------------------------------------------------------------- 输出 */

const failed = results.filter((item) => !item.ok);
results.forEach((item) => {
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}`);
  if (!item.ok) console.log(`      ${item.error && item.error.message}`);
});
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exitCode = failed.length === 0 ? 0 : 1;
