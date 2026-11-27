"use strict";

/**
 * Bili Daily —— 用户主动导入的新 UP 主内容证据引擎（C2-4B）独立测试
 * 运行：node test-candidate-content-import.js
 *
 * 覆盖：文档结构 / 版本 / 确认；UID / BV / URL 校验；去重与冲突；
 * 分区与标题覆盖率（按视频数）；探索通道准入；时间新鲜度；上限与安全；
 * 输入不可变、JSON 往返、结果确定性、与 C1/C2 的隔离。
 *
 * 全部使用内存模拟数据；不读写 chrome.storage.local，不联网。
 * 所有时间均注入固定 NOW，不依赖真实日期。
 */

const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "stats.js"));
require(path.join(__dirname, "candidate-pool.js"));
require(path.join(__dirname, "candidate-features.js"));
require(path.join(__dirname, "candidate-content-import.js"));

const CI = globalThis.BiliDailyCandidateContentImport;
const CP = globalThis.BiliDailyCandidatePool;
const CF = globalThis.BiliDailyCandidateFeatures;

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const FRESH = "2026-11-01T00:00:00.000Z";

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

function video(bvid, title, partition, extra) {
  return Object.assign({ bvid, title, partition }, extra || {});
}

function candidate(upUid, videos, extra) {
  return Object.assign(
    { upUid, upName: "示例 UP", observedAt: FRESH, videos },
    extra || {}
  );
}

function doc(candidates, extra) {
  return Object.assign(
    {
      schemaVersion: 1,
      kind: "bili-daily-candidate-content-import",
      provenance: "user-provided",
      userConfirmed: true,
      candidates
    },
    extra || {}
  );
}

function goodVideos(mark) {
  const tag = typeof mark === "string" && mark.length === 2 ? mark : "aa";
  return [
    video(`BV1${tag}411c7mD`, "科技前沿教程", "科技"),
    video(`BV1${tag}411c7mE`, "数码产品评测", "科技"),
    video(`BV1${tag}411c7mF`, "编程入门课程", "知识")
  ];
}

function parseOk(input, options) {
  const parsed = CI.parseCandidateContentImport(input, options);
  assert.equal(parsed.status, "ok");
  return parsed;
}

function buildOk(input, options) {
  return CI.buildCandidateContentEvidence(parseOk(input, options), options);
}

function candidateOf(sidecar, uid) {
  const found = sidecar.candidates.find((item) => item.upUid === uid);
  assert.ok(found, `缺少 UID ${uid} 的 sidecar 候选`);
  return found;
}

function assessmentOf(assessment, uid) {
  const found = assessment.candidates.find((item) => item.upUid === uid);
  assert.ok(found, `缺少 UID ${uid} 的评估结果`);
  return found;
}

function reasonCodes(list) {
  return list.map((item) => item.code);
}

function tokenMap(candidateEvidence) {
  const map = {};
  candidateEvidence.titleTokens.forEach((item) => {
    map[item.token] = { count: item.count, documentCount: item.documentCount };
  });
  return map;
}

function rec(partial) {
  return Object.assign(
    {
      bvid: "BV1xx411c7mD",
      title: "历史视频",
      upName: "历史 UP",
      upUid: "200",
      partition: "科技",
      watchMs: 60000,
      startedAt: "2026-11-10T20:00:00.000+08:00",
      lastWatchedAt: "2026-11-10T20:01:00.000+08:00"
    },
    partial || {}
  );
}

function root(days) {
  return { version: 1, days };
}

/* ---------------------------------------------------------------- 1. 结构与版本 */

test("1. 合法最小文档：对象解析、校验与 sidecar 生成", () => {
  const parsed = parseOk(doc([candidate("1001", [video("BV1xx411c7mD", "科技前沿", "科技")])]));
  assert.equal(parsed.document.schemaVersion, 1);
  assert.equal(parsed.document.kind, "bili-daily-candidate-content-import");
  assert.equal(parsed.document.provenance, "user-provided");
  assert.equal(parsed.document.candidates.length, 1);
  assert.equal(parsed.document.candidates[0].upUid, "1001");

  const sidecar = CI.buildCandidateContentEvidence(parsed);
  assert.equal(sidecar.status, "ok");
  assert.equal(sidecar.kind, "bili-daily-candidate-content");
  assert.equal(sidecar.provenance, "user-provided");
  assert.equal(sidecar.lane, "exploration");
  assert.equal(sidecar.candidates.length, 1);
  const item = candidateOf(sidecar, "1001");
  assert.equal(item.importedVideoCount, 1);
  assert.equal(item.contentStatus, "partial");
  assert.equal(item.provenance, "user-provided");
});

test("2. JSON 字符串解析等价于对象，非法 JSON 不回显原文", () => {
  const source = doc([candidate("1001", [video("BV1xx411c7mD", "科技前沿", "科技")])]);
  const fromString = CI.parseCandidateContentImport(JSON.stringify(source));
  const fromObject = CI.parseCandidateContentImport(source);
  assert.equal(fromString.status, "ok");
  assert.equal(fromString.status, fromObject.status);
  assert.deepEqual(fromString.document, fromObject.document);

  const secret = "这是不该回显的原始内容";
  const broken = CI.parseCandidateContentImport(`{"secret":"${secret}",`);
  assert.equal(broken.status, "invalid");
  assert.equal(broken.reason, "invalid-json");
  assert.equal(broken.document, null);
  assert.ok(!JSON.stringify(broken).includes(secret));
});

test("3. 不支持的 schemaVersion 被拒绝", () => {
  const parsed = CI.parseCandidateContentImport(doc([], { schemaVersion: 2 }));
  assert.equal(parsed.status, "invalid");
  assert.equal(parsed.reason, "unsupported-schema");
  assert.equal(CI.buildCandidateContentEvidence(parsed).status, "invalid");
});

test("4. kind 不匹配被拒绝", () => {
  const parsed = CI.parseCandidateContentImport(doc([], { kind: "other-kind" }));
  assert.equal(parsed.status, "invalid");
  assert.equal(parsed.reason, "invalid-kind");
});

test("5. provenance 非 user-provided 被拒绝", () => {
  ["platform-observed", "official-authorized", "watched"].forEach((value) => {
    const parsed = CI.parseCandidateContentImport(doc([], { provenance: value }));
    assert.equal(parsed.status, "invalid");
    assert.equal(parsed.reason, "unsupported-provenance");
  });
});

test("6. 未确认导入被拒绝", () => {
  [false, undefined, "true", 1].forEach((value) => {
    const parsed = CI.parseCandidateContentImport(doc([], { userConfirmed: value }));
    assert.equal(parsed.status, "invalid");
    assert.equal(parsed.reason, "confirmation-required");
  });
});

test("7. 空候选安全降级为 empty", () => {
  const parsed = CI.parseCandidateContentImport(doc([]));
  assert.equal(parsed.status, "empty");
  assert.equal(parsed.reason, "no-candidates");
  const sidecar = CI.buildCandidateContentEvidence(parsed);
  assert.equal(sidecar.status, "empty");
  assert.deepEqual(sidecar.candidates, []);
  assert.equal(sidecar.summary.total, 0);
});

/* ---------------------------------------------------------------- 2. UID / BV / URL */

test("8. 合法 UID：数字与带空格字符串统一规范化", () => {
  const parsed = parseOk(
    doc([
      candidate(123456, [video("BV1xx411c7mD", "科技前沿", "科技")]),
      candidate(" 123456 ", [video("BV1yy411c7mD", "数码评测", "科技")])
    ])
  );
  assert.equal(parsed.document.candidates.length, 2);
  assert.equal(parsed.document.candidates[0].upUid, "123456");
  assert.equal(parsed.document.candidates[1].upUid, "123456");
});

test("9. 非法 UID 被跳过并计数，不猜测身份", () => {
  [0, -1, 1.5, "abc", "", "00123456"].forEach((uid) => {
    const parsed = CI.parseCandidateContentImport(
      doc([candidate(uid, [video("BV1xx411c7mD", "标题", "科技")])])
    );
    assert.equal(parsed.status, "empty");
    assert.equal(parsed.reason, "no-valid-candidates");
    assert.equal(parsed.diagnostics.candidatesInvalid, 1);
    assert.ok(parsed.diagnostics.rejectedReasons["invalid-uid"] >= 1);
  });
});

test("10. 超出安全整数的 UID 被拒绝", () => {
  const parsed = CI.parseCandidateContentImport(
    doc([candidate("9007199254740993", [video("BV1xx411c7mD", "标题", "科技")])])
  );
  assert.equal(parsed.status, "empty");
  assert.equal(parsed.diagnostics.invalidUids, 1);
});

test("11. 合法 BV：前缀大小写规范化，载荷大小写保留", () => {
  const parsed = parseOk(
    doc([candidate("1001", [video("bv1xx411c7mD", "科技前沿", "科技")])])
  );
  assert.equal(parsed.document.candidates[0].videos[0].bvid, "BV1xx411c7mD");
});

test("12. 非法 BV 被跳过，候选保留但内容缺失", () => {
  ["BV123", "AV1234567890", "", "BV1xx411c7m", "BV1xx411c7mDD"].forEach((bvid) => {
    const parsed = parseOk(doc([candidate("1001", [video(bvid, "标题", "科技")])]));
    assert.equal(parsed.document.candidates[0].videos.length, 0);
    assert.equal(parsed.diagnostics.videosInvalid, 1);
    assert.ok(parsed.diagnostics.rejectedReasons["invalid-bvid"] >= 1);
  });
  const sidecar = buildOk(doc([candidate("1001", [video("BV123", "标题", "科技")])]));
  assert.equal(candidateOf(sidecar, "1001").contentStatus, "missing");
});

test("13. URL 与显式 BV 不一致时拒绝整个视频", () => {
  const parsed = CI.parseCandidateContentImport(
    doc([
      candidate("1001", [
        video("BV1xx411c7mD", "科技前沿", "科技", {
          url: "https://www.bilibili.com/video/BV1yy411c7mD"
        })
      ])
    ])
  );
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.document.candidates[0].videos.length, 0);
  assert.equal(parsed.diagnostics.urlBvMismatch, 1);
  assert.equal(parsed.diagnostics.videosInvalid, 1);
});

test("14. 危险协议 URL 被丢弃，视频本身保留", () => {
  ["javascript:alert(1)", "data:text/html,<script>", "file:///C:/secret.txt"].forEach(
    (url) => {
      const parsed = parseOk(
        doc([candidate("1001", [video("BV1xx411c7mD", "科技前沿", "科技", { url })])])
      );
      const item = parsed.document.candidates[0].videos[0];
      assert.equal(item.url, "");
      assert.equal(item.urlState, "rejected");
      assert.equal(parsed.diagnostics.videosAccepted, 1);
    }
  );
});

test("15. 非允许域名 URL 被丢弃，视频本身保留", () => {
  const parsed = parseOk(
    doc([
      candidate("1001", [
        video("BV1xx411c7mD", "科技前沿", "科技", {
          url: "https://evil.example/video/BV1xx411c7mD"
        })
      ])
    ])
  );
  const item = parsed.document.candidates[0].videos[0];
  assert.equal(item.url, "");
  assert.equal(item.urlState, "rejected");
  assert.equal(parsed.diagnostics.videosAccepted, 1);
});

test("16. 合法视频 URL 去掉 query/hash 并规范化", () => {
  const parsed = parseOk(
    doc([
      candidate("1001", [
        video("BV1xx411c7mD", "科技前沿", "科技", {
          url: "https://m.bilibili.com/video/BV1xx411c7mD?p=1&vd_source=abc#reply"
        })
      ])
    ])
  );
  const item = parsed.document.candidates[0].videos[0];
  assert.equal(item.url, "https://www.bilibili.com/video/BV1xx411c7mD");
  assert.equal(item.urlState, "accepted");
});

test("17. b23.tv 短链不解析，仅丢弃 URL", () => {
  const parsed = parseOk(
    doc([
      candidate("1001", [
        video("BV1xx411c7mD", "科技前沿", "科技", { url: "https://b23.tv/abc123" })
      ])
    ])
  );
  const item = parsed.document.candidates[0].videos[0];
  assert.equal(item.url, "");
  assert.equal(item.urlState, "short-link");
  assert.equal(parsed.diagnostics.videosAccepted, 1);
});

test("18. 空间链接不能验证 BV，按非视频链接丢弃", () => {
  const parsed = parseOk(
    doc([
      candidate("1001", [
        video("BV1xx411c7mD", "科技前沿", "科技", {
          url: "https://space.bilibili.com/123456"
        })
      ])
    ])
  );
  const item = parsed.document.candidates[0].videos[0];
  assert.equal(item.url, "");
  assert.equal(item.urlState, "not-video-url");
});

/* ---------------------------------------------------------------- 3. 去重与冲突 */

test("19. 同一 UID 多次出现合并，视频取并集", () => {
  const sidecar = buildOk(
    doc([
      candidate("1001", [video("BV1xx411c7mD", "科技前沿", "科技")]),
      candidate("1001", [video("BV1yy411c7mD", "数码评测", "科技")], {
        upName: "另一个昵称"
      })
    ])
  );
  assert.equal(sidecar.candidates.length, 1);
  assert.equal(candidateOf(sidecar, "1001").importedVideoCount, 2);
  assert.equal(sidecar.diagnostics.candidatesMerged, 1);
});

test("20. 同一 UID 改名：合并，昵称仅展示且选择确定", () => {
  const sidecar = buildOk(
    doc([
      candidate("1001", [video("BV1xx411c7mD", "科技前沿", "科技")], { upName: "甲" }),
      candidate("1001", [video("BV1yy411c7mD", "数码评测", "科技")], { upName: "乙" })
    ])
  );
  const item = candidateOf(sidecar, "1001");
  assert.equal(item.nameConflict, true);
  assert.deepEqual(item.names, ["乙", "甲"]);
  assert.equal(item.upName, "乙");
});

test("21. 不同 UID 同名保持分开（昵称不参与身份判定）", () => {
  const sidecar = buildOk(
    doc([
      candidate("1001", [video("BV1xx411c7mD", "科技前沿", "科技")], { upName: "同名" }),
      candidate("1002", [video("BV1yy411c7mD", "数码评测", "科技")], { upName: "同名" })
    ])
  );
  assert.equal(sidecar.candidates.length, 2);
  assert.equal(candidateOf(sidecar, "1001").upName, "同名");
  assert.equal(candidateOf(sidecar, "1002").upName, "同名");
});

test("22. 同 UID 重复 BV：只算一个视频，词频不膨胀", () => {
  const sidecar = buildOk(
    doc([
      candidate("1001", [
        video("BV1xx411c7mD", "科技前沿", "科技"),
        video("BV1xx411c7mD", "科技前沿", "科技")
      ])
    ])
  );
  const item = candidateOf(sidecar, "1001");
  assert.equal(item.importedVideoCount, 1);
  assert.equal(sidecar.diagnostics.duplicateVideos, 1);
  const tokens = tokenMap(item);
  assert.equal(tokens["科技"].count, 1);
  assert.equal(tokens["科技"].documentCount, 1);
});

test("23. 不同 UID 导入同一 BV：身份冲突，视频不参与任何一方特征", () => {
  const conflictSidecar = buildOk(
    doc([
      candidate("1001", [video("BV1xx411c7mD", "科技前沿", "科技")]),
      candidate("1002", [video("BV1xx411c7mD", "科技前沿", "科技")], { upName: "另一个" })
    ])
  );
  const first = candidateOf(conflictSidecar, "1001");
  const second = candidateOf(conflictSidecar, "1002");
  assert.equal(conflictSidecar.candidates.length, 2);
  assert.equal(first.conflictVideoCount, 1);
  assert.equal(second.conflictVideoCount, 1);
  assert.equal(first.contentStatus, "conflicted");
  assert.equal(second.contentStatus, "conflicted");
  assert.equal(first.videos[0].status, "uid-conflict");
  assert.equal(first.importedPartitionCount, 0);
  assert.equal(first.partitionCoverage, null);
  assert.equal(first.titleTokens.length, 0);
  assert.ok(reasonCodes(first.reasons).includes("uid-conflict-in-import"));
});

test("24. 同一 BV 的标题/分区互相矛盾：标记 metadata-conflict 并排除", () => {
  const sidecar = buildOk(
    doc([
      candidate("1001", [
        video("BV1xx411c7mD", "标题甲", "科技"),
        video("BV1xx411c7mD", "标题乙", "科技")
      ])
    ])
  );
  const item = candidateOf(sidecar, "1001");
  assert.equal(item.importedVideoCount, 1);
  assert.equal(item.metadataConflictVideoCount, 1);
  assert.equal(item.videos[0].status, "metadata-conflict");
  assert.deepEqual(item.videos[0].conflictFields, ["title"]);
  assert.equal(item.contentStatus, "missing");
  assert.ok(reasonCodes(item.reasons).includes("metadata-conflict"));
});

test("25. 缺失字段 + 有值不构成冲突", () => {
  const sidecar = buildOk(
    doc([
      candidate("1001", [
        video("BV1xx411c7mD", "科技前沿", ""),
        video("BV1xx411c7mD", "科技前沿", "科技")
      ])
    ])
  );
  const item = candidateOf(sidecar, "1001");
  assert.equal(item.metadataConflictVideoCount, 0);
  assert.equal(item.videos[0].partition, "科技");
  assert.equal(item.videos[0].status, "usable");
});

/* ---------------------------------------------------------------- 4. 内容特征 */

test("26. 标题 bigram 与 C2-3 extractTitleBigrams 完全一致", () => {
  const title = "Hello,世界! 2026 ＡＩ";
  const sidecar = buildOk(
    doc([candidate("1001", [video("BV1xx411c7mD", title, "科技")])])
  );
  const item = candidateOf(sidecar, "1001");
  const expected = CF.extractTitleBigrams(title);
  const expectedMap = {};
  expected.forEach((token) => {
    expectedMap[token] = (expectedMap[token] || 0) + 1;
  });
  const actual = {};
  item.titleTokens.forEach((entry) => {
    actual[entry.token] = entry.count;
  });
  assert.deepEqual(actual, expectedMap);
});

test("27. 分区覆盖率按视频数计算，缺失分区计入分母", () => {
  const sidecar = buildOk(
    doc([
      candidate("1001", [
        video("BV1xx411c7mD", "科技前沿", "科技"),
        video("BV1yy411c7mD", "数码评测", "科技"),
        video("BV1zz411c7mD", "生活日常", "生活"),
        video("BV1aa411c7mD", "没有分区", "")
      ])
    ])
  );
  const item = candidateOf(sidecar, "1001");
  assert.equal(item.importedVideoCount, 4);
  assert.equal(item.importedPartitionCount, 3);
  assert.equal(item.partitionCoverage, 0.75);
  assert.equal(item.partitionCoverageState, "available");
  assert.equal(item.missingPartitionCount, undefined); // 不输出内部计数
  const shares = item.partitionCounts.reduce(
    (sum, entry) => sum + entry.shareOfImportedVideos,
    0
  );
  assert.ok(Math.abs(shares - 0.75) < 1e-9);
  assert.equal(item.partitionCounts[0].name, "科技");
  assert.equal(item.partitionCounts[0].videoCount, 2);
});

test("28. 标题覆盖率按视频数计算，缺失标题计入分母", () => {
  const sidecar = buildOk(
    doc([
      candidate("1001", [
        video("BV1xx411c7mD", "科技前沿", "科技"),
        video("BV1yy411c7mD", "数码评测", "科技"),
        video("BV1zz411c7mD", "生活日常", "生活"),
        video("BV1aa411c7mD", "", "知识")
      ])
    ])
  );
  const item = candidateOf(sidecar, "1001");
  assert.equal(item.importedTitleCount, 3);
  assert.equal(item.titleCoverage, 0.75);
  assert.equal(item.titleCoverageState, "available");
});

test("29. 缺失标题与单字符标题不虚构词元", () => {
  const sidecar = buildOk(
    doc([
      candidate("1001", [
        video("BV1xx411c7mD", "", "科技"),
        video("BV1yy411c7mD", "猫", "科技"),
        video("BV1zz411c7mD", "科技前沿", "科技")
      ])
    ])
  );
  const item = candidateOf(sidecar, "1001");
  assert.equal(item.importedTitleCount, 1);
  assert.ok(Math.abs(item.titleCoverage - 1 / 3) < 1e-9);
  assert.equal(item.titleTokens.length > 0, true);
  assert.equal(item.videos.find((v) => v.bvid === "BV1yy411c7mD").titleState, "tokenless");
  assert.equal(item.videos.find((v) => v.bvid === "BV1xx411c7mD").titleState, "missing");
});

test("30. 没有可用视频时覆盖率为 null 并标记 no-data", () => {
  const sidecar = buildOk(doc([candidate("1001", [])]));
  const item = candidateOf(sidecar, "1001");
  assert.equal(item.importedVideoCount, 0);
  assert.equal(item.partitionCoverage, null);
  assert.equal(item.titleCoverage, null);
  assert.equal(item.partitionCoverageState, "no-data");
  assert.equal(item.titleCoverageState, "no-data");
  assert.equal(item.contentStatus, "missing");
});

test("31. tags 去重、排序、数量与长度受限", () => {
  const tags = [];
  for (let index = 1; index <= 25; index += 1) tags.push(`tag-${index}`);
  const parsed = parseOk(
    doc([
      candidate("1001", [
        video("BV1xx411c7mD", "科技前沿", "科技", {
          tags: tags.concat(["tag-1", "x".repeat(80), 42, ""])
        })
      ])
    ])
  );
  const item = parsed.document.candidates[0].videos[0];
  assert.equal(item.tags.length, 20);
  assert.equal(item.tags[0], "tag-1");
  assert.equal(item.tags.indexOf("tag-1"), 0);
  assert.equal(item.tags.filter((tag) => tag === "tag-1").length, 1);
  assert.ok(item.tags.every((tag) => tag.length <= 50));
});

/* ---------------------------------------------------------------- 5. 时间与探索准入 */

function freshSidecar(extraVideo) {
  return buildOk(
    doc([
      candidate("1001", [
        video("BV1xx411c7mD", "科技前沿教程", "科技"),
        video("BV1yy411c7mD", "数码产品评测", "科技"),
        video("BV1zz411c7mD", "编程入门课程", "知识")
      ].concat(extraVideo ? [extraVideo] : []))
    ])
  );
}

test("32. 满足全部实验阈值：eligibleForExploration 为 true", () => {
  const sidecar = freshSidecar();
  const assessment = CI.assessImportedContentCandidates(sidecar, root({}), { now: NOW });
  const item = assessmentOf(assessment, "1001");
  assert.equal(item.promotion.eligibleForExploration, true);
  assert.equal(item.promotion.status, "eligible");
  assert.equal(item.contentEvidence.contentStatus, "complete");
  assert.equal(item.identityEvidence.onlineVerified, false);
  assert.equal(item.identityEvidence.fromWatchHistory, false);
  assert.equal(item.identityEvidence.sources[0], "user-provided");
});

test("33. 视频数低于实验阈值：false，原因 insufficient-videos", () => {
  const sidecar = buildOk(
    doc([
      candidate("1001", [
        video("BV1xx411c7mD", "科技前沿", "科技"),
        video("BV1yy411c7mD", "数码评测", "科技")
      ])
    ])
  );
  const assessment = CI.assessImportedContentCandidates(sidecar, {}, { now: NOW });
  const item = assessmentOf(assessment, "1001");
  assert.equal(item.promotion.eligibleForExploration, false);
  assert.ok(reasonCodes(item.promotion.reasons).includes("insufficient-videos"));
});

test("34. 分区覆盖率低于阈值：false", () => {
  const sidecar = buildOk(
    doc([
      candidate("1001", [
        video("BV1xx411c7mD", "科技前沿", "科技"),
        video("BV1yy411c7mD", "数码评测", "科技"),
        video("BV1zz411c7mD", "生活日常", ""),
        video("BV1aa411c7mD", "没有分区", "")
      ])
    ])
  );
  const assessment = CI.assessImportedContentCandidates(sidecar, {}, { now: NOW });
  const item = assessmentOf(assessment, "1001");
  assert.equal(item.promotion.eligibleForExploration, false);
  assert.ok(reasonCodes(item.promotion.reasons).includes("partition-coverage-low"));
});

test("35. 标题覆盖率低于阈值：false", () => {
  const sidecar = buildOk(
    doc([
      candidate("1001", [
        video("BV1xx411c7mD", "科技前沿", "科技"),
        video("BV1yy411c7mD", "数码评测", "科技"),
        video("BV1zz411c7mD", "", "知识"),
        video("BV1aa411c7mD", "", "知识")
      ])
    ])
  );
  const assessment = CI.assessImportedContentCandidates(sidecar, {}, { now: NOW });
  const item = assessmentOf(assessment, "1001");
  assert.equal(item.promotion.eligibleForExploration, false);
  assert.ok(reasonCodes(item.promotion.reasons).includes("title-coverage-low"));
});

test("36. 缺少观察时间：保留候选，但不能晋升", () => {
  const sidecar = buildOk(
    doc([
      {
        upUid: "1001",
        upName: "示例 UP",
        videos: goodVideos("aa")
      }
    ])
  );
  assert.equal(candidateOf(sidecar, "1001").observedAtState, "unknown");
  const assessment = CI.assessImportedContentCandidates(sidecar, {}, { now: NOW });
  const item = assessmentOf(assessment, "1001");
  assert.equal(item.freshness.state, "unknown");
  assert.equal(item.promotion.eligibleForExploration, false);
  assert.ok(reasonCodes(item.promotion.reasons).includes("missing-observation-time"));
});

test("37. 非法观察时间：标记 invalid，不晋升", () => {
  const sidecar = buildOk(
    doc([
      candidate("1001", goodVideos("aa"), { observedAt: "not-a-date" })
    ])
  );
  assert.equal(candidateOf(sidecar, "1001").observedAtState, "invalid");
  const assessment = CI.assessImportedContentCandidates(sidecar, {}, { now: NOW });
  const item = assessmentOf(assessment, "1001");
  assert.equal(item.freshness.state, "invalid");
  assert.equal(item.promotion.eligibleForExploration, false);
  assert.ok(reasonCodes(item.promotion.reasons).includes("invalid-observation-time"));
});

test("38. 未来观察时间：不晋升", () => {
  const sidecar = buildOk(
    doc([
      candidate("1001", goodVideos("aa"), {
        observedAt: "2026-12-01T00:00:00.000Z"
      })
    ])
  );
  const assessment = CI.assessImportedContentCandidates(sidecar, {}, { now: NOW });
  const item = assessmentOf(assessment, "1001");
  assert.equal(item.freshness.state, "future");
  assert.equal(item.promotion.eligibleForExploration, false);
  assert.ok(reasonCodes(item.promotion.reasons).includes("future-observation-time"));
});

test("39. 超过 180 天：stale，保留但不能晋升", () => {
  const sidecar = buildOk(
    doc([
      candidate("1001", goodVideos("aa"), {
        observedAt: NOW - 181 * DAY_MS
      })
    ])
  );
  const assessment = CI.assessImportedContentCandidates(sidecar, {}, { now: NOW });
  const item = assessmentOf(assessment, "1001");
  assert.equal(item.freshness.state, "stale");
  assert.equal(item.promotion.eligibleForExploration, false);
  assert.ok(reasonCodes(item.promotion.reasons).includes("stale-observation"));
});

test("40. 恰好等于 180 天：仍算 fresh，可晋升", () => {
  const sidecar = buildOk(
    doc([
      candidate("1001", goodVideos("aa"), {
        observedAt: NOW - 180 * DAY_MS
      })
    ])
  );
  const assessment = CI.assessImportedContentCandidates(sidecar, {}, { now: NOW });
  const item = assessmentOf(assessment, "1001");
  assert.equal(item.freshness.state, "fresh");
  assert.equal(item.freshness.ageDays, 180);
  assert.equal(item.promotion.eligibleForExploration, true);
});

test("41. 自定义阈值生效，并明确标记为实验值", () => {
  const sidecar = buildOk(
    doc([
      candidate("1001", [video("BV1xx411c7mD", "科技前沿", "科技")])
    ])
  );
  const assessment = CI.assessImportedContentCandidates(sidecar, {}, {
    now: NOW,
    thresholds: {
      minImportedVideos: 1,
      minPartitionCoverage: 0,
      minTitleCoverage: 0,
      maxAgeDays: 30
    }
  });
  const item = assessmentOf(assessment, "1001");
  assert.equal(item.promotion.eligibleForExploration, true);
  assert.equal(assessment.thresholds.minImportedVideos, 1);
  assert.equal(assessment.thresholds.maxAgeDays, 30);
  assert.equal(assessment.thresholds.experimental, true);
});

/* ---------------------------------------------------------------- 6. 跨来源冲突 */

test("42. 导入 BV 与本地观看记录 UID 不一致：跨来源冲突", () => {
  const sidecar = buildOk(
    doc([
      candidate("1001", [
        video("BV1xx411c7mD", "科技前沿", "科技"),
        video("BV1yy411c7mD", "数码评测", "科技"),
        video("BV1zz411c7mD", "编程入门", "知识")
      ])
    ])
  );
  const records = root({
    "2026-11-10": {
      BV1xx411c7mD: rec({ bvid: "BV1xx411c7mD", upUid: "200" })
    }
  });
  const before = JSON.stringify(records);
  const assessment = CI.assessImportedContentCandidates(sidecar, records, { now: NOW });
  const item = assessmentOf(assessment, "1001");
  assert.equal(item.identityEvidence.crossSourceConflictVideoCount, 1);
  assert.equal(item.contentEvidence.trustedVideoCount, 2);
  assert.equal(item.promotion.eligibleForExploration, false);
  assert.ok(reasonCodes(item.promotion.reasons).includes("uid-conflict-with-history"));
  assert.equal(JSON.stringify(records), before);
});

test("43. 历史记录内部同 BV 多 UID：导入内容同样不可信", () => {
  const sidecar = buildOk(
    doc([candidate("1001", goodVideos("aa"))])
  );
  const records = root({
    "2026-11-09": { A: rec({ bvid: "BV1aa411c7mD", upUid: "200" }) },
    "2026-11-10": { A: rec({ bvid: "BV1aa411c7mD", upUid: "300" }) }
  });
  const assessment = CI.assessImportedContentCandidates(sidecar, records, { now: NOW });
  const item = assessmentOf(assessment, "1001");
  assert.equal(item.identityEvidence.crossSourceConflictVideoCount, 1);
  assert.equal(item.contentEvidence.trustedVideoCount, 2);
  assert.ok(reasonCodes(item.promotion.reasons).includes("uid-conflict-with-history"));
});

test("44. 本地观看同一 UID 的同一 BV：不算冲突，仍记录观看历史", () => {
  const sidecar = buildOk(doc([candidate("1001", goodVideos("aa"))]));
  const records = root({
    "2026-11-10": { A: rec({ bvid: "BV1aa411c7mD", upUid: "1001" }) }
  });
  const assessment = CI.assessImportedContentCandidates(sidecar, records, { now: NOW });
  const item = assessmentOf(assessment, "1001");
  assert.equal(item.identityEvidence.crossSourceConflictVideoCount, 0);
  assert.equal(item.identityEvidence.fromWatchHistory, true);
  assert.equal(item.identityEvidence.localWatchedVideoCount, 1);
  assert.equal(item.promotion.eligibleForExploration, true);
});

/* ---------------------------------------------------------------- 7. 安全、上限与不可变 */

test("45. 输入对象深度冻结仍可处理且不被修改", () => {
  const importDoc = deepFreeze(
    doc([candidate("1001", goodVideos("aa"))])
  );
  const records = deepFreeze(
    root({ "2026-11-10": { A: rec({ bvid: "BV1aa411c7mD", upUid: "200" }) } })
  );
  const snapshot = JSON.stringify(importDoc);
  const parsed = CI.parseCandidateContentImport(importDoc);
  const sidecar = CI.buildCandidateContentEvidence(parsed);
  const assessment = CI.assessImportedContentCandidates(sidecar, records, { now: NOW });
  assert.equal(assessment.status, "ok");
  assert.equal(JSON.stringify(importDoc), snapshot);
});

test("46. 结果可 JSON 序列化往返", () => {
  const sidecar = freshSidecar();
  const assessment = CI.assessImportedContentCandidates(sidecar, {}, { now: NOW });
  assert.deepEqual(JSON.parse(JSON.stringify(sidecar)), sidecar);
  assert.deepEqual(JSON.parse(JSON.stringify(assessment)), assessment);
});

test("47. 结果确定：输入顺序变化不改变输出", () => {
  const videosA = [
    video("BV1xx411c7mD", "科技前沿", "科技"),
    video("BV1yy411c7mD", "数码评测", "科技"),
    video("BV1zz411c7mD", "编程入门", "知识")
  ];
  const first = buildOk(doc([candidate("1001", videosA)]));
  const second = buildOk(
    doc([candidate("1001", videosA.slice().reverse())])
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(first)),
    JSON.parse(JSON.stringify(second))
  );

  const shuffled = buildOk(
    doc([
      candidate("1002", [video("BV1bb411c7mD", "生活日常", "生活")]),
      candidate("1001", videosA.slice().reverse())
    ])
  );
  const ordered = buildOk(
    doc([
      candidate("1001", videosA),
      candidate("1002", [video("BV1bb411c7mD", "生活日常", "生活")])
    ])
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(shuffled.candidates)),
    JSON.parse(JSON.stringify(ordered.candidates))
  );
});

test("48. 空输入与异常对象安全降级", () => {
  assert.equal(CI.parseCandidateContentImport(null).status, "empty");
  assert.equal(CI.parseCandidateContentImport("").status, "empty");
  assert.equal(CI.parseCandidateContentImport("   ").status, "empty");
  assert.equal(CI.parseCandidateContentImport([]).status, "invalid");
  assert.equal(CI.parseCandidateContentImport(42).status, "invalid");
  assert.equal(CI.parseCandidateContentImport({}).reason, "unsupported-schema");
  assert.equal(
    CI.buildCandidateContentEvidence(null).status,
    "invalid"
  );
});

test("49. 候选数、单候选视频数、总视频数与输入体积上限", () => {
  const candidates = ["1001", "1002", "1003"].map((uid) =>
    candidate(uid, [
      video("BV1xx411c7mD", "标题一", "科技"),
      video("BV1yy411c7mD", "标题二", "科技"),
      video("BV1zz411c7mD", "标题三", "科技")
    ], { upName: uid })
  );
  const limited = buildOk(doc(candidates), {
    limits: { maxCandidates: 2, maxVideosPerCandidate: 2, maxTotalVideos: 3 }
  });
  assert.equal(limited.candidates.length, 2);
  assert.equal(limited.diagnostics.candidatesDroppedByLimit, 1);
  assert.ok(limited.diagnostics.videosTruncated >= 2);
  assert.ok(limited.diagnostics.globalVideoLimitDropped >= 1);
  assert.ok(
    limited.candidates.every((item) => item.videosTruncated || item.globalVideoLimitDropped)
  );

  const tooLarge = CI.parseCandidateContentImport(JSON.stringify(doc(candidates)), {
    limits: { maxInputBytes: 10 }
  });
  assert.equal(tooLarge.status, "invalid");
  assert.equal(tooLarge.reason, "input-too-large");
});

test("50. 原型污染键不污染原型，也不造成崩溃", () => {
  const source = doc([
    candidate("1001", [
      video("BV1xx411c7mD", "constructor", "__proto__"),
      video("BV1yy411c7mD", "prototype", "constructor")
    ])
  ]);
  Object.defineProperty(source, "__proto__", {
    value: { polluted: true },
    enumerable: true,
    configurable: true
  });
  source.extraUnknown = { polluted: true };
  const parsed = parseOk(source);
  const sidecar = CI.buildCandidateContentEvidence(parsed);
  const item = candidateOf(sidecar, "1001");
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.ok(item.partitionCounts.some((entry) => entry.name === "__proto__"));
  assert.ok(item.partitionCounts.some((entry) => entry.name === "constructor"));
  assert.ok(JSON.stringify(sidecar).includes("__proto__"));
});

test("51. 不产生观看时长，也不写入观看记录字段", () => {
  const sidecar = freshSidecar();
  const serialized = JSON.stringify(sidecar);
  assert.ok(!serialized.includes("watchMs"));
  assert.ok(!serialized.includes("watchedWatchMs"));
  assert.ok(!serialized.includes("watchedVideoCount"));
  sidecar.candidates.forEach((item) => {
    assert.equal(Object.prototype.hasOwnProperty.call(item, "watchMs"), false);
  });
  const assessment = CI.assessImportedContentCandidates(sidecar, {}, { now: NOW });
  assert.ok(!JSON.stringify(assessment).includes("watchMs"));
});

test("52. 不改变 C1 / C2-1 / C2-2 / C2-3 的既有判断", () => {
  const records = root({
    "2026-11-10": {
      A: rec({ bvid: "BV1aa411c7mD", upUid: "1001", watchMs: 200000 }),
      B: rec({ bvid: "BV1bb411c7mD", upUid: "1001", watchMs: 200000 })
    }
  });
  const poolBefore = CP.buildFromRecords(records);
  const featureBefore = CF.buildCandidateFeatures(records, poolBefore);
  const snapshotPool = JSON.stringify(poolBefore);
  const snapshotFeature = JSON.stringify(featureBefore);
  const snapshotRecords = JSON.stringify(records);

  const sidecar = buildOk(doc([candidate("1001", goodVideos("aa"))]));
  CI.assessImportedContentCandidates(sidecar, records, { now: NOW });

  const poolAfter = CP.buildFromRecords(records);
  const featureAfter = CF.buildCandidateFeatures(records, poolAfter);
  assert.equal(JSON.stringify(records), snapshotRecords);
  assert.equal(JSON.stringify(poolAfter), snapshotPool);
  assert.equal(JSON.stringify(featureAfter), snapshotFeature);
  assert.equal(poolAfter.candidates[0].uidVerified, true);
  assert.equal(featureAfter.candidates[0].featureStatus, "ready");
});

test("53. 导入-only 候选在 C2-2 / C2-3 中仍是 review / missing", () => {
  const records = root({});
  const manualPool = CP.buildFromManual(["1001"]);
  const judged = CP.filterEligibleCandidates(manualPool, { now: NOW });
  assert.equal(judged.eligible.length, 0);
  assert.equal(judged.review.length, 1);

  const features = CF.buildCandidateFeatures(records, manualPool);
  const feature = features.candidates.find((item) => item.upUid === "1001");
  assert.equal(feature.featureStatus, "missing");
  assert.equal(feature.partitionCoverage, null);
  assert.equal(feature.titleCoverage, null);

  // C2-4B 的 sidecar 不参与上述判断：内容完整也不改变 featureStatus。
  const sidecar = buildOk(doc([candidate("1001", goodVideos("aa"))]));
  CI.assessImportedContentCandidates(sidecar, records, { now: NOW });
  const featuresAgain = CF.buildCandidateFeatures(records, manualPool);
  assert.equal(featuresAgain.candidates[0].featureStatus, "missing");
});

test("54. 两条通道明确区分：exploration lane 与 user-provided 来源", () => {
  const sidecar = freshSidecar();
  assert.equal(sidecar.lane, "exploration");
  assert.equal(sidecar.provenance, "user-provided");
  const assessment = CI.assessImportedContentCandidates(sidecar, {}, { now: NOW });
  assert.equal(assessment.lane, "exploration");
  const item = assessmentOf(assessment, "1001");
  assert.equal(item.lane, "exploration");
  assert.equal(item.identityEvidence.sources.includes("watched"), false);
  assert.equal(item.identityEvidence.sources.includes("manual"), false);
  assert.equal(item.identityEvidence.sources.includes("user-provided"), true);
  assert.equal(item.identityEvidence.onlineVerified, false);
});

test("55. 未知字段只计数，不执行、不参与特征", () => {
  const source = doc([
    candidate("1001", [
      video("BV1xx411c7mD", "科技前沿", "科技", { evil: "javascript:alert(1)" })
    ], { extra: { nested: true } })
  ], { extraTop: [1, 2, 3] });
  const parsed = parseOk(source);
  const sidecar = CI.buildCandidateContentEvidence(parsed);
  assert.ok(parsed.diagnostics.unknownFields >= 2);
  assert.equal(candidateOf(sidecar, "1001").importedVideoCount, 1);
  assert.ok(!JSON.stringify(sidecar).includes("javascript:alert"));
});

test("56. 名称与备注截断，不保留超长文本", () => {
  const parsed = parseOk(
    doc([candidate("1001", goodVideos("aa"), { upName: "名".repeat(300) })], {
      sourceNote: "备".repeat(900)
    })
  );
  assert.equal(parsed.document.candidates[0].upName.length, 100);
  assert.equal(parsed.document.sourceNote.length, 500);
});

test("57. 单候选视频去重后按 BV 稳定截断，与输入顺序无关", () => {
  const videos = [
    video("BV1cc411c7mD", "标题丙", "科技"),
    video("BV1aa411c7mD", "标题甲", "科技"),
    video("BV1bb411c7mD", "标题乙", "科技")
  ];
  const first = buildOk(doc([candidate("1001", videos)]), {
    limits: { maxVideosPerCandidate: 2 }
  });
  const second = buildOk(doc([candidate("1001", videos.slice().reverse())]), {
    limits: { maxVideosPerCandidate: 2 }
  });
  assert.deepEqual(
    first.candidates[0].videos.map((item) => item.bvid),
    second.candidates[0].videos.map((item) => item.bvid)
  );
  assert.deepEqual(
    first.candidates[0].videos.map((item) => item.bvid),
    ["BV1aa411c7mD", "BV1bb411c7mD"]
  );
});

test("58. 全部视频被冲突排除时 contentStatus 为 conflicted", () => {
  const sidecar = buildOk(
    doc([
      candidate("1001", [video("BV1xx411c7mD", "科技前沿", "科技")]),
      candidate("1002", [video("BV1xx411c7mD", "科技前沿", "科技")])
    ])
  );
  const item = candidateOf(sidecar, "1001");
  assert.equal(item.contentStatus, "conflicted");
  assert.equal(item.usableVideoCount, 0);
  const assessment = CI.assessImportedContentCandidates(sidecar, {}, { now: NOW });
  const judged = assessmentOf(assessment, "1001");
  assert.equal(judged.promotion.eligibleForExploration, false);
  assert.equal(judged.promotion.status, "pending-review");
  assert.equal(judged.contentEvidence.contentStatus, "conflicted");
});

test("59. 导入内容完整度不等于平台核验：onlineVerified 恒为 false", () => {
  const sidecar = buildOk(
    doc([candidate("1001", goodVideos("aa"))], {
      provenance: "user-provided",
      userConfirmed: true
    })
  );
  assert.equal(sidecar.candidates[0].provenance, "user-provided");
  const assessment = CI.assessImportedContentCandidates(sidecar, {}, {
    now: NOW,
    thresholds: { minImportedVideos: 1, minPartitionCoverage: 0, minTitleCoverage: 0 }
  });
  const item = assessmentOf(assessment, "1001");
  assert.equal(item.promotion.eligibleForExploration, true);
  assert.equal(item.identityEvidence.onlineVerified, false);
  assert.equal(item.identityEvidence.provenance, "user-provided");
  assert.ok(JSON.stringify(assessment).includes("未在线核验"));
});

test("60. 评估结果对观测时间缺失/过期的候选保留，不删除", () => {
  const sidecar = buildOk(
    doc([
      candidate("1001", goodVideos("aa"), { observedAt: NOW - 400 * DAY_MS }),
      candidate("1002", goodVideos("bb"), { observedAt: "bad-time" })
    ])
  );
  const assessment = CI.assessImportedContentCandidates(sidecar, {}, { now: NOW });
  assert.equal(assessment.candidates.length, 2);
  assert.equal(assessment.summary.total, 2);
  assessment.candidates.forEach((item) => {
    assert.equal(item.promotion.eligibleForExploration, false);
    assert.ok(item.contentEvidence.trustedVideoCount > 0);
  });
});

/* ---------------------------------------------------------------- 输出 */

const failed = results.filter((item) => !item.ok);
results.forEach((item) => {
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}`);
  if (!item.ok) console.log(`      ${item.error && item.error.stack}`);
});
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exitCode = failed.length === 0 ? 0 : 1;
