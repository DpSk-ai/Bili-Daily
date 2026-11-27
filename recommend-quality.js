"use strict";

/**
 * Bili Daily —— 推荐质量层（阶段 C3-2）
 *
 * 纯函数模块：时间衰减、用户证据评估、候选特征可靠性、冷启动状态、
 * 重复曝光信号。只输出权重、指标与诊断，**不产出推荐综合分、不排序、不出推荐列表**。
 *
 * 不调用 chrome.*、DOM、fetch、XMLHttpRequest、Cookie，不读文件系统，不访问网络，
 * 不写任何存储，不修改传入对象，不接受外部代码回调。
 *
 * 依赖（只读取，不修改）：
 *   - stats.js                   cleanRecord / mergeByBvid / 本地日期工具
 *   - candidate-features.js      extractTitleBigrams
 *   - recommend-core.js          C3-1 的向量构建（仅用于"关闭衰减"时委托，保证结果一致）
 *
 * ---------------------------------------------------------------------------
 * 关键口径（与审计结论一致）
 * ---------------------------------------------------------------------------
 *   1. 跨天合并会丢失每日 watchMs：stats.mergeByBvid 把同一 BV 多天时长直接相加，
 *      且 lastWatchedAt 取排序后第一条非空，不保证是最近一次。因此本模块
 *      **不依赖合并后的时间字段**，而是按真实日期键逐日取 watchMs 重建衰减贡献。
 *   2. 衰减关闭时直接委托 C3-1，保证默认行为与 C3-1 完全一致。
 *   3. 衰减开启时按"每日贡献 × 当日权重"累加；分区按每日分区归属，
 *      标题按"每个 BV 一个文档、以最近观看日加权"，文档数不虚增。
 *   4. 时间衰减（兴趣漂移）与重复曝光抑制是两个独立概念：
 *      前者作用在用户向量，后者只是一个默认关闭的排序信号，不修改相似度。
 */

(function (global) {
  const Stats = global.BiliDailyStats;
  const Features = global.BiliDailyCandidateFeatures;
  const Core = global.BiliDailyRecommendCore;

  if (
    !Stats ||
    typeof Stats.cleanRecord !== "function" ||
    typeof Stats.mergeByBvid !== "function" ||
    typeof Stats.parseDateKey !== "function" ||
    typeof Stats.shiftLocalDate !== "function" ||
    typeof Stats.localDateKey !== "function"
  ) {
    throw new Error("Bili Daily recommend-quality.js 需要先加载 stats.js");
  }
  if (!Features || typeof Features.extractTitleBigrams !== "function") {
    throw new Error(
      "Bili Daily recommend-quality.js 需要先加载 candidate-features.js"
    );
  }
  if (
    !Core ||
    typeof Core.buildUserPartitionVector !== "function" ||
    typeof Core.buildUserTextCounts !== "function"
  ) {
    throw new Error(
      "Bili Daily recommend-quality.js 需要先加载 recommend-core.js"
    );
  }

  const MODULE_KIND = "bili-daily-recommend-quality";
  const MODULE_VERSION = 1;

  const FEATURE_SPACE = Core.FEATURE_SPACE;
  const LANE = Core.LANE;
  const BASIS = Core.BASIS;
  const UNKNOWN_PARTITION = Core.UNKNOWN_PARTITION;

  const EVIDENCE_KIND = "bili-daily-user-evidence";
  const DECAY_KIND = "bili-daily-time-decay";
  const RELIABILITY_KIND = "bili-daily-feature-reliability";
  const COLD_START_KIND = "bili-daily-cold-start";
  const EXPOSURE_KIND = "bili-daily-exposure-signal";

  const DECAY_FORMULA = "0.5^(ageDays/H)";
  const DAY_MS = 24 * 60 * 60 * 1000;

  /** 衰减默认值：14 天只是实验起点，不是已验证的最优值。 */
  const DEFAULT_DECAY = Object.freeze({
    enabled: false,
    halfLifeDays: 14
  });

  /** 冷启动阈值。前两项与 C1 完全一致；后两项参考 C2-0 调研的数据量结论。 */
  const DEFAULT_THRESHOLDS = Object.freeze({
    // 与 stats.EFFECTIVE_WATCH_MS 一致，不得另立口径
    effectiveWatchMs: 30000,
    // 与 interest-profile.js 的 PROFILE_MIN_WATCH_MS / PROFILE_MIN_ACTIVE_DAYS 一致
    insufficientMinWatchMs: 10 * 60 * 1000,
    insufficientMinActiveDays: 2,
    // 本阶段新增的 limited / ready 门槛（C1 只有 empty / insufficient / ok）
    limitedMinEffectiveVideos: 5,
    limitedMinActiveDays: 3,
    // C2-0 调研：≥ 50 个有效视频、≥ 14 个有效观看日才谈效果评估
    readyMinEffectiveVideos: 50,
    readyMinActiveDays: 14
  });

  /** 可靠性等级阈值（工程启发式，不是概率）。 */
  const RELIABILITY_THRESHOLDS = Object.freeze({
    high: 0.8,
    medium: 0.5
  });

  /** 重复曝光信号默认关闭。 */
  const DEFAULT_EXPOSURE = Object.freeze({
    enabled: false,
    windowDays: 7
  });

  /* ---------------------------------------------------------------- 基础工具 */

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function compareText(left, right) {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  function reason(code, message) {
    return { code, message };
  }

  function setOwn(target, key, value) {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true
    });
  }

  function hasOwn(target, key) {
    return Object.prototype.hasOwnProperty.call(target, key);
  }

  function safeNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  /** 本地日期键 → UTC 日历日差（不受夏令时影响）。 */
  function calendarDayDiff(fromKey, toKey) {
    const from = Stats.parseDateKey(fromKey);
    const to = Stats.parseDateKey(toKey);
    if (!from || !to) return null;
    const fromMs = Date.UTC(from.year, from.month - 1, from.day);
    const toMs = Date.UTC(to.year, to.month - 1, to.day);
    return Math.round((toMs - fromMs) / DAY_MS);
  }

  /* ---------------------------------------------------------------- 时间解析 */

  /** 解析 now：数字 / ISO 字符串 / Date；显式传入但非法 → 报错而不是回退系统时间。 */
  function resolveNow(options) {
    const raw = options.now;
    if (raw === undefined || raw === null) {
      return { ok: true, ms: Date.now(), source: "system-clock" };
    }
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return { ok: true, ms: raw, source: "options.now" };
    }
    if (typeof raw === "string") {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) {
        return { ok: true, ms: parsed, source: "options.now" };
      }
    }
    if (raw instanceof Date && Number.isFinite(raw.getTime())) {
      return { ok: true, ms: raw.getTime(), source: "options.now" };
    }
    return { ok: false, ms: null, source: "invalid" };
  }

  function resolveHalfLife(options) {
    const raw = options.halfLifeDays;
    if (raw === undefined || raw === null) {
      return { ok: true, value: DEFAULT_DECAY.halfLifeDays };
    }
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
      return { ok: false, value: null };
    }
    return { ok: true, value: raw };
  }

  /**
   * 解析观察时间，返回 ageDays。
   *
   * - 时间戳（epoch ms / ISO）：ageDays = (now - t) / 86400000，ageBasis = "ms"；
   * - 日期键 "YYYY-MM-DD"：按本地日历日差计算，ageBasis = "local-date"，
   *   不引入"当天几点"的假设，也不受夏令时的 23/25 小时影响。
   */
  function parseObservation(observation, nowMs) {
    if (observation === undefined || observation === null) {
      return { ok: false, code: "missing-time", message: "没有提供观察时间" };
    }

    if (isPlainObject(observation)) {
      if (typeof observation.dateKey === "string") {
        return parseObservation(observation.dateKey, nowMs);
      }
      if (observation.time !== undefined) {
        return parseObservation(observation.time, nowMs);
      }
      return { ok: false, code: "invalid-time", message: "观察时间对象缺少 time / dateKey" };
    }

    if (typeof observation === "number") {
      if (!Number.isFinite(observation)) {
        return { ok: false, code: "invalid-time", message: "时间戳不是有限数字" };
      }
      return {
        ok: true,
        kind: "timestamp",
        timeMs: observation,
        dateKey: null,
        ageDays: (nowMs - observation) / DAY_MS,
        ageBasis: "ms"
      };
    }

    if (observation instanceof Date) {
      const value = observation.getTime();
      if (!Number.isFinite(value)) {
        return { ok: false, code: "invalid-time", message: "Date 对象时间无效" };
      }
      return {
        ok: true,
        kind: "timestamp",
        timeMs: value,
        dateKey: null,
        ageDays: (nowMs - value) / DAY_MS,
        ageBasis: "ms"
      };
    }

    if (typeof observation === "string") {
      const text = observation.trim();
      if (!text) {
        return { ok: false, code: "missing-time", message: "观察时间为空字符串" };
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        if (!Stats.parseDateKey(text)) {
          return { ok: false, code: "invalid-time", message: "日期键不是合法日历日" };
        }
        const todayKey = Stats.localDateKey(nowMs);
        if (!todayKey) {
          return { ok: false, code: "invalid-now", message: "无法确定今天的本地日期" };
        }
        const diff = calendarDayDiff(text, todayKey);
        if (diff === null) {
          return { ok: false, code: "invalid-time", message: "无法计算日期差" };
        }
        return {
          ok: true,
          kind: "date-key",
          timeMs: null,
          dateKey: text,
          ageDays: diff,
          ageBasis: "local-date"
        };
      }
      const parsed = Date.parse(text);
      if (!Number.isFinite(parsed)) {
        return { ok: false, code: "invalid-time", message: "无法解析 ISO 时间" };
      }
      return {
        ok: true,
        kind: "timestamp",
        timeMs: parsed,
        dateKey: null,
        ageDays: (nowMs - parsed) / DAY_MS,
        ageBasis: "ms"
      };
    }

    return { ok: false, code: "invalid-time", message: "不支持的观察时间类型" };
  }

  /**
   * 指数半衰期权重。
   *
   *   decay(ageDays, H) = 0.5 ^ (ageDays / H)
   *
   * 边界：
   *   - ageDays = 0 → 1；
   *   - ageDays = H → 0.5；
   *   - ageDays = 2H → 0.25；
   *   - 未来时间 → weight = null（不把时钟漂移当成"刚刚看过"）；
   *   - 缺失 / 非法时间 → weight = null；
   *   - 极久远 → 权重趋近 0，不会出现 NaN / Infinity。
   *
   * @param {number|string|object} observation 时间戳、ISO 字符串、日期键或 {dateKey/time}
   * @param {object} [options] { now, halfLifeDays }
   */
  function computeTimeDecay(observation, options) {
    const opts = isPlainObject(options) ? options : {};
    const reasons = [];
    const nowInfo = resolveNow(opts);

    if (!nowInfo.ok) {
      reasons.push(reason("invalid-now", "options.now 不是合法时间"));
      return {
        kind: DECAY_KIND,
        module: MODULE_KIND,
        version: MODULE_VERSION,
        status: "invalid-now",
        halfLifeDays: null,
        ageDays: null,
        weight: null,
        ageBasis: null,
        timeSource: "none",
        observation: { dateKey: null, timeMs: null },
        now: null,
        formula: DECAY_FORMULA,
        reasons,
        config: { enabled: true, halfLifeDays: null, nowSource: "invalid" }
      };
    }

    const halfLife = resolveHalfLife(opts);
    if (!halfLife.ok) {
      reasons.push(reason("invalid-half-life", "半衰期必须是有限正数"));
      return {
        kind: DECAY_KIND,
        module: MODULE_KIND,
        version: MODULE_VERSION,
        status: "invalid-half-life",
        halfLifeDays: null,
        ageDays: null,
        weight: null,
        ageBasis: null,
        timeSource: "none",
        observation: { dateKey: null, timeMs: null },
        now: nowInfo.ms,
        formula: DECAY_FORMULA,
        reasons,
        config: { enabled: true, halfLifeDays: null, nowSource: nowInfo.source }
      };
    }

    const parsed = parseObservation(observation, nowInfo.ms);
    const base = {
      kind: DECAY_KIND,
      module: MODULE_KIND,
      version: MODULE_VERSION,
      halfLifeDays: halfLife.value,
      now: nowInfo.ms,
      formula: DECAY_FORMULA
    };

    if (!parsed.ok) {
      reasons.push(reason(parsed.code, parsed.message));
      return Object.assign({}, base, {
        status: parsed.code === "missing-time" ? "missing-time" : "invalid-time",
        ageDays: null,
        weight: null,
        ageBasis: null,
        timeSource: "none",
        observation: { dateKey: null, timeMs: null },
        reasons,
        config: { enabled: true, halfLifeDays: halfLife.value, nowSource: nowInfo.source }
      });
    }

    if (parsed.ageDays < 0) {
      reasons.push(reason("future-time", "观察时间晚于 now，不能获得高权重"));
      return Object.assign({}, base, {
        status: "future-time",
        ageDays: parsed.ageDays,
        weight: null,
        ageBasis: parsed.ageBasis,
        timeSource: parsed.kind,
        observation: { dateKey: parsed.dateKey, timeMs: parsed.timeMs },
        reasons,
        config: { enabled: true, halfLifeDays: halfLife.value, nowSource: nowInfo.source }
      });
    }

    let weight = Math.pow(0.5, parsed.ageDays / halfLife.value);
    if (!Number.isFinite(weight)) weight = 0;
    weight = clamp(weight, 0, 1);

    return Object.assign({}, base, {
      status: "ok",
      ageDays: parsed.ageDays,
      weight,
      ageBasis: parsed.ageBasis,
      timeSource: parsed.kind,
      observation: { dateKey: parsed.dateKey, timeMs: parsed.timeMs },
      reasons,
      config: { enabled: true, halfLifeDays: halfLife.value, nowSource: nowInfo.source }
    });
  }

  /* ---------------------------------------------------------------- 逐日收集 */

  function readDays(records) {
    if (!isPlainObject(records)) return { days: {}, kind: "empty" };
    if (isPlainObject(records.days)) return { days: records.days, kind: "root" };
    if (hasOwn(records, "version")) return { days: {}, kind: "root" };
    return { days: records, kind: "days" };
  }

  function resolveEndDate(options) {
    if (
      typeof options.endDate === "string" &&
      Stats.parseDateKey(options.endDate)
    ) {
      return options.endDate;
    }
    const nowValue = options.now == null ? Date.now() : options.now;
    const key = Stats.localDateKey(nowValue);
    return key || Stats.localDateKey(Date.now());
  }

  function resolveWindowDays(options, reasons) {
    const raw = options.windowDays;
    if (raw === undefined || raw === null) return 30;
    const value = Number(raw);
    if (
      !Number.isFinite(value) ||
      Math.floor(value) !== value ||
      value < 1 ||
      value > 366
    ) {
      reasons.push(
        reason("invalid-window-days", "窗口天数非法，已回退默认 30 天")
      );
      return 30;
    }
    return value;
  }

  function compareRecordsForMerge(left, right) {
    return (
      compareText(left.bvid || "", right.bvid || "") ||
      compareText(left.title || "", right.title || "") ||
      right.watchMs - left.watchMs ||
      (left.page == null ? -1 : left.page) - (right.page == null ? -1 : right.page)
    );
  }

  /**
   * 保留每日粒度的收集器。
   *
   * 与 recommend-core 的区别：不在跨天阶段调用 mergeByBvid，
   * 因此每个日期键的 watchMs、分区、标题都保留下来，供衰减使用。
   * 每日内部仍按 BV 合并（同一天多分 P / 重复记录只算一份时长）。
   */
  function collectDailyBuckets(records, options) {
    const reasons = [];
    const days = readDays(records);
    const endDate = resolveEndDate(options);
    const dayCount = resolveWindowDays(options, reasons);
    const startDate = Stats.shiftLocalDate(endDate, -(dayCount - 1));

    if (!startDate) {
      reasons.push(reason("invalid-window", "无法计算统计窗口起始日期"));
      return {
        ok: false,
        endDate,
        startDate: "",
        dayCount,
        dateKeys: [],
        buckets: [],
        records: [],
        invalidRecords: 0,
        reasons
      };
    }

    const dateKeys = [];
    for (let index = 0; index < dayCount; index += 1) {
      dateKeys.push(Stats.shiftLocalDate(startDate, index));
    }

    const buckets = [];
    const flatRecords = [];
    let invalidRecords = 0;

    dateKeys.forEach((dateKey) => {
      const day = days.days[dateKey];
      if (!isPlainObject(day)) return;

      const cleaned = [];
      Object.keys(day).forEach((key) => {
        const record = Stats.cleanRecord(day[key], key);
        if (!record) {
          invalidRecords += 1;
          return;
        }
        cleaned.push(record);
        flatRecords.push(record);
      });

      cleaned.sort(compareRecordsForMerge);
      buckets.push({
        dateKey,
        videos: Stats.mergeByBvid(cleaned)
      });
    });

    return {
      ok: true,
      endDate,
      startDate,
      dayCount,
      dateKeys,
      buckets,
      records: flatRecords,
      invalidRecords,
      reasons
    };
  }

  function isIdentifiedPartition(name) {
    return typeof name === "string" && name !== "" && name !== UNKNOWN_PARTITION;
  }

  function windowBlock(collected) {
    return {
      endDate: collected.endDate,
      startDate: collected.startDate,
      dayCount: collected.dayCount,
      includeZeroWatch: false
    };
  }

  /* ---------------------------------------------------------------- 衰减后的用户特征 */

  function failedPartitionOutput(status, reasons, meta) {
    return {
      kind: "bili-daily-recommend-vector",
      module: MODULE_KIND,
      version: MODULE_VERSION,
      space: FEATURE_SPACE.PARTITION,
      side: "user",
      lane: null,
      basis: BASIS.WATCH_MS,
      status,
      available: false,
      vector: null,
      dimensions: [],
      norm: 0,
      weighting: "watch-ms-decayed",
      decay: "time-decay",
      coverage: {
        basis: BASIS.WATCH_MS,
        weighting: "time-decay",
        ratio: null,
        totalWeightMs: 0,
        identifiedWeightMs: 0,
        unknownWeightMs: 0
      },
      sample: {
        videoCount: 0,
        effectiveVideoCount: 0,
        identifiedVideoCount: 0,
        unknownVideoCount: 0,
        excludedZeroWatchVideos: 0,
        invalidRecords: 0
      },
      window: meta && meta.window ? meta.window : { endDate: "", startDate: "", dayCount: 0, includeZeroWatch: false },
      decayConfig: meta && meta.decayConfig ? meta.decayConfig : {
        enabled: true,
        halfLifeDays: null,
        formula: DECAY_FORMULA,
        timeBasis: "local-date",
        appliedTo: "per-local-day watch-ms",
        daysWithData: 0,
        skippedDays: 0,
        oldestDateKey: null,
        newestDateKey: null
      },
      reasons,
      note: "时间衰减不可用，未生成用户分区向量。"
    };
  }

  function failedTextOutput(status, reasons, meta) {
    return {
      kind: "bili-daily-recommend-counts",
      module: MODULE_KIND,
      version: MODULE_VERSION,
      space: FEATURE_SPACE.TITLE,
      side: "user",
      lane: null,
      basis: BASIS.TOKEN_COUNT,
      status,
      available: false,
      counts: {},
      dimensions: [],
      tokenCount: 0,
      totalTokenCount: 0,
      truncated: false,
      truncatedTokens: 0,
      weighting: "raw-count-times-decay",
      decay: "time-decay",
      coverage: {
        basis: BASIS.VIDEO_COUNT,
        videoCount: 0,
        titledVideoCount: 0,
        tokenizedVideoCount: 0,
        titleCoverage: null,
        tokenCoverage: null
      },
      sample: {
        videoCount: 0,
        titledVideoCount: 0,
        tokenizedVideoCount: 0,
        tokenlessVideoCount: 0,
        missingTitleCount: 0,
        excludedZeroWatchVideos: 0,
        invalidRecords: 0
      },
      window: meta && meta.window ? meta.window : { endDate: "", startDate: "", dayCount: 0, includeZeroWatch: false },
      decayConfig: meta && meta.decayConfig ? meta.decayConfig : {
        enabled: true,
        halfLifeDays: null,
        formula: DECAY_FORMULA,
        timeBasis: "latest-watch-day",
        appliedTo: "one document per BV",
        daysWithData: 0,
        skippedDays: 0,
        oldestDateKey: null,
        newestDateKey: null
      },
      reasons,
      note: "时间衰减不可用，未生成用户标题词频。"
    };
  }

  function decayMeta(halfLifeDays, collected) {
    const keys = collected.buckets
      .filter((bucket) => bucket.videos.some((video) => video.watchMs > 0))
      .map((bucket) => bucket.dateKey)
      .sort(compareText);
    return {
      enabled: true,
      halfLifeDays,
      formula: DECAY_FORMULA,
      timeBasis: "local-date",
      appliedTo: "per-local-day watch-ms",
      daysWithData: keys.length,
      skippedDays: 0,
      oldestDateKey: keys.length > 0 ? keys[0] : null,
      newestDateKey: keys.length > 0 ? keys[keys.length - 1] : null
    };
  }

  /**
   * 用户分区向量（可带时间衰减）。
   *
   * 关闭衰减（默认）→ 直接委托 C3-1，结果与 C3-1 完全一致。
   * 开启衰减 → 逐日计算 `watchMs × 当日权重`，再按分区累加；
   *   同一天同一 BV 仍只算一个视频，跨天时长不再被简单归到"最新一次"。
   */
  function buildDecayedUserPartitionVector(records, options) {
    const opts = isPlainObject(options) ? options : {};
    const enabled = opts.decayEnabled === true;

    if (!enabled) {
      const base = Core.buildUserPartitionVector(records, opts);
      return Object.assign({}, base, {
        decay: "none",
        decayConfig: {
          enabled: false,
          halfLifeDays: null,
          formula: "none",
          timeBasis: "none",
          appliedTo: "none"
        },
        delegatedTo: "bili-daily-recommend-core"
      });
    }

    const reasons = [];
    const halfLife = resolveHalfLife(opts);
    const nowInfo = resolveNow(opts);
    if (!halfLife.ok) {
      reasons.push(reason("invalid-half-life", "半衰期必须是有限正数"));
      return failedPartitionOutput("invalid-half-life", reasons, null);
    }
    if (!nowInfo.ok) {
      reasons.push(reason("invalid-now", "options.now 不是合法时间"));
      return failedPartitionOutput("invalid-now", reasons, null);
    }

    const collected = collectDailyBuckets(records, opts);
    collected.reasons.forEach((item) => reasons.push(item));
    const meta = {
      window: windowBlock(collected),
      decayConfig: decayMeta(halfLife.value, collected)
    };
    if (!collected.ok) {
      return failedPartitionOutput("invalid", reasons, meta);
    }

    const partitionWeighted = new Map();
    const perBv = new Map();
    let totalWeightedMs = 0;
    let identifiedWeightedMs = 0;
    let unknownWeightedMs = 0;
    let skippedDays = 0;
    let excludedZeroWatchVideos = 0;

    collected.buckets.forEach((bucket) => {
      const decay = computeTimeDecay(
        { dateKey: bucket.dateKey },
        { now: nowInfo.ms, halfLifeDays: halfLife.value }
      );
      if (decay.status !== "ok") {
        skippedDays += 1;
        return;
      }
      const weight = decay.weight;
      bucket.videos.forEach((video) => {
        const watchMs = safeNumber(video.watchMs);
        if (watchMs === null || watchMs <= 0) {
          excludedZeroWatchVideos += 1;
          return;
        }
        const contribution = watchMs * weight;
        if (!Number.isFinite(contribution) || contribution <= 0) return;
        totalWeightedMs += contribution;

        let entry = perBv.get(video.bvid);
        if (!entry) {
          entry = {
            bvid: video.bvid,
            rawWatchMs: 0,
            identified: false,
            unknown: false
          };
          perBv.set(video.bvid, entry);
        }
        entry.rawWatchMs += watchMs;

        if (isIdentifiedPartition(video.partition)) {
          identifiedWeightedMs += contribution;
          entry.identified = true;
          partitionWeighted.set(
            video.partition,
            (partitionWeighted.get(video.partition) || 0) + contribution
          );
        } else {
          unknownWeightedMs += contribution;
          entry.unknown = true;
        }
      });
    });

    const entries = {};
    if (identifiedWeightedMs > 0) {
      partitionWeighted.forEach((value, name) => {
        setOwn(entries, name, value / identifiedWeightedMs);
      });
    }
    const vector = {};
    Object.keys(entries)
      .sort(compareText)
      .forEach((key) => {
        const value = entries[key];
        if (Number.isFinite(value) && value > 0) setOwn(vector, key, value);
      });
    const dimensions = Object.keys(vector);
    const available = dimensions.length > 0;

    let videoCount = 0;
    let effectiveVideoCount = 0;
    let identifiedVideoCount = 0;
    let unknownVideoCount = 0;
    perBv.forEach((entry) => {
      if (entry.rawWatchMs <= 0) return;
      videoCount += 1;
      if (entry.rawWatchMs >= DEFAULT_THRESHOLDS.effectiveWatchMs) {
        effectiveVideoCount += 1;
      }
      if (entry.identified) identifiedVideoCount += 1;
      else if (entry.unknown) unknownVideoCount += 1;
    });

    let norm = 0;
    dimensions.forEach((key) => {
      norm += vector[key] * vector[key];
    });
    norm = Math.sqrt(norm);

    let status = "ok";
    if (videoCount === 0) {
      status = "empty";
      reasons.push(reason("no-watched-videos", "统计窗口内没有实际观看时长的视频"));
    } else if (!available) {
      status = "unavailable";
      reasons.push(
        reason("no-identified-partition", "窗口内没有任何可识别的分区，分区向量不可用")
      );
    }

    return {
      kind: "bili-daily-recommend-vector",
      module: MODULE_KIND,
      version: MODULE_VERSION,
      space: FEATURE_SPACE.PARTITION,
      side: "user",
      lane: null,
      basis: BASIS.WATCH_MS,
      status,
      available,
      vector: available ? vector : null,
      dimensions,
      norm: available ? norm : 0,
      weighting: "watch-ms-decayed",
      decay: "time-decay",
      coverage: {
        basis: BASIS.WATCH_MS,
        weighting: "time-decay",
        ratio: totalWeightedMs > 0 ? identifiedWeightedMs / totalWeightedMs : null,
        totalWeightMs: totalWeightedMs,
        identifiedWeightMs: identifiedWeightedMs,
        unknownWeightMs: unknownWeightedMs
      },
      sample: {
        videoCount,
        effectiveVideoCount,
        identifiedVideoCount,
        unknownVideoCount,
        excludedZeroWatchVideos,
        invalidRecords: collected.invalidRecords
      },
      window: windowBlock(collected),
      decayConfig: Object.assign({}, meta.decayConfig, { skippedDays }),
      reasons,
      note:
        "开启时间衰减：按真实日期键逐日取 watchMs 并乘以当日半衰期权重，" +
        "同一天内仍按 BV 合并；未知分区不参与匹配但计入覆盖率。" +
        "本函数不产出推荐分数。"
    };
  }

  /**
   * 用户标题词频（可带时间衰减）。
   *
   * 关闭衰减（默认）→ 委托 C3-1，结果与 C3-1 完全一致。
   * 开启衰减 → 每个 BV 仍只贡献一个内容文档（标题取确定性的最小非空标题），
   *   文档权重取该 BV **最近一次观看日** 的衰减权重，词频按权重缩放。
   */
  function buildDecayedUserTextCounts(records, options) {
    const opts = isPlainObject(options) ? options : {};
    const enabled = opts.decayEnabled === true;

    if (!enabled) {
      const base = Core.buildUserTextCounts(records, opts);
      return Object.assign({}, base, {
        decay: "none",
        decayConfig: {
          enabled: false,
          halfLifeDays: null,
          formula: "none",
          timeBasis: "none",
          appliedTo: "none"
        },
        delegatedTo: "bili-daily-recommend-core"
      });
    }

    const reasons = [];
    const halfLife = resolveHalfLife(opts);
    const nowInfo = resolveNow(opts);
    if (!halfLife.ok) {
      reasons.push(reason("invalid-half-life", "半衰期必须是有限正数"));
      return failedTextOutput("invalid-half-life", reasons, null);
    }
    if (!nowInfo.ok) {
      reasons.push(reason("invalid-now", "options.now 不是合法时间"));
      return failedTextOutput("invalid-now", reasons, null);
    }

    const collected = collectDailyBuckets(records, opts);
    collected.reasons.forEach((item) => reasons.push(item));
    const meta = {
      window: windowBlock(collected),
      decayConfig: Object.assign({}, decayMeta(halfLife.value, collected), {
        timeBasis: "latest-watch-day",
        appliedTo: "one document per BV"
      })
    };
    if (!collected.ok) {
      return failedTextOutput("invalid", reasons, meta);
    }

    const maxTokens =
      Number.isFinite(opts.maxTokens) && opts.maxTokens >= 1
        ? Math.floor(opts.maxTokens)
        : 2000;

    const perBv = new Map();
    let excludedZeroWatchVideos = 0;

    collected.buckets.forEach((bucket) => {
      bucket.videos.forEach((video) => {
        const watchMs = safeNumber(video.watchMs);
        if (watchMs === null || watchMs <= 0) {
          excludedZeroWatchVideos += 1;
          return;
        }
        let entry = perBv.get(video.bvid);
        if (!entry) {
          entry = {
            bvid: video.bvid,
            watchMs: 0,
            latestDateKey: "",
            titles: []
          };
          perBv.set(video.bvid, entry);
        }
        entry.watchMs += watchMs;
        if (!entry.latestDateKey || bucket.dateKey > entry.latestDateKey) {
          entry.latestDateKey = bucket.dateKey;
        }
        if (typeof video.title === "string" && video.title.trim()) {
          entry.titles.push(video.title.trim());
        }
      });
    });

    const counts = new Map();
    let videoCount = 0;
    let titledVideoCount = 0;
    let tokenizedVideoCount = 0;
    let tokenlessVideoCount = 0;
    let missingTitleCount = 0;
    let skippedDocuments = 0;

    perBv.forEach((entry) => {
      if (entry.watchMs <= 0) return;
      videoCount += 1;

      // 与 C3-1 的跨天合并保持一致：取确定性顺序下第一个非空标题。
      const title = entry.titles.slice().sort(compareText)[0] || "";
      if (!title) {
        missingTitleCount += 1;
        return;
      }
      titledVideoCount += 1;

      let tokens = [];
      try {
        tokens = Features.extractTitleBigrams(title);
      } catch (error) {
        tokens = [];
      }
      if (!Array.isArray(tokens) || tokens.length === 0) {
        tokenlessVideoCount += 1;
        return;
      }

      const decay = computeTimeDecay(
        { dateKey: entry.latestDateKey },
        { now: nowInfo.ms, halfLifeDays: halfLife.value }
      );
      if (decay.status !== "ok" || decay.weight === null) {
        skippedDocuments += 1;
        return;
      }
      tokenizedVideoCount += 1;

      tokens.forEach((token) => {
        if (typeof token !== "string" || !token) return;
        counts.set(token, (counts.get(token) || 0) + decay.weight);
      });
    });

    const sortedTokens = Array.from(counts.entries())
      .map(([token, count]) => ({ token, count }))
      .sort(
        (left, right) =>
          right.count - left.count || compareText(left.token, right.token)
      );

    let truncatedTokens = 0;
    if (sortedTokens.length > maxTokens) {
      truncatedTokens = sortedTokens.length - maxTokens;
      sortedTokens.length = maxTokens;
    }

    const countObject = {};
    let totalTokenCount = 0;
    sortedTokens.forEach((entry) => {
      setOwn(countObject, entry.token, entry.count);
      totalTokenCount += entry.count;
    });

    const dimensions = sortedTokens.map((entry) => entry.token);
    const available = dimensions.length > 0;

    let status = "ok";
    if (videoCount === 0) {
      status = "empty";
      reasons.push(reason("no-watched-videos", "统计窗口内没有实际观看时长的视频"));
    } else if (!available) {
      status = "unavailable";
      reasons.push(reason("no-title-tokens", "窗口内没有可生成词元的标题"));
    }

    return {
      kind: "bili-daily-recommend-counts",
      module: MODULE_KIND,
      version: MODULE_VERSION,
      space: FEATURE_SPACE.TITLE,
      side: "user",
      lane: null,
      basis: BASIS.TOKEN_COUNT,
      status,
      available,
      counts: countObject,
      dimensions,
      tokenCount: dimensions.length,
      totalTokenCount,
      truncated: truncatedTokens > 0,
      truncatedTokens,
      weighting: "raw-count-times-decay",
      decay: "time-decay",
      coverage: {
        basis: BASIS.VIDEO_COUNT,
        videoCount,
        titledVideoCount,
        tokenizedVideoCount,
        titleCoverage: videoCount > 0 ? titledVideoCount / videoCount : null,
        tokenCoverage: videoCount > 0 ? tokenizedVideoCount / videoCount : null
      },
      sample: {
        videoCount,
        titledVideoCount,
        tokenizedVideoCount,
        tokenlessVideoCount,
        missingTitleCount,
        excludedZeroWatchVideos,
        invalidRecords: collected.invalidRecords
      },
      window: windowBlock(collected),
      decayConfig: Object.assign({}, meta.decayConfig, { skippedDocuments }),
      reasons,
      note:
        "开启时间衰减：每个 BV 只贡献一个标题文档，文档权重取最近一次观看日的衰减值；" +
        "标题覆盖率仍按视频数统计。" +
        "本函数不产出推荐分数。"
    };
  }

  /* ---------------------------------------------------------------- 用户证据 */

  function normalizeThresholds(input) {
    const source = isPlainObject(input) ? input : {};
    const result = {};
    Object.keys(DEFAULT_THRESHOLDS).forEach((key) => {
      const value = source[key];
      result[key] =
        typeof value === "number" && Number.isFinite(value) && value >= 0
          ? value
          : DEFAULT_THRESHOLDS[key];
    });
    return result;
  }

  function guidanceFor(status) {
    if (status === "empty") {
      return [
        {
          code: "no-watch-data",
          message: "还没有可用的观看记录，无法生成任何推荐；请继续正常观看。"
        }
      ];
    }
    if (status === "insufficient") {
      return [
        {
          code: "only-returning",
          message: "数据较少，只适合展示你常看的 UP 主，不做相似度推荐。"
        },
        {
          code: "watch-more",
          message: "继续积累观看记录后才能评估内容匹配。"
        }
      ];
    }
    if (status === "limited") {
      return [
        {
          code: "limited-matching",
          message: "可以进行初步匹配，但证据仍然有限；结果需要谨慎解读。"
        }
      ];
    }
    if (status === "ready") {
      return [
        {
          code: "ready-for-matching",
          message: "数据量满足初步匹配条件；这不代表兴趣已被完整刻画。"
        }
      ];
    }
    return [
      {
        code: "invalid-input",
        message: "输入无法解析，未生成任何结论。"
      }
    ];
  }

  /** 由指标 + 阈值推导冷启动状态。只表示数据充分程度，不表示兴趣真实性。 */
  function buildColdStart(metrics, thresholds) {
    const reasons = [];
    let status = "limited";

    if (metrics.totalWatchMs <= 0) {
      status = "empty";
      reasons.push(reason("no-watch-data", "统计窗口内没有实际观看时长"));
    } else if (
      metrics.totalWatchMs < thresholds.insufficientMinWatchMs ||
      metrics.activeDays < thresholds.insufficientMinActiveDays
    ) {
      status = "insufficient";
      if (metrics.totalWatchMs < thresholds.insufficientMinWatchMs) {
        reasons.push(
          reason(
            "watch-time-below-threshold",
            `实际观看时长不足 ${Math.round(thresholds.insufficientMinWatchMs / 60000)} 分钟`
          )
        );
      }
      if (metrics.activeDays < thresholds.insufficientMinActiveDays) {
        reasons.push(
          reason(
            "active-days-below-threshold",
            `有观看的天数少于 ${thresholds.insufficientMinActiveDays} 天`
          )
        );
      }
    } else if (
      metrics.effectiveVideoCount >= thresholds.readyMinEffectiveVideos &&
      metrics.activeDays >= thresholds.readyMinActiveDays
    ) {
      status = "ready";
    } else {
      status = "limited";
      if (metrics.effectiveVideoCount < thresholds.readyMinEffectiveVideos) {
        reasons.push(
          reason(
            "effective-videos-below-ready",
            `有效观看视频 ${metrics.effectiveVideoCount} 个，少于 ready 门槛 ${thresholds.readyMinEffectiveVideos}`
          )
        );
      }
      if (metrics.activeDays < thresholds.readyMinActiveDays) {
        reasons.push(
          reason(
            "active-days-below-ready",
            `有观看的天数 ${metrics.activeDays} 天，少于 ready 门槛 ${thresholds.readyMinActiveDays}`
          )
        );
      }
    }

    return {
      kind: COLD_START_KIND,
      module: MODULE_KIND,
      version: MODULE_VERSION,
      status,
      thresholds,
      reasons,
      guidance: guidanceFor(status),
      metrics: {
        totalWatchMs: metrics.totalWatchMs,
        effectiveWatchMs: metrics.effectiveWatchMs,
        videoCount: metrics.videoCount,
        effectiveVideoCount: metrics.effectiveVideoCount,
        activeDays: metrics.activeDays
      },
      note:
        "状态只表示数据充分程度，不代表用户兴趣真实或推荐质量；" +
        "本模块不生成推荐、不抓取热门 UP 主作为降级。"
    };
  }

  /**
   * 用户证据评估：真实观看时长、有效视频数、有效观看天数、覆盖率、
   * 时间范围、时间字段缺失、身份冲突与异常记录。
   *
   * 有效观看阈值固定复用 stats.EFFECTIVE_WATCH_MS（30 秒），不另立口径。
   */
  function assessUserEvidence(records, options) {
    const opts = isPlainObject(options) ? options : {};
    const thresholds = normalizeThresholds(opts.thresholds);
    const reasons = [];
    const collected = collectDailyBuckets(records, opts);
    collected.reasons.forEach((item) => reasons.push(item));

    if (!collected.ok) {
      const emptyMetrics = emptyMetricsOf(collected);
      return {
        kind: EVIDENCE_KIND,
        module: MODULE_KIND,
        version: MODULE_VERSION,
        status: "invalid",
        available: false,
        metrics: emptyMetrics,
        coldStart: buildColdStart(emptyMetrics, thresholds),
        window: windowBlock(collected),
        thresholds,
        reasons,
        note: "输入无法解析，未生成任何证据结论。"
      };
    }

    const perBv = new Map();
    let totalWatchMs = 0;
    let identifiedWatchMs = 0;
    let unknownWatchMs = 0;
    let activeDays = 0;
    let effectiveDayCount = 0;
    let daysWithData = 0;

    collected.buckets.forEach((bucket) => {
      let dayWatchMs = 0;
      let dayEffective = false;
      bucket.videos.forEach((video) => {
        const watchMs = safeNumber(video.watchMs);
        if (watchMs === null || watchMs <= 0) return;
        dayWatchMs += watchMs;
        if (watchMs >= thresholds.effectiveWatchMs) dayEffective = true;

        let entry = perBv.get(video.bvid);
        if (!entry) {
          entry = {
            bvid: video.bvid,
            watchMs: 0,
            title: "",
            hasIdentifiedPartition: false,
            uids: new Set()
          };
          perBv.set(video.bvid, entry);
        }
        entry.watchMs += watchMs;
        if (!entry.title && typeof video.title === "string" && video.title.trim()) {
          entry.title = video.title.trim();
        }
        if (isIdentifiedPartition(video.partition)) {
          entry.hasIdentifiedPartition = true;
        }
        if (typeof video.upUid === "string" && video.upUid) {
          entry.uids.add(video.upUid);
        }
      });
      if (dayWatchMs > 0) activeDays += 1;
      if (dayEffective) effectiveDayCount += 1;
      if (dayWatchMs > 0) daysWithData += 1;
    });

    // 分区覆盖率用原始观看时长（不衰减），与 C1 同口径。
    collected.buckets.forEach((bucket) => {
      bucket.videos.forEach((video) => {
        const watchMs = safeNumber(video.watchMs);
        if (watchMs === null || watchMs <= 0) return;
        totalWatchMs += watchMs;
        if (isIdentifiedPartition(video.partition)) {
          identifiedWatchMs += watchMs;
        } else {
          unknownWatchMs += watchMs;
        }
      });
    });

    let videoCount = 0;
    let effectiveVideoCount = 0;
    let effectiveWatchMs = 0;
    let titledVideoCount = 0;
    const dateKeysWithData = [];

    perBv.forEach((entry) => {
      if (entry.watchMs <= 0) return;
      videoCount += 1;
      if (entry.watchMs >= thresholds.effectiveWatchMs) {
        effectiveVideoCount += 1;
        effectiveWatchMs += entry.watchMs;
      }
      if (entry.title) titledVideoCount += 1;
    });

    collected.buckets.forEach((bucket) => {
      if (bucket.videos.some((video) => (video.watchMs || 0) > 0)) {
        dateKeysWithData.push(bucket.dateKey);
      }
    });
    dateKeysWithData.sort(compareText);

    // 身份冲突：同一 BV 在窗口内出现 ≥2 个不同 UID。
    let conflictVideoCount = 0;
    perBv.forEach((entry) => {
      if (entry.uids.size >= 2) conflictVideoCount += 1;
    });

    let missingTimestampRecords = 0;
    collected.records.forEach((record) => {
      if (!record.startedAt && !record.lastWatchedAt) missingTimestampRecords += 1;
    });

    const metrics = {
      totalWatchMs,
      effectiveWatchMs,
      videoCount,
      effectiveVideoCount,
      activeDays,
      effectiveDayCount,
      titledVideoCount,
      partitionCoverage: {
        ratio: totalWatchMs > 0 ? identifiedWatchMs / totalWatchMs : null,
        basis: BASIS.WATCH_MS,
        identifiedWatchMs,
        unknownWatchMs
      },
      titleCoverage: {
        ratio: videoCount > 0 ? titledVideoCount / videoCount : null,
        basis: BASIS.VIDEO_COUNT,
        titledVideoCount
      },
      timeRange: {
        firstDateKey: dateKeysWithData.length > 0 ? dateKeysWithData[0] : null,
        lastDateKey:
          dateKeysWithData.length > 0
            ? dateKeysWithData[dateKeysWithData.length - 1]
            : null,
        dayCountWithData: dateKeysWithData.length
      },
      conflictVideoCount,
      invalidRecords: collected.invalidRecords,
      missingTimestampRecords,
      daysWithData
    };

    const coldStart = buildColdStart(metrics, thresholds);

    return {
      kind: EVIDENCE_KIND,
      module: MODULE_KIND,
      version: MODULE_VERSION,
      status: coldStart.status,
      available: totalWatchMs > 0,
      metrics,
      coldStart,
      window: windowBlock(collected),
      thresholds,
      reasons,
      note:
        "指标全部来自真实观看记录；有效观看阈值固定为 30 秒。" +
        "分区覆盖率按观看时长统计，标题覆盖率按视频数统计，两者单位不同。"
    };
  }

  function emptyMetricsOf(collected) {
    return {
      totalWatchMs: 0,
      effectiveWatchMs: 0,
      videoCount: 0,
      effectiveVideoCount: 0,
      activeDays: 0,
      effectiveDayCount: 0,
      titledVideoCount: 0,
      partitionCoverage: {
        ratio: null,
        basis: BASIS.WATCH_MS,
        identifiedWatchMs: 0,
        unknownWatchMs: 0
      },
      titleCoverage: {
        ratio: null,
        basis: BASIS.VIDEO_COUNT,
        titledVideoCount: 0
      },
      timeRange: { firstDateKey: null, lastDateKey: null, dayCountWithData: 0 },
      conflictVideoCount: 0,
      invalidRecords: collected ? collected.invalidRecords : 0,
      missingTimestampRecords: 0,
      daysWithData: 0
    };
  }

  /**
   * 冷启动状态。可传入 assessUserEvidence 的结果，或直接传观看记录。
   * 只输出数据充分程度与降级建议，不生成推荐。
   */
  function assessColdStart(input, options) {
    const opts = isPlainObject(options) ? options : {};
    if (
      isPlainObject(input) &&
      input.kind === EVIDENCE_KIND &&
      isPlainObject(input.metrics)
    ) {
      const thresholds = normalizeThresholds(
        Object.assign({}, input.thresholds, opts.thresholds)
      );
      return buildColdStart(input.metrics, thresholds);
    }
    const evidence = assessUserEvidence(input, opts);
    return evidence.coldStart;
  }

  /* ---------------------------------------------------------------- 候选可靠性 */

  function detectLane(candidate, options) {
    if (isPlainObject(options) && typeof options.lane === "string") {
      if (options.lane === LANE.MAIN || options.lane === LANE.EXPLORATION) {
        return options.lane;
      }
    }
    if (!isPlainObject(candidate)) return null;
    const hasMain =
      isPlainObject(candidate.partitionFeatures) ||
      isPlainObject(candidate.titleFeatures);
    const hasExploration =
      Array.isArray(candidate.partitionCounts) ||
      Array.isArray(candidate.titleTokens);
    if (hasMain && !hasExploration) return LANE.MAIN;
    if (hasExploration && !hasMain) return LANE.EXPLORATION;
    return null;
  }

  function readConflict(candidate) {
    if (!isPlainObject(candidate)) return { blocked: false, reasons: [] };
    const reasons = [];
    let blocked = false;

    if (candidate.hasUidConflict === true) {
      blocked = true;
      reasons.push(reason("uid-conflict", "候选存在 UID 身份冲突"));
    }
    if (
      isPlainObject(candidate.evidence) &&
      Number.isInteger(candidate.evidence.conflictVideoCount) &&
      candidate.evidence.conflictVideoCount > 0
    ) {
      blocked = true;
      reasons.push(reason("uid-conflict-videos", "候选存在冲突视频"));
    }
    if (
      Number.isInteger(candidate.conflictVideoCount) &&
      candidate.conflictVideoCount > 0
    ) {
      blocked = true;
      reasons.push(reason("uid-conflict-videos", "候选存在冲突视频"));
    }
    if (isPlainObject(candidate.identityEvidence)) {
      if (candidate.identityEvidence.hasIdentityConflict === true) {
        blocked = true;
        reasons.push(reason("identity-conflict", "评估结果显示身份冲突"));
      }
      if (
        Number.isInteger(candidate.identityEvidence.crossSourceConflictVideoCount) &&
        candidate.identityEvidence.crossSourceConflictVideoCount > 0
      ) {
        blocked = true;
        reasons.push(reason("cross-source-conflict", "与本地观看记录存在冲突"));
      }
    }

    return { blocked, reasons };
  }

  function coverageOf(candidate, key, basis) {
    const value =
      typeof candidate[key] === "number" && Number.isFinite(candidate[key])
        ? clamp(candidate[key], 0, 1)
        : null;
    return { ratio: value, basis };
  }

  /**
   * 候选特征可靠性。
   *
   * 只读字段，不修改 C2-2 eligibility、不修改 C2-4B eligibleForExploration。
   * 等级是工程启发式证据等级，不是概率，也不是预测准确率。
   */
  function assessFeatureReliability(candidate, options) {
    const opts = isPlainObject(options) ? options : {};
    const lane = detectLane(candidate, opts);
    const reasons = [];

    if (!isPlainObject(candidate)) {
      return {
        kind: RELIABILITY_KIND,
        module: MODULE_KIND,
        version: MODULE_VERSION,
        status: "invalid",
        lane: null,
        provenance: null,
        level: "unavailable",
        coverage: {
          partition: { ratio: null, basis: null },
          title: { ratio: null, basis: null }
        },
        identity: {
          onlineVerified: false,
          uidVerified: false,
          hasIdentityConflict: false,
          rankingBlocked: true
        },
        passthrough: { c2Eligibility: null, eligibleForExploration: null },
        diagnostics: {},
        thresholds: RELIABILITY_THRESHOLDS,
        reasons: [reason("invalid-candidate", "候选不是对象")],
        note: "候选无效，可靠性不可用。"
      };
    }

    const conflict = readConflict(candidate);
    const provenance =
      candidate.provenance === "page-observed" && lane === LANE.EXPLORATION
        ? "page-observed"
        : lane === LANE.EXPLORATION || candidate.provenance === "user-provided"
          ? "user-provided"
          : "watched";

    const isExploration = lane === LANE.EXPLORATION || provenance === "user-provided";
    const coverage = {
      partition: coverageOf(
        candidate,
        "partitionCoverage",
        isExploration ? BASIS.VIDEO_COUNT : BASIS.WATCH_MS
      ),
      title: coverageOf(candidate, "titleCoverage", BASIS.VIDEO_COUNT)
    };

    const ratios = [coverage.partition.ratio, coverage.title.ratio].filter(
      (value) => typeof value === "number"
    );
    const effectiveCoverage = ratios.length > 0 ? Math.min.apply(null, ratios) : null;

    const completenessOk = isExploration
      ? candidate.contentStatus === "complete"
      : candidate.featureStatus === "ready";

    let level;
    if (conflict.blocked) {
      level = "unavailable";
      conflict.reasons.forEach((item) => reasons.push(item));
    } else if (effectiveCoverage === null) {
      level = "unavailable";
      reasons.push(reason("no-coverage-data", "没有任何覆盖率数据"));
    } else if (effectiveCoverage >= RELIABILITY_THRESHOLDS.high && completenessOk) {
      level = "high";
    } else if (effectiveCoverage >= RELIABILITY_THRESHOLDS.medium) {
      level = "medium";
    } else {
      level = "low";
    }

    if (!completenessOk && !conflict.blocked) {
      reasons.push(
        reason(
          "incomplete-features",
          isExploration
            ? "contentStatus 未达到 complete"
            : "featureStatus 未达到 ready"
        )
      );
    }

    const onlineVerified = false; // 本项目没有任何在线核验能力，任何 true 声明都不采信

    return {
      kind: RELIABILITY_KIND,
      module: MODULE_KIND,
      version: MODULE_VERSION,
      status: conflict.blocked
        ? "blocked"
        : effectiveCoverage === null
          ? "unavailable"
          : "ok",
      lane,
      provenance,
      level,
      coverage,
      identity: {
        // 恒为 false：C2-1 / C2-2 / C2-4B 都没有在线核验能力
        onlineVerified,
        uidVerified: candidate.uidVerified === true,
        hasIdentityConflict: conflict.blocked,
        rankingBlocked: conflict.blocked
      },
      passthrough: {
        c2Eligibility:
          typeof candidate.eligibility === "string" ? candidate.eligibility : null,
        eligibleForExploration:
          isPlainObject(candidate.promotion) &&
          candidate.promotion.eligibleForExploration === true
            ? true
            : isPlainObject(candidate.promotion)
              ? false
              : null
      },
      diagnostics: {
        featureStatus:
          typeof candidate.featureStatus === "string" ? candidate.featureStatus : null,
        contentStatus:
          typeof candidate.contentStatus === "string" ? candidate.contentStatus : null,
        importedVideoCount: Number.isInteger(candidate.importedVideoCount)
          ? candidate.importedVideoCount
          : null,
        observedVideoCount: Number.isInteger(candidate.observedVideoCount)
          ? candidate.observedVideoCount
          : null,
        conflictVideoCount: conflict.blocked ? 1 : 0
      },
      thresholds: RELIABILITY_THRESHOLDS,
      reasons,
      note:
        "等级是工程启发式的证据充分度标签，不是统计概率，也不是预测准确率；" +
        "不覆盖 C2-2 eligibility 与 C2-4B eligibleForExploration。"
    };
  }

  /* ---------------------------------------------------------------- 重复曝光 */

  /**
   * 重复曝光信号（默认关闭）。
   *
   * 与时间衰减完全分离：
   *   - 时间衰减作用在用户向量（兴趣漂移）；
   *   - 本函数只回答"这个已看过的 UP 主是否在短期窗口内刚出现过"，
   *     结果仅作为未来排序的可选信号，本模块**从不应用**它。
   *
   * 导入-only 候选没有真实观看曝光 → not-applicable，不推断。
   */
  function assessExposureRecency(candidate, options) {
    const opts = isPlainObject(options) ? options : {};
    const enabled = opts.enabled === true;
    const windowDays =
      typeof opts.windowDays === "number" &&
      Number.isFinite(opts.windowDays) &&
      opts.windowDays >= 0
        ? opts.windowDays
        : DEFAULT_EXPOSURE.windowDays;

    const base = {
      kind: EXPOSURE_KIND,
      module: MODULE_KIND,
      version: MODULE_VERSION,
      enabled,
      applied: false,
      windowDays,
      lastWatchedAt: null,
      lastWatchedDateKey: null,
      ageDays: null,
      suppressed: null,
      remainingDays: null,
      timeSource: "none",
      reasons: [],
      note:
        "仅作为未来排序的可选信号；不修改相似度、不生成排名。" +
        "与时间衰减是不同概念，默认关闭。"
    };

    if (!isPlainObject(candidate)) {
      return Object.assign({}, base, {
        status: "invalid",
        reasons: [reason("invalid-candidate", "候选不是对象")]
      });
    }

    const lane = detectLane(candidate, opts);
    const provenance =
      lane === LANE.EXPLORATION || candidate.provenance === "user-provided"
        ? "user-provided"
        : "watched";
    const sources = Array.isArray(candidate.sources) ? candidate.sources : [];
    const watchedSource =
      sources.indexOf("watched") !== -1 ||
      candidate.watchedBefore === true ||
      (isPlainObject(candidate.evidence) && candidate.evidence.fromWatchHistory === true);

    if (provenance === "user-provided" || (!watchedSource && lane === LANE.EXPLORATION)) {
      return Object.assign({}, base, {
        status: "not-applicable",
        reasons: [
          reason(
            "never-watched",
            "该候选来自用户导入或手动输入，没有真实观看曝光，不能作为重复曝光依据"
          )
        ]
      });
    }

    if (lane === null && !watchedSource) {
      return Object.assign({}, base, {
        status: "not-applicable",
        reasons: [reason("no-watch-evidence", "没有观看来源证据，无法判断曝光")]
      });
    }

    let lastWatchedAt = null;
    let timeSource = "none";
    if (typeof candidate.lastObservedAt === "number" && Number.isFinite(candidate.lastObservedAt)) {
      lastWatchedAt = candidate.lastObservedAt;
      timeSource = "candidate.lastObservedAt";
    } else if (
      isPlainObject(candidate.freshness) &&
      typeof candidate.freshness.lastObservedAt === "number" &&
      Number.isFinite(candidate.freshness.lastObservedAt)
    ) {
      lastWatchedAt = candidate.freshness.lastObservedAt;
      timeSource = "candidate.freshness.lastObservedAt";
    }

    if (lastWatchedAt === null) {
      return Object.assign({}, base, {
        status: "unknown",
        reasons: [reason("missing-last-watched", "没有可靠的最近观看时间，不做推断")]
      });
    }

    if (!enabled) {
      return Object.assign({}, base, {
        status: "disabled",
        lastWatchedAt,
        timeSource,
        reasons: [reason("exposure-disabled", "重复曝光信号默认关闭")]
      });
    }

    const decay = computeTimeDecay(lastWatchedAt, {
      now: opts.now,
      halfLifeDays: 14
    });
    if (decay.status !== "ok") {
      return Object.assign({}, base, {
        status: "unknown",
        lastWatchedAt,
        timeSource,
        reasons: [
          reason(
            decay.status === "future-time" ? "future-time" : "invalid-time",
            "最近观看时间不可用，不做推断"
          )
        ]
      });
    }

    const suppressed = decay.ageDays <= windowDays;
    return Object.assign({}, base, {
      status: "ok",
      lastWatchedAt,
      ageDays: decay.ageDays,
      suppressed,
      remainingDays: suppressed ? Math.max(0, windowDays - decay.ageDays) : 0,
      timeSource,
      reasons: [
        reason(
          suppressed ? "within-window" : "outside-window",
          suppressed
            ? `最近 ${windowDays} 天内观看过该 UP 主`
            : `超过 ${windowDays} 天没有观看该 UP 主`
        )
      ]
    });
  }

  /* ---------------------------------------------------------------- 导出 */

  global.BiliDailyRecommendQuality = Object.freeze({
    MODULE_KIND,
    MODULE_VERSION,
    EVIDENCE_KIND,
    DECAY_KIND,
    RELIABILITY_KIND,
    COLD_START_KIND,
    EXPOSURE_KIND,
    DECAY_FORMULA,
    DEFAULT_DECAY,
    DEFAULT_THRESHOLDS,
    RELIABILITY_THRESHOLDS,
    DEFAULT_EXPOSURE,
    computeTimeDecay,
    buildDecayedUserPartitionVector,
    buildDecayedUserTextCounts,
    assessUserEvidence,
    assessColdStart,
    assessFeatureReliability,
    assessExposureRecency
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
