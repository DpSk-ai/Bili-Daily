"use strict";

/**
 * Bili Daily —— 候选 UP 主内容特征（C2-3）独立测试
 * 运行：node test-candidate-features.js
 *
 * 覆盖：分区时长加权 / 归一化 / 覆盖率、标题 bigram / 清洗 / 覆盖率、
 * BV 去重与跨天 / 分 P 合并、UID 归属、UID 冲突隔离、新候选无特征、
 * ready / partial / missing、异常输入、不可变、JSON 往返、稳定排序与上限。
 *
 * 全部使用内存模拟数据，不读写 chrome.storage.local，不联网。
 */

const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "stats.js"));
require(path.join(__dirname, "candidate-pool.js"));
require(path.join(__dirname, "candidate-features.js"));

const CF = globalThis.BiliDailyCandidateFeatures;
const CP = globalThis.BiliDailyCandidatePool;

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const DAY1 = "2026-11-09";
const DAY2 = "2026-11-10";

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
      title: "科技数码",
      upName: "UP甲",
      upUid: "1001",
      partition: "科技",
      videoDuration: 600,
      watchMs: 60000,
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

function build(days, pool, options) {
  const records = root(days);
  return CF.buildCandidateFeatures(records, pool || CP.buildFromRecords(records), options);
}

function featureOf(result, uid) {
  const feature = result.candidates.find((item) => item.upUid === uid);
  assert.ok(feature, `缺少 UID ${uid} 的特征`);
  return feature;
}

function tokenCounts(feature) {
  const map = {};
  feature.titleFeatures.tokens.forEach((item) => {
    map[item.token] = item.count;
  });
  return map;
}

function tokenDocs(feature) {
  const map = {};
  feature.titleFeatures.tokens.forEach((item) => {
    map[item.token] = item.documentCount;
  });
  return map;
}

function partitionNames(feature) {
  return feature.partitionFeatures.partitions.map((item) => item.name);
}

function reasonCodes(feature) {
  return feature.featureReasons.map((item) => item.code);
}

function approx(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${message || "数值不匹配"}：实际 ${actual}，期望 ${expected}`
  );
}

/* ---------------------------------------------------------------- 基础特征 */

test("1. 单 UID 单视频：分区、标题与基础计数", () => {
  const result = build({ [DAY1]: { BV1: rec({ upUid: "1001" }) } });
  const feature = featureOf(result, "1001");
  assert.equal(feature.observedVideoCount, 1);
  assert.equal(feature.observedWatchMs, 60000);
  assert.equal(feature.featureVideoCount, 1);
  assert.equal(feature.partitionCoverage, 1);
  assert.equal(feature.titleCoverage, 1);
  assert.deepEqual(partitionNames(feature), ["科技"]);
  assert.equal(feature.partitionFeatures.partitions[0].watchMs, 60000);
  assert.equal(feature.partitionFeatures.partitions[0].shareOfIdentified, 1);
  assert.equal(feature.partitionFeatures.partitions[0].shareOfAll, 1);
  assert.equal(feature.partitionFeatures.vector["科技"], 1);
  assert.equal(feature.titleFeatures.tokens.length, 3);
  assert.equal(tokenCounts(feature)["科技"], 1);
  assert.equal(tokenCounts(feature)["技数"], 1);
  assert.equal(tokenCounts(feature)["数码"], 1);
  assert.equal(feature.featureStatus, "partial");
  assert.deepEqual(reasonCodes(feature), ["insufficient-videos", "insufficient-watch-time"]);
});

test("2. 单 UID 多视频：满足最低样本后为 ready", () => {
  const result = build({
    [DAY1]: { BV1: rec({ bvid: "BV1", title: "科技前沿", partition: "科技", watchMs: 200000 }) },
    [DAY2]: { BV2: rec({ bvid: "BV2", title: "生活日常", partition: "生活", watchMs: 200000 }) }
  });
  const feature = featureOf(result, "1001");
  assert.equal(feature.observedVideoCount, 2);
  assert.equal(feature.observedWatchMs, 400000);
  assert.equal(feature.featureVideoCount, 2);
  assert.equal(feature.partitionCoverage, 1);
  assert.equal(feature.titleCoverage, 1);
  assert.equal(feature.featureStatus, "ready");
  assert.deepEqual(feature.featureReasons, []);
  assert.equal(result.summary.ready, 1);
  assert.equal(result.summary.partial, 0);
  assert.equal(result.summary.missing, 0);
});

test("3. 分区时长加权：以真实 watchMs 为基础", () => {
  const result = build({
    [DAY1]: {
      BV1: rec({ bvid: "BV1", partition: "科技", watchMs: 30000 }),
      BV2: rec({ bvid: "BV2", partition: "生活", watchMs: 10000 }),
      BV3: rec({ bvid: "BV3", partition: "科技", watchMs: 10000 })
    }
  });
  const feature = featureOf(result, "1001");
  const tech = feature.partitionFeatures.partitions.find((item) => item.name === "科技");
  const life = feature.partitionFeatures.partitions.find((item) => item.name === "生活");
  assert.equal(tech.watchMs, 40000);
  assert.equal(tech.videoCount, 2);
  assert.equal(life.watchMs, 10000);
  assert.equal(life.videoCount, 1);
  approx(tech.shareOfIdentified, 0.8);
  approx(life.shareOfIdentified, 0.2);
  approx(feature.partitionFeatures.identifiedWatchMs, 50000);
  assert.equal(feature.observedWatchMs, 50000);
});

test("4. 分区占比归一化：已识别分区内部占比之和为 1", () => {
  const result = build({
    [DAY1]: {
      BV1: rec({ bvid: "BV1", partition: "科技", watchMs: 30000 }),
      BV2: rec({ bvid: "BV2", partition: "生活", watchMs: 20000 }),
      BV3: rec({ bvid: "BV3", partition: "游戏", watchMs: 10000 })
    }
  });
  const feature = featureOf(result, "1001");
  const sumIdentified = feature.partitionFeatures.partitions.reduce(
    (sum, item) => sum + item.shareOfIdentified,
    0
  );
  const sumAll = feature.partitionFeatures.partitions.reduce(
    (sum, item) => sum + item.shareOfAll,
    0
  );
  approx(sumIdentified, 1, "已识别分区内部占比");
  approx(sumAll, 1, "占全部观看时长比例");
  approx(feature.partitionFeatures.vector["科技"], 0.5);
  assert.equal(feature.partitionFeatures.unknown, null);
});

/* ---------------------------------------------------------------- 分区缺失 */

test("5. 缺失分区：归入未知桶，观看时长不丢弃", () => {
  const result = build({
    [DAY1]: {
      BV1: rec({ bvid: "BV1", partition: "", title: "科技数码", watchMs: 60000 }),
      BV2: rec({ bvid: "BV2", partition: "科技", title: "生活日常", watchMs: 60000 })
    }
  });
  const feature = featureOf(result, "1001");
  assert.equal(feature.observedVideoCount, 2);
  assert.equal(feature.observedWatchMs, 120000);
  assert.equal(feature.partitionFeatures.identifiedWatchMs, 60000);
  assert.equal(feature.partitionFeatures.unknownWatchMs, 60000);
  assert.equal(feature.missingPartitionCount, 1);
  assert.equal(feature.partitionFeatures.unknown.videoCount, 1);
  assert.equal(feature.partitionFeatures.unknown.name, "未知");
  approx(feature.partitionFeatures.unknown.shareOfAll, 0.5);
  approx(feature.partitionCoverage, 0.5);
  assert.equal("未知" in feature.partitionFeatures.vector, false);
});

test("6. 字面「未知」分区：与缺失分区同样按未识别处理", () => {
  const result = build({
    [DAY1]: {
      BV1: rec({ bvid: "BV1", partition: "未知", watchMs: 30000 }),
      BV2: rec({ bvid: "BV2", partition: "科技", watchMs: 60000 })
    }
  });
  const feature = featureOf(result, "1001");
  assert.equal(feature.missingPartitionCount, 1);
  assert.equal(feature.partitionFeatures.unknownWatchMs, 30000);
  approx(feature.partitionCoverage, 2 / 3);
});

test("7. 分区覆盖率：按观看时长计算，分母包含未知分区", () => {
  const result = build({
    [DAY1]: {
      BV1: rec({ bvid: "BV1", partition: "科技", watchMs: 30000 }),
      BV2: rec({ bvid: "BV2", partition: "", watchMs: 60000 })
    }
  });
  const feature = featureOf(result, "1001");
  approx(feature.partitionCoverage, 1 / 3);
  assert.equal(feature.partitionCoverageState, "available");
  assert.equal(feature.partitionCoverageBasis, "watch-ms");
});

/* ---------------------------------------------------------------- 标题特征 */

test("8. 中文标题 bigram：相邻双字符", () => {
  assert.deepEqual(CF.extractTitleBigrams("科技数码"), ["科技", "技数", "数码"]);
});

test("9. 中英文数字混合标题：NFKC + 小写 + 连续段 bigram", () => {
  assert.deepEqual(
    CF.extractTitleBigrams("AI科技2026"),
    ["ai", "i科", "科技", "技2", "20", "02", "26"]
  );
  assert.deepEqual(CF.extractTitleBigrams("ＡＩ科技"), ["ai", "i科", "科技"]);
});

test("10. 标点和空白不跨段拼接词元", () => {
  assert.deepEqual(CF.extractTitleBigrams("科技 数码！生活"), ["科技", "数码", "生活"]);
  assert.deepEqual(CF.extractTitleBigrams("科技，数码"), ["科技", "数码"]);
  const tokens = CF.extractTitleBigrams("科技 数码");
  assert.equal(tokens.includes("技数"), false);
});

test("11. 重复词元：词频累计，文档数只算一次", () => {
  const result = build({
    [DAY1]: { BV1: rec({ title: "科技科技", watchMs: 60000 }) }
  });
  const feature = featureOf(result, "1001");
  assert.equal(tokenCounts(feature)["科技"], 2);
  assert.equal(tokenCounts(feature)["技科"], 1);
  assert.equal(tokenDocs(feature)["科技"], 1);
  assert.equal(feature.titleFeatures.documentCount, 1);
});

test("12. 缺失标题：不虚构文本特征，覆盖率为 0", () => {
  const result = build({
    [DAY1]: { BV1: rec({ title: "", watchMs: 60000 }) }
  });
  const feature = featureOf(result, "1001");
  assert.equal(feature.missingTitleCount, 1);
  assert.equal(feature.titleFeatures.tokens.length, 0);
  assert.equal(feature.titleFeatures.documentCount, 0);
  assert.equal(feature.titleCoverage, 0);
  assert.equal(feature.titleCoverageState, "available");
  assert.equal(feature.featureStatus, "partial");
  assert.ok(reasonCodes(feature).includes("title-coverage-low"));
});

test("13. 标题覆盖率：有效标题文档数 / 参与统计视频数", () => {
  const result = build({
    [DAY1]: {
      BV1: rec({ bvid: "BV1", title: "", watchMs: 60000 }),
      BV2: rec({ bvid: "BV2", title: "生活日常", watchMs: 60000 })
    }
  });
  const feature = featureOf(result, "1001");
  assert.equal(feature.titleFeatures.documentCount, 1);
  assert.equal(feature.missingTitleCount, 1);
  approx(feature.titleCoverage, 0.5);
  assert.equal(feature.titleCoverageBasis, "video-count");
});

/* ---------------------------------------------------------------- BV 合并 */

test("14. 同 BV 同日重复：只算一个视频，时长累加，词元不重复计数", () => {
  const result = build({
    [DAY1]: {
      k1: rec({ bvid: "BV1", watchMs: 30000 }),
      k2: rec({ bvid: "BV1", watchMs: 40000 })
    }
  });
  const feature = featureOf(result, "1001");
  assert.equal(feature.observedVideoCount, 1);
  assert.equal(feature.observedWatchMs, 70000);
  assert.equal(feature.partitionFeatures.partitions[0].watchMs, 70000);
  assert.equal(feature.partitionFeatures.partitions[0].videoCount, 1);
  assert.equal(feature.titleFeatures.documentCount, 1);
  assert.equal(tokenCounts(feature)["科技"], 1);
});

test("15. 同 BV 跨天：合并为一个视频，观看时长累加", () => {
  const result = build({
    [DAY1]: { BV1: rec({ bvid: "BV1", watchMs: 30000 }) },
    [DAY2]: { BV1: rec({ bvid: "BV1", watchMs: 20000 }) }
  });
  const feature = featureOf(result, "1001");
  assert.equal(feature.observedVideoCount, 1);
  assert.equal(feature.observedWatchMs, 50000);
  assert.equal(feature.partitionFeatures.partitions[0].watchMs, 50000);
  assert.equal(feature.titleFeatures.documentCount, 1);
});

test("16. 同 BV 不同分 P：按同一视频合并，不重复计数", () => {
  const result = build({
    [DAY1]: {
      k1: rec({ bvid: "BV1", page: 1, partition: "科技", watchMs: 20000 }),
      k2: rec({ bvid: "BV1", page: 2, partition: "生活", watchMs: 30000 })
    }
  });
  const feature = featureOf(result, "1001");
  assert.equal(feature.observedVideoCount, 1);
  assert.equal(feature.observedWatchMs, 50000);
  assert.equal(feature.partitionFeatures.partitions.length, 1);
  // 复用 stats.mergeByBvid 语义：分区取观看时长更多的分 P。
  assert.equal(feature.partitionFeatures.partitions[0].name, "生活");
  assert.equal(feature.partitionFeatures.partitions[0].watchMs, 50000);
});

/* ---------------------------------------------------------------- 身份归属 */

test("17. 同 UID 改名：按 UID 聚合，昵称不参与身份判定", () => {
  const result = build({
    [DAY1]: { BV1: rec({ bvid: "BV1", upUid: "1001", upName: "旧名", watchMs: 60000 }) },
    [DAY2]: { BV2: rec({ bvid: "BV2", upUid: "1001", upName: "新名", watchMs: 90000 }) }
  });
  const feature = featureOf(result, "1001");
  assert.equal(feature.upName, "新名");
  assert.equal(feature.observedVideoCount, 2);
  assert.equal(feature.observedWatchMs, 150000);
  assert.equal(feature.partitionFeatures.partitions[0].videoCount, 2);
});

test("18. 不同 UID 同名：特征严格分开，不按昵称混合", () => {
  const result = build({
    [DAY1]: {
      BV1: rec({ bvid: "BV1", upUid: "1001", upName: "同名", title: "科技甲", partition: "科技" }),
      BV2: rec({ bvid: "BV2", upUid: "2002", upName: "同名", title: "生活乙", partition: "生活" })
    }
  });
  const first = featureOf(result, "1001");
  const second = featureOf(result, "2002");
  assert.deepEqual(partitionNames(first), ["科技"]);
  assert.deepEqual(partitionNames(second), ["生活"]);
  assert.equal(tokenCounts(first)["科技"], 1);
  assert.equal(tokenCounts(first)["生活"], undefined);
  assert.equal(tokenCounts(second)["生活"], 1);
  assert.equal(tokenCounts(second)["科技"], undefined);
});

test("19. UID 缺失的旧记录：不凭昵称并入候选", () => {
  const result = build({
    [DAY1]: {
      BV1: rec({ bvid: "BV1", upUid: "1001", upName: "同名", title: "有主甲", watchMs: 60000 }),
      BV2: rec({ bvid: "BV2", upUid: null, upName: "同名", title: "无主乙", watchMs: 90000 })
    }
  });
  const feature = featureOf(result, "1001");
  assert.equal(feature.observedVideoCount, 1);
  assert.equal(feature.observedWatchMs, 60000);
  assert.equal(tokenCounts(feature)["有主"], 1);
  assert.equal(tokenCounts(feature)["无主"], undefined);
  assert.equal(tokenCounts(feature)["主乙"], undefined);
  assert.equal(result.diagnostics.uidlessVideos, 1);
});

/* ---------------------------------------------------------------- UID 冲突 */

function conflictFixture() {
  const days = {
    [DAY1]: {
      BV1: rec({
        bvid: "BV1",
        upUid: "1001",
        upName: "UP甲",
        title: "冲突标题",
        partition: "冲突分区",
        watchMs: 999000
      }),
      BV2: rec({
        bvid: "BV2",
        upUid: "1001",
        upName: "UP甲",
        title: "干净甲",
        partition: "科技",
        watchMs: 100000
      })
    },
    [DAY2]: {
      BV1: rec({
        bvid: "BV1",
        upUid: "2002",
        upName: "UP乙",
        title: "冲突标题",
        partition: "冲突分区",
        watchMs: 999000
      }),
      BV3: rec({
        bvid: "BV3",
        upUid: "2002",
        upName: "UP乙",
        title: "干净乙",
        partition: "生活",
        watchMs: 100000
      })
    }
  };
  const records = root(days);
  const pool = CP.buildFromRecords(records);
  return { records, pool };
}

test("20. 同 BV 不同 UID 冲突：冲突视频不参与任何一方", () => {
  const fixture = conflictFixture();
  const result = CF.buildCandidateFeatures(fixture.records, fixture.pool);
  assert.equal(result.diagnostics.uidConflictVideos, 1);
  assert.equal(result.diagnostics.conflictVideosSeen, 1);

  ["1001", "2002"].forEach((uid) => {
    const feature = featureOf(result, uid);
    assert.equal(feature.hasUidConflict, true);
    assert.equal(feature.conflictVideoCount, 1);
    assert.equal(feature.observedVideoCount, 1);
    assert.equal(feature.observedWatchMs, 100000, "冲突视频的时长不得计入");
    assert.ok(reasonCodes(feature).includes("uid-conflicts-excluded"));
  });

  // C2-1 的观看计数口径保持不变：冲突 BV 仍按主 UID 计给 1001，
  // 2002 只保留自己的干净视频 BV3，特征模块不修改这些计数。
  assert.equal(CP.getCandidate(fixture.pool, "1001").evidence.watchedVideoCount, 2);
  assert.equal(CP.getCandidate(fixture.pool, "2002").evidence.watchedVideoCount, 1);
});

test("21. 冲突视频不污染分区与标题特征", () => {
  const fixture = conflictFixture();
  const result = CF.buildCandidateFeatures(fixture.records, fixture.pool);
  ["1001", "2002"].forEach((uid) => {
    const feature = featureOf(result, uid);
    assert.equal(partitionNames(feature).includes("冲突分区"), false);
    assert.equal(feature.partitionFeatures.unknown, null);
    assert.equal(tokenCounts(feature)["冲突"], undefined);
    assert.equal(tokenCounts(feature)["突标"], undefined);
    assert.equal(tokenCounts(feature)["标题"], undefined);
    assert.equal(feature.partitionCoverage, 1);
  });
  assert.equal(result.summary.conflictVideoCount, 1);
  assert.equal(result.summary.conflictedCandidates, 2);
});

/* ---------------------------------------------------------------- 新候选 */

test("22. 只有手动 UID 的新候选：保留候选，返回 missing", () => {
  const records = root({
    [DAY1]: { BV1: rec({ upUid: "1001", watchMs: 60000 }) }
  });
  const pool = CP.mergePools([
    CP.buildFromRecords(records),
    CP.buildFromManual([{ upUid: "2002", upName: "新UP" }])
  ]);
  const result = CF.buildCandidateFeatures(records, pool);
  const feature = featureOf(result, "2002");
  assert.equal(feature.upUid, "2002");
  assert.equal(feature.upName, "新UP");
  assert.equal(feature.candidateType, "new");
  assert.equal(feature.featureStatus, "missing");
  assert.equal(feature.observedVideoCount, 0);
  assert.equal(feature.observedWatchMs, 0);
  assert.equal(feature.featureVideoCount, 0);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.summary.missing, 1);
  assert.equal(result.diagnostics.candidatesWithoutObservedVideos, 1);
});

test("23. 新候选不虚构内容：分区 / 标题 / 覆盖率均为无数据", () => {
  const records = root({});
  const pool = CP.buildFromManual([{ upUid: "2002", upName: "新UP" }]);
  const result = CF.buildCandidateFeatures(records, pool);
  const feature = featureOf(result, "2002");
  assert.deepEqual(feature.partitionFeatures.partitions, []);
  assert.deepEqual(feature.partitionFeatures.vector, {});
  assert.equal(feature.partitionFeatures.unknown, null);
  assert.deepEqual(feature.titleFeatures.tokens, []);
  assert.equal(feature.partitionCoverage, null);
  assert.equal(feature.partitionCoverageState, "no-data");
  assert.equal(feature.titleCoverage, null);
  assert.equal(feature.titleCoverageState, "no-data");
  assert.equal(feature.missingPartitionCount, 0);
  assert.equal(feature.missingTitleCount, 0);
  assert.equal(feature.conflictVideoCount, 0);
  assert.deepEqual(reasonCodes(feature), ["no-observed-videos"]);
  assert.equal("partition" in feature, false);
  assert.equal("title" in feature, false);
  assert.equal("eligibility" in feature, false);
  assert.equal(feature.candidateType, "new");
});

test("24. ready / partial / missing 三种状态同时出现", () => {
  const records = root({
    [DAY1]: {
      BV1: rec({ bvid: "BV1", upUid: "1001", title: "科技前沿", partition: "科技", watchMs: 200000 }),
      BV3: rec({ bvid: "BV3", upUid: "2002", title: "测试标题", partition: "科技", watchMs: 60000 })
    },
    [DAY2]: {
      BV2: rec({ bvid: "BV2", upUid: "1001", title: "生活日常", partition: "生活", watchMs: 200000 })
    }
  });
  const pool = CP.mergePools([
    CP.buildFromRecords(records),
    CP.buildFromManual(["3003"])
  ]);
  const result = CF.buildCandidateFeatures(records, pool);
  assert.equal(featureOf(result, "1001").featureStatus, "ready");
  assert.equal(featureOf(result, "2002").featureStatus, "partial");
  assert.equal(featureOf(result, "3003").featureStatus, "missing");
  assert.equal(result.summary.ready, 1);
  assert.equal(result.summary.partial, 1);
  assert.equal(result.summary.missing, 1);
});

/* ---------------------------------------------------------------- 边界与稳定 */

test("25. 空输入：结构完整、不抛异常", () => {
  const inputs = [
    [null, null],
    [undefined, undefined],
    [{}, []],
    [{ version: 1 }, { candidates: [] }],
    [{ version: 1, days: {} }, null]
  ];
  inputs.forEach(([records, pool]) => {
    const result = CF.buildCandidateFeatures(records, pool);
    assert.equal(result.status, "empty");
    assert.equal(result.reason, "no-candidates");
    assert.deepEqual(result.candidates, []);
    assert.equal(result.summary.total, 0);
    assert.equal(result.summary.ready, 0);
    assert.equal(result.thresholds.minObservedVideos, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  });
});

test("26. 异常记录：安全降级，不产生虚构特征", () => {
  const records = {
    version: 1,
    days: {
      "not-a-date": { BV1: rec({ upUid: "1001" }) },
      [DAY2]: null,
      "2026-11-11": {
        BV1: "oops",
        BV2: null,
        BV3: rec({ bvid: "BV3", upUid: "1001", title: 123, partition: ["科技"], watchMs: -5 })
      }
    }
  };
  const result = CF.buildCandidateFeatures(records, CP.buildFromRecords(records));
  assert.equal(result.diagnostics.daysInvalid, 2);
  assert.equal(result.diagnostics.recordsInvalid, 2);
  assert.equal(result.diagnostics.zeroWatchVideos, 1);
  const feature = featureOf(result, "1001");
  assert.equal(feature.observedVideoCount, 0);
  assert.equal(feature.featureStatus, "missing");
  assert.deepEqual(feature.titleFeatures.tokens, []);
});

test("27. 输入对象不可变", () => {
  const records = root({
    [DAY1]: { BV1: rec({ upUid: "1001", watchMs: 60000 }) },
    [DAY2]: { BV2: rec({ bvid: "BV2", upUid: "2002", upName: "UP乙", watchMs: 90000 }) }
  });
  const pool = CP.buildFromRecords(records);
  deepFreeze(records);
  deepFreeze(pool);
  const recordsSnapshot = JSON.stringify(records);
  const poolSnapshot = JSON.stringify(pool);
  CF.buildCandidateFeatures(records, pool);
  assert.equal(JSON.stringify(records), recordsSnapshot);
  assert.equal(JSON.stringify(pool), poolSnapshot);
});

test("28. 结果可 JSON 序列化往返，且分区名为 __proto__ 时安全", () => {
  const result = build({
    [DAY1]: {
      BV1: rec({ bvid: "BV1", partition: "__proto__", title: "科技前沿", watchMs: 200000 }),
      BV2: rec({ bvid: "BV2", partition: "__proto__", title: "生活日常", watchMs: 200000 })
    }
  });
  const feature = featureOf(result, "1001");
  assert.equal(
    Object.prototype.hasOwnProperty.call(feature.partitionFeatures.vector, "__proto__"),
    true
  );
  assert.equal(feature.partitionFeatures.vector["__proto__"], 1);
  assert.equal(Object.getPrototypeOf(feature.partitionFeatures.vector), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("29. 结果顺序稳定：与输入顺序无关，按 UID 升序", () => {
  const daysA = {
    [DAY1]: {
      BV1: rec({ bvid: "BV1", upUid: "3003", upName: "UP丙" }),
      BV2: rec({ bvid: "BV2", upUid: "1001", upName: "UP甲" })
    },
    [DAY2]: {
      BV3: rec({ bvid: "BV3", upUid: "2002", upName: "UP乙" })
    }
  };
  const daysB = {
    [DAY2]: {
      BV3: rec({ bvid: "BV3", upUid: "2002", upName: "UP乙" })
    },
    [DAY1]: {
      BV2: rec({ bvid: "BV2", upUid: "1001", upName: "UP甲" }),
      BV1: rec({ bvid: "BV1", upUid: "3003", upName: "UP丙" })
    }
  };
  const recordsA = root(daysA);
  const recordsB = root(daysB);
  const poolA = CP.buildFromRecords(recordsA);
  const poolB = CP.buildFromRecords(recordsB);
  const first = CF.buildCandidateFeatures(recordsA, poolA);
  const second = CF.buildCandidateFeatures(recordsB, poolB.candidates.slice().reverse());
  assert.deepEqual(
    first.candidates.map((item) => item.upUid),
    ["1001", "2002", "3003"]
  );
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("30. 大量重复记录不会错误膨胀统计", () => {
  const day = {};
  for (let index = 0; index < 100; index += 1) {
    day[`k${index}`] = rec({ bvid: "BV1", watchMs: 1000 });
  }
  const result = build({ [DAY1]: day });
  const feature = featureOf(result, "1001");
  assert.equal(feature.observedVideoCount, 1);
  assert.equal(feature.observedWatchMs, 100000);
  assert.equal(feature.partitionFeatures.partitions[0].videoCount, 1);
  assert.equal(feature.titleFeatures.documentCount, 1);
  assert.equal(tokenCounts(feature)["科技"], 1);
});

/* ---------------------------------------------------------------- C2-2 兼容 */

test("31. 支持 C2-2 filterEligibleCandidates 结果作为候选池", () => {
  const records = root({
    [DAY1]: {
      BV1: rec({ bvid: "BV1", upUid: "1001", title: "科技前沿", partition: "科技", watchMs: 200000 }),
      BV2: rec({ bvid: "BV2", upUid: "2002", title: "生活日常", partition: "生活", watchMs: 200000 })
    }
  });
  const pool = CP.buildFromRecords(records);
  const filtered = CP.filterEligibleCandidates(pool, { now: NOW });
  const snapshot = JSON.stringify(filtered);
  const result = CF.buildCandidateFeatures(records, filtered);
  assert.equal(result.candidates.length, filtered.summary.total);
  assert.deepEqual(result.candidates.map((item) => item.upUid), ["1001", "2002"]);
  assert.equal(JSON.stringify(filtered), snapshot, "C2-2 结果对象不得被修改");
  result.candidates.forEach((feature) => {
    assert.equal("eligibility" in feature, false);
  });
});

test("32. 冲突候选的 C2-2 资格结论不被特征模块改变", () => {
  const fixture = conflictFixture();
  const before = CP.filterEligibleCandidates(fixture.pool, { now: NOW });
  const snapshot = JSON.stringify(before);
  CF.buildCandidateFeatures(fixture.records, before);
  assert.equal(JSON.stringify(before), snapshot);
  assert.equal(before.review.length, 2);
  assert.equal(before.eligible.length, 0);
});

/* ---------------------------------------------------------------- 上限与异常 */

test("33. 超长标题被截断，词元数量有上限", () => {
  const result = build({
    [DAY1]: { BV1: rec({ title: "科".repeat(500), watchMs: 60000 }) }
  });
  const feature = featureOf(result, "1001");
  assert.equal(feature.titleFeatures.truncatedTitleCount, 1);
  assert.equal(feature.titleFeatures.uniqueTokenCount, 1);
  assert.equal(feature.titleFeatures.tokens[0].token, "科科");
  assert.equal(feature.titleFeatures.tokens[0].count, 199);
  assert.equal(feature.titleFeatures.tokens.length, 1);
});

test("34. 空白 / 非字符串 / 控制字符 / 超长分区统一归入未知", () => {
  const result = build({
    [DAY1]: {
      BV1: rec({ bvid: "BV1", partition: "", watchMs: 60000 }),
      BV2: rec({ bvid: "BV2", partition: "   ", watchMs: 60000 }),
      BV3: rec({ bvid: "BV3", partition: 123, watchMs: 60000 }),
      BV4: rec({ bvid: "BV4", partition: "x".repeat(100), watchMs: 60000 }),
      BV5: rec({ bvid: "BV5", partition: "\u200B零宽分区", watchMs: 60000 }),
      BV6: rec({ bvid: "BV6", partition: "新闻\u0007", watchMs: 60000 }),
      BV7: rec({ bvid: "BV7", partition: "y".repeat(200), watchMs: 60000 })
    }
  });
  const feature = featureOf(result, "1001");
  assert.equal(feature.observedVideoCount, 7);
  assert.equal(feature.missingPartitionCount, 7);
  assert.equal(feature.partitionFeatures.identifiedWatchMs, 0);
  assert.equal(feature.partitionFeatures.unknownVideoCount, 7);
  assert.equal(feature.partitionFeatures.unknownWatchMs, 420000);
  assert.deepEqual(partitionNames(feature), []);
  assert.deepEqual(feature.partitionFeatures.vector, {});
  assert.equal(feature.partitionCoverage, 0);
});

test("35. 超大 / 非法 watchMs 安全处理", () => {
  const result = build({
    [DAY1]: {
      BV1: rec({ bvid: "BV1", watchMs: Number.MAX_SAFE_INTEGER, title: "科技前沿" }),
      BV2: rec({ bvid: "BV2", watchMs: 1000, title: "生活日常" }),
      BV3: rec({ bvid: "BV3", watchMs: -5, title: "异常负值" }),
      BV4: rec({ bvid: "BV4", watchMs: NaN, title: "异常非数" })
    }
  });
  const feature = featureOf(result, "1001");
  assert.equal(feature.observedVideoCount, 2);
  assert.equal(feature.observedWatchMs, Number.MAX_SAFE_INTEGER);
  assert.ok(Number.isSafeInteger(feature.observedWatchMs));
  assert.equal(result.diagnostics.zeroWatchVideos, 2);
  assert.equal(feature.featureStatus, "ready");
});

test("36. 重复候选 UID 只输出一次，来源取并集", () => {
  const records = root({
    [DAY1]: { BV1: rec({ upUid: "1001", watchMs: 60000 }) }
  });
  const pool = CP.buildFromRecords(records);
  const duplicated = [pool.candidates[0], pool.candidates[0]];
  const result = CF.buildCandidateFeatures(records, duplicated);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.diagnostics.duplicateCandidates, 1);
  assert.equal(result.candidates[0].upUid, "1001");
});

test("37. 零观看时长视频不参与特征统计", () => {
  const result = build({
    [DAY1]: {
      BV1: rec({ bvid: "BV1", title: "零秒标题", watchMs: 0 }),
      BV2: rec({ bvid: "BV2", title: "正常标题", watchMs: 60000 })
    }
  });
  const feature = featureOf(result, "1001");
  assert.equal(feature.observedVideoCount, 1);
  assert.equal(feature.observedWatchMs, 60000);
  assert.equal(result.diagnostics.zeroWatchVideos, 1);
  assert.equal(tokenCounts(feature)["零秒"], undefined);
  assert.equal(tokenCounts(feature)["正常"], 1);
});

test("38. 阈值可覆盖，并随结果输出", () => {
  const records = root({
    [DAY1]: { BV1: rec({ upUid: "1001", title: "科技前沿", partition: "科技", watchMs: 60000 }) }
  });
  const pool = CP.buildFromRecords(records);
  const result = CF.buildCandidateFeatures(records, pool, {
    thresholds: { minObservedVideos: 1, minObservedWatchMs: 0 }
  });
  const feature = featureOf(result, "1001");
  assert.equal(feature.featureStatus, "ready");
  assert.equal(result.thresholds.minObservedVideos, 1);
  assert.equal(result.thresholds.minObservedWatchMs, 0);
  assert.equal(result.thresholds.minPartitionCoverage, 0.5);
});

/* ---------------------------------------------------------------- 输出 */

const failed = results.filter((item) => !item.ok);
results.forEach((item) => {
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}`);
  if (!item.ok) console.log(`      ${item.error && item.error.stack}`);
});
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exitCode = failed.length === 0 ? 0 : 1;
