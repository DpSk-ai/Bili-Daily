"use strict";

/**
 * Bili Daily —— candidate-pool.js 独立测试（纯模拟数据，不读写真实用户数据）
 * 运行：node test-candidate-pool.js
 *
 * 覆盖：单 UID 记录、同 UID 多视频、同 UID 改名、异 UID 同名、缺失 / 非法 / 空 UID、
 * 数字与带空格 UID、新旧记录混合、重复视频、多来源合并、手动候选、时间合并与缺失、
 * 输入不可变、空与异常输入、去重、类型分类、不伪造字段、输出稳定、筛选与查询。
 */

const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "stats.js"));
require(path.join(__dirname, "candidate-pool.js"));

const CP = globalThis.BiliDailyCandidatePool;

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

const DEFAULT_START = "2026-11-10T20:00:00.000+08:00";
const DEFAULT_END = "2026-11-10T20:01:00.000+08:00";

function rec(partial) {
  return Object.assign(
    {
      bvid: "BV1",
      page: 1,
      title: "测试视频",
      upName: "测试UP",
      upUid: null,
      partition: "科技",
      videoDuration: 600,
      watchMs: 60000,
      watchMsByHour: {},
      startedAt: DEFAULT_START,
      lastWatchedAt: DEFAULT_END,
      updatedAt: DEFAULT_END
    },
    partial
  );
}

function root(days) {
  return { version: 1, days };
}

function only(pool) {
  assert.equal(pool.candidates.length, 1);
  return pool.candidates[0];
}

/* ---------------------------------------------------------------- 1. 来源 A */

test("1. 单个有 UID 的观看记录生成一个回访候选", () => {
  const pool = CP.buildFromRecords(
    root({ "2026-11-10": { BV1: rec({ upUid: "1001", upName: "UP甲", watchMs: 60000 }) } })
  );
  assert.equal(pool.status, "ok");
  assert.equal(pool.reason, "");
  const candidate = only(pool);
  assert.equal(candidate.upUid, "1001");
  assert.equal(candidate.upName, "UP甲");
  assert.deepEqual(candidate.sources, ["watched"]);
  assert.equal(candidate.watchedBefore, true);
  assert.equal(candidate.candidateType, "returning");
  assert.equal(candidate.uidVerified, true);
  assert.equal(candidate.evidence.watchedVideoCount, 1);
  assert.equal(candidate.evidence.watchedWatchMs, 60000);
  assert.equal(candidate.evidence.uidFormatValid, true);
  assert.equal(candidate.evidence.fromWatchHistory, true);
  assert.equal(candidate.evidence.fromUserInput, false);
  assert.equal(candidate.evidence.onlineVerified, false);
  assert.equal(candidate.evidence.nameSource, "watch-history");
});

test("2. 多个视频属于同一 UID 时合并为一个候选并累计时长", () => {
  const pool = CP.buildFromRecords(
    root({
      "2026-11-09": { BV1: rec({ bvid: "BV1", upUid: "1001", upName: "UP甲", watchMs: 30000 }) },
      "2026-11-10": { BV2: rec({ bvid: "BV2", upUid: "1001", upName: "UP甲", watchMs: 90000 }) }
    })
  );
  const candidate = only(pool);
  assert.equal(candidate.evidence.watchedVideoCount, 2);
  assert.equal(candidate.evidence.watchedWatchMs, 120000);
});

test("3. 同 UID 不同昵称时取观看时长最多的昵称，并保留全部昵称", () => {
  const pool = CP.buildFromRecords(
    root({
      "2026-11-10": {
        BV1: rec({ bvid: "BV1", upUid: "1001", upName: "旧名", watchMs: 30000 }),
        BV2: rec({ bvid: "BV2", upUid: "1001", upName: "新名", watchMs: 90000 })
      }
    })
  );
  const candidate = only(pool);
  assert.equal(candidate.upName, "新名");
  assert.deepEqual(candidate.evidence.names.slice().sort(), ["新名", "旧名"].sort());
  assert.equal(candidate.evidence.names.length, 2);
});

test("3b. 同 UID 昵称时长并列时按码点取最小值，结果可复现", () => {
  const days = {
    "2026-11-10": {
      BV1: rec({ bvid: "BV1", upUid: "1001", upName: "Beta", watchMs: 50000 }),
      BV2: rec({ bvid: "BV2", upUid: "1001", upName: "Alpha", watchMs: 50000 })
    }
  };
  const first = only(CP.buildFromRecords(root(days)));
  const second = only(CP.buildFromRecords(root(days)));
  assert.equal(first.upName, "Alpha");
  assert.equal(first.upName, second.upName);
});

test("4. 不同 UID 的同名 UP 主保持为两个候选，不合并", () => {
  const pool = CP.buildFromRecords(
    root({
      "2026-11-10": {
        BV1: rec({ bvid: "BV1", upUid: "1001", upName: "同名UP" }),
        BV2: rec({ bvid: "BV2", upUid: "2002", upName: "同名UP" })
      }
    })
  );
  assert.equal(pool.candidates.length, 2);
  assert.deepEqual(
    pool.candidates.map((item) => item.upUid).sort(),
    ["1001", "2002"]
  );
  assert.equal(new Set(pool.candidates.map((item) => item.upName)).size, 1);
});

test("5. 缺失 UID 的记录不产生候选，只进入诊断统计", () => {
  const pool = CP.buildFromRecords(
    root({ "2026-11-10": { BV1: rec({ upUid: null, upName: "无UID的UP" }) } })
  );
  assert.equal(pool.status, "empty");
  assert.equal(pool.reason, "no-candidates");
  assert.equal(pool.candidates.length, 0);
  assert.equal(pool.diagnostics.nameOnlyVideos, 1);
  assert.equal(pool.summary.total, 0);
});

test("6. 非法 UID 不会被规范化成任何账号", () => {
  const pool = CP.buildFromRecords(
    root({
      "2026-11-10": {
        BV1: rec({ bvid: "BV1", upUid: "abc" }),
        BV2: rec({ bvid: "BV2", upUid: "0" }),
        BV3: rec({ bvid: "BV3", upUid: "-1" }),
        BV4: rec({ bvid: "BV4", upUid: 1.5 })
      }
    })
  );
  assert.equal(pool.candidates.length, 0);
  assert.equal(pool.diagnostics.nameOnlyVideos, 4);
  assert.equal(CP.normalizeUid("abc"), null);
  assert.equal(CP.normalizeUid("0"), null);
  assert.equal(CP.normalizeUid("-1"), null);
  assert.equal(CP.normalizeUid(1.5), null);
});

test("7. 纯数字 UID 被统一成字符串", () => {
  const pool = CP.buildFromRecords(
    root({ "2026-11-10": { BV1: rec({ upUid: 1001, upName: "UP甲" }) } })
  );
  assert.equal(only(pool).upUid, "1001");
  assert.equal(typeof only(pool).upUid, "string");
});

test("8. 带前后空格的 UID 会被去除空格后识别", () => {
  const pool = CP.buildFromRecords(
    root({ "2026-11-10": { BV1: rec({ upUid: "   1001   ", upName: "UP甲" }) } })
  );
  assert.equal(only(pool).upUid, "1001");
});

test("9. 空字符串 UID 不产生候选", () => {
  const pool = CP.buildFromRecords(
    root({ "2026-11-10": { BV1: rec({ upUid: "   ", upName: "UP甲" }) } })
  );
  assert.equal(pool.candidates.length, 0);
  assert.equal(pool.diagnostics.nameOnlyVideos, 1);
});

test("10. 新旧记录混合时取有 UID 的记录，同一 BV 只计一次", () => {
  const pool = CP.buildFromRecords(
    root({
      "2026-11-09": { BV1: rec({ bvid: "BV1", upUid: null, upName: "旧记录", watchMs: 20000 }) },
      "2026-11-10": { BV1: rec({ bvid: "BV1", upUid: "1001", upName: "UP甲", watchMs: 40000 }) }
    })
  );
  const candidate = only(pool);
  assert.equal(candidate.upUid, "1001");
  assert.equal(candidate.evidence.watchedVideoCount, 1);
  assert.equal(candidate.evidence.watchedWatchMs, 60000);
});

test("11. 历史记录重复（同一 BV 出现两次）不会重复计数", () => {
  const pool = CP.buildFromRecords(
    root({
      "2026-11-10": {
        k1: rec({ bvid: "BV1", upUid: "1001", upName: "UP甲", watchMs: 30000 }),
        k2: rec({ bvid: "BV1", upUid: "1001", upName: "UP甲", watchMs: 30000 })
      }
    })
  );
  const candidate = only(pool);
  assert.equal(candidate.evidence.watchedVideoCount, 1);
  assert.equal(candidate.evidence.watchedWatchMs, 60000);
});

/* ---------------------------------------------------------------- 2. 来源 B 与合并 */

test("12. 多来源同一 UID 合并来源并保持回访类型", () => {
  const watched = CP.buildFromRecords(
    root({ "2026-11-10": { BV1: rec({ upUid: "1001", upName: "UP甲" }) } })
  );
  const manual = CP.buildFromManual([{ upUid: "1001", upName: "UP甲" }]);
  const merged = CP.mergePools([watched, manual]);
  const candidate = only(merged);
  assert.deepEqual(candidate.sources, ["watched", "manual"]);
  assert.equal(candidate.candidateType, "returning");
  assert.equal(candidate.uidVerified, true);
  assert.equal(candidate.evidence.fromUserInput, true);
  assert.equal(candidate.evidence.fromWatchHistory, true);
  assert.equal(merged.summary.bySource.watched, 1);
  assert.equal(merged.summary.bySource.manual, 1);
});

test("13. 手动添加的新候选标记为 new，且不声明在线核验", () => {
  const pool = CP.buildFromManual([{ upUid: "2002", upName: "UP乙", observedAt: DEFAULT_START }]);
  const candidate = only(pool);
  assert.equal(candidate.candidateType, "new");
  assert.equal(candidate.watchedBefore, false);
  assert.deepEqual(candidate.sources, ["manual"]);
  assert.equal(candidate.uidVerified, false);
  assert.equal(candidate.evidence.fromUserInput, true);
  assert.equal(candidate.evidence.fromWatchHistory, false);
  assert.equal(candidate.evidence.onlineVerified, false);
  assert.equal(candidate.evidence.watchedVideoCount, 0);
  assert.equal(candidate.evidence.nameSource, "manual");
});

test("14. 手动 UID 与观看历史重叠时升级为回访候选", () => {
  const watched = CP.buildFromRecords(
    root({ "2026-11-10": { BV1: rec({ upUid: "1001", upName: "UP甲" }) } })
  );
  const merged = CP.mergePools([CP.buildFromManual(["1001"]), watched]);
  const candidate = only(merged);
  assert.equal(candidate.candidateType, "returning");
  assert.equal(candidate.uidVerified, true);
});

test("15. 手动输入的 UID 只能标记为格式通过、用户提供，不能标记为已在线核验", () => {
  const pool = CP.buildFromManual(["123456"]);
  const candidate = only(pool);
  assert.equal(candidate.evidence.uidFormatValid, true);
  assert.equal(candidate.evidence.fromUserInput, true);
  assert.equal(candidate.evidence.fromWatchHistory, false);
  assert.equal(candidate.evidence.onlineVerified, false);
  assert.equal(candidate.uidVerified, false);
});

test("16. 缺失时间字段时时间为 null，不用日期键反推", () => {
  const pool = CP.buildFromRecords(
    root({
      "2026-11-10": {
        BV1: rec({ upUid: "1001", startedAt: "", lastWatchedAt: "" })
      }
    })
  );
  const candidate = only(pool);
  assert.equal(candidate.firstObservedAt, null);
  assert.equal(candidate.lastObservedAt, null);
});

test("17. 不同来源的时间按可靠值取最早与最晚", () => {
  const watched = CP.buildFromRecords(
    root({
      "2026-11-10": {
        BV1: rec({
          upUid: "1001",
          startedAt: "2026-11-10T20:00:00.000+08:00",
          lastWatchedAt: "2026-11-10T20:30:00.000+08:00"
        })
      }
    })
  );
  const manual = CP.buildFromManual([
    { upUid: "1001", observedAt: "2026-11-12T10:00:00.000+08:00" }
  ]);
  const candidate = only(CP.mergePools([watched, manual]));
  assert.equal(candidate.firstObservedAt, Date.parse("2026-11-10T20:00:00.000+08:00"));
  assert.equal(candidate.lastObservedAt, Date.parse("2026-11-12T10:00:00.000+08:00"));
});

test("18. 构建候选池不修改任何输入对象", () => {
  const days = deepFreeze({
    "2026-11-10": {
      BV1: rec({ upUid: "1001", upName: "UP甲" }),
      BV2: rec({ bvid: "BV2", upUid: null, upName: "无UID" })
    }
  });
  const records = deepFreeze({ version: 1, days });
  const snapshot = JSON.stringify(records);
  CP.buildFromRecords(records);
  assert.equal(JSON.stringify(records), snapshot);

  const manual = deepFreeze([{ upUid: "2002", upName: "UP乙", observedAt: DEFAULT_START }]);
  const manualSnapshot = JSON.stringify(manual);
  const manualPool = CP.buildFromManual(manual);
  assert.equal(JSON.stringify(manual), manualSnapshot);

  const mergedInput = deepFreeze([manualPool]);
  CP.mergePools(mergedInput);
  assert.equal(manualPool.candidates.length, 1);
});

test("19. 空输入返回空池，不抛异常", () => {
  [null, undefined, {}, [], { version: 1 }, { days: {} }, ""].forEach((input) => {
    const pool = CP.buildFromRecords(input);
    assert.equal(pool.status, "empty");
    assert.equal(pool.reason, "no-candidates");
    assert.equal(pool.summary.total, 0);
    assert.deepEqual(pool.summary.byType, { returning: 0, new: 0, unknown: 0 });
  });
  assert.equal(CP.buildFromManual(null).status, "empty");
  assert.equal(CP.buildFromManual([]).status, "empty");
  assert.equal(CP.mergePools([]).status, "empty");
});

test("20. 异常数据结构安全降级，不产生候选", () => {
  const pool = CP.buildFromRecords({
    version: 1,
    days: {
      "not-a-date": { BV1: rec({ upUid: "1001" }) },
      "2026-11-10": null,
      "2026-11-11": { BV1: "oops", BV2: null }
    }
  });
  assert.equal(pool.status, "empty");
  assert.equal(pool.candidates.length, 0);
  assert.equal(pool.diagnostics.daysInvalid, 2);
  assert.equal(pool.diagnostics.recordsInvalid, 2);
});

test("21. 多个来源与重复合并后候选数量正确且不重复", () => {
  const watched = CP.buildFromRecords(
    root({
      "2026-11-09": { BV1: rec({ bvid: "BV1", upUid: "1001", upName: "UP甲", watchMs: 30000 }) },
      "2026-11-10": {
        BV2: rec({ bvid: "BV2", upUid: "1001", upName: "UP甲", watchMs: 30000 }),
        BV3: rec({ bvid: "BV3", upUid: "2002", upName: "UP乙", watchMs: 30000 })
      }
    })
  );
  assert.equal(watched.candidates.length, 2);

  const manual = CP.buildFromManual(["1001", "2002", "3003", "3003"]);
  assert.equal(manual.candidates.length, 3);
  assert.equal(manual.diagnostics.duplicatesInInput, 1);

  const merged = CP.mergePools([watched, manual, watched]);
  assert.equal(merged.candidates.length, 3);
  assert.equal(new Set(merged.candidates.map((item) => item.upUid)).size, 3);

  const target = CP.getCandidate(merged, "1001");
  assert.equal(target.evidence.watchedVideoCount, 2, "重复合并同一观看池不应把视频数翻倍");
  assert.equal(target.evidence.watchedWatchMs, 60000);
});

test("22. 候选类型按证据分类：returning / new / unknown", () => {
  const returning = only(
    CP.buildFromRecords(root({ "2026-11-10": { BV1: rec({ upUid: "1001" }) } }))
  );
  const fresh = only(CP.buildFromManual(["2002"]));
  const unknown = only(CP.mergePools([{ candidates: [{ upUid: "3003", sources: [] }] }]));

  assert.equal(returning.candidateType, "returning");
  assert.equal(fresh.candidateType, "new");
  assert.equal(unknown.candidateType, "unknown");
  assert.deepEqual(unknown.sources, []);
  assert.equal(unknown.uidVerified, false);
});

test("23. 候选不虚构分区、标签、作品或缺失的昵称", () => {
  const fromRecords = only(
    CP.buildFromRecords(root({ "2026-11-10": { BV1: rec({ upUid: "1001", upName: "" }) } }))
  );
  const fromManual = only(CP.buildFromManual(["2002"]));

  [fromRecords, fromManual].forEach((candidate) => {
    assert.equal("partition" in candidate, false);
    assert.equal("tags" in candidate, false);
    assert.equal("videos" in candidate, false);
    assert.equal("title" in candidate, false);
    // C2-2 追加了 conflictVideoCount / conflicts / nameConflict 三个身份证据字段；
    // 这里仍然逐键严格比对，保证 evidence 结构不会被悄悄改变。
    assert.deepEqual(Object.keys(candidate.evidence).sort(), [
      "conflictVideoCount",
      "conflicts",
      "fromUserInput",
      "fromWatchHistory",
      "nameConflict",
      "nameSource",
      "names",
      "onlineVerified",
      "uidFormatValid",
      "watchedVideoCount",
      "watchedWatchMs"
    ]);
  });

  assert.equal(fromRecords.upName, "");
  assert.equal(fromRecords.evidence.nameSource, "");
  assert.equal(fromManual.upName, "");
});

test("24. 输出顺序稳定，与记录插入顺序无关", () => {
  const first = CP.buildFromRecords(
    root({
      "2026-11-10": {
        BV1: rec({ bvid: "BV1", upUid: "3003", upName: "UP丙" }),
        BV2: rec({ bvid: "BV2", upUid: "1001", upName: "UP甲" })
      },
      "2026-11-11": { BV3: rec({ bvid: "BV3", upUid: "2002", upName: "UP乙" }) }
    })
  );
  const second = CP.buildFromRecords(
    root({
      "2026-11-11": { BV3: rec({ bvid: "BV3", upUid: "2002", upName: "UP乙" }) },
      "2026-11-10": {
        BV2: rec({ bvid: "BV2", upUid: "1001", upName: "UP甲" }),
        BV1: rec({ bvid: "BV1", upUid: "3003", upName: "UP丙" })
      }
    })
  );
  assert.deepEqual(
    first.candidates.map((item) => item.upUid),
    ["1001", "2002", "3003"]
  );
  assert.equal(JSON.stringify(first.candidates), JSON.stringify(second.candidates));
});

/* ---------------------------------------------------------------- 3. 查询、筛选与诊断 */

test("25. filterCandidates 按类型与来源筛选，不修改原池", () => {
  const watched = CP.buildFromRecords(
    root({
      "2026-11-10": {
        BV1: rec({ bvid: "BV1", upUid: "1001" }),
        BV2: rec({ bvid: "BV2", upUid: "2002" })
      }
    })
  );
  const merged = CP.mergePools([watched, CP.buildFromManual(["3003"])]);
  const returningOnly = CP.filterCandidates(merged, { candidateType: "returning" });
  const manualOnly = CP.filterCandidates(merged, { source: "manual" });

  assert.equal(merged.candidates.length, 3);
  assert.equal(returningOnly.candidates.length, 2);
  assert.equal(manualOnly.candidates.length, 1);
  assert.equal(manualOnly.candidates[0].upUid, "3003");
  assert.equal(returningOnly.diagnostics.filteredOut, 1);
  assert.equal(returningOnly.summary.total, 2);
});

test("26. getCandidate 支持数字与带空格 UID，非法输入返回 null", () => {
  const pool = CP.buildFromManual(["1001"]);
  assert.equal(CP.getCandidate(pool, 1001).upUid, "1001");
  assert.equal(CP.getCandidate(pool, " 1001 ").upUid, "1001");
  assert.equal(CP.getCandidate(pool, "9999"), null);
  assert.equal(CP.getCandidate(pool, "abc"), null);
  assert.equal(CP.getCandidate(null, "1001"), null);
});

test("27. 同一视频被记录成不同 UID 时给出冲突诊断，不静默抹掉", () => {
  const pool = CP.buildFromRecords(
    root({
      "2026-11-09": { BV1: rec({ bvid: "BV1", upUid: "1001", upName: "UP甲", watchMs: 30000 }) },
      "2026-11-10": { BV1: rec({ bvid: "BV1", upUid: "2002", upName: "UP乙", watchMs: 30000 }) }
    })
  );
  assert.equal(pool.diagnostics.uidConflictVideos, 1);
  assert.equal(pool.candidates.length, 2);
  assert.equal(CP.getCandidate(pool, "1001").evidence.watchedVideoCount, 1);
  assert.equal(CP.getCandidate(pool, "2002").evidence.watchedVideoCount, 0);
});

test("28. 手动输入逐条校验并给出可诊断原因", () => {
  const pool = CP.buildFromManual([
    null,
    "",
    "abc",
    { upUid: 1.5 },
    { upName: "没有UID" },
    {},
    0,
    -1,
    [{ upUid: "1001" }]
  ]);
  assert.equal(pool.diagnostics.entries, 9);
  assert.equal(pool.diagnostics.accepted, 0);
  assert.equal(pool.diagnostics.rejected, 9);
  assert.equal(pool.diagnostics.rejectedReasons["not-object"], 2);
  assert.equal(pool.diagnostics.rejectedReasons["missing-uid"], 3);
  assert.equal(pool.diagnostics.rejectedReasons["invalid-uid"], 4);
  assert.equal(pool.status, "empty");
});

test("29. 手动输入的时间非法时忽略，不编造时间也不丢候选", () => {
  const pool = CP.buildFromManual([{ upUid: "2002", observedAt: "not-a-date" }]);
  const candidate = only(pool);
  assert.equal(candidate.firstObservedAt, null);
  assert.equal(candidate.lastObservedAt, null);
  assert.equal(pool.diagnostics.invalidTimes, 1);
  assert.equal(pool.diagnostics.accepted, 1);
});

test("30. 统计摘要与类型、来源计数一致", () => {
  const watched = CP.buildFromRecords(
    root({
      "2026-11-10": {
        BV1: rec({ bvid: "BV1", upUid: "1001" }),
        BV2: rec({ bvid: "BV2", upUid: "2002" })
      }
    })
  );
  const merged = CP.mergePools([watched, CP.buildFromManual(["1001", "3003"])]);
  assert.deepEqual(merged.summary, {
    total: 3,
    byType: { returning: 2, new: 1, unknown: 0 },
    bySource: { watched: 2, manual: 2 },
    uidVerified: 2
  });
});

test("31. 结果可 JSON 序列化，不含 Map / Set / undefined", () => {
  const pool = CP.mergePools([
    CP.buildFromRecords(root({ "2026-11-10": { BV1: rec({ upUid: "1001" }) } })),
    CP.buildFromManual(["2002"])
  ]);
  const roundTrip = JSON.parse(JSON.stringify(pool));
  assert.deepEqual(roundTrip, pool);
  assert.equal(roundTrip.diagnostics.inputKind, "merged");
});

test("32. 超大 UID 保持字符串精度，不经过 Number 丢失精度", () => {
  const big = "9007199254740991";
  const pool = CP.buildFromRecords(
    root({ "2026-11-10": { BV1: rec({ upUid: big, upName: "大UID" }) } })
  );
  assert.equal(only(pool).upUid, big);
  assert.equal(CP.normalizeUid("9007199254740993"), null, "超出安全整数的 UID 应被拒绝");
});

/* ---------------------------------------------------------------- 输出 */

const failed = results.filter((item) => !item.ok);
results.forEach((item) => {
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}`);
  if (!item.ok) console.log(`      ${item.error && item.error.message}`);
});
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exitCode = failed.length === 0 ? 0 : 1;
