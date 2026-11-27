"use strict";

/**
 * Bili Daily —— 观看数据统计层（纯函数，无副作用）
 *
 * 只读取 storage.js 定义的记录结构，不写入、不修改原始数据：
 * {
 *   version: 1,
 *   days: {
 *     "YYYY-MM-DD": {
 *       "BVxxxx": {
 *         bvid, page, title, upName, partition,
 *         videoDuration, watchMs, watchMsByHour,
 *         startedAt, lastWatchedAt, updatedAt
 *       }
 *     }
 *   }
 * }
 *
 * 统计口径：
 * - 日期一律使用调用方传入的本地日期键 "YYYY-MM-DD"；本文件从不使用 UTC 日期。
 * - 同一个 BV 号视为一个视频（不同分 P 已由 storage.js 合并到同一条记录，
 *   若历史数据里出现同一 BV 的多条记录，这里按键合并，不重复计数）。
 * - 累计时长使用记录里的真实观看时长 watchMs，不使用 videoDuration 代替。
 * - 有效观看阈值：watchMs >= 30 秒才计入「有效观看视频数量」。
 * - 分区喜好 & 时段分布只基于真实存在的字段；字段缺失时返回 null / available=false，
 *   并由 reason 说明缺失原因，绝不虚构结果。
 * - summarizeUps 优先按 upUid 聚合；没有 UID 的老记录按 upName 兼容统计，
 *   缺失 UID 的记录不会被名称合并进已知 UID 分组。
 */

(function (global) {
  const EFFECTIVE_WATCH_MS = 30 * 1000;

  const PERIODS = Object.freeze([
    { key: "dawn", label: "凌晨", startHour: 0, endHour: 5 },
    { key: "morning", label: "上午", startHour: 6, endHour: 11 },
    { key: "afternoon", label: "下午", startHour: 12, endHour: 17 },
    { key: "evening", label: "晚上", startHour: 18, endHour: 23 }
  ]);

  const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
  const HOUR_PATTERN = /^(\d{1,2})$/;

  /* ---------------------------------------------------------------- 基础工具 */

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function pad(number) {
    return String(number).padStart(2, "0");
  }

  /** 非负有限数字 → 数字，其余（含 NaN / Infinity / 负数 / 字符串）→ 0。 */
  function safeMs(value) {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return number;
  }

  const UID_PATTERN = /^[1-9]\d{0,15}$/;

  /** 校验并规范化 UP 主 UID；无法确认时返回 null，不做任何猜测。 */
  function normalizeUpUid(value) {
    let text = "";
    if (typeof value === "string") {
      text = value.trim();
    } else if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      text = String(value);
    } else {
      return null;
    }
    if (!UID_PATTERN.test(text)) return null;
    const number = Number(text);
    return Number.isSafeInteger(number) && number > 0 ? String(number) : null;
  }

  /* ---------------------------------------------------------------- 日期工具 */

  /** 把 Date / 毫秒时间戳格式化为本地日期键 "YYYY-MM-DD"（不使用 UTC）。 */
  function localDateKey(value) {
    const date = value instanceof Date ? value : new Date(value == null ? Date.now() : value);
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  /** 校验 "YYYY-MM-DD" 是否是真实存在的本地日期；不合法返回 null。 */
  function parseDateKey(dateKey) {
    if (typeof dateKey !== "string") return null;
    const match = DATE_PATTERN.exec(dateKey);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    ) {
      return null;
    }
    return { year, month, day };
  }

  /** 在本地日历上平移日期键，跨月 / 跨年 / 夏令时都交给 Date 处理。 */
  function shiftLocalDate(dateKey, days) {
    const parsed = parseDateKey(dateKey);
    const offset = Number(days);
    if (!parsed || !Number.isFinite(offset)) return "";
    const date = new Date(parsed.year, parsed.month - 1, parsed.day + Math.trunc(offset));
    return localDateKey(date);
  }

  /** 本地时区的「昨天」。now 可注入，便于测试。 */
  function yesterdayKey(now) {
    const today = localDateKey(now == null ? Date.now() : now);
    return today ? shiftLocalDate(today, -1) : "";
  }

  /* ------------------------------------------------------------ 记录读取与清洗 */

  /**
   * 从根结构（{ version, days }）或直接传入的「日期 → 记录」映射中取出 days。
   * 两种形态都接受，避免调用方拿错层级时静默统计出 0。
   */
  function resolveDays(records) {
    if (!isPlainObject(records)) return {};
    if (isPlainObject(records.days)) return records.days;
    return records;
  }

  /** 取指定日期的原始记录表；没有则返回 null。 */
  function getDay(records, dateKey) {
    if (!parseDateKey(dateKey)) return null;
    const days = resolveDays(records);
    const day = days[dateKey];
    return isPlainObject(day) ? day : null;
  }

  /** 规范一条记录的时长部分，返回新对象 —— 绝不修改入参。 */
  function cleanRecord(raw, fallbackBvid) {
    if (!isPlainObject(raw)) return null;
    const bvid = typeof raw.bvid === "string" && raw.bvid.trim() ? raw.bvid.trim() : fallbackBvid;
    const watchMs = safeMs(raw.watchMs);
    const hours = {};
    let hourFieldValid = false;
    if (isPlainObject(raw.watchMsByHour)) {
      Object.keys(raw.watchMsByHour).forEach((key) => {
        const match = HOUR_PATTERN.exec(key);
        if (!match) return;
        const hour = Number(match[1]);
        if (hour < 0 || hour > 23) return;
        const value = safeMs(raw.watchMsByHour[key]);
        if (value <= 0) return;
        hours[pad(hour)] = (hours[pad(hour)] || 0) + value;
        hourFieldValid = true;
      });
    }
    return {
      bvid,
      upName: typeof raw.upName === "string" ? raw.upName.trim() : "",
      upUid: normalizeUpUid(raw.upUid),
      partition: typeof raw.partition === "string" ? raw.partition.trim() : "",
      title: typeof raw.title === "string" ? raw.title : "",
      page: Number.isInteger(raw.page) ? raw.page : null,
      watchMs,
      hours,
      hasHourData: hourFieldValid,
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "",
      lastWatchedAt: typeof raw.lastWatchedAt === "string" ? raw.lastWatchedAt : ""
    };
  }

  /**
   * 把同一天内同一个 BV 的多条记录合并成一条（正常数据里不会出现，
   * 用于兼容历史结构或手工修改过的数据）。不修改原始对象。
   */
  function mergeByBvid(records) {
    const merged = new Map();
    records.forEach((record) => {
      const key = record.bvid || "\u0000unknown";
      const current = merged.get(key);
      if (!current) {
        merged.set(key, record);
        return;
      }
      const hours = Object.assign({}, current.hours);
      Object.keys(record.hours).forEach((hour) => {
        hours[hour] = (hours[hour] || 0) + record.hours[hour];
      });
      merged.set(key, {
        bvid: current.bvid,
        // 名称取观看时长更多的那条，缺失时回退，避免分 P 记录把名称覆盖成空
        upName: record.watchMs > current.watchMs
          ? record.upName || current.upName
          : current.upName || record.upName,
        // UID 只补空，不使用 null / 不同值覆盖原记录
        upUid: current.upUid || record.upUid,
        // 分区取观看时长更多的那条，避免分 P 信息把主分区覆盖成空
        partition: record.watchMs > current.watchMs ? record.partition || current.partition : current.partition || record.partition,
        title: current.title || record.title,
        page: record.page || current.page,
        watchMs: current.watchMs + record.watchMs,
        hours,
        hasHourData: current.hasHourData || record.hasHourData,
        startedAt: current.startedAt || record.startedAt,
        lastWatchedAt: record.lastWatchedAt || current.lastWatchedAt
      });
    });
    return Array.from(merged.values());
  }

  /* ---------------------------------------------------------------- 统计主体 */

  function emptyResult(dateKey) {
    return {
      date: dateKey,
      validDate: parseDateKey(dateKey) !== null,
      hasData: false,
      recordCount: 0,
      invalidRecords: 0,
      videoCount: 0,
      effectiveVideoCount: 0,
      totalWatchMs: 0,
      effectiveWatchMs: 0,
      favoritePartition: null,
      partitionAvailable: false,
      partitionReason: "",
      periods: PERIODS.map((period) => ({
        key: period.key,
        label: period.label,
        startHour: period.startHour,
        endHour: period.endHour,
        watchMs: 0,
        share: 0
      })),
      periodsAvailable: false,
      periodsReason: "",
      missingPartitionVideos: 0
    };
  }

  /**
   * 统计指定本地日期的观看数据。
   *
   * @param {object} records 根结构 { version, days } 或 "YYYY-MM-DD" → 记录 的映射
   * @param {string} dateKey 本地日期键 "YYYY-MM-DD"
   * @returns {object} 统计结果（结构见 emptyResult）
   */
  function summarizeDay(records, dateKey) {
    const result = emptyResult(dateKey);
    if (!result.validDate) {
      result.partitionReason = "日期格式无效，无法统计";
      result.periodsReason = "日期格式无效，无法统计";
      return result;
    }

    const day = getDay(records, dateKey);
    if (!day) {
      result.partitionReason = "当日没有观看记录";
      result.periodsReason = "当日没有观看记录";
      return result;
    }

    const keys = Object.keys(day);
    const cleaned = [];
    keys.forEach((key) => {
      const record = cleanRecord(day[key], key);
      if (!record) {
        result.invalidRecords += 1;
        return;
      }
      cleaned.push(record);
    });

    const videos = mergeByBvid(cleaned);
    result.recordCount = keys.length;
    result.videoCount = videos.length;
    result.hasData = videos.length > 0;

    if (!result.hasData) {
      result.partitionReason = "当日没有可用的观看记录";
      result.periodsReason = "当日没有可用的观看记录";
      return result;
    }

    /* ---- 数量与时长 ---- */
    let totalWatchMs = 0;
    let effectiveWatchMs = 0;
    let effectiveVideoCount = 0;
    videos.forEach((video) => {
      totalWatchMs += video.watchMs;
      if (video.watchMs >= EFFECTIVE_WATCH_MS) {
        effectiveVideoCount += 1;
        effectiveWatchMs += video.watchMs;
      }
    });
    result.totalWatchMs = totalWatchMs;
    result.effectiveWatchMs = effectiveWatchMs;
    result.effectiveVideoCount = effectiveVideoCount;

    /* ---- 分区 ---- */
    const partitionMs = new Map();
    let partitionTotalMs = 0;
    let missingPartitionVideos = 0;
    videos.forEach((video) => {
      if (video.watchMs <= 0) return; // 没有实际观看时长，不参与分区统计
      if (!video.partition) {
        missingPartitionVideos += 1;
        return;
      }
      partitionMs.set(video.partition, (partitionMs.get(video.partition) || 0) + video.watchMs);
      partitionTotalMs += video.watchMs;
    });
    result.missingPartitionVideos = missingPartitionVideos;

    if (partitionTotalMs > 0) {
      let best = null;
      partitionMs.forEach((ms, name) => {
        // 时长相同按名称排序，保证结果稳定可复现
        if (!best || ms > best.watchMs || (ms === best.watchMs && name < best.name)) {
          best = { name, watchMs: ms, share: ms / partitionTotalMs };
        }
      });
      result.favoritePartition = best;
      result.partitionAvailable = true;
      if (missingPartitionVideos > 0) {
        result.partitionReason = `${missingPartitionVideos} 个视频缺少分区信息，未计入分区统计`;
      }
    } else {
      result.partitionAvailable = false;
      result.partitionReason = missingPartitionVideos > 0
        ? "记录中缺少分区信息，无法统计最喜欢的视频分区"
        : "没有可用的观看时长，无法统计分区";
    }

    /* ---- 时段分布 ---- */
    const periodMs = PERIODS.map(() => 0);
    let periodTotalMs = 0;
    let videosWithHourData = 0;
    videos.forEach((video) => {
      if (!video.hasHourData) return;
      videosWithHourData += 1;
      Object.keys(video.hours).forEach((hourKey) => {
        const hour = Number(hourKey);
        const index = PERIODS.findIndex((period) => hour >= period.startHour && hour <= period.endHour);
        if (index < 0) return;
        const ms = video.hours[hourKey];
        periodMs[index] += ms;
        periodTotalMs += ms;
      });
    });

    if (videosWithHourData > 0 && periodTotalMs > 0) {
      result.periodsAvailable = true;
      result.periods.forEach((period, index) => {
        period.watchMs = periodMs[index];
        period.share = periodMs[index] / periodTotalMs;
      });
      if (videosWithHourData < videos.length) {
        result.periodsReason = `${videos.length - videosWithHourData} 个视频缺少时间戳，未计入时段统计`;
      }
    } else {
      result.periodsAvailable = false;
      result.periodsReason = "记录中缺少精确观看时间戳（watchMsByHour），无法统计观看时段分布";
    }

    return result;
  }

  /* ---------------------------------------------------------------- UP 主统计 */

  /**
   * UP 主条目排序：有效观看时长 → 有效视频数 → 总观看时长 → 名称（码点顺序）。
   * 显式兜底保证并列时顺序稳定、可复现，不依赖引擎的排序实现细节。
   */
  function compareUpItems(left, right) {
    return (
      right.effectiveWatchMs - left.effectiveWatchMs ||
      right.effectiveVideoCount - left.effectiveVideoCount ||
      right.watchMs - left.watchMs ||
      (left.upName < right.upName ? -1 : left.upName > right.upName ? 1 : 0) ||
      ((left.upUid || "") < (right.upUid || "") ? -1 : (left.upUid || "") > (right.upUid || "") ? 1 : 0)
    );
  }

  function emptyUpsResult(dateKey) {
    return {
      date: dateKey,
      validDate: parseDateKey(dateKey) !== null,
      hasData: false,
      items: [],
      unknown: {
        videoCount: 0,
        effectiveVideoCount: 0,
        watchMs: 0,
        effectiveWatchMs: 0
      },
      belowThresholdVideoCount: 0,
      uidUpCount: 0,
      nameOnlyUpCount: 0,
      reason: ""
    };
  }

  /**
   * 取出 summarizeUps 需要统计的「当天记录表」。
   *
   * summarizeDay 的 getDay 只接受根结构或「日期 → 记录表」映射；
   * 而弹窗之外的调用方（独立测试）会直接把「BV 号 → 记录」的当天记录表传进来。
   * 这里在不改动 summarizeDay 行为的前提下兼容三种输入形态：
   * 1. 根结构 { version, days }；
   * 2. 「日期 → 记录表」映射：只要出现任意合法日期键，就只按 dateKey 取值，
   *    指定日期不存在时返回 null —— 绝不把其他日期的记录算进当天；
   * 3. 直接的当天记录表（键是 BV 号 / 记录键），整个对象就是当天数据。
   * 日期键只做格式校验，不参与记录过滤。
   */
  function getDayForUps(records, dateKey) {
    if (!parseDateKey(dateKey)) return null;
    if (!isPlainObject(records)) return null;
    if (isPlainObject(records.days)) {
      const day = records.days[dateKey];
      return isPlainObject(day) ? day : null;
    }
    if (isPlainObject(records[dateKey])) return records[dateKey];
    const hasDateKey = Object.keys(records).some((key) => parseDateKey(key) !== null);
    if (hasDateKey) return null;
    return records;
  }

  /**
   * 把一组（已按 BV 合并的）视频按 UP 主身份聚合。
   * summarizeUps 与兴趣画像（interest-profile.js）共用同一套身份识别规则，
   * 避免在两个模块里各写一遍 UID / 昵称聚合。
   *
   * 身份识别规则：
   * - 有可信 upUid 时按 upUid 聚合：同一 UID 的不同昵称合并为一条；
   * - 没有 upUid 时继续按 upName 聚合（兼容老记录）；
   * - 缺失 UID 的记录不会凭昵称并入任何已知 UID 分组；
   * - 不同 UID 的同名 UP 主保持分开；
   * - 既没有 UID 也没有名称的记录归入 unknown，不参与排名。
   *
   * 不修改传入的视频对象。
   *
   * @param {Array<object>} videos cleanRecord + mergeByBvid 产出的视频列表
   * @returns {object} { items, unknown, belowThresholdVideoCount, uidUpCount, nameOnlyUpCount }
   */
  function aggregateUps(videos) {
    const summary = {
      items: [],
      unknown: {
        videoCount: 0,
        effectiveVideoCount: 0,
        watchMs: 0,
        effectiveWatchMs: 0
      },
      belowThresholdVideoCount: 0,
      uidUpCount: 0,
      nameOnlyUpCount: 0
    };

    const list = Array.isArray(videos) ? videos : [];
    const byIdentity = new Map();
    list.forEach((video) => {
      const isEffective = video.watchMs >= EFFECTIVE_WATCH_MS;
      if (!isEffective) summary.belowThresholdVideoCount += 1;

      if (!video.upUid && !video.upName) {
        summary.unknown.videoCount += 1;
        summary.unknown.watchMs += video.watchMs;
        if (isEffective) {
          summary.unknown.effectiveVideoCount += 1;
          summary.unknown.effectiveWatchMs += video.watchMs;
        }
        return;
      }

      // 有 UID 按 UID 聚合；无 UID 按名称单独聚合。
      // 缺失 UID 的记录不会凭昵称并入任何 UID 分组。
      const key = video.upUid ? `uid:${video.upUid}` : `name:${video.upName}`;
      let entry = byIdentity.get(key);
      if (!entry) {
        entry = {
          upUid: video.upUid || null,
          nameWatchMs: new Map(),
          watchMs: 0,
          effectiveWatchMs: 0,
          videoCount: 0,
          effectiveVideoCount: 0
        };
        byIdentity.set(key, entry);
      }
      if (video.upName) {
        entry.nameWatchMs.set(video.upName, (entry.nameWatchMs.get(video.upName) || 0) + video.watchMs);
      }
      entry.videoCount += 1;
      entry.watchMs += video.watchMs;
      if (isEffective) {
        entry.effectiveVideoCount += 1;
        entry.effectiveWatchMs += video.watchMs;
      }
    });

    summary.items = Array.from(byIdentity.values())
      .map((entry) => {
        // 同一 UID 有多个昵称时，展示观看时长最多的昵称；并列时按码点排序，保证可复现。
        let upName = "";
        let bestMs = -1;
        entry.nameWatchMs.forEach((watchMs, name) => {
          if (watchMs > bestMs || (watchMs === bestMs && (!upName || name < upName))) {
            upName = name;
            bestMs = watchMs;
          }
        });
        return {
          upName,
          upUid: entry.upUid,
          watchMs: entry.watchMs,
          effectiveWatchMs: entry.effectiveWatchMs,
          videoCount: entry.videoCount,
          effectiveVideoCount: entry.effectiveVideoCount
        };
      })
      .sort(compareUpItems);

    summary.uidUpCount = summary.items.filter((item) => item.upUid !== null).length;
    summary.nameOnlyUpCount = summary.items.length - summary.uidUpCount;
    return summary;
  }

  /**
   * 统计指定本地日期中各 UP 主的观看情况，按有效观看时长降序排列。
   *
   * 口径与 summarizeDay 保持一致：
   * - 同一天同一 BV 的多条记录先按 BV 合并（兼容历史 / 手工数据），不会重复计数；
   * - effectiveWatchMs 只累加 watchMs >= 30 秒的视频，watchMs / videoCount 保留全部视频；
   * - 既没有 upUid 也没有 upName 的记录归入 unknown，不参与排名，也不虚构 UP 主。
   *
   * 身份识别规则：
   * - 有可信 upUid 时按 upUid 聚合：同一 UID 的不同昵称合并为一条；
   * - 没有 upUid 时继续按 upName 聚合（兼容老记录）；
   * - 缺失 UID 的记录不会凭昵称并入任何已知 UID 分组；
   * - 不同 UID 的同名 UP 主保持分开。
   * 无法确认 UP 主身份（既无 UID 也无名称）的记录归入 unknown，不参与排名。
   *
   * @param {object} records 根结构 { version, days }、「YYYY-MM-DD」→ 记录表 的映射，
   *   或直接传入的当天记录表（BV 号 → 记录）
   * @param {string} dateKey 本地日期键 "YYYY-MM-DD"
   * @returns {object} 统计结果（结构见 emptyUpsResult）
   */
  function summarizeUps(records, dateKey) {
    const result = emptyUpsResult(dateKey);
    if (!result.validDate) {
      result.reason = "日期格式无效，无法统计";
      return result;
    }

    const day = getDayForUps(records, dateKey);
    if (!day) {
      result.reason = "当日没有观看记录";
      return result;
    }

    const keys = Object.keys(day);
    const cleaned = [];
    let invalidRecords = 0;
    keys.forEach((key) => {
      const record = cleanRecord(day[key], key);
      if (!record) {
        invalidRecords += 1;
        return;
      }
      cleaned.push(record);
    });

    const videos = mergeByBvid(cleaned);
    if (videos.length === 0) {
      result.reason = invalidRecords > 0 ? "当日没有可用的观看记录" : "当日没有观看记录";
      return result;
    }
    result.hasData = true;

    // 身份聚合规则与 interest-profile.js 共用，保证两处口径一致。
    const aggregated = aggregateUps(videos);
    result.items = aggregated.items;
    result.unknown = aggregated.unknown;
    result.belowThresholdVideoCount = aggregated.belowThresholdVideoCount;
    result.uidUpCount = aggregated.uidUpCount;
    result.nameOnlyUpCount = aggregated.nameOnlyUpCount;

    if (result.items.length === 0) {
      result.reason = `记录中缺少 UP 主信息（${result.unknown.videoCount} 个视频），无法排名`;
    }
    return result;
  }

  /* ---------------------------------------------------------------- 展示辅助 */

  /** 毫秒 → 人类可读时长，用于弹窗展示。 */
  function formatDuration(ms) {
    const total = Math.round(safeMs(ms) / 1000);
    if (total <= 0) return "0 分钟";
    if (total < 60) return `${total} 秒`;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
    return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  }

  /** 小数占比 → 百分比整数（四舍五入，避免 0.6% 显示成 0%）。 */
  function formatPercent(share) {
    const value = Number(share);
    if (!Number.isFinite(value) || value <= 0) return "0%";
    const percent = Math.round(value * 1000) / 10;
    return percent < 1 ? "<1%" : `${percent}%`;
  }

  global.BiliDailyStats = Object.freeze({
    EFFECTIVE_WATCH_MS,
    PERIODS,
    localDateKey,
    parseDateKey,
    shiftLocalDate,
    yesterdayKey,
    getDay,
    cleanRecord,
    mergeByBvid,
    aggregateUps,
    summarizeDay,
    summarizeUps,
    formatDuration,
    formatPercent
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
