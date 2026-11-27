"use strict";

/**
 * Bili Daily —— 公共数据存储层
 *
 * 供内容脚本（content.js）与弹窗（popup.js）共用，UI 模块在第二阶段接入。
 * 本文件不发起任何网络请求，所有数据只写入 chrome.storage.local。
 *
 * 存储结构（STORAGE_KEY = "biliDailyRecords"）：
 * {
 *   version: 1,
 *   days: {
 *     "YYYY-MM-DD": {
 *       "BVxxxx": {
 *         bvid, page, title, upName, upUid, partition,
 *         videoDuration, watchMs, watchMsByHour,
 *         startedAt, lastWatchedAt, updatedAt
 *       }
 *     }
 *   }
 * }
 *
 * 约定（与第一阶段之前的实现保持一致）：
 * - 同一个 BV 的不同分 P 视为同一个视频，观看时长累加，page 记录最后一次观看的分 P。
 * - 时间统一按浏览器本地时区归属到具体日期，日期键为 "YYYY-MM-DD"。
 * - 读不到的文字留空字符串，读不到的时长留 null。
 * - upUid 为可选字段：老记录可以没有；只接受正整数字符串，无法确认时存 null，
 *   合并时绝不使用 null 覆盖已有有效 UID，两个不同有效 UID 会保留原值并打印冲突警告。
 * - 不清理任何未知字段，保证旧数据与未来字段都能原样保留。
 */

(function (global) {
  const STORAGE_KEY = "biliDailyRecords";
  const SCHEMA_VERSION = 1;

  function logError(error) {
    console.error("[Bili Daily] 本地数据读写失败", error);
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  const UID_PATTERN = /^[1-9]\d{0,15}$/;

  /**
   * 校验并规范化 UP 主 UID：只接受正整数字符串 / 安全整数，统一返回字符串；
   * 无法确认（null、空串、0、负数、小数、非数字、超出安全整数）一律返回 null。
   * 存储为字符串，避免大整数精度问题。
   */
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

  /* ---------------------------------------------------------------- 时间工具 */

  function pad(number) {
    return String(number).padStart(2, "0");
  }

  /** 将毫秒时间戳格式化为本地时区的 "YYYY-MM-DD"。 */
  function formatLocalDate(ms) {
    const date = new Date(ms);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  /** 将毫秒时间戳格式化为带本地时区偏移的 ISO 字符串。 */
  function toLocalIso(ms) {
    const date = new Date(ms);
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "-";
    const absolute = Math.abs(offset);
    return `${formatLocalDate(ms)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
  }

  /** 返回下一个本地日 / 本地小时的毫秒时间戳。 */
  function nextBoundary(ms, unit) {
    const date = new Date(ms);
    if (unit === "day") return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours() + 1).getTime();
  }

  /* ------------------------------------------------------------ 数据结构规范 */

  function normalizeDay(day) {
    return isPlainObject(day) ? day : {};
  }

  function normalizeRecord(record) {
    if (!isPlainObject(record)) return null;
    if (typeof record.watchMs !== "number" || !Number.isFinite(record.watchMs) || record.watchMs < 0) {
      record.watchMs = 0;
    }
    if (!isPlainObject(record.watchMsByHour)) record.watchMsByHour = {};
    if (Object.prototype.hasOwnProperty.call(record, "upUid")) {
      record.upUid = normalizeUpUid(record.upUid);
    }
    return record;
  }

  /**
   * 统一根结构：保证 version 与 days 存在，并修补明显损坏的日期 / 记录。
   * 不做删除、不做重命名、不改写已有字段的含义，未知字段原样保留。
   */
  function normalizeRoot(value) {
    const root = isPlainObject(value) ? value : {};
    if (!isPlainObject(root.days)) root.days = {};
    Object.keys(root.days).forEach((date) => {
      const day = normalizeDay(root.days[date]);
      root.days[date] = day;
      Object.keys(day).forEach((bvid) => {
        const record = normalizeRecord(day[bvid]);
        if (record) day[bvid] = record;
      });
    });
    root.version = SCHEMA_VERSION;
    return root;
  }

  function emptyRoot() {
    return { version: SCHEMA_VERSION, days: {} };
  }

  /* ---------------------------------------------------------------- 存储封装 */

  function getStorageArea() {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        return chrome.storage.local;
      }
    } catch (error) {
      logError(error);
    }
    return null;
  }

  function lastRuntimeError() {
    try {
      return (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError) || null;
    } catch (error) {
      return error || null;
    }
  }

  /**
   * 读取并规范化整份记录。
   * 读取失败时会 reject，调用方必须决定是否继续写入 ——
   * 不要用空结构兜底后写回，否则会覆盖已有数据。
   */
  function readRoot() {
    return new Promise((resolve, reject) => {
      const area = getStorageArea();
      if (!area) {
        reject(new Error("当前浏览器不能使用本地存储"));
        return;
      }
      try {
        area.get(STORAGE_KEY, (result) => {
          const error = lastRuntimeError();
          if (error) {
            reject(error);
            return;
          }
          resolve(normalizeRoot(result ? result[STORAGE_KEY] : null));
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /** 读取规范化数据，失败时返回空结构并附带错误，仅供只读展示使用。 */
  function readRootSafe() {
    return readRoot().then(
      (root) => ({ ok: true, root, error: null }),
      (error) => {
        logError(error);
        return { ok: false, root: emptyRoot(), error };
      }
    );
  }

  function writeRoot(root) {
    return new Promise((resolve, reject) => {
      const area = getStorageArea();
      if (!area) {
        reject(new Error("当前浏览器不能使用本地存储"));
        return;
      }
      try {
        area.set({ [STORAGE_KEY]: normalizeRoot(root) }, () => {
          const error = lastRuntimeError();
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /* -------------------------------------------------------------- 记录累加 */

  function ensureRecord(day, payload, startMs) {
    const current = day[payload.bvid];
    if (current && typeof current === "object") {
      if (typeof current.watchMs !== "number" || !Number.isFinite(current.watchMs) || current.watchMs < 0) {
        current.watchMs = 0;
      }
      if (!current.watchMsByHour || typeof current.watchMsByHour !== "object" || Array.isArray(current.watchMsByHour)) {
        current.watchMsByHour = {};
      }
      return current;
    }
    const created = {
      bvid: payload.bvid,
      page: payload.page,
      title: payload.title || "",
      upName: payload.upName || "",
      upUid: normalizeUpUid(payload.upUid),
      partition: payload.partition || "",
      videoDuration: payload.videoDuration,
      watchMs: 0,
      watchMsByHour: {},
      startedAt: toLocalIso(startMs),
      lastWatchedAt: toLocalIso(startMs),
      updatedAt: toLocalIso(startMs)
    };
    day[payload.bvid] = created;
    return created;
  }

  function fillMissing(record, payload, date) {
    record.page = payload.page || record.page || 1;
    if (!record.title && payload.title) record.title = payload.title;
    if (!record.upName && payload.upName) record.upName = payload.upName;
    if (!record.partition && payload.partition) record.partition = payload.partition;
    if (record.videoDuration == null && payload.videoDuration != null) {
      record.videoDuration = payload.videoDuration;
    }

    const incomingUid = normalizeUpUid(payload.upUid);
    if (incomingUid) {
      const currentUid = normalizeUpUid(record.upUid);
      if (!currentUid) {
        record.upUid = incomingUid;
      } else if (currentUid !== incomingUid) {
        // 同一 BV 上出现两个可信但不同的 UID：保留原始记录，绝不静默覆盖。
        console.warn(
          `[Bili Daily] UP 主 UID 冲突：${date} ${record.bvid} 已有 ${currentUid}，本次 ${incomingUid}，已保留原值`
        );
      }
    }
  }

  /**
   * 把 [startMs, endMs) 这一段观看时间累加到对应日期 / 视频记录上。
   * 跨天、跨小时会自动拆分到不同日期与不同的小时桶，语义与拆分前完全一致。
   * 读取失败会 reject，且不会写入任何内容。
   */
  async function addWatch(payload, startMs, endMs) {
    if (!payload || !payload.bvid || endMs <= startMs) return;
    if (!getStorageArea()) {
      throw new Error("当前浏览器不能使用本地存储");
    }
    const root = await readRoot();
    let cursor = startMs;
    while (cursor < endMs) {
      const dayEnd = Math.min(endMs, nextBoundary(cursor, "day"));
      const date = formatLocalDate(cursor);
      if (!isPlainObject(root.days[date])) {
        root.days[date] = {};
      }
      const record = ensureRecord(root.days[date], payload, cursor);
      let hourCursor = cursor;
      while (hourCursor < dayEnd) {
        const hourEnd = Math.min(dayEnd, nextBoundary(hourCursor, "hour"));
        const hour = pad(new Date(hourCursor).getHours());
        const delta = hourEnd - hourCursor;
        record.watchMs += delta;
        record.watchMsByHour[hour] = (Number(record.watchMsByHour[hour]) || 0) + delta;
        hourCursor = hourEnd;
      }
      fillMissing(record, payload, date);
      record.lastWatchedAt = toLocalIso(dayEnd);
      record.updatedAt = toLocalIso(dayEnd);
      cursor = dayEnd;
    }
    await writeRoot(root);
  }

  global.BiliDailyStorage = Object.freeze({
    STORAGE_KEY,
    SCHEMA_VERSION,
    normalizeUpUid,
    normalizeRoot,
    emptyRoot,
    readRoot,
    readRootSafe,
    writeRoot,
    addWatch,
    pad,
    formatLocalDate,
    toLocalIso,
    nextBoundary
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
