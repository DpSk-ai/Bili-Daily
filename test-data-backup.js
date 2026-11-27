"use strict";

/**
 * Bili Daily v1.1 —— 本地数据备份/恢复纯函数测试
 * 运行：node test-data-backup.js
 */

const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "data-backup.js"));

const Backup = globalThis.BiliDailyDataBackup;

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

function bvid(index) {
  return `BV1${String(index).padStart(9, "0")}`;
}

function sampleRecords() {
  return {
    version: 1,
    days: {
      "2026-11-11": {
        [bvid(1)]: { bvid: bvid(1), title: "A", watchMs: 120000 },
        [bvid(2)]: { bvid: bvid(2), title: "B", watchMs: 60000 }
      },
      "2026-11-10": {
        [bvid(3)]: { bvid: bvid(3), title: "C", watchMs: 30000 }
      }
    }
  };
}

function sampleImports() {
  return {
    version: 1,
    kind: "bili-daily-candidate-imports",
    batches: [
      {
        id: "batch-1",
        candidates: [
          { upUid: "1001", videos: [{ bvid: bvid(10) }, { bvid: bvid(11) }] },
          { upUid: "1002", videos: [{ bvid: bvid(12) }] }
        ]
      },
      { id: "batch-2", candidates: [{ upUid: "1003", videos: [] }] }
    ]
  };
}

function sampleDiscovered() {
  return {
    version: 1,
    kind: "bili-daily-discovered-candidates",
    observations: [
      { upUid: "2001", bvid: bvid(20) },
      { upUid: "2001", bvid: bvid(21) },
      { upUid: "2002", bvid: bvid(22) }
    ]
  };
}

function sampleSettings() {
  return { version: 1, enabled: true, maxCandidates: 300 };
}

function sampleStorage() {
  return {
    biliDailyRecords: sampleRecords(),
    biliDailyCandidateImports: sampleImports(),
    biliDailyDiscoveredCandidates: sampleDiscovered(),
    biliDailyDiscoverySettings: sampleSettings()
  };
}

function makeBackupText(overrides) {
  return JSON.stringify(
    Object.assign(
      {
        format: Backup.FORMAT,
        version: Backup.VERSION,
        app: "Bili Daily",
        appVersion: "1.1",
        exportedAt: "2026-11-12T12:00:00.000Z",
        data: { biliDailyRecords: sampleRecords() }
      },
      overrides || {}
    )
  );
}

(async function run() {
  await test("1. 只导出四个已知存储键，并写入格式元信息", () => {
    const result = Backup.buildBackup(
      Object.assign({ unknownKey: { secret: true } }, sampleStorage()),
      1762950000000
    );
    assert.equal(result.ok, true);
    assert.equal(result.backup.format, Backup.FORMAT);
    assert.equal(result.backup.version, 1);
    assert.equal(result.backup.appVersion, "1.1");
    assert.deepEqual(Object.keys(result.backup.data).sort(), Backup.KEY_LIST.slice().sort());
    assert.equal(Object.prototype.hasOwnProperty.call(result.backup.data, "unknownKey"), false);
  });

  await test("2. 空来源失败，不生成空备份", () => {
    const result = Backup.buildBackup({}, 1762950000000);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "empty-source");
  });

  await test("3. 非对象来源失败", () => {
    assert.equal(Backup.buildBackup(null).reason, "invalid-source");
    assert.equal(Backup.buildBackup([]).reason, "invalid-source");
    assert.equal(Backup.buildBackup("x").reason, "invalid-source");
  });

  await test("4. 备份是 JSON 深拷贝，修改备份不影响源数据", () => {
    const source = sampleStorage();
    const result = Backup.buildBackup(source, 1762950000000);
    result.backup.data.biliDailyRecords.days["2026-11-11"][bvid(1)].title = "HACKED";
    assert.equal(source.biliDailyRecords.days["2026-11-11"][bvid(1)].title, "A");
  });

  await test("5. 统计观看天数与记录数", () => {
    const summary = Backup.summarize(sampleStorage());
    assert.equal(summary.records.days, 2);
    assert.equal(summary.records.records, 3);
    assert.equal(summary.keys.includes("biliDailyRecords"), true);
  });

  await test("6. 统计导入批次、候选与视频数", () => {
    const summary = Backup.summarize(sampleStorage());
    assert.equal(summary.imports.batches, 2);
    assert.equal(summary.imports.candidates, 3);
    assert.equal(summary.imports.videos, 3);
  });

  await test("7. 统计观察条数与不同 UP 数", () => {
    const summary = Backup.summarize(sampleStorage());
    assert.equal(summary.discovered.observations, 3);
    assert.equal(summary.discovered.uniqueUps, 2);
  });

  await test("8. 统计自动发现设置状态", () => {
    const summary = Backup.summarize(sampleStorage());
    assert.equal(summary.settings.present, true);
    assert.equal(summary.settings.enabled, true);
  });

  await test("9. 序列化后可解析，数据与元信息保持一致", () => {
    const serialized = Backup.serializeBackup(sampleStorage(), 1762950000000);
    assert.equal(serialized.ok, true);
    const parsed = Backup.parseBackupText(serialized.text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.meta.version, 1);
    assert.equal(parsed.meta.exportedAt, "2026-11-12T12:00:00.000Z");
    assert.equal(parsed.summary.records.records, 3);
    assert.deepEqual(parsed.data.biliDailyDiscoverySettings, sampleSettings());
  });

  await test("10. 超过 5 MiB 的备份被拒绝", () => {
    const huge = { version: 1, days: { "2026-11-11": { big: { title: "x".repeat(5 * 1024 * 1024) } } } };
    const result = Backup.serializeBackup({ biliDailyRecords: huge }, 1762950000000);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "too-large");
  });

  await test("11. 非法 JSON 被拒绝", () => {
    assert.equal(Backup.parseBackupText("{").reason, "invalid-json");
    assert.equal(Backup.parseBackupText("").reason, "invalid-json");
    assert.equal(Backup.parseBackupText(123).reason, "invalid-json");
  });

  await test("12. 错误 format 被拒绝", () => {
    const parsed = Backup.parseBackupText(makeBackupText({ format: "other" }));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, "invalid-format");
  });

  await test("13. 不支持的版本被拒绝", () => {
    const parsed = Backup.parseBackupText(makeBackupText({ version: 99 }));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, "unsupported-version");
  });

  await test("14. data 不是对象或为空时被拒绝", () => {
    assert.equal(Backup.parseBackupText(makeBackupText({ data: [] })).reason, "invalid-data");
    assert.equal(Backup.parseBackupText(makeBackupText({ data: {} })).reason, "empty-data");
  });

  await test("15. 未知存储键被拒绝", () => {
    const parsed = Backup.parseBackupText(makeBackupText({ data: { evilKey: {} } }));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, "unknown-key");
    assert.deepEqual(parsed.unknownKeys, ["evilKey"]);
  });

  await test("16. __proto__ / constructor 等危险键被拒绝", () => {
    const raw = '{"format":"bili-daily-backup","version":1,"data":{"__proto__":{"polluted":true}}}';
    assert.equal(Backup.parseBackupText(raw).reason, "dangerous-key");
    const nested =
      '{"format":"bili-daily-backup","version":1,"data":{"biliDailyRecords":{"constructor":{"x":1}}}}';
    assert.equal(Backup.parseBackupText(nested).reason, "dangerous-key");
  });

  await test("17. UTF-8 BOM 不影响解析", () => {
    const parsed = Backup.parseBackupText("﻿" + makeBackupText());
    assert.equal(parsed.ok, true);
  });

  await test("18. prepareImport 调用注入的校验函数并返回待写 payload", () => {
    const normalizers = {
      biliDailyRecords: (value) => ({ value: { normalized: true, days: value.days }, warnings: [] })
    };
    const prepared = Backup.prepareImport(makeBackupText(), normalizers);
    assert.equal(prepared.ok, true);
    assert.equal(prepared.payload.biliDailyRecords.normalized, true);
    assert.equal(prepared.summary.records.days, 2);
  });

  await test("19. prepareImport 缺少校验函数时拒绝", () => {
    const prepared = Backup.prepareImport(makeBackupText(), {});
    assert.equal(prepared.ok, false);
    assert.equal(prepared.reason, "missing-normalizer");
    assert.equal(prepared.key, "biliDailyRecords");
  });

  await test("20. 校验函数抛错时拒绝，不产生 payload", () => {
    const prepared = Backup.prepareImport(makeBackupText(), {
      biliDailyRecords: () => {
        throw new Error("boom");
      }
    });
    assert.equal(prepared.ok, false);
    assert.equal(prepared.reason, "normalize-failed");
  });

  await test("21. 校验函数返回 null 时拒绝", () => {
    const prepared = Backup.prepareImport(makeBackupText(), {
      biliDailyRecords: () => null
    });
    assert.equal(prepared.ok, false);
    assert.equal(prepared.reason, "normalize-failed");
  });

  await test("22. 校验 warning 被汇总，不丢失", () => {
    const prepared = Backup.prepareImport(makeBackupText(), {
      biliDailyRecords: () => ({ value: { version: 1, days: {} }, warnings: ["invalid-record:1"] })
    });
    assert.equal(prepared.ok, true);
    assert.deepEqual(prepared.warnings, ["invalid-record:1"]);
  });

  await test("23. 校验结果中若出现危险键也拒绝", () => {
    const prepared = Backup.prepareImport(makeBackupText(), {
      biliDailyRecords: () => ({ value: JSON.parse('{"__proto__":{"x":1}}'), warnings: [] })
    });
    assert.equal(prepared.ok, false);
    assert.equal(prepared.reason, "dangerous-key");
  });

  await test("24. writePayload 成功后返回 ok，并只写传入的键", async () => {
    let written = null;
    const area = {
      set(payload, callback) {
        written = payload;
        callback();
      }
    };
    const result = await Backup.writePayload({ biliDailyRecords: sampleRecords() }, area);
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(written), ["biliDailyRecords"]);
  });

  await test("25. writePayload 在写入抛错时返回失败", async () => {
    const result = await Backup.writePayload(
      { biliDailyRecords: sampleRecords() },
      {
        set() {
          throw new Error("quota");
        }
      }
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "storage-write-failed");
  });

  await test("26. writePayload 拒绝空 payload、未知键、危险键与超大内容", async () => {
    const area = { set(payload, callback) { callback(); } };
    assert.equal((await Backup.writePayload({}, area)).reason, "invalid-payload");
    assert.equal((await Backup.writePayload({ evil: 1 }, area)).reason, "unknown-key");
    assert.equal(
      (await Backup.writePayload(JSON.parse('{"biliDailyRecords":{"__proto__":{"x":1}}}'), area))
        .reason,
      "dangerous-key"
    );
    const hugePayload = {
      biliDailyRecords: { version: 1, days: { big: { title: "x".repeat(5 * 1024 * 1024) } } }
    };
    assert.equal((await Backup.writePayload(hugePayload, area)).reason, "too-large");
  });

  await test("27. 没有 storage area 时返回失败", async () => {
    const result = await Backup.writePayload({ biliDailyRecords: {} }, null);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "storage-write-failed");
  });

  await test("28. 文件名包含本地时间戳且以 .json 结尾", () => {
    const name = Backup.filename(new Date(2026, 10, 12, 9, 8, 7).getTime());
    assert.equal(name, "bili-daily-backup-20261112-090807.json");
  });

  await test("29. formatSummary 生成可读摘要", () => {
    const text = Backup.formatSummary(Backup.summarize(sampleStorage()));
    assert.match(text, /观看 2 天 \/ 3 条/);
    assert.match(text, /导入 2 批 \/ 3 个候选/);
    assert.match(text, /观察 3 条 \/ 2 个 UP/);
    assert.match(text, /自动发现已开启/);
  });

  await test("30. 键清单固定为四个，API 冻结", () => {
    assert.deepEqual(Backup.KEY_LIST, [
      "biliDailyRecords",
      "biliDailyCandidateImports",
      "biliDailyDiscoveredCandidates",
      "biliDailyDiscoverySettings"
    ]);
    assert.equal(Object.isFrozen(Backup), true);
    assert.equal(Object.isFrozen(Backup.KEYS), true);
  });

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
