"use strict";

/**
 * Bili Daily —— 自动发现与既有推荐引擎的集成测试
 * 运行：node test-auto-discovery-integration.js
 *
 * 覆盖：page-observed 候选独立进入探索、与手动导入同 UID 去重、
 * 已观看 UP 仍走 main、分区缺失降级、理由/来源一致、服务视图状态、
 * 空状态、稳定排序、不修改输入、不新增网络调用。
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
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
require(path.join(__dirname, "discovered-candidate-store.js"));
require(path.join(__dirname, "recommend-service.js"));

const CP = globalThis.BiliDailyCandidatePool;
const CF = globalThis.BiliDailyCandidateFeatures;
const CI = globalThis.BiliDailyCandidateContentImport;
const Rank = globalThis.BiliDailyRecommendRank;
const Discovered = globalThis.BiliDailyDiscoveredCandidateStore;
const Service = globalThis.BiliDailyRecommendService;

const NOW = new Date(2026, 10, 12, 12, 0, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;
const D_READY = "2026-11-11";
const D_PREV = "2026-11-10";

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

function bvid(index) {
  return `BV1${String(index).padStart(9, "0")}`;
}

function rec(bv, upUid, upName, title, partition, watchMs, dateKey) {
  const parts = dateKey.split("-").map(Number);
  const iso = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0).toISOString();
  return {
    bvid: bv,
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
        [bvid(6)]: rec(bvid(6), "1004", "知识UP", "历史知识科普", "知识", 600000, D_PREV),
        [bvid(7)]: rec(bvid(7), "1004", "知识UP", "地理知识讲解", "知识", 600000, D_PREV)
      },
      [D_READY]: {
        [bvid(1)]: rec(bvid(1), "1001", "科技UP", "科技前沿教程", "科技", 600000, D_READY),
        [bvid(2)]: rec(bvid(2), "1001", "科技UP", "数码评测入门", "科技", 300000, D_READY),
        [bvid(3)]: rec(bvid(3), "1002", "生活UP", "生活日常记录", "生活", 300000, D_READY),
        [bvid(4)]: rec(bvid(4), "1003", "编程UP", "编程入门课程", "科技", 300000, D_READY),
        [bvid(5)]: rec(bvid(5), "1003", "编程UP", "算法基础讲解", "科技", 300000, D_READY)
      }
    }
  };
}

function discoveryObservation(index, options) {
  const opts = options || {};
  return {
    upUid: opts.upUid || "3001",
    upName: opts.upName || "页面观察UP",
    bvid: bvid(100 + index),
    title: opts.title == null ? `科技前沿教程 ${index}` : opts.title,
    partition: opts.partition == null ? "科技" : opts.partition,
    observedAt: new Date(NOW - DAY).toISOString(),
    sourcePageBvid: bvid(900 + index),
    provenance: "page-observed",
    observationScope: "related-recommendation-card"
  };
}

function buildDiscovery(options) {
  const opts = options || {};
  const observations =
    opts.observations ||
    [1, 2, 3].map((index) => discoveryObservation(index, opts));
  const store = {
    version: Discovered.STORE_VERSION,
    kind: Discovered.STORE_KIND,
    updatedAt: new Date(NOW).toISOString(),
    observations
  };
  const settings = Discovered.normalizeSettings(
    Object.assign({ enabled: true }, opts.settings || {})
  );
  return Discovered.buildDiscoveredEvidence(
    store,
    opts.records || readyRecords(),
    { now: NOW, settings }
  );
}

function importSidecar(candidates) {
  const parsed = CI.parseCandidateContentImport({
    schemaVersion: 1,
    kind: "bili-daily-candidate-content-import",
    provenance: "user-provided",
    userConfirmed: true,
    candidates
  });
  assert.equal(parsed.status, "ok");
  return CI.buildCandidateContentEvidence(parsed, { now: NOW });
}

function manualCandidate(upUid, upName) {
  return {
    upUid,
    upName,
    observedAt: new Date(NOW - 2 * DAY).toISOString(),
    videos: [
      { bvid: bvid(201), title: "科技前沿教程", partition: "科技" },
      { bvid: bvid(202), title: "数码评测入门", partition: "科技" },
      { bvid: bvid(203), title: "编程基础讲解", partition: "科技" }
    ]
  };
}

function rankInput(records, extra) {
  const pool = CP.buildFromRecords(records);
  const features = CF.buildCandidateFeatures(records, pool, {
    thresholds: { minObservedVideos: 1, minObservedWatchMs: 0 }
  });
  return Object.assign({ records, pool, features, sidecar: null }, extra || {});
}

function rank(records, extra, options) {
  return Rank.buildRecommendations(
    rankInput(records, extra),
    Object.assign(
      {
        now: NOW,
        endDate: D_READY,
        K: 5,
        explorationQuota: 1,
        windowDays: 30,
        decay: { enabled: true, halfLifeDays: 14 }
      },
      options || {}
    )
  );
}

function cardFor(result, upUid) {
  return result.recommendations.find((item) => item.upUid === upUid) || null;
}

/* ---------------------------------------------------------------- 排序层 */

test("1. 没有手动导入时，page-observed 候选也能独立进入探索通道", () => {
  const evidence = buildDiscovery();
  const result = rank(readyRecords(), {
    discovery: { sidecar: evidence.sidecar, assessment: evidence.assessment }
  });
  assert.equal(result.mode, "similarity");
  const card = cardFor(result, "3001");
  assert.ok(card, "自动发现候选应被推荐");
  assert.equal(card.lane, "exploration");
  assert.equal(card.provenance, "page-observed");
  assert.equal(card.onlineVerified, false);
});

test("2. 自动发现候选的置信度被压到 low，并标记跨口径近似", () => {
  const evidence = buildDiscovery();
  const result = rank(readyRecords(), {
    discovery: { sidecar: evidence.sidecar, assessment: evidence.assessment }
  });
  const card = cardFor(result, "3001");
  assert.equal(card.confidence, "low");
  assert.equal(card.similarity.approximate, true);
  assert.equal(card.reliability.onlineVerified, false);

  const reliability = globalThis.BiliDailyRecommendQuality.assessFeatureReliability(
    evidence.sidecar.candidates[0],
    { lane: "exploration" }
  );
  assert.equal(reliability.provenance, "page-observed");
  assert.equal(reliability.identity.onlineVerified, false);
});

test("3. 推荐理由明确写成页面观察，不声称官方认证", () => {
  const evidence = buildDiscovery();
  const result = rank(readyRecords(), {
    discovery: { sidecar: evidence.sidecar, assessment: evidence.assessment }
  });
  const card = cardFor(result, "3001");
  const reason = card.reasons.find((item) => item.code === "page-observed");
  assert.ok(reason);
  assert.ok(reason.message.includes("相关推荐"));
  assert.ok(reason.message.includes("不代表账号经过平台验证"));
  assert.equal(/官方认证|平台认证通过|已核验/.test(reason.message), false);
});

test("4. 已观看 UP 主仍走 main，不会被自动发现重复推荐", () => {
  const observations = [1, 2, 3].map((index) =>
    discoveryObservation(index, { upUid: "1001", upName: "科技UP" })
  );
  const evidence = buildDiscovery({ observations });
  assert.equal(evidence.sidecar.candidates.length, 0);
  assert.equal(evidence.summary.watchedUpExcluded, 1);
  const result = rank(readyRecords(), {
    discovery: { sidecar: evidence.sidecar, assessment: evidence.assessment }
  });
  const cards = result.recommendations.filter((item) => item.upUid === "1001");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].lane, "main");
  assert.equal(cards[0].provenance, "watched");
});

test("5. 同一 UID 同时来自手动导入和页面观察时只保留一条，手动导入优先", () => {
  const sidecar = importSidecar([manualCandidate("3005", "重叠UP")]);
  const evidence = buildDiscovery({
    observations: [1, 2, 3].map((index) =>
      discoveryObservation(index, { upUid: "3005", upName: "重叠UP" })
    )
  });
  const result = rank(readyRecords(), {
    sidecar,
    discovery: { sidecar: evidence.sidecar, assessment: evidence.assessment }
  });
  const cards = result.recommendations.filter((item) => item.upUid === "3005");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].provenance, "user-provided");
  assert.ok(cards[0].reasons.some((item) => item.code === "user-imported"));
});

test("6. 手动导入在没有自动发现时保持原行为", () => {
  const sidecar = importSidecar([manualCandidate("3006", "手动UP")]);
  const result = rank(readyRecords(), { sidecar });
  const card = cardFor(result, "3006");
  assert.ok(card);
  assert.equal(card.provenance, "user-provided");
  assert.ok(card.reasons.some((item) => item.code === "user-imported"));
});

test("7. 自动发现候选不足 3 个视频时不会出现在推荐中，并给出真实空原因", () => {
  const observations = [1, 2].map((index) => discoveryObservation(index));
  const evidence = buildDiscovery({ observations });
  const result = rank(readyRecords(), {
    discovery: { sidecar: evidence.sidecar, assessment: evidence.assessment }
  });
  assert.equal(cardFor(result, "3001"), null);
  assert.ok(result.reasons.some((item) => item.code === "no-eligible-discovered"));
});

test("8. 页面缺少分区时按标题做低可信探索，不伪造分区", () => {
  const observations = [1, 2, 3].map((index) =>
    discoveryObservation(index, { partition: "" })
  );
  const evidence = buildDiscovery({ observations });
  const sidecar = evidence.sidecar.candidates[0];
  assert.equal(sidecar.partitionCounts.length, 0);

  const result = rank(readyRecords(), {
    discovery: { sidecar: evidence.sidecar, assessment: evidence.assessment }
  });
  const card = cardFor(result, "3001");
  assert.ok(card);
  assert.equal(card.confidence, "low");
  assert.equal(card.similarity.basis, "video-count");
  assert.equal(card.similarity.partition, null);
  const reason = card.reasons.find((item) => item.code === "partition-match");
  assert.equal(reason, undefined);
});

test("9. 探索配额为 0 时自动发现不占用名额", () => {
  const evidence = buildDiscovery();
  const result = rank(
    readyRecords(),
    { discovery: { sidecar: evidence.sidecar, assessment: evidence.assessment } },
    { explorationQuota: 0 }
  );
  assert.equal(cardFor(result, "3001"), null);
  assert.equal(result.recommendations.every((item) => item.lane === "main"), true);
});

test("10. 相同输入重复排序结果稳定，不修改输入", () => {
  const records = deepFreeze(readyRecords());
  const evidence = buildDiscovery();
  const input = Object.freeze({
    sidecar: null,
    discovery: Object.freeze({
      sidecar: deepFreeze(evidence.sidecar),
      assessment: deepFreeze(evidence.assessment)
    })
  });
  const first = rank(records, input);
  const second = rank(records, input);
  assert.deepEqual(first, second);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
});

test("11. 输出理由与来源使用同一 page-observed 标记", () => {
  const evidence = buildDiscovery();
  const result = rank(readyRecords(), {
    discovery: { sidecar: evidence.sidecar, assessment: evidence.assessment }
  });
  const card = cardFor(result, "3001");
  const reason = card.reasons.find((item) => item.code === "page-observed");
  assert.equal(reason.evidence.provenance, "page-observed");
  assert.equal(reason.evidence.observedVideoCount, 3);
  assert.equal(reason.evidence.onlineVerified, false);
});

/* ---------------------------------------------------------------- 服务层 */

function runService(options) {
  const opts = options || {};
  return Service.buildView({
    records: opts.records || readyRecords(),
    store: opts.store || null,
    discoveredStore: opts.discoveredStore,
    discoverySettings: opts.discoverySettings,
    now: NOW,
    endDate: D_READY,
    options: { K: 5, explorationQuota: 1 }
  });
}

function discoveryStore(observations) {
  return {
    version: Discovered.STORE_VERSION,
    kind: Discovered.STORE_KIND,
    updatedAt: new Date(NOW).toISOString(),
    observations
  };
}

test("12. buildView 在关闭状态下显示 disabled，且不使用演示候选", () => {
  const view = runService({
    discoveredStore: discoveryStore([]),
    discoverySettings: { enabled: false }
  });
  assert.equal(view.ok, true);
  assert.equal(view.discovery.status, "disabled");
  assert.equal(view.discovery.counts.discovered, 0);
});

test("13. buildView 在开启但无观察时显示 enabled", () => {
  const view = runService({
    discoveredStore: discoveryStore([]),
    discoverySettings: { enabled: true }
  });
  assert.equal(view.discovery.status, "enabled");
  assert.equal(view.discovery.counts.recommendable, 0);
});

test("14. buildView 在观察不足时显示 insufficient 与真实数量", () => {
  const view = runService({
    discoveredStore: discoveryStore([discoveryObservation(1), discoveryObservation(2)]),
    discoverySettings: { enabled: true }
  });
  assert.equal(view.discovery.status, "insufficient");
  assert.equal(view.discovery.counts.discovered, 1);
  assert.equal(view.discovery.counts.insufficient, 1);
});

test("15. buildView 在候选可推荐时显示 has-candidates 并生成页面来源卡片", () => {
  const view = runService({
    discoveredStore: discoveryStore([1, 2, 3].map((index) => discoveryObservation(index))),
    discoverySettings: { enabled: true }
  });
  assert.equal(view.discovery.status, "has-candidates");
  assert.equal(view.discovery.counts.discovered, 1);
  assert.equal(view.discovery.counts.recommendable, 1);
  const card = view.recommendations.find((item) => item.upUid === "3001");
  assert.ok(card);
  assert.equal(card.provenance, "page-observed");
  assert.ok(card.provenanceLabel.includes("页面相关推荐发现"));
  assert.equal(card.lane, "exploration");
});

test("16. 关闭开关后已积累候选仍可推荐，但状态明确为关闭", () => {
  const view = runService({
    discoveredStore: discoveryStore([1, 2, 3].map((index) => discoveryObservation(index))),
    discoverySettings: { enabled: false }
  });
  assert.equal(view.discovery.status, "disabled");
  assert.ok(view.recommendations.some((item) => item.upUid === "3001"));
});

test("17. 重复打开弹窗（重复 buildView）不改变存储输入，也不产生额外候选", () => {
  const store = deepFreeze(
    discoveryStore([1, 2, 3].map((index) => discoveryObservation(index)))
  );
  const settings = deepFreeze({ enabled: true });
  const first = runService({ discoveredStore: store, discoverySettings: settings });
  const second = runService({ discoveredStore: store, discoverySettings: settings });
  assert.deepEqual(first, second);
  assert.equal(first.recommendations.filter((item) => item.upUid === "3001").length, 1);
});

test("18. 恶意额外字段不会出现在服务视图或推荐理由里", () => {
  const observations = [1, 2, 3].map((index) =>
    Object.assign(discoveryObservation(index), {
      innerHTML: "<img src=x onerror=alert(1)>",
      cookie: "SESSDATA=secret",
      script: "alert(1)"
    })
  );
  const view = runService({
    discoveredStore: discoveryStore(observations),
    discoverySettings: { enabled: true }
  });
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes("SESSDATA"), false);
  assert.equal(serialized.includes("onerror"), false);
  const card = view.recommendations.find((item) => item.upUid === "3001");
  assert.ok(card);
});

test("19. 没有发现候选时保留 main 推荐，不制造虚假探索结果", () => {
  const view = runService({
    discoveredStore: discoveryStore([]),
    discoverySettings: { enabled: true }
  });
  assert.ok(view.recommendations.some((item) => item.lane === "main"));
  assert.equal(view.recommendations.some((item) => item.provenance === "page-observed"), false);
});

test("20. 服务层不发起网络请求，也不使用运行时消息或 Cookie", () => {
  [
    "recommend-service.js",
    "recommend-rank.js",
    "discovered-candidate-store.js",
    "candidate-discovery.js",
    "popup.js"
  ].forEach((file) => {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    assert.equal(/\bfetch\s*\(/.test(source), false, `${file} fetch`);
    assert.equal(/XMLHttpRequest/.test(source), false, `${file} XHR`);
    assert.equal(/WebSocket/.test(source), false, `${file} WebSocket`);
    assert.equal(/chrome\.runtime\.sendMessage/.test(source), false, `${file} sendMessage`);
    assert.equal(/chrome\.cookies/.test(source), false, `${file} cookies`);
    assert.equal(/document\.cookie/.test(source), false, `${file} document.cookie`);
  });
});

test("21. 跨来源同 UID 去重后总候选数量不重复计数", () => {
  const sidecar = importSidecar([manualCandidate("3005", "重叠UP")]);
  const evidence = buildDiscovery({
    observations: [1, 2, 3].map((index) =>
      discoveryObservation(index, { upUid: "3005", upName: "重叠UP" })
    )
  });
  const result = rank(readyRecords(), {
    sidecar,
    discovery: { sidecar: evidence.sidecar, assessment: evidence.assessment }
  });
  assert.equal(result.recommendations.filter((item) => item.upUid === "3005").length, 1);
});

test("22. 页面观察到已观看但导入的 UID 冲突时不会覆盖观看来源", () => {
  const sidecar = importSidecar([manualCandidate("1001", "科技UP")]);
  const evidence = buildDiscovery({
    observations: [1, 2, 3].map((index) =>
      discoveryObservation(index, { upUid: "1001", upName: "科技UP" })
    )
  });
  const result = rank(readyRecords(), {
    sidecar,
    discovery: { sidecar: evidence.sidecar, assessment: evidence.assessment }
  });
  const cards = result.recommendations.filter((item) => item.upUid === "1001");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].lane, "main");
});

/* ---------------------------------------------------------------- 汇总 */

const failed = results.filter((item) => !item.ok);
results.forEach((item) => {
  if (item.ok) console.log(`PASS ${item.name}`);
  else {
    console.log(`FAIL ${item.name}`);
    console.log(item.error && item.error.stack ? item.error.stack : String(item.error));
  }
});
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) process.exitCode = 1;
