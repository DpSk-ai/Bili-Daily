"use strict";

/**
 * Bili Daily —— 本地数据备份/恢复（v1.1）
 *
 * 解析、校验与构建 payload 均为纯函数：不访问 DOM、网络、Cookie 或文件系统。
 * 只有 writePayload 是对调用方传入的 chrome.storage.local 兼容 area 的薄封装。
 * 调用方把 chrome.storage.local 的值传入，或把待写入的 payload 与 storage area 传入。
 *
 * 设计边界：
 * - 只识别四个既有存储键：biliDailyRecords / biliDailyCandidateImports /
 *   biliDailyDiscoveredCandidates / biliDailyDiscoverySettings；
 * - 导出时原样保留值，不做字段改写；
 * - 导入时先解析、再校验格式与键，再由调用方提供的既有 normalize 函数清洗；
 * - 不认识的键、危险键（__proto__ / constructor / prototype）直接拒绝；
 * - 导入只生成待写 payload，真正写入由调用方确认后执行；
 * - 不读取、不覆盖任何未包含在备份中的键。
 */

(function (global) {
  const FORMAT = "bili-daily-backup";
  const VERSION = 1;
  const APP = "Bili Daily";
  const APP_VERSION = "1.1";
  const MAX_BYTES = 5 * 1024 * 1024;
  const MAX_DEPTH = 32;

  const KEYS = Object.freeze({
    records: "biliDailyRecords",
    imports: "biliDailyCandidateImports",
    discovered: "biliDailyDiscoveredCandidates",
    settings: "biliDailyDiscoverySettings"
  });

  const KEY_LIST = Object.freeze(Object.keys(KEYS).map((name) => KEYS[name]));
  const DANGEROUS_KEYS = Object.freeze(["__proto__", "constructor", "prototype"]);

  const REASONS = Object.freeze({
    "invalid-source": "传入的存储内容不是普通对象",
    "empty-source": "没有可导出的本地数据",
    "invalid-json": "文件不是合法 JSON",
    "too-large": "备份文件超过 5 MiB 上限",
    "invalid-format": "不是 Bili Daily 备份文件",
    "unsupported-version": "备份版本不受支持",
    "invalid-data": "备份 data 字段不是普通对象",
    "empty-data": "备份中没有可恢复的数据",
    "unknown-key": "备份包含未知存储键",
    "dangerous-key": "备份包含不安全的字段名",
    "missing-normalizer": "缺少对应数据的校验函数",
    "normalize-failed": "数据校验失败",
    "invalid-payload": "待写入内容不是普通对象",
    "storage-write-failed": "本地存储写入失败"
  });

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function reasonText(reason) {
    return REASONS[reason] || "未知错误";
  }

  function utf8Bytes(text) {
    if (typeof text !== "string") return 0;
    try {
      if (typeof TextEncoder === "function") {
        return new TextEncoder().encode(text).length;
      }
    } catch (error) {
      /* 回退到保守估算 */
    }
    return text.length * 3;
  }

  function cloneJson(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  /**
   * 深度检查危险字段名。只检查普通对象与数组，限制深度，避免恶意结构耗尽调用栈。
   */
  function hasDangerousKey(value, depth) {
    const level = typeof depth === "number" ? depth : 0;
    if (level > MAX_DEPTH) return true;
    if (Array.isArray(value)) {
      return value.some((item) => hasDangerousKey(item, level + 1));
    }
    if (!isPlainObject(value)) return false;
    const keys = Object.keys(value);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (DANGEROUS_KEYS.includes(key)) return true;
      if (hasDangerousKey(value[key], level + 1)) return true;
    }
    return false;
  }

  function isKnownStorageKey(key) {
    return KEY_LIST.includes(key);
  }

  function countRecords(value) {
    const root = isPlainObject(value) ? value : {};
    const days = isPlainObject(root.days) ? root.days : {};
    let records = 0;
    Object.keys(days).forEach((dateKey) => {
      const day = days[dateKey];
      if (isPlainObject(day)) records += Object.keys(day).length;
    });
    return { days: Object.keys(days).length, records };
  }

  function countImports(value) {
    const store = isPlainObject(value) ? value : {};
    const batches = Array.isArray(store.batches) ? store.batches : [];
    let candidates = 0;
    let videos = 0;
    batches.forEach((batch) => {
      if (!isPlainObject(batch)) return;
      const list = Array.isArray(batch.candidates) ? batch.candidates : [];
      candidates += list.length;
      list.forEach((candidate) => {
        if (isPlainObject(candidate) && Array.isArray(candidate.videos)) {
          videos += candidate.videos.length;
        }
      });
    });
    return { batches: batches.length, candidates, videos };
  }

  function countDiscovered(value) {
    const store = isPlainObject(value) ? value : {};
    const observations = Array.isArray(store.observations) ? store.observations : [];
    const uids = new Set();
    observations.forEach((item) => {
      if (isPlainObject(item) && typeof item.upUid === "string" && item.upUid) {
        uids.add(item.upUid);
      }
    });
    return { observations: observations.length, uniqueUps: uids.size };
  }

  function summarize(data) {
    const source = isPlainObject(data) ? data : {};
    const summary = {
      keys: [],
      records: { days: 0, records: 0 },
      imports: { batches: 0, candidates: 0, videos: 0 },
      discovered: { observations: 0, uniqueUps: 0 },
      settings: { enabled: false, present: false }
    };
    if (hasOwn(source, KEYS.records)) {
      summary.keys.push(KEYS.records);
      summary.records = countRecords(source[KEYS.records]);
    }
    if (hasOwn(source, KEYS.imports)) {
      summary.keys.push(KEYS.imports);
      summary.imports = countImports(source[KEYS.imports]);
    }
    if (hasOwn(source, KEYS.discovered)) {
      summary.keys.push(KEYS.discovered);
      summary.discovered = countDiscovered(source[KEYS.discovered]);
    }
    if (hasOwn(source, KEYS.settings)) {
      summary.keys.push(KEYS.settings);
      summary.settings.present = true;
      summary.settings.enabled = Boolean(
        isPlainObject(source[KEYS.settings]) && source[KEYS.settings].enabled === true
      );
    }
    return summary;
  }

  function buildBackup(storageValues, now) {
    if (!isPlainObject(storageValues)) {
      return { ok: false, reason: "invalid-source" };
    }
    const data = {};
    KEY_LIST.forEach((key) => {
      if (hasOwn(storageValues, key)) data[key] = cloneJson(storageValues[key]);
    });
    const keys = Object.keys(data);
    if (keys.length === 0) {
      return { ok: false, reason: "empty-source" };
    }
    const exportedAt = new Date(
      typeof now === "number" && Number.isFinite(now) ? now : Date.now()
    ).toISOString();
    return {
      ok: true,
      backup: {
        format: FORMAT,
        version: VERSION,
        app: APP,
        appVersion: APP_VERSION,
        exportedAt,
        data
      },
      summary: summarize(data)
    };
  }

  function serializeBackup(storageValues, now) {
    const built = buildBackup(storageValues, now);
    if (!built.ok) return built;
    let text;
    try {
      text = JSON.stringify(built.backup, null, 2);
    } catch (error) {
      return { ok: false, reason: "invalid-source" };
    }
    if (utf8Bytes(text) > MAX_BYTES) {
      return { ok: false, reason: "too-large" };
    }
    return {
      ok: true,
      text,
      backup: built.backup,
      summary: built.summary
    };
  }

  function parseBackupText(text) {
    if (typeof text !== "string" || !text.trim()) {
      return { ok: false, reason: "invalid-json" };
    }
    const cleanText = text.replace(/^﻿/, "");
    if (utf8Bytes(cleanText) > MAX_BYTES) {
      return { ok: false, reason: "too-large" };
    }
    let raw;
    try {
      raw = JSON.parse(cleanText);
    } catch (error) {
      return { ok: false, reason: "invalid-json" };
    }
    if (!isPlainObject(raw)) return { ok: false, reason: "invalid-format" };
    if (raw.format !== FORMAT) return { ok: false, reason: "invalid-format" };
    if (raw.version !== VERSION) return { ok: false, reason: "unsupported-version" };
    if (!isPlainObject(raw.data)) return { ok: false, reason: "invalid-data" };
    if (hasDangerousKey(raw)) return { ok: false, reason: "dangerous-key" };

    const keys = Object.keys(raw.data);
    if (keys.length === 0) return { ok: false, reason: "empty-data" };
    const unknown = keys.filter((key) => !isKnownStorageKey(key));
    if (unknown.length > 0) {
      return { ok: false, reason: "unknown-key", unknownKeys: unknown };
    }
    const data = {};
    keys.forEach((key) => {
      data[key] = raw.data[key];
    });
    return {
      ok: true,
      data,
      meta: {
        format: raw.format,
        version: raw.version,
        app: typeof raw.app === "string" ? raw.app : "",
        appVersion: typeof raw.appVersion === "string" ? raw.appVersion : "",
        exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : ""
      },
      summary: summarize(data)
    };
  }

  /**
   * 解析并清洗备份。normalizers 形如：
   * { biliDailyRecords: (value) => ({ value, warnings }), ... }
   * 返回待写入的 payload；不执行写入。
   */
  function prepareImport(text, normalizers) {
    const parsed = parseBackupText(text);
    if (!parsed.ok) return parsed;
    const map = isPlainObject(normalizers) ? normalizers : {};
    const payload = {};
    const warnings = [];
    const keys = Object.keys(parsed.data);

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const normalize = map[key];
      if (typeof normalize !== "function") {
        return { ok: false, reason: "missing-normalizer", key };
      }
      let result;
      try {
        result = normalize(parsed.data[key]);
      } catch (error) {
        return { ok: false, reason: "normalize-failed", key };
      }
      let value;
      if (isPlainObject(result) && hasOwn(result, "value")) {
        value = result.value;
        if (Array.isArray(result.warnings)) warnings.push.apply(warnings, result.warnings);
      } else {
        value = result;
      }
      if (value === undefined || value === null) {
        return { ok: false, reason: "normalize-failed", key };
      }
      if (hasDangerousKey(value)) {
        return { ok: false, reason: "dangerous-key", key };
      }
      payload[key] = value;
    }

    return {
      ok: true,
      payload,
      summary: summarize(payload),
      warnings,
      meta: parsed.meta
    };
  }

  function validatePayload(payload) {
    if (!isPlainObject(payload)) return { ok: false, reason: "invalid-payload" };
    const keys = Object.keys(payload);
    if (keys.length === 0) return { ok: false, reason: "invalid-payload" };
    const unknown = keys.filter((key) => !isKnownStorageKey(key));
    if (unknown.length > 0) {
      return { ok: false, reason: "unknown-key", unknownKeys: unknown };
    }
    if (hasDangerousKey(payload)) return { ok: false, reason: "dangerous-key" };
    try {
      if (utf8Bytes(JSON.stringify(payload)) > MAX_BYTES) {
        return { ok: false, reason: "too-large" };
      }
    } catch (error) {
      return { ok: false, reason: "invalid-payload" };
    }
    return { ok: true };
  }

  function writePayload(payload, area) {
    return new Promise((resolve) => {
      const checked = validatePayload(payload);
      if (!checked.ok) {
        resolve(checked);
        return;
      }
      if (!area || typeof area.set !== "function") {
        resolve({ ok: false, reason: "storage-write-failed" });
        return;
      }
      try {
        area.set(payload, () => {
          let error = null;
          try {
            error =
              typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError
                ? chrome.runtime.lastError
                : null;
          } catch (ignored) {
            error = null;
          }
          resolve(error ? { ok: false, reason: "storage-write-failed" } : { ok: true });
        });
      } catch (error) {
        resolve({ ok: false, reason: "storage-write-failed" });
      }
    });
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function filename(now) {
    const date = new Date(
      typeof now === "number" && Number.isFinite(now) ? now : Date.now()
    );
    const stamp =
      `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
      `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    return `bili-daily-backup-${stamp}.json`;
  }

  function formatSummary(summary) {
    const data = isPlainObject(summary) ? summary : summarize({});
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const pieces = [];
    if (data.records.days > 0 || keys.includes(KEYS.records)) {
      pieces.push(`观看 ${data.records.days} 天 / ${data.records.records} 条`);
    }
    if (keys.includes(KEYS.imports)) {
      pieces.push(`导入 ${data.imports.batches} 批 / ${data.imports.candidates} 个候选`);
    }
    if (keys.includes(KEYS.discovered)) {
      pieces.push(`观察 ${data.discovered.observations} 条 / ${data.discovered.uniqueUps} 个 UP`);
    }
    if (data.settings.present) {
      pieces.push(`自动发现${data.settings.enabled ? "已开启" : "已关闭"}`);
    }
    return pieces.length > 0 ? pieces.join(" · ") : "没有可识别的数据";
  }

  const api = Object.freeze({
    FORMAT,
    VERSION,
    APP,
    APP_VERSION,
    MAX_BYTES,
    KEYS,
    KEY_LIST,
    reasonText,
    isKnownStorageKey,
    buildBackup,
    serializeBackup,
    parseBackupText,
    prepareImport,
    validatePayload,
    writePayload,
    summarize,
    formatSummary,
    filename,
    _internal: Object.freeze({
      utf8Bytes,
      hasDangerousKey,
      cloneJson,
      countRecords,
      countImports,
      countDiscovered
    })
  });

  global.BiliDailyDataBackup = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
