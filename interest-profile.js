"use strict";

/**
 * Bili Daily —— 本地用户兴趣画像引擎（纯函数，无副作用、无网络请求）
 *
 * 输入：storage.js 维护的 biliDailyRecords 结构（或其中的 days 映射）
 * {
 *   version: 1,
 *   days: {
 *     "YYYY-MM-DD": {
 *       "BVxxxx": {
 *         bvid, page, title, upName, upUid, partition,
 *         videoDuration, watchMs, watchMsByHour, ...
 *       }
 *     }
 *   }
 * }
 *
 * 输出：最近 7 天 / 30 天的兴趣画像（分区偏好、UP 主偏好、数据质量）。
 *
 * 统计口径（与 stats.js 保持一致，并复用其实现）：
 * - 日期一律按浏览器本地时区计算，窗口以本地日期键 "YYYY-MM-DD" 表示；
 *   默认「最近 N 天」= 含今天在内的 N 个本地日历日。
 * - 观看时长只使用记录里的真实 watchMs，绝不使用 videoDuration 代替。
 * - 同一天内同一 BV 的不同分 P 先按 BV 合并（stats.mergeByBvid）；
 *   窗口内同一 BV 跨天也只计为一个视频，时长累加。
 * - 有效观看阈值沿用 30 秒：窗口内某视频累计 watchMs >= 30000 才算「有效观看视频」。
 * - 分区统计只基于真实存在的 partition 字段；缺失分区归入保留名「未知」，
 *   该桶会出现在 partitions 里并参与占比，绝不被悄悄排除。
 * - 分区覆盖率 = 有分区视频的观看时长 / 全部实际观看时长，用于提示数据完整度。
 * - UP 主身份聚合复用 stats.aggregateUps：有 upUid 按 UID 合并不同昵称；
 *   无 UID 按昵称兼容聚合；缺失 UID 的记录不会凭昵称并入已知 UID 分组；
 *   不同 UID 的同名 UP 主保持分开。
 * - 7 天窗口嵌套在 30 天窗口内，二者不能当作两个独立周期直接算增长率；
 *   兴趣变化只在 comparisons 里用「最近 N 天 vs 前 N 天」的互不重叠窗口计算。
 * - 输入记录只读：所有中间对象都是新建的，绝不修改原始观看记录。
 */

(function (global) {
  const Stats = global.BiliDailyStats;
  if (!Stats) {
    throw new Error("[Bili Daily] interest-profile.js 依赖 stats.js，请先加载 stats.js");
  }

  const EFFECTIVE_WATCH_MS = Stats.EFFECTIVE_WATCH_MS;
  const UNKNOWN_PARTITION = "未知";
  const DEFAULT_WINDOWS = Object.freeze([7, 30]);
  const MAX_WINDOW_DAYS = 366;

  /* 画像可信度阈值：全部写入输出的 thresholds 字段，便于调用方理解与调整。 */
  const PROFILE_MIN_WATCH_MS = 10 * 60 * 1000; // 一个窗口至少 10 分钟真实观看
  const PROFILE_MIN_ACTIVE_DAYS = 2; // 一个窗口至少 2 天有观看
  const TREND_MIN_WATCH_MS = 10 * 60 * 1000; // 趋势对比的每个窗口至少 10 分钟
  const TREND_MIN_ACTIVE_DAYS = 2; // 趋势对比的每个窗口至少 2 天有观看
  const TREND_MIN_PARTITION_COVERAGE = 0.5; // 趋势对比的每个窗口分区覆盖率至少 50%

  /* ---------------------------------------------------------------- 基础工具 */

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  /**
   * 取出「日期 → 记录表」映射。
   * 兼容根结构 { version, days } 与直接传入的日期映射；
   * 其他输入一律视为空数据，不猜测层级。
   */
  function readDays(records) {
    if (!isPlainObject(records)) return { days: {}, kind: "empty" };
    if (isPlainObject(records.days)) return { days: records.days, kind: "root" };
    return { days: records, kind: "days" };
  }

  /** 规范化窗口天数列表：只保留 1..366 的整数，去重并升序；非法时回退默认值。 */
  function normalizeWindowDays(value) {
    const source = Array.isArray(value) ? value : DEFAULT_WINDOWS;
    const seen = new Set();
    const days = [];
    source.forEach((item) => {
      const number = Number(item);
      if (!Number.isInteger(number) || number < 1 || number > MAX_WINDOW_DAYS) return;
      if (seen.has(number)) return;
      seen.add(number);
      days.push(number);
    });
    if (days.length === 0) return DEFAULT_WINDOWS.slice();
    return days.sort((left, right) => left - right);
  }

  /** 以本地日期键为基准生成含首尾的日期范围；日期非法返回 null。 */
  function makeRange(endDate, dayCount) {
    if (!Stats.parseDateKey(endDate)) return null;
    const startDate = Stats.shiftLocalDate(endDate, -(dayCount - 1));
    if (!startDate) return null;
    const dateKeys = [];
    for (let index = 0; index < dayCount; index += 1) {
      dateKeys.push(Stats.shiftLocalDate(startDate, index));
    }
    return { startDate, endDate, dateKeys };
  }

  /** 确定画像的本地基准日：优先 options.endDate，其次 options.now，最后当前时间。 */
  function resolveEndDate(options) {
    if (typeof options.endDate === "string" && Stats.parseDateKey(options.endDate)) {
      return options.endDate;
    }
    const nowValue = options.now == null ? Date.now() : options.now;
    const key = Stats.localDateKey(nowValue);
    return key || Stats.localDateKey(Date.now());
  }

  /** 生成可复现的毫秒时间戳基准（只用于 generatedAt / 时区偏移展示）。 */
  function resolveNowMs(options) {
    const nowValue = options.now == null ? Date.now() : options.now;
    if (nowValue instanceof Date) {
      return Number.isNaN(nowValue.getTime()) ? Date.now() : nowValue.getTime();
    }
    const number = Number(nowValue);
    return Number.isFinite(number) ? number : Date.now();
  }

  /* ------------------------------------------------------------ 记录读取与清洗 */

  /**
   * 读取窗口内的所有记录，并复用 stats.js 的清洗与合并规则。
   *
   * 先按天合并同一 BV 的不同分 P（与 summarizeDay 完全一致），
   * 再把窗口内同一 BV 的跨天记录合并为一个视频（时长累加）。
   * 原始记录只读，cleanRecord / mergeByBvid 都返回新对象。
   */
  function collectVideos(days, dateKeys) {
    const collected = [];
    const activeDayKeys = [];
    let invalidRecords = 0;
    let invalidDays = 0;
    let recordedDays = 0;

    dateKeys.forEach((dateKey) => {
      const day = days[dateKey];
      if (day === undefined) return;
      if (!isPlainObject(day)) {
        invalidDays += 1;
        return;
      }
      recordedDays += 1;

      const cleaned = [];
      Object.keys(day).forEach((recordKey) => {
        const video = Stats.cleanRecord(day[recordKey], recordKey);
        if (!video) {
          invalidRecords += 1;
          return;
        }
        cleaned.push(video);
      });

      const dayVideos = Stats.mergeByBvid(cleaned);
      if (dayVideos.some((video) => video.watchMs > 0)) {
        activeDayKeys.push(dateKey);
      }
      dayVideos.forEach((video) => collected.push(video));
    });

    return {
      videos: Stats.mergeByBvid(collected),
      activeDayKeys,
      invalidRecords,
      invalidDays,
      recordedDays
    };
  }

  /* ---------------------------------------------------------------- 分区聚合 */

  /**
   * 分区排序：观看时长降序 → 已识别分区优先 → 名称码点升序。
   * 显式兜底保证并列时顺序稳定、可复现。
   */
  function comparePartitions(left, right) {
    return (
      right.watchMs - left.watchMs ||
      (left.identified === right.identified ? 0 : left.identified ? -1 : 1) ||
      (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    );
  }

  /**
   * 按分区聚合观看时长。
   * - 只有 watchMs > 0 的视频参与（与 summarizeDay 一致）；
   * - 缺失分区统一归入「未知」桶，而不是从分母里删掉；
   * - share 以窗口总实际观看时长为分母，因此「未知」也有明确占比。
   */
  function aggregatePartitions(videos, totalWatchMs) {
    const buckets = new Map();
    let identifiedWatchMs = 0;
    let unknownWatchMs = 0;
    let identifiedVideoCount = 0;
    let unknownVideoCount = 0;

    videos.forEach((video) => {
      if (video.watchMs <= 0) return;
      // 「未知」是保留桶名：缺失分区与字面名为「未知」的记录都无法确认分区，
      // 一律按未识别处理，避免把无法确认的信息算进覆盖率。
      const identified =
        Boolean(video.partition) && video.partition !== UNKNOWN_PARTITION;
      const name = identified ? video.partition : UNKNOWN_PARTITION;
      let entry = buckets.get(name);
      if (!entry) {
        entry = {
          name,
          identified,
          watchMs: 0,
          effectiveWatchMs: 0,
          videoCount: 0,
          effectiveVideoCount: 0
        };
        buckets.set(name, entry);
      }
      entry.watchMs += video.watchMs;
      entry.videoCount += 1;
      if (video.watchMs >= EFFECTIVE_WATCH_MS) {
        entry.effectiveWatchMs += video.watchMs;
        entry.effectiveVideoCount += 1;
      }
      if (identified) {
        identifiedWatchMs += video.watchMs;
        identifiedVideoCount += 1;
      } else {
        unknownWatchMs += video.watchMs;
        unknownVideoCount += 1;
      }
    });

    const partitions = Array.from(buckets.values())
      .map((entry) =>
        Object.assign({}, entry, {
          share: totalWatchMs > 0 ? entry.watchMs / totalWatchMs : 0
        })
      )
      .sort(comparePartitions);

    const identifiedPartitions = partitions.filter((entry) => entry.identified);
    const classifiedVideoCount = identifiedVideoCount + unknownVideoCount;

    return {
      partitions,
      favoritePartition: partitions.length > 0 ? partitions[0] : null,
      favoriteIdentifiedPartition: identifiedPartitions.length > 0 ? identifiedPartitions[0] : null,
      coverage: {
        totalWatchMs,
        identifiedWatchMs,
        unknownWatchMs,
        identifiedVideoCount,
        unknownVideoCount,
        videoCount: classifiedVideoCount,
        // 按观看时长计算的覆盖率；没有观看时长时为 0，而不是 100%。
        ratio: totalWatchMs > 0 ? identifiedWatchMs / totalWatchMs : 0,
        // 按视频数量计算的覆盖率，供交叉参考。
        videoRatio: classifiedVideoCount > 0 ? identifiedVideoCount / classifiedVideoCount : 0
      }
    };
  }

  /* ---------------------------------------------------------------- 窗口统计 */

  /** 根据数据量给出窗口状态：empty / insufficient / ok。 */
  function assessStatus(totalWatchMs, activeDays) {
    if (totalWatchMs <= 0) {
      return { status: "empty", reasons: ["统计窗口内没有实际观看时长"] };
    }
    const reasons = [];
    if (totalWatchMs < PROFILE_MIN_WATCH_MS) {
      reasons.push(
        `实际观看时长不足 ${Math.round(PROFILE_MIN_WATCH_MS / 60000)} 分钟`
      );
    }
    if (activeDays < PROFILE_MIN_ACTIVE_DAYS) {
      reasons.push(`有观看记录的天数少于 ${PROFILE_MIN_ACTIVE_DAYS} 天`);
    }
    if (reasons.length > 0) return { status: "insufficient", reasons };
    return { status: "ok", reasons: [] };
  }

  /**
   * 统计一个本地日期窗口内的兴趣画像。
   * 不修改 days / 原始记录。
   */
  function summarizeRange(days, dayCount, range, key) {
    const collected = collectVideos(days, range.dateKeys);
    const videos = collected.videos;

    let totalWatchMs = 0;
    let effectiveWatchMs = 0;
    let effectiveVideoCount = 0;
    let watchedVideoCount = 0;

    videos.forEach((video) => {
      totalWatchMs += video.watchMs;
      if (video.watchMs > 0) watchedVideoCount += 1;
      if (video.watchMs >= EFFECTIVE_WATCH_MS) {
        effectiveVideoCount += 1;
        effectiveWatchMs += video.watchMs;
      }
    });

    // 分区与 UP 主聚合都复用 stats.js 已验证的规则。
    const partitionStats = aggregatePartitions(videos, totalWatchMs);
    const upStats = Stats.aggregateUps(videos);
    const assessment = assessStatus(totalWatchMs, collected.activeDayKeys.length);

    const reasons = assessment.reasons.slice();
    if (collected.invalidRecords > 0) {
      reasons.push(`${collected.invalidRecords} 条记录结构异常，已跳过`);
    }
    if (collected.invalidDays > 0) {
      reasons.push(`${collected.invalidDays} 个日期数据异常，已跳过`);
    }
    if (partitionStats.coverage.unknownVideoCount > 0) {
      reasons.push(
        `${partitionStats.coverage.unknownVideoCount} 个视频缺少分区信息，已归入「${UNKNOWN_PARTITION}」`
      );
    }

    return {
      key,
      dayCount,
      startDate: range.startDate,
      endDate: range.endDate,
      dateKeys: range.dateKeys.slice(),
      hasData: totalWatchMs > 0,
      status: assessment.status,
      reasons,
      recordedDays: collected.recordedDays,
      activeDays: collected.activeDayKeys.length,
      activeDayKeys: collected.activeDayKeys.slice(),
      invalidRecords: collected.invalidRecords,
      invalidDays: collected.invalidDays,
      videoCount: videos.length,
      watchedVideoCount,
      effectiveVideoCount,
      belowThresholdVideoCount: upStats.belowThresholdVideoCount,
      totalWatchMs,
      effectiveWatchMs,
      partitions: partitionStats.partitions,
      favoritePartition: partitionStats.favoritePartition,
      favoriteIdentifiedPartition: partitionStats.favoriteIdentifiedPartition,
      partitionCoverage: partitionStats.coverage,
      ups: upStats.items,
      topUp: upStats.items.length > 0 ? upStats.items[0] : null,
      unknownUps: upStats.unknown,
      uidUpCount: upStats.uidUpCount,
      nameOnlyUpCount: upStats.nameOnlyUpCount
    };
  }

  /** 趋势对比中用到的窗口摘要（不重复携带完整分区 / UP 列表）。 */
  function trendSummary(summary) {
    return {
      key: summary.key,
      startDate: summary.startDate,
      endDate: summary.endDate,
      status: summary.status,
      totalWatchMs: summary.totalWatchMs,
      effectiveVideoCount: summary.effectiveVideoCount,
      activeDays: summary.activeDays,
      partitionCoverageRatio: summary.partitionCoverage.ratio,
      favoritePartition: summary.favoritePartition,
      topUp: summary.topUp
    };
  }

  /**
   * 计算兴趣变化：最近 N 天 vs 前 N 天（互不重叠、等长）。
   * 不使用嵌套的 7 天 / 30 天窗口直接相减。
   * 数据量或分区覆盖率不足时 reliable=false，并给出具体原因。
   */
  function buildComparison(days, dayCount, endDate) {
    const recentRange = makeRange(endDate, dayCount);
    const previousEndDate = Stats.shiftLocalDate(recentRange.startDate, -1);
    const previousRange = makeRange(previousEndDate, dayCount);
    const recent = summarizeRange(days, dayCount, recentRange, `${dayCount}d-recent`);
    const previous = summarizeRange(days, dayCount, previousRange, `${dayCount}d-previous`);

    const reasons = [];
    if (recent.totalWatchMs <= 0) reasons.push("最近窗口没有观看数据");
    if (previous.totalWatchMs <= 0) reasons.push("前一个窗口没有观看数据");
    if (recent.activeDays < TREND_MIN_ACTIVE_DAYS) {
      reasons.push(`最近窗口有观看记录的天数少于 ${TREND_MIN_ACTIVE_DAYS} 天`);
    }
    if (previous.activeDays < TREND_MIN_ACTIVE_DAYS) {
      reasons.push(`前一个窗口有观看记录的天数少于 ${TREND_MIN_ACTIVE_DAYS} 天`);
    }
    if (recent.totalWatchMs > 0 && recent.totalWatchMs < TREND_MIN_WATCH_MS) {
      reasons.push(
        `最近窗口观看时长不足 ${Math.round(TREND_MIN_WATCH_MS / 60000)} 分钟`
      );
    }
    if (previous.totalWatchMs > 0 && previous.totalWatchMs < TREND_MIN_WATCH_MS) {
      reasons.push(
        `前一个窗口观看时长不足 ${Math.round(TREND_MIN_WATCH_MS / 60000)} 分钟`
      );
    }
    if (
      recent.totalWatchMs > 0 &&
      recent.partitionCoverage.ratio < TREND_MIN_PARTITION_COVERAGE
    ) {
      reasons.push(
        `最近窗口分区覆盖率低于 ${Math.round(TREND_MIN_PARTITION_COVERAGE * 100)}%`
      );
    }
    if (
      previous.totalWatchMs > 0 &&
      previous.partitionCoverage.ratio < TREND_MIN_PARTITION_COVERAGE
    ) {
      reasons.push(
        `前一个窗口分区覆盖率低于 ${Math.round(TREND_MIN_PARTITION_COVERAGE * 100)}%`
      );
    }

    const reliable = reasons.length === 0;
    const status =
      recent.totalWatchMs <= 0 && previous.totalWatchMs <= 0
        ? "empty"
        : reliable
          ? "ok"
          : "insufficient";

    const recentMap = new Map();
    recent.partitions.forEach((entry) => recentMap.set(entry.name, entry));
    const previousMap = new Map();
    previous.partitions.forEach((entry) => previousMap.set(entry.name, entry));

    const names = new Map();
    recent.partitions.forEach((entry) => {
      names.set(entry.name, { name: entry.name, identified: entry.identified });
    });
    previous.partitions.forEach((entry) => {
      if (!names.has(entry.name)) {
        names.set(entry.name, { name: entry.name, identified: entry.identified });
      }
    });

    const partitions = Array.from(names.values())
      .map((identity) => {
        const recentEntry = recentMap.get(identity.name);
        const previousEntry = previousMap.get(identity.name);
        const recentWatchMs = recentEntry ? recentEntry.watchMs : 0;
        const previousWatchMs = previousEntry ? previousEntry.watchMs : 0;
        const recentShare = recentEntry ? recentEntry.share : 0;
        const previousShare = previousEntry ? previousEntry.share : 0;
        const shareDelta = recentShare - previousShare;
        return {
          name: identity.name,
          identified: Boolean(
            (recentEntry && recentEntry.identified) ||
              (previousEntry && previousEntry.identified)
          ),
          recentWatchMs,
          previousWatchMs,
          watchMsDelta: recentWatchMs - previousWatchMs,
          recentShare,
          previousShare,
          shareDelta,
          direction: shareDelta > 0 ? "up" : shareDelta < 0 ? "down" : "flat"
        };
      })
      .sort(
        (left, right) =>
          Math.max(right.recentShare, right.previousShare) -
            Math.max(left.recentShare, left.previousShare) ||
          (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
      );

    return {
      key: `${dayCount}d`,
      windowDays: dayCount,
      recent: trendSummary(recent),
      previous: trendSummary(previous),
      partitions,
      reliable,
      status,
      reasons,
      note: `兴趣变化使用互不重叠的等长窗口：最近 ${dayCount} 天 vs 前 ${dayCount} 天；不把嵌套的 7 天与 30 天窗口直接对比。`
    };
  }

  /* ---------------------------------------------------------------- 主入口 */

  /**
   * 构建本地用户兴趣画像。
   *
   * @param {object} records 根结构 { version, days }，或直接传入「日期 → 记录表」映射
   * @param {object} [options]
   * @param {Date|number} [options.now] 计算「今天」的基准时间，默认当前时间；便于测试注入
   * @param {string} [options.endDate] 本地日期键 "YYYY-MM-DD"，优先于 now
   * @param {number[]} [options.windows] 统计窗口天数，默认 [7, 30]，范围 1..366
   * @param {boolean} [options.includeComparisons] 是否计算互不重叠的兴趣变化，默认 true
   * @returns {object} 兴趣画像（结构见下方注释）
   */
  function buildInterestProfile(records, options) {
    const opts = isPlainObject(options) ? options : {};
    const endDate = resolveEndDate(opts);
    const nowMs = resolveNowMs(opts);
    const windowDaysList = normalizeWindowDays(opts.windows);
    const source = readDays(records);

    const profile = {
      // 画像基准日与生成信息
      asOfDate: endDate,
      generatedAt: new Date(nowMs).toISOString(),
      timezoneOffsetMinutes: new Date(nowMs).getTimezoneOffset(),
      inputKind: source.kind,

      // 总体状态取最大窗口（数据量最多）的判断
      status: "empty",
      reasons: [],

      // 各统计窗口：键为 "7d" / "30d"，结构与 summarizeRange 返回值一致
      windows: {},
      windowOrder: [],

      // 互不重叠的兴趣变化：键同 windows，值为 buildComparison 返回值
      comparisons: {},
      comparisonOrder: [],

      unknownPartition: UNKNOWN_PARTITION,
      thresholds: {
        effectiveWatchMs: EFFECTIVE_WATCH_MS,
        profileMinWatchMs: PROFILE_MIN_WATCH_MS,
        profileMinActiveDays: PROFILE_MIN_ACTIVE_DAYS,
        trendMinWatchMs: TREND_MIN_WATCH_MS,
        trendMinActiveDays: TREND_MIN_ACTIVE_DAYS,
        trendMinPartitionCoverage: TREND_MIN_PARTITION_COVERAGE
      },
      note:
        "7 天窗口嵌套在 30 天窗口内，不能把两者当作独立周期计算增长率；" +
        "兴趣变化请使用 comparisons 中互不重叠的等长窗口。"
    };

    if (!endDate) {
      profile.reasons.push("无法确定本地日期基准，未生成画像");
      return profile;
    }

    windowDaysList.forEach((dayCount) => {
      const key = `${dayCount}d`;
      const range = makeRange(endDate, dayCount);
      profile.windows[key] = summarizeRange(source.days, dayCount, range, key);
      profile.windowOrder.push(key);
    });

    // 总体状态以数据量最多的窗口为准；其他窗口的问题写进 reasons 供调用方展示。
    const largestKey = profile.windowOrder[profile.windowOrder.length - 1];
    const largest = largestKey ? profile.windows[largestKey] : null;
    profile.status = largest ? largest.status : "empty";
    if (largest) profile.reasons = largest.reasons.slice();
    profile.windowOrder.forEach((key) => {
      if (key === largestKey) return;
      const summary = profile.windows[key];
      if (summary.status !== "ok") {
        profile.reasons.push(
          `${key} 窗口数据不足：${summary.reasons.join("；") || summary.status}`
        );
      }
    });

    if (opts.includeComparisons !== false) {
      profile.windowOrder.forEach((key) => {
        const summary = profile.windows[key];
        profile.comparisons[key] = buildComparison(
          source.days,
          summary.dayCount,
          endDate
        );
        profile.comparisonOrder.push(key);
      });
    }

    return profile;
  }

  global.BiliDailyInterestProfile = Object.freeze({
    UNKNOWN_PARTITION,
    DEFAULT_WINDOWS,
    PROFILE_MIN_WATCH_MS,
    PROFILE_MIN_ACTIVE_DAYS,
    TREND_MIN_WATCH_MS,
    TREND_MIN_ACTIVE_DAYS,
    TREND_MIN_PARTITION_COVERAGE,
    buildInterestProfile
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
