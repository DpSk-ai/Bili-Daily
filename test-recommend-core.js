"use strict";

/**
 * Bili Daily —— 推荐基础算法（C3-1）独立测试
 * 运行：node test-recommend-core.js
 *
 * 覆盖：用户分区向量 / 标题词频、候选 main 与 exploration 适配、
 * TF-IDF、余弦相似度、跨口径拒绝与近似标记、不可变、JSON 往返、
 * 顺序稳定、身份冲突优先、无排序、无网络与存储。
 *
 * 全部使用内存模拟数据，不读写 chrome.storage.local，不联网。
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

require(path.join(__dirname, "stats.js"));
require(path.join(__dirname, "candidate-features.js"));
require(path.join(__dirname, "recommend-core.js"));

const RC = globalThis.BiliDailyRecommendCore;

const END = "2026-11-11";
const WINDOW = { endDate: END, windowDays: 7 };

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

function mainCandidate(extra) {
  return Object.assign(
    {
      upUid: "1001",
      upName: "科技UP",
      featureStatus: "ready",
      partitionCoverage: 0.9,
      partitionCoverageBasis: "watch-ms",
      partitionFeatures: {
        partitions: [
          { name: "科技", watchMs: 60000, videoCount: 2, shareOfIdentified: 0.75 },
          { name: "生活", watchMs: 20000, videoCount: 1, shareOfIdentified: 0.25 },
          { name: "未知", watchMs: 5000, videoCount: 1, shareOfIdentified: 0 }
        ],
        vector: { 科技: 0.75, 生活: 0.25 }
      },
      titleFeatures: {
        tokens: [
          { token: "科技", count: 3, documentCount: 2 },
          { token: "评测", count: 1, documentCount: 1 }
        ],
        documentCount: 2
      },
      titleCoverage: 0.8
    },
    extra || {}
  );
}

function explorationCandidate(extra) {
  return Object.assign(
    {
      upUid: "2001",
      upName: "导入UP",
      provenance: "user-provided",
      contentStatus: "complete",
      partitionCoverage: 0.8,
      partitionCounts: [
        { name: "科技", videoCount: 3, shareOfImportedVideos: 0.6 },
        { name: "知识", videoCount: 2, shareOfImportedVideos: 0.4 },
        { name: "未知", videoCount: 1, shareOfImportedVideos: 0 }
      ],
      titleTokens: [
        { token: "教程", count: 2, documentCount: 2 },
        { token: "入门", count: 1, documentCount: 1 }
      ],
      titleCoverage: 0.6
    },
    extra || {}
  );
}

/* ---------------------------------------------------------------- 1. 用户分区向量 */

test("1. 分区向量：按观看时长归一化，basis 为 watch-ms", () => {
  const records = root({
    "2026-11-10": {
      BV1: rec("BV1", "科技前沿", "科技", 60000),
      BV2: rec("BV2", "生活日常", "生活", 30000),
      BV3: rec("BV3", "编程入门", "科技", 10000)
    }
  });
  const result = RC.buildUserPartitionVector(records, WINDOW);
  assert.equal(result.status, "ok");
  assert.equal(result.available, true);
  assert.equal(result.basis, "watch-ms");
  assert.equal(result.side, "user");
  assert.deepEqual(result.dimensions, ["生活", "科技"]);
  closeTo(result.vector["科技"], 0.7);
  closeTo(result.vector["生活"], 0.3);
  assert.equal(result.sample.videoCount, 3);
  closeTo(result.norm, Math.sqrt(0.49 + 0.09));
  assertStable(result, "分区向量");
});

test("2. 未知分区不进入可匹配维度", () => {
  const records = root({
    "2026-11-10": {
      BV1: rec("BV1", "A", "科技", 60000),
      BV2: rec("BV2", "B", "未知", 20000),
      BV3: rec("BV3", "C", "", 20000)
    }
  });
  const result = RC.buildUserPartitionVector(records, WINDOW);
  assert.deepEqual(result.dimensions, ["科技"]);
  assert.equal(Object.prototype.hasOwnProperty.call(result.vector, "未知"), false);
  closeTo(result.vector["科技"], 1);
  assert.equal(result.sample.unknownVideoCount, 2);
});

test("3. 覆盖率分母包含未知分区", () => {
  const records = root({
    "2026-11-10": {
      BV1: rec("BV1", "A", "科技", 60000),
      BV2: rec("BV2", "B", "未知", 30000),
      BV3: rec("BV3", "C", "", 10000)
    }
  });
  const result = RC.buildUserPartitionVector(records, WINDOW);
  assert.equal(result.coverage.totalWatchMs, 100000);
  assert.equal(result.coverage.identifiedWatchMs, 60000);
  assert.equal(result.coverage.unknownWatchMs, 40000);
  closeTo(result.coverage.ratio, 0.6);
  assert.equal(result.coverage.basis, "watch-ms");
});

test("4. 没有有效分区时返回不可用，不伪造向量", () => {
  const records = root({
    "2026-11-10": {
      BV1: rec("BV1", "A", "未知", 30000),
      BV2: rec("BV2", "B", "", 20000)
    }
  });
  const result = RC.buildUserPartitionVector(records, WINDOW);
  assert.equal(result.status, "unavailable");
  assert.equal(result.available, false);
  assert.equal(result.vector, null);
  assert.deepEqual(result.dimensions, []);
  assert.ok(reasonCodes(result.reasons).includes("no-identified-partition"));
  // 有总时长但没有已识别时长 → 真实的 0，不是缺失。
  assert.equal(result.coverage.ratio, 0);
});

test("5. 同一天同一 BV 多条记录合并为一个视频", () => {
  const records = root({
    "2026-11-10": {
      k1: rec("BV1", "科技前沿", "科技", 30000, { page: 1 }),
      k2: rec("BV1", "科技前沿", "科技", 20000, { page: 2 })
    }
  });
  const result = RC.buildUserPartitionVector(records, WINDOW);
  assert.equal(result.sample.videoCount, 1);
  assert.equal(result.coverage.totalWatchMs, 50000);
  closeTo(result.vector["科技"], 1);
});

test("6. 同一 BV 跨天合并，时长累加且只算一个视频", () => {
  const records = root({
    "2026-11-09": { BV1: rec("BV1", "科技前沿", "科技", 40000) },
    "2026-11-10": { BV1: rec("BV1", "科技前沿", "生活", 20000) }
  });
  const result = RC.buildUserPartitionVector(records, WINDOW);
  assert.equal(result.sample.videoCount, 1);
  assert.equal(result.coverage.totalWatchMs, 60000);
  // 分区取观看时长更多的那条（40000 的「科技」）
  assert.deepEqual(result.dimensions, ["科技"]);
});

test("7. 不同 UID 同名不合并，两个视频各自贡献标题词元", () => {
  const records = root({
    "2026-11-10": {
      BV1: rec("BV1", "科技前沿", "科技", 30000, { upName: "同名UP", upUid: "1001" }),
      BV2: rec("BV2", "数码评测", "科技", 20000, { upName: "同名UP", upUid: "1002" })
    }
  });
  const counts = RC.buildUserTextCounts(records, WINDOW);
  assert.equal(counts.sample.videoCount, 2);
  assert.equal(counts.sample.titledVideoCount, 2);
  assert.ok(Object.prototype.hasOwnProperty.call(counts.counts, "科技"));
  assert.ok(Object.prototype.hasOwnProperty.call(counts.counts, "数码"));
});

/* ---------------------------------------------------------------- 2. 用户标题词频 */

test("8. 用户标题生成字符 bigram，权重标记为原始计数", () => {
  const records = root({
    "2026-11-10": { BV1: rec("BV1", "科技前沿", "科技", 30000) }
  });
  const counts = RC.buildUserTextCounts(records, WINDOW);
  assert.equal(counts.status, "ok");
  assert.equal(counts.space, "title");
  assert.equal(counts.basis, "token-count");
  assert.equal(counts.weighting, "raw-count");
  assert.equal(counts.decay, "none");
  assert.equal(counts.counts["科技"], 1);
  assert.equal(counts.counts["技前"], 1);
  assert.equal(counts.counts["前沿"], 1);
  assert.equal(counts.totalTokenCount, 3);
  assert.equal(counts.tokenCount, 3);
});

test("9. 缺失标题与单字符标题安全降级", () => {
  const records = root({
    "2026-11-10": {
      BV1: rec("BV1", "", "科技", 30000),
      BV2: rec("BV2", "猫", "生活", 20000),
      BV3: rec("BV3", "！？。", "知识", 10000)
    }
  });
  const counts = RC.buildUserTextCounts(records, WINDOW);
  assert.equal(counts.status, "unavailable");
  assert.equal(counts.available, false);
  assert.deepEqual(counts.counts, {});
  assert.equal(counts.sample.missingTitleCount, 1);
  assert.equal(counts.sample.tokenlessVideoCount, 2);
  assert.equal(counts.coverage.titleCoverage, 2 / 3);
  assert.equal(counts.coverage.tokenCoverage, 0);
});

test("10. 词频是原始出现次数，同 BV 不会让文档数虚假膨胀", () => {
  const records = root({
    "2026-11-09": { BV1: rec("BV1", "科技科技", "科技", 30000) },
    "2026-11-10": { BV1: rec("BV1", "科技科技", "科技", 30000) }
  });
  const counts = RC.buildUserTextCounts(records, WINDOW);
  assert.equal(counts.sample.videoCount, 1);
  assert.equal(counts.counts["科技"], 2);
  assert.equal(counts.counts["技科"], 1);
  assert.equal(counts.totalTokenCount, 3);
});

test("11. 次线性 TF：tf' = 1 + ln(tf)", () => {
  const vector = RC.buildTfIdfVector({ 科技: 2, 技科: 1 }, null);
  closeTo(vector.vector["科技"], 1 + Math.log(2));
  closeTo(vector.vector["技科"], 1);
  assert.equal(vector.config.idfEnabled, false);
});

/* ---------------------------------------------------------------- 3. TF-IDF */

test("12. DF 按候选文档统计，不按视频数统计", () => {
  const model = RC.computeIdf(
    [{ 科学: 1, 技术: 1 }, { 科学: 1 }],
    { minIdfDocuments: 1 }
  );
  assert.equal(model.documentCount, 2);
  assert.equal(model.df["科学"], 2);
  assert.equal(model.df["技术"], 1);
  assert.equal(model.documentBasis, "candidate-up");
});

test("13. IDF 平滑：df=0 与 N=1 都不产生零权重或除零", () => {
  const model = RC.computeIdf([{ 甲: 1 }], { minIdfDocuments: 1 });
  closeTo(model.idf["甲"], 1); // ln(2/2)+1
  closeTo(model.oovIdf, Math.log(2) + 1);
  assert.ok(model.oovIdf > 0);
});

test("14. 空 IDF 语料：关闭 IDF，无 NaN / Infinity", () => {
  const model = RC.computeIdf([], {});
  assert.equal(model.enabled, false);
  assert.equal(model.documentCount, 0);
  assert.equal(model.tokenCount, 0);
  assert.deepEqual(model.idf, {});
  closeTo(model.oovIdf, 1);
  assert.ok(reasonCodes(model.reasons).includes("empty-corpus"));
  assertStable(model, "IDF 模型");
});

test("15. 未登录词使用平滑 OOV 权重", () => {
  const model = RC.computeIdf([{ 甲: 1 }], { minIdfDocuments: 1 });
  const vector = RC.buildTfIdfVector({ 乙: 1 }, model);
  closeTo(vector.vector["乙"], model.oovIdf);
  assert.equal(vector.oovTokens, 1);
});

test("16. 小候选池默认关闭 IDF，阈值可配置", () => {
  const docs = [{ 甲: 1 }, { 乙: 1 }];
  const off = RC.computeIdf(docs, {});
  assert.equal(off.enabled, false);
  assert.ok(reasonCodes(off.reasons).includes("small-corpus"));

  const on = RC.computeIdf(docs, { minIdfDocuments: 1 });
  assert.equal(on.enabled, true);
  assert.equal(on.documentCount, 2);
});

test("17. 冻结 IDF 模型可 JSON 往返后复用", () => {
  const model = RC.computeIdf([{ 甲: 1 }, { 甲: 1, 乙: 1 }], {
    minIdfDocuments: 1,
    frozen: true,
    lane: "main"
  });
  assert.equal(model.frozen, true);
  assert.equal(model.lane, "main");

  const frozen = roundTrip(model);
  const first = RC.buildTfIdfVector({ 甲: 2, 乙: 1 }, model);
  const second = RC.buildTfIdfVector({ 甲: 2, 乙: 1 }, frozen);
  assert.deepEqual(second.vector, first.vector);
  assert.equal(second.config.modelFrozen, true);
});

/* ---------------------------------------------------------------- 4. 余弦 */

test("18. 一维余弦：同方向为 1", () => {
  assert.equal(RC.cosineSimilarity({ a: 1 }, { a: 2 }), 1);
});

test("19. 多维余弦与手算一致", () => {
  const value = RC.cosineSimilarity({ x: 1, y: 1 }, { x: 1 });
  closeTo(value, Math.SQRT1_2);
});

test("20. 正交向量返回 0 而不是 null", () => {
  assert.equal(RC.cosineSimilarity({ a: 1 }, { b: 1 }), 0);
});

test("21. 零范数返回 null", () => {
  assert.equal(RC.cosineSimilarity({ a: 0 }, { a: 1 }), null);
});

test("22. 两侧空向量返回 null，不等于 0", () => {
  assert.equal(RC.cosineSimilarity({}, {}), null);
});

test("23. 非法权重安全拒绝", () => {
  assert.equal(RC.cosineSimilarity({ a: NaN }, { a: 1 }), null);
  assert.equal(RC.cosineSimilarity({ a: "1" }, { a: 1 }), null);
  assert.equal(RC.cosineSimilarity({ a: -1 }, { a: 1 }), null);
  assert.equal(RC.cosineSimilarity({ a: Infinity }, { a: 1 }), null);
});

test("24. 所有输出不含 NaN / Infinity，可安全序列化", () => {
  const records = root({
    "2026-11-10": {
      BV1: rec("BV1", "科技前沿", "科技", 60000),
      BV2: rec("BV2", "生活日常", "未知", 0)
    }
  });
  const outputs = [
    RC.buildUserPartitionVector(records, WINDOW),
    RC.buildUserTextCounts(records, WINDOW),
    RC.buildCandidatePartitionVector(mainCandidate(), { lane: "main" }),
    RC.buildCandidateTextCounts(mainCandidate(), { lane: "main" }),
    RC.computeIdf([{ 科技: 1 }], { minIdfDocuments: 1 }),
    RC.buildTfIdfVector({ 科技: 2 }, null)
  ];
  outputs.forEach((output, index) => {
    assertStable(output, `输出 ${index}`);
    const text = JSON.stringify(output);
    assert.equal(text.includes("NaN"), false);
    assert.equal(text.includes("Infinity"), false);
  });
});

/* ---------------------------------------------------------------- 5. 候选向量 */

test("25. main lane：分区来自 C2-3，口径 watch-ms", () => {
  const partition = RC.buildCandidatePartitionVector(mainCandidate(), {
    lane: "main"
  });
  assert.equal(partition.status, "ok");
  assert.equal(partition.lane, "main");
  assert.equal(partition.basis, "watch-ms");
  assert.deepEqual(partition.dimensions, ["生活", "科技"]);
  closeTo(partition.vector["科技"], 0.75);
  closeTo(partition.vector["生活"], 0.25);

  const text = RC.buildCandidateTextCounts(mainCandidate(), { lane: "main" });
  assert.equal(text.lane, "main");
  assert.equal(text.basis, "token-count");
  assert.equal(text.counts["科技"], 3);
  assert.equal(text.coverage.ratio, 0.8);
});

test("26. exploration lane：分区来自 C2-4B，口径 video-count", () => {
  const partition = RC.buildCandidatePartitionVector(explorationCandidate(), {
    lane: "exploration"
  });
  assert.equal(partition.status, "ok");
  assert.equal(partition.lane, "exploration");
  assert.equal(partition.basis, "video-count");
  closeTo(partition.vector["科技"], 0.6);
  closeTo(partition.vector["知识"], 0.4);
  assert.equal(
    Object.prototype.hasOwnProperty.call(partition.vector, "未知"),
    false
  );

  const text = RC.buildCandidateTextCounts(explorationCandidate(), {
    lane: "exploration"
  });
  assert.equal(text.lane, "exploration");
  assert.equal(text.counts["教程"], 2);
});

test("27. 同口径分区比较：返回可审计的相似度", () => {
  const records = root({
    "2026-11-10": {
      BV1: rec("BV1", "科技前沿", "科技", 70000),
      BV2: rec("BV2", "生活日常", "生活", 30000)
    }
  });
  const user = RC.buildUserPartitionVector(records, WINDOW);
  const candidate = RC.buildCandidatePartitionVector(mainCandidate(), {
    lane: "main"
  });
  const result = RC.compareVectors(user, candidate);
  assert.equal(result.status, "ok");
  assert.equal(result.approximate, false);
  assert.ok(result.similarity > 0.99);
  assert.deepEqual(result.bases, { left: "watch-ms", right: "watch-ms" });
  assert.equal(result.evidence.confidencePolicy, "deferred-to-c3-2");
});

test("28. 跨口径默认拒绝，且不伪装成 0", () => {
  const records = root({
    "2026-11-10": { BV1: rec("BV1", "科技前沿", "科技", 60000) }
  });
  const user = RC.buildUserPartitionVector(records, WINDOW);
  const candidate = RC.buildCandidatePartitionVector(explorationCandidate(), {
    lane: "exploration"
  });
  const result = RC.compareVectors(user, candidate);
  assert.equal(result.status, "cross-basis-rejected");
  assert.equal(result.similarity, null);
  assert.equal(result.approximate, false);
  assert.ok(result.limitations.length > 0);
  assert.equal(RC.cosineSimilarity(user, candidate), null);
});

test("29. 显式允许跨口径时返回近似标记与限制说明", () => {
  const records = root({
    "2026-11-10": {
      BV1: rec("BV1", "科技前沿", "科技", 60000),
      BV2: rec("BV2", "生活日常", "生活", 40000)
    }
  });
  const user = RC.buildUserPartitionVector(records, WINDOW);
  const candidate = RC.buildCandidatePartitionVector(explorationCandidate(), {
    lane: "exploration"
  });
  const result = RC.compareVectors(user, candidate, { allowCrossBasis: true });
  assert.equal(result.status, "approximation");
  assert.equal(result.approximate, true);
  assert.deepEqual(result.bases, { left: "watch-ms", right: "video-count" });
  assert.equal(typeof result.similarity, "number");
  assert.ok(result.limitations.length > 0);
  assert.ok(reasonCodes(result.reasons).includes("cross-basis-approximation"));
});

test("30. 缺失组件返回 null，不被误认为不相似", () => {
  const empty = RC.buildCandidatePartitionVector(
    { upUid: "3001", partitionCounts: [] },
    { lane: "exploration" }
  );
  assert.equal(empty.status, "unavailable");
  assert.equal(empty.vector, null);

  const records = root({
    "2026-11-10": { BV1: rec("BV1", "科技前沿", "科技", 60000) }
  });
  const user = RC.buildUserPartitionVector(records, WINDOW);
  const result = RC.compareVectors(user, empty);
  assert.equal(result.status, "insufficient-data");
  assert.equal(result.similarity, null);
});

test("31. 输入不可变：深度冻结仍可处理", () => {
  const records = deepFreeze(
    root({
      "2026-11-10": {
        BV1: rec("BV1", "科技前沿", "科技", 60000),
        BV2: rec("BV2", "生活日常", "生活", 30000)
      }
    })
  );
  const candidate = deepFreeze(mainCandidate());
  const snapshotRecords = JSON.stringify(records);
  const snapshotCandidate = JSON.stringify(candidate);

  RC.buildUserPartitionVector(records, WINDOW);
  RC.buildUserTextCounts(records, WINDOW);
  RC.buildCandidatePartitionVector(candidate, { lane: "main" });
  RC.buildCandidateTextCounts(candidate, { lane: "main" });

  assert.equal(JSON.stringify(records), snapshotRecords);
  assert.equal(JSON.stringify(candidate), snapshotCandidate);
});

test("32. 全部输出可 JSON 序列化往返", () => {
  const records = root({
    "2026-11-10": {
      BV1: rec("BV1", "科技前沿", "科技", 60000),
      BV2: rec("BV2", "生活日常", "生活", 30000)
    }
  });
  const user = RC.buildUserPartitionVector(records, WINDOW);
  const candidate = RC.buildCandidatePartitionVector(mainCandidate(), {
    lane: "main"
  });
  const comparison = RC.compareVectors(user, candidate);
  assertStable(RC.buildUserPartitionVector(records, WINDOW), "用户分区向量");
  assertStable(RC.buildUserTextCounts(records, WINDOW), "用户词频");
  assertStable(RC.buildCandidatePartitionVector(mainCandidate(), { lane: "main" }), "候选分区");
  assertStable(RC.buildCandidateTextCounts(mainCandidate(), { lane: "main" }), "候选词频");
  assertStable(RC.computeIdf([{ 甲: 1 }], { minIdfDocuments: 1 }), "IDF");
  assertStable(RC.buildTfIdfVector({ 甲: 2 }, null), "TF-IDF 向量");
  assertStable(comparison, "比较结果");
});

test("33. 输入顺序变化不改变结果", () => {
  const dayA = {
    BV1: rec("BV1", "科技前沿", "科技", 60000),
    BV2: rec("BV2", "生活日常", "生活", 30000),
    BV3: rec("BV3", "编程入门", "科技", 10000)
  };
  const dayB = {
    BV3: rec("BV3", "编程入门", "科技", 10000),
    BV1: rec("BV1", "科技前沿", "科技", 60000),
    BV2: rec("BV2", "生活日常", "生活", 30000)
  };
  const first = JSON.stringify(
    RC.buildUserPartitionVector(root({ "2026-11-10": dayA }), WINDOW)
  );
  const second = JSON.stringify(
    RC.buildUserPartitionVector(root({ "2026-11-10": dayB }), WINDOW)
  );
  assert.equal(second, first);

  const firstText = JSON.stringify(
    RC.buildUserTextCounts(root({ "2026-11-10": dayA }), WINDOW)
  );
  const secondText = JSON.stringify(
    RC.buildUserTextCounts(root({ "2026-11-10": dayB }), WINDOW)
  );
  assert.equal(secondText, firstText);
});

test("34. 身份冲突优先于内容完整度", () => {
  const conflictedMain = RC.buildCandidatePartitionVector(
    mainCandidate({ conflictVideoCount: 2 }),
    { lane: "main" }
  );
  assert.equal(conflictedMain.status, "blocked");
  assert.equal(conflictedMain.available, false);
  assert.equal(conflictedMain.vector, null);

  const conflictedExploration = RC.buildCandidateTextCounts(
    explorationCandidate({
      identityEvidence: {
        hasIdentityConflict: true,
        crossSourceConflictVideoCount: 1
      }
    }),
    { lane: "exploration" }
  );
  assert.equal(conflictedExploration.status, "blocked");
  assert.deepEqual(conflictedExploration.counts, {});
});

/* ---------------------------------------------------------------- 6. 边界与约束 */

test("35. 不提供任何排序 / 打分入口", () => {
  const names = Object.keys(RC);
  names.forEach((name) => {
    assert.equal(
      /rank|mmr|score|topk|recommendlist/i.test(name),
      false,
      `不应导出排序相关入口：${name}`
    );
  });
  const output = RC.buildUserPartitionVector(
    root({ "2026-11-10": { BV1: rec("BV1", "科技前沿", "科技", 60000) } }),
    WINDOW
  );
  ["score", "rank", "recommendations", "mmr", "confidence"].forEach((key) => {
    assert.equal(
      Object.prototype.hasOwnProperty.call(output, key),
      false,
      `输出不应包含 ${key}`
    );
  });
});

test("36. 不使用网络、浏览器存储或文件系统", () => {
  const source = fs.readFileSync(path.join(__dirname, "recommend-core.js"), "utf8");
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
    assert.equal(
      stripped.includes(token),
      false,
      `模块不应引用 ${token}`
    );
  });
});

test("37. 窗口范围外的记录不参与统计", () => {
  const records = root({
    "2026-10-01": { BV9: rec("BV9", "旧视频", "科技", 999999) },
    "2026-11-10": { BV1: rec("BV1", "科技前沿", "生活", 60000) }
  });
  const result = RC.buildUserPartitionVector(records, WINDOW);
  assert.equal(result.sample.videoCount, 1);
  assert.equal(result.coverage.totalWatchMs, 60000);
  assert.deepEqual(result.dimensions, ["生活"]);
});

test("38. 零观看时长的视频不进入向量", () => {
  const records = root({
    "2026-11-10": {
      BV1: rec("BV1", "科技前沿", "科技", 60000),
      BV2: rec("BV2", "生活日常", "生活", 0)
    }
  });
  const partition = RC.buildUserPartitionVector(records, WINDOW);
  assert.equal(partition.sample.videoCount, 1);
  assert.equal(partition.sample.excludedZeroWatchVideos, 1);
  assert.deepEqual(partition.dimensions, ["科技"]);

  const counts = RC.buildUserTextCounts(records, WINDOW);
  assert.equal(counts.sample.videoCount, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(counts.counts, "生活"), false);
});

test("39. 词元上限可配置并显式标记截断", () => {
  const records = root({
    "2026-11-10": { BV1: rec("BV1", "科技前沿", "科技", 30000) }
  });
  const counts = RC.buildUserTextCounts(records, {
    endDate: END,
    windowDays: 7,
    maxTokens: 2
  });
  assert.equal(counts.tokenCount, 2);
  assert.equal(counts.truncated, true);
  assert.equal(counts.truncatedTokens, 1);
});

test("40. IDF 语料中的非法文档被跳过并计数", () => {
  const model = RC.computeIdf([null, { 甲: 1 }, { 甲: NaN }], {
    minIdfDocuments: 1
  });
  assert.equal(model.skippedDocuments, 1);
  assert.equal(model.invalidEntries, 1);
  assert.equal(model.documentCount, 1);
  assert.equal(model.df["甲"], 1);
});

test("41. 无 IDF 模型时等价于统一权重 1", () => {
  const withNull = RC.buildTfIdfVector({ 甲: 1 }, null);
  const disabled = RC.computeIdf([{ 甲: 1 }], { minIdfDocuments: 20 });
  const withDisabled = RC.buildTfIdfVector({ 甲: 1 }, disabled);
  closeTo(withNull.vector["甲"], 1);
  closeTo(withDisabled.vector["甲"], 1);
  assert.equal(withDisabled.config.idfEnabled, false);
  assertStable(withDisabled, "统一权重向量");
});

test("42. 非法输入比较返回 invalid-input，不抛异常", () => {
  const result = RC.compareVectors(null, { a: 1 });
  assert.equal(result.status, "invalid-input");
  assert.equal(result.similarity, null);

  const badVector = RC.compareVectors({ a: "x" }, { a: 1 });
  assert.equal(badVector.status, "invalid-input");
});

test("43. IDF 模型携带完整元数据", () => {
  const model = RC.computeIdf([{ 甲: 1 }], {
    minIdfDocuments: 1,
    frozen: true,
    lane: "exploration"
  });
  assert.equal(model.kind, "bili-daily-idf-model");
  assert.equal(model.formula, "ln((N+1)/(df+1))+1");
  assert.equal(model.tfFormula, "1+ln(tf)");
  assert.equal(model.documentBasis, "candidate-up");
  assert.equal(model.frozen, true);
  assert.equal(model.lane, "exploration");
  assertStable(model, "IDF 元数据");
});

test("44. 无法判断 lane 的候选返回 unavailable", () => {
  const result = RC.buildCandidatePartitionVector({ upUid: "9999" }, {});
  assert.equal(result.status, "unavailable");
  assert.ok(reasonCodes(result.reasons).includes("unknown-lane"));
});

test("45. 权重与衰减语义在输出中显式声明", () => {
  const records = root({
    "2026-11-10": { BV1: rec("BV1", "科技前沿", "科技", 60000) }
  });
  const partition = RC.buildUserPartitionVector(records, WINDOW);
  const counts = RC.buildUserTextCounts(records, WINDOW);
  assert.equal(partition.weighting, "watch-ms-raw");
  assert.equal(partition.decay, "none");
  assert.equal(counts.weighting, "raw-count");
  assert.equal(counts.decay, "none");
  assert.equal(partition.window.decay, "none");
});

/* ---------------------------------------------------------------- 7. 审计补强 */

test("46. 不同特征空间默认拒绝比较", () => {
  const records = root({
    "2026-11-10": { BV1: rec("BV1", "科技前沿", "科技", 60000) }
  });
  const partition = RC.buildUserPartitionVector(records, WINDOW);
  const title = RC.buildTfIdfVector({ 科技: 2 }, null);
  assert.equal(partition.space, "partition");
  assert.equal(title.space, "title");

  const result = RC.compareVectors(partition, title);
  assert.equal(result.status, "space-mismatch");
  assert.equal(result.similarity, null);
  assert.deepEqual(result.spaces, { left: "partition", right: "title" });
  assert.ok(reasonCodes(result.reasons).includes("space-mismatch"));
  assert.ok(result.limitations.length > 0);
});

test("47. allowCrossBasis 不能绕过特征空间校验", () => {
  const records = root({
    "2026-11-10": { BV1: rec("BV1", "科技前沿", "科技", 60000) }
  });
  const partition = RC.buildUserPartitionVector(records, WINDOW);
  const title = RC.buildTfIdfVector({ 科技: 2 }, null);

  const result = RC.compareVectors(partition, title, { allowCrossBasis: true });
  assert.equal(result.status, "space-mismatch");
  assert.equal(result.similarity, null);
  assert.equal(result.approximate, false);
});

test("48. cosineSimilarity 对跨空间返回 null（含显式近似）", () => {
  const records = root({
    "2026-11-10": { BV1: rec("BV1", "科技前沿", "科技", 60000) }
  });
  const partition = RC.buildUserPartitionVector(records, WINDOW);
  const title = RC.buildTfIdfVector({ 科技: 2 }, null);
  assert.equal(RC.cosineSimilarity(partition, title), null);
  assert.equal(
    RC.cosineSimilarity(partition, title, { allowCrossBasis: true }),
    null
  );
});

test("49. 同空间不同口径仍可显式近似", () => {
  const records = root({
    "2026-11-10": {
      BV1: rec("BV1", "科技前沿", "科技", 60000),
      BV2: rec("BV2", "生活日常", "生活", 40000)
    }
  });
  const user = RC.buildUserPartitionVector(records, WINDOW);
  const candidate = RC.buildCandidatePartitionVector(explorationCandidate(), {
    lane: "exploration"
  });
  assert.equal(user.space, "partition");
  assert.equal(candidate.space, "partition");
  const result = RC.compareVectors(user, candidate, { allowCrossBasis: true });
  assert.equal(result.status, "approximation");
  assert.equal(result.spaces.left, "partition");
  assert.equal(result.spaces.right, "partition");
});

test("50. 未声明 space 的原始稀疏向量保留数学兼容并标注限制", () => {
  assert.equal(RC.cosineSimilarity({ a: 1 }, { a: 1 }), 1);
  const result = RC.compareVectors({ a: 1 }, { a: 2 });
  assert.equal(result.status, "ok");
  assert.equal(result.similarity, 1);
  assert.deepEqual(result.spaces, { left: null, right: null });
  assert.ok(
    result.limitations.some((item) => item.indexOf("feature space") !== -1)
  );
  assert.ok(reasonCodes(result.reasons).includes("space-unspecified"));
});

test("51. 损坏的 IDF 模型被显式拒绝（非对象 / 缺字段）", () => {
  const cases = [
    ["abc", "invalid-model-object"],
    [{}, "invalid-model-enabled"],
    [{ enabled: "true", documentCount: 1, oovIdf: 1, idf: {} }, "invalid-model-enabled"],
    [{ enabled: true }, "invalid-model-document-count"],
    [{ enabled: true, documentCount: -1, oovIdf: 1, idf: {} }, "invalid-model-document-count"],
    [{ enabled: true, documentCount: 1 }, "invalid-model-oov-idf"],
    [{ enabled: true, documentCount: 1, oovIdf: Infinity, idf: {} }, "invalid-model-oov-idf"],
    [{ enabled: true, documentCount: 1, oovIdf: 1, idf: null }, "invalid-model-idf"]
  ];
  cases.forEach(([model, code]) => {
    const output = RC.buildTfIdfVector({ 甲: 1 }, model);
    assert.equal(output.status, "invalid-idf-model", code);
    assert.equal(output.available, false);
    assert.equal(output.vector, null);
    assert.equal(output.reasons[0].code, code);
  });
});

test("52. 损坏 IDF 模型：idf 值非法一律拒绝，不抛异常", () => {
  const base = { enabled: true, documentCount: 1, oovIdf: 1 };
  const cases = [
    Object.assign({}, base, { idf: { 甲: NaN } }),
    Object.assign({}, base, { idf: { 甲: Infinity } }),
    Object.assign({}, base, { idf: { 甲: 0 } }),
    Object.assign({}, base, { idf: { 甲: -1 } }),
    Object.assign({}, base, { idf: { 甲: "1" } }),
    Object.assign({}, base, { idf: {}, df: { 甲: -1 } }),
    Object.assign({}, base, { idf: {}, minDocuments: -1 })
  ];
  cases.forEach((model) => {
    let output;
    assert.doesNotThrow(() => {
      output = RC.buildTfIdfVector({ 甲: 1 }, model);
    });
    assert.equal(output.status, "invalid-idf-model");
    assert.equal(output.vector, null);
  });
});

test("53. 损坏模型不会被静默修正成统一权重", () => {
  const corrupt = { enabled: true, documentCount: 1, oovIdf: 1, idf: { 甲: NaN } };
  const rejected = RC.buildTfIdfVector({ 甲: 1 }, corrupt);
  const noModel = RC.buildTfIdfVector({ 甲: 1 }, null);
  assert.equal(rejected.status, "invalid-idf-model");
  assert.equal(rejected.vector, null);
  assert.equal(noModel.status, "ok");
  assert.equal(noModel.vector["甲"], 1);
  assert.notDeepEqual(rejected.vector, noModel.vector);
});

test("54. 损坏模型的输出可 JSON 往返且不含 NaN / Infinity", () => {
  const output = RC.buildTfIdfVector({ 甲: 1 }, {
    enabled: true,
    documentCount: 1,
    oovIdf: Infinity,
    idf: {}
  });
  assertStable(output, "拒绝输出");
  const text = JSON.stringify(output);
  assert.equal(text.includes("NaN"), false);
  assert.equal(text.includes("Infinity"), false);
  assert.equal(output.config.modelRejected, true);
  assert.equal(output.config.documentCount, null);
});

test("55. 合法模型边界仍然通过校验", () => {
  const enabled = RC.computeIdf([{ 甲: 1 }, { 甲: 1, 乙: 1 }], {
    minIdfDocuments: 1
  });
  assert.equal(RC.buildTfIdfVector({ 甲: 1 }, enabled).status, "ok");

  const disabled = RC.computeIdf([], {});
  assert.equal(disabled.enabled, false);
  assert.equal(RC.buildTfIdfVector({ 甲: 1 }, disabled).status, "ok");

  const frozen = roundTrip(enabled);
  const output = RC.buildTfIdfVector({ 甲: 2 }, frozen);
  assert.equal(output.status, "ok");
  closeTo(output.vector["甲"], (1 + Math.log(2)) * frozen.idf["甲"]);
});

test("56. 比较结果的 space 字段可审计且 JSON 稳定", () => {
  const a = RC.buildCandidatePartitionVector(mainCandidate(), { lane: "main" });
  const b = RC.buildCandidatePartitionVector(explorationCandidate(), {
    lane: "exploration"
  });
  const mismatch = RC.buildTfIdfVector({ 科技: 1 }, null);
  const okResult = RC.compareVectors(a, b, { allowCrossBasis: true });
  const badResult = RC.compareVectors(a, mismatch);
  assertStable(okResult, "近似比较结果");
  assertStable(badResult, "空间不匹配结果");
  assert.equal(badResult.spaces.right, "title");
  assert.equal(badResult.evidence.confidencePolicy, "deferred-to-c3-2");
});

/* ---------------------------------------------------------------- 输出 */

const failed = results.filter((item) => !item.ok);
results.forEach((item) => {
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}`);
  if (!item.ok) console.log(`      ${item.error && item.error.stack}`);
});
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exitCode = failed.length === 0 ? 0 : 1;
