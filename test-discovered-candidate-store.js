"use strict";

/**
 * Bili Daily —— page-observed 候选存储与证据适配测试
 * 运行：node test-discovered-candidate-store.js
 *
 * 使用内存版 chrome.storage.local，不联网、不启动浏览器扩展。
 * 覆盖：默认关闭、白名单字段、去重、跨页累积、冲突、过期、容量、
 * 自动准入、缺失字段降级、已观看排除、空状态、不可变与稳定 JSON。
 */

const assert = require("node:assert/strict");
const path = require("node:path");

function installChrome() {
  const data = Object.create(null);
  const writes = [];
  globalThis.chrome = {
    runtime: { lastError: null },
    storage: {
      local: {
        get(key, callback) {
          callback({ [key]: data[key] });
        },
        set(payload, callback) {
          writes.push(JSON.parse(JSON.stringify(payload)));
          Object.keys(payload).forEach((key) => {
            data[key] = JSON.parse(JSON.stringify(payload[key]));
          });
          if (callback) callback();
        }
      }
    }
  };
  return { data, writes };
}

const chromeMock = installChrome();

require(path.join(__dirname, "storage.js"));
require(path.join(__dirname, "stats.js"));
require(path.join(__dirname, "candidate-features.js"));
require(path.join(__dirname, "discovered-candidate-store.js"));

const Store = globalThis.BiliDailyDiscoveredCandidateStore;

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

function resetStorage() {
  Object.keys(chromeMock.data).forEach((key) => delete chromeMock.data[key]);
  chromeMock.writes.length = 0;
}

function bvid(index) {
  return `BV1${String(index).padStart(9, "0")}`;
}

function observation(options) {
  const opts = options || {};
  return {
    upUid: opts.upUid || "2001",
    upName: opts.upName == null ? "观察UP" : opts.upName,
    bvid: opts.bvid || bvid(1),
    title: opts.title == null ? `观察标题${opts.bvid || bvid(1)}` : opts.title,
    partition: opts.partition == null ? "科技" : opts.partition,
    observedAt: opts.observedAt || new Date(NOW - DAY).toISOString(),
    sourcePageBvid: opts.sourcePageBvid || bvid(900),
    provenance:
      opts.provenance === undefined ? "page-observed" : opts.provenance,
    observationScope:
      opts.observationScope === undefined
        ? "related-recommendation-card"
        : opts.observationScope,
    html: "<script>alert(1)</script>",
    script: "alert(1)",
    cookie: "SESSDATA=secret",
    token: "secret-token"
  };
}

async function enable(settings) {
  const result = await Store.saveSettings(
    Object.assign({ enabled: true }, settings || {})
  );
  assert.equal(result.ok, true);
  return result.settings;
}

function recordsWithUp(uid) {
  return {
    version: 1,
    days: {
      "2026-11-10": {
        [bvid(4)]: {
          bvid: bvid(4),
          upUid: uid,
          upName: "已观看UP",
          title: "已看",
          partition: "科技",
          watchMs: 600000,
          startedAt: "2026-11-10T12:00:00.000Z",
          lastWatchedAt: "2026-11-10T12:00:00.000Z"
        }
      }
    }
  };
}

function frozen(value) {
  if (value && typeof value === "object") {
    Object.getOwnPropertyNames(value).forEach((key) => frozen(value[key]));
    Object.freeze(value);
  }
  return value;
}

async function main() {
  await test("1. 默认设置关闭自动发现", async () => {
    resetStorage();
    const result = await Store.readSettings();
    assert.equal(result.ok, true);
    assert.equal(result.settings.enabled, false);
  });

  await test("2. 关闭状态下 addObservations 不产生任何写入", async () => {
    resetStorage();
    const result = await Store.addObservations([observation()], { now: NOW });
    assert.equal(result.ok, true);
    assert.equal(result.disabled, true);
    assert.equal(chromeMock.writes.length, 0);
  });

  await test("3. 开启后按 UID + BV 保存，且只保留白名单字段", async () => {
    resetStorage();
    await enable();
    const result = await Store.addObservations(
      [observation({ bvid: bvid(1), upUid: "2001" })],
      { now: NOW }
    );
    assert.equal(result.ok, true);
    assert.equal(result.added, 1);
    const read = await Store.readStore();
    assert.equal(read.store.observations.length, 1);
    const item = read.store.observations[0];
    assert.equal(item.upUid, "2001");
    assert.equal(item.bvid, bvid(1));
    assert.equal(item.provenance, "page-observed");
    assert.equal(item.observationScope, "related-recommendation-card");
    ["html", "script", "cookie", "token"].forEach((key) => {
      assert.equal(Object.prototype.hasOwnProperty.call(item, key), false, key);
    });
  });

  await test("4. 同一 UID + BV 重复观察只保留一条并更新时间", async () => {
    resetStorage();
    await enable();
    await Store.addObservations([observation({ bvid: bvid(1) })], { now: NOW - DAY });
    const newer = new Date(NOW).toISOString();
    const result = await Store.addObservations(
      [observation({ bvid: bvid(1), observedAt: newer })],
      { now: NOW }
    );
    assert.equal(result.updated, 1);
    const read = await Store.readStore();
    assert.equal(read.store.observations.length, 1);
    assert.equal(read.store.observations[0].observedAt, newer);
  });

  await test("5. 同一 UID 在不同来源页观察到不同 BV 时跨页累积", async () => {
    resetStorage();
    await enable();
    await Store.addObservations([observation({ bvid: bvid(1), sourcePageBvid: bvid(901) })], {
      now: NOW
    });
    await Store.addObservations([observation({ bvid: bvid(2), sourcePageBvid: bvid(902) })], {
      now: NOW
    });
    const read = await Store.readStore();
    assert.equal(read.store.observations.length, 2);
    assert.deepEqual(
      read.store.observations.map((item) => item.sourcePageBvid).sort(),
      [bvid(901), bvid(902)].sort()
    );
  });

  await test("6. 同一 BV 出现不同 UID 时标记冲突，不为任何一方选定身份", async () => {
    resetStorage();
    await enable();
    await Store.addObservations([observation({ bvid: bvid(1), upUid: "2001" })], { now: NOW });
    await Store.addObservations([observation({ bvid: bvid(1), upUid: "2002" })], { now: NOW });
    const read = await Store.readStore();
    assert.equal(read.store.observations.length, 2);
    read.store.observations.forEach((item) => {
      assert.equal(item.evidenceStatus, "uid-conflict");
      assert.deepEqual(item.conflictUids, ["2001", "2002"]);
    });
  });

  await test("7. 无效观察被拒绝，不因为一条坏数据写入空存储", async () => {
    resetStorage();
    await enable();
    const result = await Store.addObservations(
      [
        { bvid: "BVbad", upUid: "2001" },
        observation({ provenance: "user-provided" }),
        observation({ observationScope: "other" }),
        observation({ observedAt: "not-a-date" })
      ],
      { now: NOW }
    );
    assert.equal(result.ok, true);
    assert.equal(result.rejected, 4);
    assert.equal(result.added, 0);
    assert.equal(chromeMock.writes.length, 1);
  });

  await test("8. 恶意 JSON 额外字段不会进入存储", async () => {
    resetStorage();
    await enable();
    const malicious = JSON.parse(
      '{"upUid":"2001","bvid":"' +
        bvid(1) +
        '","title":"标题","partition":"科技","observedAt":"' +
        new Date(NOW).toISOString() +
        '","sourcePageBvid":"' +
        bvid(900) +
        '","provenance":"page-observed","observationScope":"related-recommendation-card","__proto__":{"polluted":true},"innerHTML":"<img onerror=alert(1)>","cookies":"a=b"}'
    );
    await Store.addObservations([malicious], { now: NOW });
    const read = await Store.readStore();
    const item = read.store.observations[0];
    assert.equal(item.innerHTML, undefined);
    assert.equal(item.cookies, undefined);
    assert.equal(item.polluted, undefined);
    assert.equal({}.polluted, undefined);
  });

  await test("9. 3 个不同视频且标题/分区达标时可进入探索，onlineVerified 恒为 false", async () => {
    resetStorage();
    await enable();
    await Store.addObservations(
      [1, 2, 3].map((index) =>
        observation({
          upUid: "2001",
          bvid: bvid(index),
          title: `科技教程 ${index}`,
          partition: "科技",
          sourcePageBvid: bvid(900 + index)
        })
      ),
      { now: NOW }
    );
    const read = await Store.readStore();
    const evidence = Store.buildDiscoveredEvidence(read.store, { version: 1, days: {} }, {
      now: NOW,
      settings: (await Store.readSettings()).settings
    });
    assert.equal(evidence.sidecar.provenance, "page-observed");
    assert.equal(evidence.sidecar.candidates.length, 1);
    const candidate = evidence.assessment.candidates[0];
    assert.equal(candidate.promotion.eligibleForExploration, true);
    assert.equal(candidate.identityEvidence.onlineVerified, false);
    assert.equal(candidate.identityEvidence.fromWatchHistory, false);
    assert.equal(candidate.identityEvidence.fromUserInput, false);
    assert.deepEqual(candidate.identityEvidence.sources, ["page-observed"]);
    assert.equal(evidence.summary.eligible, 1);
  });

  await test("10. 页面没有明确分区时按标题降级，不伪造分区", async () => {
    resetStorage();
    await enable();
    await Store.addObservations(
      [1, 2, 3].map((index) =>
        observation({
          upUid: "2001",
          bvid: bvid(index),
          title: `观察标题 ${index}`,
          partition: "",
          sourcePageBvid: bvid(910 + index)
        })
      ),
      { now: NOW }
    );
    const read = await Store.readStore();
    const evidence = Store.buildDiscoveredEvidence(read.store, { version: 1, days: {} }, {
      now: NOW,
      settings: (await Store.readSettings()).settings
    });
    const sidecar = evidence.sidecar.candidates[0];
    const candidate = evidence.assessment.candidates[0];
    assert.equal(candidate.promotion.eligibleForExploration, true);
    assert.equal(candidate.promotion.partitionDegraded, true);
    assert.equal(sidecar.partitionCounts.length, 0);
    assert.equal(sidecar.contentStatus, "partial");
    assert.equal(evidence.summary.degradedPartitionCount, 1);
  });

  await test("11. 标题覆盖不足时数据不足，不进入探索", async () => {
    resetStorage();
    await enable();
    await Store.addObservations(
      [
        observation({ bvid: bvid(1), title: "标题一", partition: "科技" }),
        observation({ bvid: bvid(2), title: "", partition: "科技" }),
        observation({ bvid: bvid(3), title: "", partition: "科技" })
      ],
      { now: NOW }
    );
    const read = await Store.readStore();
    const evidence = Store.buildDiscoveredEvidence(read.store, { version: 1, days: {} }, {
      now: NOW,
      settings: (await Store.readSettings()).settings
    });
    assert.equal(evidence.assessment.candidates[0].promotion.eligibleForExploration, false);
    assert.equal(evidence.summary.eligible, 0);
    assert.equal(evidence.summary.insufficientData, 1);
  });

  await test("12. 少于 3 个不同视频时数据不足", async () => {
    resetStorage();
    await enable();
    await Store.addObservations(
      [1, 2].map((index) => observation({ bvid: bvid(index), title: `标题 ${index}` })),
      { now: NOW }
    );
    const read = await Store.readStore();
    const evidence = Store.buildDiscoveredEvidence(read.store, { version: 1, days: {} }, {
      now: NOW,
      settings: (await Store.readSettings()).settings
    });
    assert.equal(evidence.summary.total, 1);
    assert.equal(evidence.summary.eligible, 0);
    assert.equal(evidence.summary.insufficientData, 1);
  });

  await test("13. 已观看 UP 主被排除出自动发现候选", async () => {
    resetStorage();
    await enable();
    await Store.addObservations(
      [1, 2, 3].map((index) => observation({ upUid: "2001", bvid: bvid(index) })),
      { now: NOW }
    );
    const read = await Store.readStore();
    const evidence = Store.buildDiscoveredEvidence(read.store, recordsWithUp("2001"), {
      now: NOW,
      settings: (await Store.readSettings()).settings
    });
    assert.equal(evidence.sidecar.candidates.length, 0);
    assert.equal(evidence.summary.watchedUpExcluded, 1);
    assert.equal(evidence.summary.observedVideoCount, 0);
  });

  await test("14. 身份冲突的候选被标记待复核并阻断探索", async () => {
    resetStorage();
    await enable();
    await Store.addObservations(
      [
        observation({ upUid: "2001", bvid: bvid(1) }),
        observation({ upUid: "2001", bvid: bvid(2) }),
        observation({ upUid: "2001", bvid: bvid(3) })
      ],
      { now: NOW }
    );
    await Store.addObservations(
      [observation({ upUid: "2002", bvid: bvid(1) })],
      { now: NOW }
    );
    const read = await Store.readStore();
    const evidence = Store.buildDiscoveredEvidence(read.store, { version: 1, days: {} }, {
      now: NOW,
      settings: (await Store.readSettings()).settings
    });
    const candidate = evidence.assessment.candidates.find((item) => item.upUid === "2001");
    assert.equal(candidate.identityEvidence.hasIdentityConflict, true);
    assert.equal(candidate.promotion.eligibleForExploration, false);
    assert.equal(candidate.promotion.status, "pending-review");
    assert.equal(candidate.identityEvidence.onlineVerified, false);
    assert.equal(evidence.summary.pendingReview >= 1, true);
  });

  await test("15. 超过保留期的观察在证据适配时被剔除", async () => {
    resetStorage();
    const staleAt = new Date(NOW - 5 * DAY).toISOString();
    const normalized = Store.normalizeObservation(
      observation({ bvid: bvid(1), observedAt: staleAt })
    );
    await Store.writeStore({
      version: Store.STORE_VERSION,
      kind: Store.STORE_KIND,
      updatedAt: staleAt,
      observations: [normalized]
    });
    const read = await Store.readStore();
    const evidence = Store.buildDiscoveredEvidence(read.store, { version: 1, days: {} }, {
      now: NOW,
      settings: { enabled: true, retentionDays: 1 }
    });
    assert.equal(evidence.sidecar.candidates.length, 0);
    assert.equal(evidence.summary.staleVideoExcluded, 1);
  });

  await test("16. 写入容量上限生效，只保留较新的观察", async () => {
    resetStorage();
    await enable({ maxCandidates: 2 });
    for (let index = 1; index <= 3; index += 1) {
      await Store.addObservations(
        [
          observation({
            bvid: bvid(index),
            observedAt: new Date(NOW - (4 - index) * DAY).toISOString()
          })
        ],
        { now: NOW }
      );
    }
    const read = await Store.readStore();
    assert.equal(read.store.observations.length, 2);
    assert.deepEqual(
      read.store.observations.map((item) => item.bvid).sort(),
      [bvid(2), bvid(3)].sort()
    );
  });

  await test("17. 重复读取不会写入，重复打开弹窗不会产生重复数据", async () => {
    resetStorage();
    await enable();
    await Store.addObservations([observation()], { now: NOW });
    const writesBefore = chromeMock.writes.length;
    await Store.readStore();
    await Store.readStore();
    await Store.readSettings();
    assert.equal(chromeMock.writes.length, writesBefore);
  });

  await test("18. 证据适配不修改传入的观看记录与候选存储", async () => {
    resetStorage();
    await enable();
    await Store.addObservations(
      [1, 2, 3].map((index) => observation({ bvid: bvid(index) })),
      { now: NOW }
    );
    const read = await Store.readStore();
    const store = frozen(JSON.parse(JSON.stringify(read.store)));
    const records = frozen({ version: 1, days: {} });
    const evidence = Store.buildDiscoveredEvidence(store, records, {
      now: NOW,
      settings: frozen(await Store.readSettings()).settings
    });
    assert.equal(evidence.sidecar.candidates.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(evidence)), evidence);
  });

  await test("19. 存储规范化对 JSON 往返稳定", async () => {
    resetStorage();
    await enable();
    await Store.addObservations([observation({ bvid: bvid(1) })], { now: NOW });
    const read = await Store.readStore();
    const again = Store.normalizeStore(JSON.parse(JSON.stringify(read.store)));
    assert.deepEqual(again.store, read.store);
  });

  await test("20. 非法存储结构回退为空存储并给出警告", async () => {
    resetStorage();
    const result = Store.normalizeStore({ kind: "wrong", observations: [] });
    assert.equal(result.store.observations.length, 0);
    assert.ok(result.warnings.includes("invalid-store"));
    const missing = Store.normalizeStore(null);
    assert.equal(missing.store.observations.length, 0);
  });

  await test("21. 设置值越界会被收敛到安全范围，enabled 默认为 false", async () => {
    const settings = Store.normalizeSettings({
      enabled: "yes",
      maxCandidates: 99999,
      retentionDays: -5,
      maxObservationsPerPage: 9999,
      minImportedVideos: 0,
      minTitleCoverage: 5,
      minPartitionCoverage: -1
    });
    assert.equal(settings.enabled, false);
    assert.equal(settings.maxCandidates, Store.LIMITS.maxCandidates);
    assert.equal(settings.retentionDays, Store.LIMITS.minRetentionDays);
    assert.equal(settings.maxObservationsPerPage, 200);
    assert.equal(settings.minImportedVideos, 1);
    assert.equal(settings.minTitleCoverage, 1);
    assert.equal(settings.minPartitionCoverage, 0);
  });

  await test("22. 同一 BV 同 UID 的标题观察冲突时不使用矛盾标题", async () => {
    resetStorage();
    await enable();
    await Store.addObservations(
      [observation({ bvid: bvid(1), title: "标题甲" })],
      { now: NOW }
    );
    await Store.addObservations(
      [observation({ bvid: bvid(1), title: "标题乙" })],
      { now: NOW }
    );
    const read = await Store.readStore();
    assert.deepEqual(read.store.observations[0].metadataConflictFields, ["title"]);
    const evidence = Store.buildDiscoveredEvidence(read.store, { version: 1, days: {} }, {
      now: NOW,
      settings: (await Store.readSettings()).settings
    });
    const sidecar = evidence.sidecar.candidates[0];
    assert.equal(sidecar.metadataConflictVideoCount, 1);
    assert.deepEqual(sidecar.titleTokens, []);
    assert.equal(evidence.summary.eligible, 0);
  });

  await test("23. 只写入两个独立存储键，不触碰观看记录或手动导入", async () => {
    resetStorage();
    await enable();
    await Store.addObservations([observation()], { now: NOW });
    const keys = Object.keys(chromeMock.data).sort();
    assert.deepEqual(keys, [Store.SETTINGS_KEY, Store.STORE_KEY].sort());
    assert.equal(keys.includes("biliDailyRecords"), false);
    assert.equal(keys.includes("biliDailyCandidateImports"), false);
  });

  await test("24. 空存储产生真实空状态，不生成候选", async () => {
    resetStorage();
    const evidence = Store.buildDiscoveredEvidence(
      Store.emptyStore(),
      { version: 1, days: {} },
      { now: NOW, settings: { enabled: true } }
    );
    assert.equal(evidence.sidecar.status, "empty");
    assert.equal(evidence.assessment.status, "empty");
    assert.equal(evidence.sidecar.candidates.length, 0);
    assert.equal(evidence.summary.total, 0);
  });

  await test("25. 清除操作只清空自动发现候选，设置保持开启", async () => {
    resetStorage();
    await enable();
    await Store.addObservations([observation()], { now: NOW });
    const cleared = await Store.clearStore();
    assert.equal(cleared.ok, true);
    const read = await Store.readStore();
    assert.equal(read.store.observations.length, 0);
    const settings = await Store.readSettings();
    assert.equal(settings.settings.enabled, true);
  });

  await test("26. 观测记录 JSON 不包含页面 HTML / 脚本 / 凭据字段", async () => {
    resetStorage();
    await enable();
    await Store.addObservations([observation()], { now: NOW });
    const serialized = JSON.stringify(chromeMock.data[Store.STORE_KEY]);
    assert.equal(serialized.includes("<script"), false);
    assert.equal(serialized.includes("SESSDATA"), false);
    assert.equal(serialized.includes("secret-token"), false);
    assert.equal(serialized.includes("cookie"), false);
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
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
