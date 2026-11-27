"use strict";

/**
 * Bili Daily —— 候选持久化（MVP 工作包 B）独立测试
 * 运行：node test-candidate-store.js
 *
 * 使用内存模拟 chrome.storage.local，不读写真实浏览器存储，不联网。
 * 覆盖：持久化与读回、导入失败不覆盖旧数据、格式 / 体积 / UID / BV 校验、
 * 删除单个候选与批次、清空、原型污染与 HTML 文本安全、存储上限、sidecar 重建。
 */

const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "stats.js"));
require(path.join(__dirname, "candidate-features.js"));
require(path.join(__dirname, "candidate-content-import.js"));
require(path.join(__dirname, "candidate-store.js"));

const Store = globalThis.BiliDailyCandidateStore;
const Import = globalThis.BiliDailyCandidateContentImport;

const BASE = Date.parse("2026-11-11T04:00:00.000Z");
const RECORDS_KEY = "biliDailyRecords";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/* ------------------------------------------------------------ 模拟 chrome.storage */

function installStorage(initial) {
  const data = clone(initial) || {};
  const state = { failNextWrite: false, failNextRead: false };
  const area = {
    get(key, callback) {
      setTimeout(() => {
        if (state.failNextRead) {
          state.failNextRead = false;
          globalThis.chrome.runtime.lastError = { message: "模拟存储读取失败" };
          callback({});
          globalThis.chrome.runtime.lastError = undefined;
          return;
        }
        const result = {};
        if (typeof key === "string" && Object.prototype.hasOwnProperty.call(data, key)) {
          result[key] = clone(data[key]);
        }
        callback(result);
      }, 0);
    },
    set(payload, callback) {
      setTimeout(() => {
        if (state.failNextWrite) {
          state.failNextWrite = false;
          globalThis.chrome.runtime.lastError = { message: "模拟写入失败" };
          if (callback) callback();
          globalThis.chrome.runtime.lastError = undefined;
          return;
        }
        Object.keys(payload).forEach((key) => {
          data[key] = clone(payload[key]);
        });
        if (callback) callback();
      }, 0);
    }
  };
  globalThis.chrome = {
    runtime: {},
    storage: { local: area, onChanged: { addListener() {} } }
  };
  return { data, state };
}

/* ---------------------------------------------------------------- 测试数据 */

function bv(index) {
  return `BV1aa411c7m${String(index).slice(-1)}`;
}

function video(index, title, partition) {
  return { bvid: bv(index), title, partition };
}

function candidate(upUid, upName, videos) {
  return { upUid, upName, observedAt: BASE - 2 * 24 * 60 * 60 * 1000, videos };
}

function document(candidates, extra) {
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

function sampleCandidates() {
  return [
    candidate("2001", "探索UP", [
      video(1, "科技前沿教程", "科技"),
      video(2, "数码评测入门", "科技"),
      video(3, "编程基础讲解", "科技")
    ]),
    candidate("2002", "生活探索", [
      video(4, "生活日常记录", "生活"),
      video(5, "美食制作教程", "美食")
    ])
  ];
}

function seedStore(batchCount) {
  const batches = [];
  for (let index = 0; index < batchCount; index += 1) {
    batches.push({
      id: `batch-seed-${index}`,
      importedAt: new Date(BASE + index * 1000).toISOString(),
      sourceName: `seed-${index}`,
      provenance: "user-provided",
      candidates: [
        {
          upUid: String(9000 + index),
          upName: `Seed${index}`,
          observedAt: BASE,
          videos: [{ bvid: bv(index % 10), title: "种子视频", partition: "科技" }]
        }
      ]
    });
  }
  return {
    version: 1,
    kind: "bili-daily-candidate-store",
    updatedAt: new Date(BASE).toISOString(),
    batches
  };
}

async function countStored() {
  const read = await Store.readStore();
  assert.equal(read.ok, true);
  return read.store.batches.reduce((total, batch) => total + batch.candidates.length, 0);
}

/* ---------------------------------------------------------------- 1. 持久化 */

(async function run() {
  await test("1. previewImport 返回候选 / 视频数量且不写入存储", async () => {
    const fake = installStorage({});
    const preview = Store.previewImport(JSON.stringify(document(sampleCandidates())));
    assert.equal(preview.ok, true);
    assert.deepEqual(preview.summary, { candidateCount: 2, videoCount: 5, rejected: 0 });
    assert.equal(Object.keys(fake.data).length, 0, "预览不得写入存储");
  });

  await test("2. importText 写入独立键并可读回", async () => {
    const fake = installStorage({});
    const result = await Store.importText(JSON.stringify(document(sampleCandidates())), {
      sourceName: "候选.json",
      now: BASE
    });
    assert.equal(result.ok, true);
    assert.equal(result.addedCandidates, 2);
    assert.ok(fake.data[Store.STORE_KEY], "应写入 biliDailyCandidateImports");
    assert.equal(fake.data[RECORDS_KEY], undefined, "不得创建观看记录键");

    const read = await Store.readStore();
    assert.equal(read.ok, true);
    assert.equal(read.store.batches.length, 1);
    assert.equal(read.store.batches[0].sourceName, "候选.json");
    assert.equal(read.store.batches[0].provenance, "user-provided");
    const byUid = new Map(read.store.batches[0].candidates.map((item) => [item.upUid, item]));
    assert.equal(byUid.get("2001").upName, "探索UP");
    assert.equal(byUid.get("2001").videos.length, 3);
    assert.equal(byUid.get("2002").videos[0].partition, "生活");
  });

  await test("3. 导入不修改已有观看记录", async () => {
    const records = {
      version: 1,
      days: { "2026-11-10": { BV1: { bvid: "BV1", watchMs: 60000 } } }
    };
    const fake = installStorage({ [RECORDS_KEY]: records });
    const before = clone(fake.data[RECORDS_KEY]);
    const result = await Store.importText(JSON.stringify(document(sampleCandidates())));
    assert.equal(result.ok, true);
    assert.deepEqual(fake.data[RECORDS_KEY], before, "观看记录必须原样保留");
  });

  await test("4. 重复导入追加批次，不覆盖已有候选", async () => {
    installStorage({});
    await Store.importText(JSON.stringify(document([candidate("3001", "首批", [video(1, "科技教程", "科技")])])));
    const second = await Store.importText(
      JSON.stringify(document([candidate("3002", "二批", [video(2, "生活记录", "生活")])]))
    );
    assert.equal(second.ok, true);
    assert.equal(await countStored(), 2);
  });

  /* ------------------------------------------------------ 2. 失败不覆盖旧数据 */

  await test("5. 非法 JSON 失败且旧数据保持不变", async () => {
    installStorage({});
    await Store.importText(JSON.stringify(document(sampleCandidates())));
    const before = await countStored();
    const result = await Store.importText("{ not json");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid-json");
    assert.equal(await countStored(), before);
  });

  await test("6. schemaVersion 错误被拒绝且不写入", async () => {
    installStorage({});
    const result = await Store.importText(
      JSON.stringify(document(sampleCandidates(), { schemaVersion: 2 }))
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unsupported-schema");
    assert.equal(await countStored(), 0);
  });

  await test("7. provenance 不是 user-provided 被拒绝", async () => {
    installStorage({});
    const result = await Store.importText(
      JSON.stringify(document(sampleCandidates(), { provenance: "platform-observed" }))
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unsupported-provenance");
    assert.equal(await countStored(), 0);
  });

  await test("8. userConfirmed 不为 true 被拒绝", async () => {
    installStorage({});
    const result = await Store.importText(
      JSON.stringify(document(sampleCandidates(), { userConfirmed: false }))
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "confirmation-required");
    assert.equal(await countStored(), 0);
  });

  await test("9. 所有候选 UID 无效时导入失败且旧数据不变", async () => {
    installStorage({});
    await Store.importText(JSON.stringify(document(sampleCandidates())));
    const before = await countStored();
    const result = await Store.importText(
      JSON.stringify(document([candidate("abc", "坏 UID", [video(1, "视频", "科技")])]))
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no-valid-candidates");
    assert.equal(await countStored(), before);
  });

  await test("10. 非法 BV 的视频被丢弃，候选本身保留", async () => {
    installStorage({});
    const preview = Store.previewImport(
      JSON.stringify(
        document([
          candidate("4001", "混合候选", [
            video(1, "有效视频", "科技"),
            { bvid: "BV坏号", title: "无效视频", partition: "科技" }
          ])
        ])
      )
    );
    assert.equal(preview.ok, true);
    assert.equal(preview.summary.candidateCount, 1);
    assert.equal(preview.summary.videoCount, 1);
    assert.equal(preview.diagnostics.invalidBvids, 1);
  });

  await test("11. 超过 1 MiB 的输入被拒绝且不写入", async () => {
    installStorage({});
    const oversized = `{"padding":"${"a".repeat(1100000)}"}`;
    const result = await Store.importText(oversized);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "input-too-large");
    assert.equal(await countStored(), 0);
  });

  await test("12. 写入失败时返回错误，旧数据保持完整", async () => {
    const fake = installStorage({});
    await Store.importText(JSON.stringify(document(sampleCandidates())));
    const before = clone(fake.data[Store.STORE_KEY]);
    fake.state.failNextWrite = true;
    const result = await Store.importText(
      JSON.stringify(document([candidate("5001", "写入失败", [video(1, "视频", "科技")])]))
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "storage-write-failed");
    assert.deepEqual(fake.data[Store.STORE_KEY], before);
  });

  await test("13. 读取失败时导入中止，不写入任何数据", async () => {
    const fake = installStorage({});
    fake.state.failNextRead = true;
    const result = await Store.importText(JSON.stringify(document(sampleCandidates())));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "storage-read-failed");
    fake.state.failNextRead = false;
    assert.equal(fake.data[Store.STORE_KEY], undefined);
  });

  /* ---------------------------------------------------------------- 3. 删除 */

  await test("14. deleteCandidate 只删除指定候选", async () => {
    installStorage({});
    const imported = await Store.importText(JSON.stringify(document(sampleCandidates())));
    assert.equal(imported.ok, true);
    const read = await Store.readStore();
    const batchId = read.store.batches[0].id;

    const deleted = await Store.deleteCandidate(batchId, "2001");
    assert.equal(deleted.ok, true);
    const after = await Store.readStore();
    assert.equal(after.store.batches.length, 1);
    assert.deepEqual(
      after.store.batches[0].candidates.map((item) => item.upUid),
      ["2002"]
    );
  });

  await test("15. 删除不存在的候选返回 candidate-not-found 且不改动数据", async () => {
    installStorage({});
    await Store.importText(JSON.stringify(document(sampleCandidates())));
    const read = await Store.readStore();
    const batchId = read.store.batches[0].id;
    const before = clone(read.store);
    const deleted = await Store.deleteCandidate(batchId, "9999");
    assert.equal(deleted.ok, false);
    assert.equal(deleted.reason, "candidate-not-found");
    const after = await Store.readStore();
    assert.deepEqual(after.store, before);
  });

  await test("16. 删除批次只移除该批次", async () => {
    installStorage({});
    await Store.importText(JSON.stringify(document([candidate("6001", "A", [video(1, "视频", "科技")])])));
    await Store.importText(JSON.stringify(document([candidate("6002", "B", [video(2, "视频", "生活")])])));
    const read = await Store.readStore();
    assert.equal(read.store.batches.length, 2);
    const target = read.store.batches[0].id;

    const deleted = await Store.deleteBatch(target);
    assert.equal(deleted.ok, true);
    const after = await Store.readStore();
    assert.equal(after.store.batches.length, 1);
    assert.equal(after.store.batches[0].candidates[0].upUid, "6002");
  });

  await test("17. clearStore 清空候选但保留观看记录", async () => {
    const records = { version: 1, days: {} };
    const fake = installStorage({ [RECORDS_KEY]: records });
    await Store.importText(JSON.stringify(document(sampleCandidates())));
    const result = await Store.clearStore();
    assert.equal(result.ok, true);
    const read = await Store.readStore();
    assert.equal(read.store.batches.length, 0);
    assert.equal(read.store.kind, Store.STORE_KIND);
    assert.deepEqual(fake.data[RECORDS_KEY], records);
  });

  /* ------------------------------------------------------ 4. 安全与结构校验 */

  await test("18. 原型污染键不会进入存储，也不污染 Object.prototype", async () => {
    installStorage({});
    const polluted = JSON.parse(
      `{
        "__proto__": { "polluted": true },
        "constructor": { "prototype": { "polluted": true } },
        "schemaVersion": 1,
        "kind": "bili-daily-candidate-content-import",
        "provenance": "user-provided",
        "userConfirmed": true,
        "candidates": [
          {
            "__proto__": { "polluted": true },
            "upUid": "7001",
            "upName": "<img src=x onerror=alert(1)>",
            "videos": [
              {
                "__proto__": { "polluted": true },
                "bvid": "BV1aa411c7m1",
                "title": "<script>alert(1)</script>",
                "partition": "科技"
              }
            ]
          }
        ]
      }`
    );
    const result = await Store.importText(JSON.stringify(polluted));
    assert.equal(result.ok, true);
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal({}.polluted, undefined);

    const read = await Store.readStore();
    const stored = read.store.batches[0].candidates[0];
    assert.deepEqual(Object.keys(stored).sort(), ["observedAt", "upName", "upUid", "videos"]);
    assert.equal(stored.observedAt, null);
    assert.equal(Object.prototype.hasOwnProperty.call(stored, "__proto__"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(stored, "constructor"), false);
    // 文本按原样保存，由 popup 使用 textContent 展示，不在这里解释成 HTML。
    assert.equal(stored.upName, "<img src=x onerror=alert(1)>");
    assert.equal(stored.videos[0].title, "<script>alert(1)</script>");
  });

  await test("19. normalizeStore 拒绝未知 kind 并返回空结构", async () => {
    const normalized = Store.normalizeStore({ kind: "something-else", batches: [] });
    assert.equal(normalized.store.batches.length, 0);
    assert.ok(normalized.warnings.includes("invalid-store"));
  });

  await test("20. normalizeStore 跳过损坏批次并保留有效批次", async () => {
    const store = seedStore(2);
    store.batches[1].candidates[0].upUid = "not-a-uid";
    const normalized = Store.normalizeStore(store);
    assert.equal(normalized.store.batches.length, 1);
    assert.ok(normalized.warnings.some((warning) => warning.startsWith("invalid-batch:")));
  });

  await test("21. 来源文件名去除控制字符并截断", async () => {
    installStorage({});
    const longName = `文\u0000件​名${"a".repeat(200)}.json`;
    const result = await Store.importText(JSON.stringify(document(sampleCandidates())), {
      sourceName: longName
    });
    assert.equal(result.ok, true);
    const read = await Store.readStore();
    const name = read.store.batches[0].sourceName;
    assert.ok(name.length <= Store.LIMITS.maxSourceNameLength);
    assert.equal(name.includes("\u0000"), false);
    assert.equal(name.includes("​"), false);
  });

  await test("22. 超过 50 个批次时拒绝新导入", async () => {
    const fake = installStorage({ [Store.STORE_KEY]: seedStore(50) });
    const result = await Store.importText(
      JSON.stringify(document([candidate("8001", "超限", [video(1, "视频", "科技")])]))
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "too-many-batches");
    assert.equal(fake.data[Store.STORE_KEY].batches.length, 50, "失败的导入不得改动旧批次");
  });

  await test("23. summarizeStore 统计批次 / 候选 / 视频数量", async () => {
    const summary = Store.summarizeStore(Store.normalizeStore(seedStore(3)).store);
    assert.equal(summary.batchCount, 3);
    assert.equal(summary.candidateCount, 3);
    assert.equal(summary.videoCount, 3);
    assert.equal(typeof summary.newestImportAt, "string");
  });

  await test("24. toImportDocument 输出 user-provided 且不修改原存储", async () => {
    const store = Store.normalizeStore(seedStore(1)).store;
    const doc = Store.toImportDocument(store);
    assert.equal(doc.provenance, "user-provided");
    assert.equal(doc.userConfirmed, true);
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.kind, "bili-daily-candidate-content-import");
    assert.equal(doc.candidates.length, 1);
    assert.equal(Store.toImportDocument(Store.emptyStore()), null);
  });

  await test("25. buildSidecar 为导入候选生成可用的 C2-4B 证据", async () => {
    installStorage({});
    await Store.importText(JSON.stringify(document(sampleCandidates())), { now: BASE });
    const read = await Store.readStore();
    const sidecar = Store.buildSidecar(read.store, { now: BASE });
    assert.ok(sidecar, "应生成 sidecar");
    assert.equal(sidecar.kind, "bili-daily-candidate-content");
    assert.equal(sidecar.provenance, "user-provided");
    assert.equal(sidecar.lane, "exploration");
    assert.equal(sidecar.status, "ok");
    assert.ok(sidecar.note.includes("未在线核验"));
    assert.equal(sidecar.candidates.length, 2);
    const byUid = new Map(sidecar.candidates.map((item) => [item.upUid, item]));
    assert.equal(byUid.get("2001").importedVideoCount, 3);
    assert.equal(byUid.get("2002").importedVideoCount, 2);
    sidecar.candidates.forEach((item) => {
      assert.equal(item.provenance, "user-provided");
      assert.equal(item.lane, "exploration");
    });

    // sidecar 本身不携带 onlineVerified；该字段只在正式评估结果的
    // identityEvidence 中，且本阶段恒为 false。
    const assessment = Import.assessImportedContentCandidates(sidecar, {}, { now: BASE });
    assert.equal(assessment.status, "ok");
    assert.equal(assessment.candidates.length, 2);
    assessment.candidates.forEach((item) => {
      assert.equal(item.identityEvidence.onlineVerified, false);
      assert.equal(item.identityEvidence.fromWatchHistory, false);
    });
  });

  await test("26. 同一 UID 出现在多个批次时 sidecar 合并身份", async () => {
    installStorage({});
    await Store.importText(JSON.stringify(document([candidate("8101", "同人", [video(1, "科技教程", "科技")])])));
    await Store.importText(JSON.stringify(document([candidate("8101", "同人", [video(2, "科技评测", "科技")])])));
    const read = await Store.readStore();
    assert.equal(read.store.batches.length, 2);
    const sidecar = Store.buildSidecar(read.store, { now: BASE });
    assert.equal(sidecar.candidates.length, 1, "同一 UID 在 sidecar 中应合并");
    assert.equal(sidecar.candidates[0].provenance, "user-provided");
    assert.equal(sidecar.candidates[0].lane, "exploration");
    assert.equal(sidecar.candidates[0].importedVideoCount, 2);

    // 同一 UID 再次导入已存在的 BV：仍只算一个视频。
    await Store.importText(
      JSON.stringify(document([candidate("8101", "同人", [video(2, "科技评测", "科技")])]))
    );
    const dedupedRead = await Store.readStore();
    const deduped = Store.buildSidecar(dedupedRead.store, { now: BASE });
    assert.equal(deduped.candidates.length, 1);
    assert.equal(deduped.candidates[0].importedVideoCount, 2, "同一 UID 的同一 BV 不得重复计数");
  });

  await test("27. 存储中的未知 / 危险字段在读取时被白名单过滤", async () => {
    const store = seedStore(1);
    store.batches[0].candidates[0].evil = { injected: true };
    store.batches[0].candidates[0].videos[0].evil = "<script>";
    installStorage({ [Store.STORE_KEY]: store });
    const read = await Store.readStore();
    const stored = read.store.batches[0].candidates[0];
    assert.equal(Object.prototype.hasOwnProperty.call(stored, "evil"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(stored.videos[0], "evil"), false);
  });

  await test("28. 存储值完全损坏时返回空结构而非抛异常", async () => {
    installStorage({ [Store.STORE_KEY]: { kind: "bad", batches: "nope" } });
    const read = await Store.readStore();
    assert.equal(read.ok, true);
    assert.equal(read.store.batches.length, 0);
    assert.ok(read.warnings.length > 0);
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
})();
