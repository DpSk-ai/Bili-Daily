"use strict";

/**
 * Bili Daily —— 页面观察候选存储与内容证据适配（page-observed）
 *
 * 数据来源只限于：用户在正常浏览 B 站视频页时，页面上已经渲染出来的
 * 「相关推荐」视频卡片。内容脚本 candidate-discovery.js 负责读 DOM，
 * 本文件负责校验、去重、持久化，以及把观察结果适配成探索通道可用的证据。
 *
 * 独立存储键：
 *   biliDailyDiscoveredCandidates  —— 观察到的候选内容证据
 *   biliDailyDiscoverySettings    —— 自动发现开关与容量配置
 *
 * 明确边界：
 * - 不读写 biliDailyRecords；
 * - 不读写 biliDailyCandidateImports；
 * - provenance 固定为 "page-observed"，绝不复用 "user-provided"；
 * - onlineVerified 恒为 false；
 * - 不保存页面 HTML、脚本、Cookie、token 或账号凭据；
 * - 所有文本只按纯文本保存，渲染端使用 textContent。
 */

(function (global) {
  const STORE_KEY = "biliDailyDiscoveredCandidates";
  const SETTINGS_KEY = "biliDailyDiscoverySettings";
  const STORE_VERSION = 1;
  const SETTINGS_VERSION = 1;
  const STORE_KIND = "bili-daily-discovered-candidates";
  const ASSESSMENT_KIND = "bili-daily-discovered-content-assessment";
  const PROVENANCE = "page-observed";
  const SCOPE = "related-recommendation-card";

  const BVID_PATTERN = /^[Bb][Vv][0-9A-Za-z]{10}$/;
  const UID_PATTERN = /^[1-9]\d{0,15}$/;

  const LIMITS = Object.freeze({
    maxCandidates: 500,
    maxTitleLength: 200,
    maxUpNameLength: 120,
    maxPartitionLength: 30,
    maxSourcePageBvidLength: 12,
    maxConflictUids: 20,
    maxBytes: 1500000,
    minRetentionDays: 1,
    maxRetentionDays: 3650
  });

  const DEFAULT_SETTINGS = Object.freeze({
    version: SETTINGS_VERSION,
    enabled: false,
    maxCandidates: 300,
    retentionDays: 180,
    maxObservationsPerPage: 100,
    minImportedVideos: 3,
    minTitleCoverage: 0.6,
    minPartitionCoverage: 0.6,
    allowPartitionDegradation: true
  });

  const THRESHOLDS = Object.freeze({
    minImportedVideos: 3,
    minTitleCoverage: 0.6,
    minPartitionCoverage: 0.6,
    maxAgeDays: 180,
    experimental: true
  });

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function logError(error) {
    try {
      console.error("[Bili Daily] 自动发现候选存储失败", error);
    } catch (ignored) {
      /* 忽略日志失败 */
    }
  }

  function normalizeUid(value) {
    const Storage = global.BiliDailyStorage;
    if (Storage && typeof Storage.normalizeUpUid === "function") {
      return Storage.normalizeUpUid(value);
    }
    let text = "";
    if (typeof value === "string") text = value.trim();
    else if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      text = String(value);
    } else {
      return null;
    }
    if (!UID_PATTERN.test(text)) return null;
    const number = Number(text);
    return Number.isSafeInteger(number) && number > 0 ? String(number) : null;
  }

  function normalizeBvid(value) {
    if (typeof value !== "string") return null;
    const text = value.trim();
    return BVID_PATTERN.test(text) ? `BV${text.slice(2)}` : null;
  }

  function cleanText(value, maxLength) {
    if (typeof value !== "string") return "";
    const cleaned = value
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return "";
    const chars = Array.from(cleaned);
    return chars.length > maxLength ? chars.slice(0, maxLength).join("") : cleaned;
  }

  function normalizePartition(value) {
    const text = cleanText(value, LIMITS.maxPartitionLength);
    if (!text || text === "未知") return "";
    return text;
  }

  function toIso(ms) {
    return new Date(ms).toISOString();
  }

  function parseTime(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  function resolveNow(options) {
    if (isPlainObject(options)) {
      if (options.now instanceof Date && Number.isFinite(options.now.getTime())) {
        return options.now.getTime();
      }
      if (typeof options.now === "number" && Number.isFinite(options.now)) return options.now;
      if (typeof options.now === "string") {
        const parsed = Date.parse(options.now);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return Date.now();
  }

  function settingsNumber(value, fallback, min, max) {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    const rounded = Math.round(value);
    if (rounded < min) return min;
    if (rounded > max) return max;
    return rounded;
  }

  function settingsRatio(value, fallback) {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  }

  function normalizeSettings(raw) {
    const source = isPlainObject(raw) ? raw : {};
    return {
      version: SETTINGS_VERSION,
      enabled: source.enabled === true,
      maxCandidates: settingsNumber(
        source.maxCandidates,
        DEFAULT_SETTINGS.maxCandidates,
        1,
        LIMITS.maxCandidates
      ),
      retentionDays: settingsNumber(
        source.retentionDays,
        DEFAULT_SETTINGS.retentionDays,
        LIMITS.minRetentionDays,
        LIMITS.maxRetentionDays
      ),
      maxObservationsPerPage: settingsNumber(
        source.maxObservationsPerPage,
        DEFAULT_SETTINGS.maxObservationsPerPage,
        1,
        200
      ),
      minImportedVideos: settingsNumber(
        source.minImportedVideos,
        DEFAULT_SETTINGS.minImportedVideos,
        1,
        50
      ),
      minTitleCoverage: settingsRatio(
        source.minTitleCoverage,
        DEFAULT_SETTINGS.minTitleCoverage
      ),
      minPartitionCoverage: settingsRatio(
        source.minPartitionCoverage,
        DEFAULT_SETTINGS.minPartitionCoverage
      ),
      allowPartitionDegradation: source.allowPartitionDegradation !== false
    };
  }

  function emptyStore() {
    return {
      version: STORE_VERSION,
      kind: STORE_KIND,
      updatedAt: toIso(Date.now()),
      observations: []
    };
  }

  /** 页面观察到的一张卡片 → 白名单内容证据；缺字段保留 missing 状态，不猜测。 */
  function normalizeObservation(raw, options) {
    if (!isPlainObject(raw)) return null;
    const bvid = normalizeBvid(raw.bvid);
    const upUid = normalizeUid(raw.upUid);
    const sourcePageBvid = normalizeBvid(raw.sourcePageBvid);
    if (!bvid || !upUid || !sourcePageBvid) return null;
    if (raw.provenance !== PROVENANCE) return null;
    if (raw.observationScope !== SCOPE) return null;
    const observedAt = parseTime(raw.observedAt);
    if (observedAt === null) return null;
    const firstObservedAt = parseTime(raw.firstObservedAt);
    const title = cleanText(raw.title, LIMITS.maxTitleLength);
    const upName = cleanText(raw.upName, LIMITS.maxUpNameLength);
    const partition = normalizePartition(raw.partition);
    const metadataConflictFields = Array.isArray(raw.metadataConflictFields)
      ? raw.metadataConflictFields.filter(
          (field) => field === "title" || field === "partition"
        )
      : [];
    return {
      upUid,
      upName,
      bvid,
      title,
      partition,
      observedAt: toIso(observedAt),
      firstObservedAt: toIso(firstObservedAt === null ? observedAt : firstObservedAt),
      sourcePageBvid,
      provenance: PROVENANCE,
      observationScope: SCOPE,
      evidenceStatus: "valid",
      fieldStates: {
        upName: upName ? "present" : "missing",
        title: title ? "present" : "missing",
        partition: partition ? "present" : "missing"
      },
      metadataConflictFields: Array.from(new Set(metadataConflictFields)),
      conflictUids: []
    };
  }

  function sortConflictUids(values) {
    return Array.from(new Set(values)).sort().slice(0, LIMITS.maxConflictUids);
  }

  function markBvidConflict(entries, bvid, conflictUids) {
    const uids = sortConflictUids(conflictUids);
    entries.forEach((entry) => {
      if (entry.bvid !== bvid) return;
      entry.evidenceStatus = "uid-conflict";
      entry.conflictUids = uids.slice();
    });
  }

  function mergeObservation(entries, incoming) {
    const sameBvid = entries.filter((entry) => entry.bvid === incoming.bvid);
    if (sameBvid.length > 0 && sameBvid.some((entry) => entry.upUid !== incoming.upUid)) {
      const conflictUids = sameBvid.map((entry) => entry.upUid).concat(incoming.upUid);
      markBvidConflict(entries, incoming.bvid, conflictUids);
      if (!sameBvid.some((entry) => entry.upUid === incoming.upUid)) {
        entries.push(
          Object.assign({}, incoming, {
            evidenceStatus: "uid-conflict",
            conflictUids: sortConflictUids(conflictUids)
          })
        );
        return { added: 1, updated: 0, conflict: 1 };
      }
      return { added: 0, updated: 1, conflict: 1 };
    }

    const current = sameBvid.find((entry) => entry.upUid === incoming.upUid);
    if (!current) {
      entries.push(incoming);
      return { added: 1, updated: 0, conflict: 0 };
    }

    if (incoming.title) {
      if (current.title && current.title !== incoming.title) {
        if (!current.metadataConflictFields.includes("title")) {
          current.metadataConflictFields.push("title");
        }
      } else if (!current.title) {
        current.title = incoming.title;
      }
    }
    if (incoming.partition) {
      if (current.partition && current.partition !== incoming.partition) {
        if (!current.metadataConflictFields.includes("partition")) {
          current.metadataConflictFields.push("partition");
        }
      } else if (!current.partition) {
        current.partition = incoming.partition;
      }
    }
    if (!current.upName && incoming.upName) current.upName = incoming.upName;
    current.fieldStates = {
      upName: current.upName ? "present" : "missing",
      title: current.title ? "present" : "missing",
      partition: current.partition ? "present" : "missing"
    };

    const currentTime = parseTime(current.observedAt);
    const incomingTime = parseTime(incoming.observedAt);
    if (incomingTime !== null && (currentTime === null || incomingTime >= currentTime)) {
      current.observedAt = incoming.observedAt;
      current.sourcePageBvid = incoming.sourcePageBvid;
    }
    const firstTime = parseTime(current.firstObservedAt);
    if (incomingTime !== null && (firstTime === null || incomingTime < firstTime)) {
      current.firstObservedAt = incoming.observedAt;
    }
    // 已经因跨 UID 冲突被冻结的条目，不因为新观察恢复为 valid。
    if (current.evidenceStatus !== "uid-conflict") current.evidenceStatus = "valid";
    return { added: 0, updated: 1, conflict: 0 };
  }

  function normalizeStore(raw, options) {
    const warnings = [];
    if (!isPlainObject(raw) || raw.kind !== STORE_KIND) {
      if (raw != null) warnings.push("invalid-store");
      return { store: emptyStore(), warnings };
    }
    const entries = [];
    const seen = new Set();
    (Array.isArray(raw.observations) ? raw.observations : []).forEach((item) => {
      const normalized = normalizeObservation(item, options);
      if (!normalized) {
        warnings.push("invalid-observation");
        return;
      }
      const key = `${normalized.upUid}|${normalized.bvid}`;
      if (seen.has(key)) {
        // 同一 UID + BV 的重复条目合并字段，不重复计数。
        mergeObservation(entries, normalized);
        return;
      }
      seen.add(key);
      entries.push(normalized);
    });

    // 重新计算跨 UID 冲突，防止手工改坏存储后绕过冲突标记。
    const uidsByBvid = new Map();
    entries.forEach((entry) => {
      if (!uidsByBvid.has(entry.bvid)) uidsByBvid.set(entry.bvid, new Set());
      uidsByBvid.get(entry.bvid).add(entry.upUid);
    });
    uidsByBvid.forEach((uids, bvid) => {
      if (uids.size > 1) markBvidConflict(entries, bvid, Array.from(uids));
    });

    return {
      store: {
        version: STORE_VERSION,
        kind: STORE_KIND,
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : toIso(Date.now()),
        observations: entries.sort(compareObservations)
      },
      warnings
    };
  }

  function compareObservations(left, right) {
    const leftTime = parseTime(left.observedAt) || 0;
    const rightTime = parseTime(right.observedAt) || 0;
    return (
      leftTime - rightTime ||
      (left.upUid < right.upUid ? -1 : left.upUid > right.upUid ? 1 : 0) ||
      (left.bvid < right.bvid ? -1 : left.bvid > right.bvid ? 1 : 0)
    );
  }

  function pruneObservations(entries, now, retentionDays) {
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
    const kept = [];
    let dropped = 0;
    entries.forEach((entry) => {
      const time = parseTime(entry.observedAt);
      if (time === null || time < cutoff) {
        dropped += 1;
        return;
      }
      kept.push(entry);
    });
    return { entries: kept, dropped };
  }

  function enforceCapacity(entries, maxCandidates) {
    const sorted = entries.slice().sort(compareObservations);
    const dropped = Math.max(0, sorted.length - maxCandidates);
    return {
      entries: dropped > 0 ? sorted.slice(dropped) : sorted,
      dropped
    };
  }

  function utf8Length(text) {
    try {
      if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
    } catch (error) {
      /* 回退到字符长度 */
    }
    return text.length;
  }

  function enforceByteLimit(store) {
    let serialized = JSON.stringify(store);
    let dropped = 0;
    while (utf8Length(serialized) > LIMITS.maxBytes && store.observations.length > 0) {
      store.observations.shift();
      dropped += 1;
      serialized = JSON.stringify(store);
    }
    return { dropped };
  }

  function buildStore(entries, updatedAt) {
    return {
      version: STORE_VERSION,
      kind: STORE_KIND,
      updatedAt: updatedAt || toIso(Date.now()),
      observations: entries.sort(compareObservations)
    };
  }

  /* ---------------------------------------------------------------- 存储封装 */

  function getArea() {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        return chrome.storage.local;
      }
    } catch (error) {
      /* 由调用方处理 */
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

  function readKey(key) {
    return new Promise((resolve) => {
      const area = getArea();
      if (!area) {
        resolve({ ok: false, reason: "storage-read-failed", value: null });
        return;
      }
      try {
        area.get(key, (result) => {
          const error = lastRuntimeError();
          if (error) {
            resolve({ ok: false, reason: "storage-read-failed", value: null });
            return;
          }
          resolve({ ok: true, value: result ? result[key] : null });
        });
      } catch (error) {
        resolve({ ok: false, reason: "storage-read-failed", value: null });
      }
    });
  }

  function writeKey(key, value) {
    return new Promise((resolve) => {
      const area = getArea();
      if (!area) {
        resolve({ ok: false, reason: "storage-write-failed" });
        return;
      }
      try {
        area.set({ [key]: value }, () => {
          const error = lastRuntimeError();
          resolve(error ? { ok: false, reason: "storage-write-failed" } : { ok: true });
        });
      } catch (error) {
        resolve({ ok: false, reason: "storage-write-failed" });
      }
    });
  }

  async function readStore() {
    const result = await readKey(STORE_KEY);
    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason,
        store: emptyStore(),
        warnings: []
      };
    }
    const normalized = normalizeStore(result.value);
    return { ok: true, store: normalized.store, warnings: normalized.warnings };
  }

  async function writeStore(store) {
    const normalized = normalizeStore(store);
    const limit = enforceByteLimit(normalized.store);
    const result = await writeKey(STORE_KEY, normalized.store);
    return Object.assign({}, result, {
      store: normalized.store,
      droppedByBytes: limit.dropped,
      warnings: normalized.warnings
    });
  }

  async function readSettings() {
    const result = await readKey(SETTINGS_KEY);
    if (!result.ok) return { ok: false, reason: result.reason, settings: normalizeSettings(null) };
    return { ok: true, settings: normalizeSettings(result.value) };
  }

  async function saveSettings(patch) {
    const current = await readSettings();
    const merged = normalizeSettings(
      Object.assign({}, current.settings, isPlainObject(patch) ? patch : {})
    );
    const result = await writeKey(SETTINGS_KEY, merged);
    return Object.assign({}, result, { settings: merged });
  }

  /* ------------------------------------------------------------ 写入与整理 */

  async function addObservations(rawList, options) {
    const now = resolveNow(options);
    const list = Array.isArray(rawList) ? rawList.slice(0, 400) : [];
    const settingsResult = await readSettings();
    const settings = settingsResult.settings;
    if (!settingsResult.ok) {
      return {
        ok: false,
        reason: settingsResult.reason || "storage-read-failed",
        added: 0,
        updated: 0,
        unchanged: 0,
        rejected: 0,
        conflicts: 0,
        dropped: 0,
        total: 0
      };
    }
    if (settings.enabled !== true) {
      // 关闭后即使仍有排队观察，也不产生任何写入。
      return {
        ok: true,
        disabled: true,
        added: 0,
        updated: 0,
        unchanged: 0,
        rejected: 0,
        conflicts: 0,
        dropped: 0,
        total: 0
      };
    }
    const normalized = [];
    let rejected = 0;
    list.forEach((item) => {
      const observation = normalizeObservation(item, options);
      if (observation) normalized.push(observation);
      else rejected += 1;
    });
    if (normalized.length === 0) {
      return {
        ok: true,
        added: 0,
        updated: 0,
        unchanged: 0,
        rejected,
        conflicts: 0,
        dropped: 0,
        total: 0
      };
    }

    const read = await readStore();
    if (!read.ok) {
      return {
        ok: false,
        reason: read.reason,
        added: 0,
        updated: 0,
        unchanged: 0,
        rejected,
        conflicts: 0,
        dropped: 0,
        total: 0
      };
    }

    const entries = read.store.observations.slice();
    let added = 0;
    let updated = 0;
    let conflicts = 0;
    normalized.forEach((observation) => {
      const result = mergeObservation(entries, observation);
      added += result.added;
      updated += result.updated;
      conflicts += result.conflict;
    });
    const pruned = pruneObservations(entries, now, settings.retentionDays);
    const capped = enforceCapacity(pruned.entries, settings.maxCandidates);
    const store = buildStore(capped.entries, toIso(now));
    const written = await writeStore(store);
    if (!written.ok) {
      return {
        ok: false,
        reason: written.reason,
        added: 0,
        updated: 0,
        unchanged: 0,
        rejected,
        conflicts: 0,
        dropped: 0,
        total: 0
      };
    }
    return {
      ok: true,
      added,
      updated,
      unchanged: normalized.length - added - updated,
      rejected,
      conflicts,
      dropped: pruned.dropped + capped.dropped + written.droppedByBytes,
      total: written.store.observations.length
    };
  }

  async function rebuildStore(options) {
    const now = resolveNow(options);
    const settings = (await readSettings()).settings;
    const read = await readStore();
    if (!read.ok) return { ok: false, reason: read.reason, total: 0, dropped: 0 };
    const pruned = pruneObservations(read.store.observations, now, settings.retentionDays);
    const capped = enforceCapacity(pruned.entries, settings.maxCandidates);
    const store = buildStore(capped.entries, toIso(now));
    const written = await writeStore(store);
    return {
      ok: written.ok,
      reason: written.ok ? "" : written.reason,
      total: written.store.observations.length,
      dropped: pruned.dropped + capped.dropped + written.droppedByBytes
    };
  }

  async function clearStore() {
    const result = await writeKey(STORE_KEY, buildStore([], toIso(Date.now())));
    return { ok: result.ok, reason: result.ok ? "" : result.reason };
  }

  function summarizeStore(store) {
    const normalized = normalizeStore(store).store;
    const observations = normalized.observations;
    const uids = new Set();
    const bvids = new Set();
    const conflictBvids = new Set();
    let conflictObservations = 0;
    let oldest = null;
    let newest = null;
    observations.forEach((entry) => {
      uids.add(entry.upUid);
      bvids.add(entry.bvid);
      const time = parseTime(entry.observedAt);
      if (time !== null) {
        if (oldest === null || time < oldest) oldest = time;
        if (newest === null || time > newest) newest = time;
      }
      if (entry.evidenceStatus === "uid-conflict") {
        conflictObservations += 1;
        conflictBvids.add(entry.bvid);
      }
    });
    return {
      observationCount: observations.length,
      uniqueUpCount: uids.size,
      uniqueVideoCount: bvids.size,
      conflictObservationCount: conflictObservations,
      conflictVideoCount: conflictBvids.size,
      oldestObservedAt: oldest === null ? null : toIso(oldest),
      newestObservedAt: newest === null ? null : toIso(newest)
    };
  }

  /* ---------------------------------------------------- page-observed 证据适配 */

  function collectWatchedUids(records) {
    const uids = new Set();
    if (!isPlainObject(records) || !isPlainObject(records.days)) return uids;
    Object.keys(records.days).forEach((dayKey) => {
      const day = records.days[dayKey];
      if (!isPlainObject(day)) return;
      Object.keys(day).forEach((bvid) => {
        const record = day[bvid];
        if (!isPlainObject(record)) return;
        const uid = normalizeUid(record.upUid);
        if (uid) uids.add(uid);
      });
    });
    return uids;
  }

  function titleTokensOf(title) {
    const Features = global.BiliDailyCandidateFeatures;
    if (!title || !Features || typeof Features.extractTitleBigrams !== "function") return [];
    try {
      return Features.extractTitleBigrams(title);
    } catch (error) {
      return [];
    }
  }

  function buildTitleTokenCounts(videos) {
    const counts = new Map();
    videos.forEach((video) => {
      if (video.titleState !== "present") return;
      titleTokensOf(video.title).forEach((token) => {
        counts.set(token, (counts.get(token) || 0) + 1);
      });
    });
    return Array.from(counts.keys())
      .sort()
      .map((token) => ({ token, count: counts.get(token) }));
  }

  function buildPartitionCounts(videos) {
    const counts = new Map();
    videos.forEach((video) => {
      if (video.partitionState !== "present") return;
      counts.set(video.partition, (counts.get(video.partition) || 0) + 1);
    });
    return Array.from(counts.keys())
      .sort()
      .map((name) => ({
        name,
        count: counts.get(name),
        shareOfImportedVideos: counts.get(name) / videos.length
      }));
  }

  function buildDiscoveredEvidence(store, records, options) {
    const now = resolveNow(options);
    const settings = normalizeSettings(
      isPlainObject(options) && isPlainObject(options.settings)
        ? options.settings
        : DEFAULT_SETTINGS
    );
    const normalized = normalizeStore(store);
    const pruned = pruneObservations(normalized.store.observations, now, settings.retentionDays);
    const entries = pruned.entries;
    const watchedUids = collectWatchedUids(records);

    // bvid → 是否存在跨 UID 冲突；冲突视频不进入任何候选的内容特征。
    const uidsByBvid = new Map();
    entries.forEach((entry) => {
      if (!uidsByBvid.has(entry.bvid)) uidsByBvid.set(entry.bvid, new Set());
      uidsByBvid.get(entry.bvid).add(entry.upUid);
    });
    const conflictBvids = new Set();
    uidsByBvid.forEach((uids, bvid) => {
      if (uids.size > 1) conflictBvids.add(bvid);
    });
    const conflictingUids = new Set();
    entries.forEach((entry) => {
      if (entry.evidenceStatus === "uid-conflict" || conflictBvids.has(entry.bvid)) {
        conflictingUids.add(entry.upUid);
      }
    });

    const groups = new Map();
    entries.forEach((entry) => {
      if (watchedUids.has(entry.upUid)) return;
      if (!groups.has(entry.upUid)) groups.set(entry.upUid, []);
      groups.get(entry.upUid).push(entry);
    });

    const candidates = [];
    const assessments = [];
    let watchedUpExcluded = 0;
    let staleVideoExcluded = pruned.dropped;
    let degradedPartitionCount = 0;

    watchedUids.forEach((uid) => {
      if (entries.some((entry) => entry.upUid === uid)) watchedUpExcluded += 1;
    });

    const cutoff = now - THRESHOLDS.maxAgeDays * 24 * 60 * 60 * 1000;
    Array.from(groups.keys())
      .sort()
      .forEach((upUid) => {
        const rawVideos = groups.get(upUid).slice().sort(compareObservations);
        const videos = rawVideos
          .filter((entry) => {
            if (entry.evidenceStatus === "uid-conflict" || conflictBvids.has(entry.bvid)) {
              return false;
            }
            const time = parseTime(entry.observedAt);
            return time !== null && time >= cutoff;
          })
          .map((entry) => {
            const metadataConflict =
              Array.isArray(entry.metadataConflictFields) &&
              entry.metadataConflictFields.length > 0;
            return {
              bvid: entry.bvid,
              title: metadataConflict ? "" : entry.title,
              partition: metadataConflict ? "" : entry.partition,
              tags: [],
              url: `https://www.bilibili.com/video/${entry.bvid}`,
              titleState: !metadataConflict && entry.title ? "present" : "missing",
              partitionState: !metadataConflict && entry.partition ? "present" : "missing",
              status: "usable",
              conflictFields: metadataConflict
                ? entry.metadataConflictFields.slice()
                : [],
              sourcePageBvid: entry.sourcePageBvid,
              observedAt: entry.observedAt
            };
          });
        staleVideoExcluded += rawVideos.length - videos.length;
        if (videos.length === 0) return;

        const titleVideoCount = videos.filter((video) => video.titleState === "present").length;
        const partitionVideoCount = videos.filter(
          (video) => video.partitionState === "present"
        ).length;
        const titleCoverage = titleVideoCount / videos.length;
        const partitionCoverage = partitionVideoCount / videos.length;
        const partitionCounts = buildPartitionCounts(videos);
        const titleTokens = buildTitleTokenCounts(videos);
        const usableVideoCount = videos.filter((video) => {
          if (video.titleState !== "present") return false;
          return titleTokensOf(video.title).length > 0;
        }).length;
        const metadataConflictVideoCount = videos.filter(
          (video) => video.conflictFields.length > 0
        ).length;

        const identityConflict =
          conflictingUids.has(upUid) ||
          rawVideos.some((entry) => entry.evidenceStatus === "uid-conflict");
        const enoughVideos = videos.length >= settings.minImportedVideos;
        const titleOk =
          titleCoverage >= settings.minTitleCoverage &&
          titleVideoCount >= settings.minImportedVideos;
        const partitionOk = partitionCoverage >= settings.minPartitionCoverage;
        const partitionDegraded =
          !partitionOk && settings.allowPartitionDegradation === true && titleOk;
        if (partitionDegraded) degradedPartitionCount += 1;

        const promotionReasons = [];
        const addReason = (code, level, message) => {
          promotionReasons.push({ code, level, message });
        };
        if (identityConflict) {
          addReason("uid-conflict", "error", "同一视频出现不同 UP UID，身份冲突，不进入推荐");
        }
        if (!enoughVideos) {
          addReason(
            "insufficient-videos",
            "warning",
            `页面观察到的不同视频只有 ${videos.length} 个，少于 ${settings.minImportedVideos} 个`
          );
        }
        if (!titleOk) {
          addReason(
            "title-coverage-low",
            "warning",
            `标题覆盖率 ${Math.round(titleCoverage * 1000) / 10}% 低于 ${Math.round(
              settings.minTitleCoverage * 1000
            ) / 10}%`
          );
        }
        if (partitionDegraded) {
          addReason(
            "partition-degraded",
            "info",
            "页面卡片没有提供足够的分区信息，本次仅按标题相似度做低可信探索，不伪造分区"
          );
        } else if (!partitionOk) {
          addReason(
            "partition-coverage-low",
            "warning",
            `分区覆盖率 ${Math.round(partitionCoverage * 1000) / 10}% 低于 ${Math.round(
              settings.minPartitionCoverage * 1000
            ) / 10}%`
          );
        }
        if (metadataConflictVideoCount > 0) {
          addReason(
            "metadata-conflict",
            "info",
            `${metadataConflictVideoCount} 个视频的标题或分区观察结果互相矛盾，已排除出内容特征`
          );
        }

        const blocking = promotionReasons.some((item) => item.level !== "info");
        const eligibleForExploration = !blocking;
        const contentStatus =
          titleOk && partitionOk && metadataConflictVideoCount === 0
            ? "complete"
            : titleOk
              ? "partial"
              : "missing";

        const selectedPartition = partitionCounts
          .slice()
          .sort(
            (left, right) =>
              right.count - left.count || (left.name < right.name ? -1 : 1)
          )[0];

        const observedAtMs = Math.max.apply(
          null,
          videos.map((video) => parseTime(video.observedAt) || 0)
        );
        const names = Array.from(
          new Set(rawVideos.map((entry) => entry.upName).filter(Boolean))
        ).sort();
        const sourcePages = Array.from(
          new Set(rawVideos.map((entry) => entry.sourcePageBvid).filter(Boolean))
        ).sort();

        const sidecarCandidate = {
          upUid,
          upName: names[0] || "",
          names,
          nameConflict: names.length > 1,
          provenance: PROVENANCE,
          lane: "exploration",
          observedAt: observedAtMs > 0 ? toIso(observedAtMs) : null,
          videos,
          partitionCounts,
          titleTokens,
          importedVideoCount: videos.length,
          observedVideoCount: videos.length,
          usableVideoCount,
          importedTitleCount: titleVideoCount,
          importedPartitionCount: partitionVideoCount,
          partitionCoverage,
          titleCoverage,
          contentStatus,
          conflictVideoCount: 0,
          metadataConflictVideoCount,
          hasUidConflict: identityConflict,
          sourcePages,
          degradation: partitionDegraded ? "partition-missing" : null,
          reasons: promotionReasons.slice()
        };

        const assessmentCandidate = {
          upUid,
          upName: sidecarCandidate.upName,
          provenance: PROVENANCE,
          lane: "exploration",
          observedAt: sidecarCandidate.observedAt,
          identityEvidence: {
            uid: upUid,
            uidFormatValid: true,
            provenance: PROVENANCE,
            userConfirmed: false,
            fromWatchHistory: false,
            fromUserInput: false,
            sources: [PROVENANCE],
            onlineVerified: false,
            observedVideoCount: videos.length,
            internalConflictVideoCount: identityConflict ? 1 : 0,
            hasIdentityConflict: identityConflict
          },
          contentEvidence: {
            importedVideoCount: videos.length,
            trustedVideoCount: usableVideoCount,
            partitionVideoCount,
            titleVideoCount,
            partitionCoverage,
            titleCoverage,
            contentStatus,
            metadataConflictVideoCount,
            sourcePages
          },
          promotion: {
            eligibleForExploration,
            status: identityConflict
              ? "pending-review"
              : eligibleForExploration
                ? "eligible"
                : "insufficient-data",
            reasons: promotionReasons,
            thresholds: Object.assign({}, THRESHOLDS, {
              minImportedVideos: settings.minImportedVideos,
              minTitleCoverage: settings.minTitleCoverage,
              minPartitionCoverage: settings.minPartitionCoverage,
              experimental: true
            }),
            partitionDegraded
          }
        };

        candidates.push(sidecarCandidate);
        assessments.push(assessmentCandidate);
      });

    const summary = {
      total: candidates.length,
      eligible: 0,
      insufficientData: 0,
      pendingReview: 0,
      observedVideoCount: candidates.reduce(
        (total, candidate) => total + candidate.importedVideoCount,
        0
      ),
      degradedPartitionCount,
      watchedUpExcluded,
      staleVideoExcluded,
      conflictVideoCount: conflictBvids.size
    };
    assessments.forEach((candidate) => {
      if (candidate.promotion.status === "eligible") summary.eligible += 1;
      else if (candidate.promotion.status === "pending-review") summary.pendingReview += 1;
      else summary.insufficientData += 1;
    });

    const status =
      entries.length === 0 ? "empty" : candidates.length === 0 ? "insufficient" : "ok";
    return {
      sidecar: {
        version: STORE_VERSION,
        kind: "bili-daily-discovered-content",
        provenance: PROVENANCE,
        lane: "exploration",
        status,
        reason: "",
        candidates,
        summary,
        thresholds: Object.assign({}, THRESHOLDS, { experimental: true }),
        note:
          "页面相关推荐观察结果，只代表本地看到了页面展示的信息；未在线核验，不代表平台认证。"
      },
      assessment: {
        version: STORE_VERSION,
        kind: ASSESSMENT_KIND,
        provenance: PROVENANCE,
        lane: "exploration",
        status: status === "empty" ? "empty" : "ok",
        reason: "",
        candidates: assessments,
        summary,
        diagnostics: {
          observedEntries: entries.length,
          conflictBvids: conflictBvids.size,
          watchedUpExcluded,
          staleVideoExcluded
        },
        note:
          "page-observed 候选只进入探索通道；onlineVerified 恒为 false；不修改观看记录或手动导入。"
      },
      summary
    };
  }

  global.BiliDailyDiscoveredCandidateStore = Object.freeze({
    STORE_KEY,
    SETTINGS_KEY,
    STORE_VERSION,
    STORE_KIND,
    ASSESSMENT_KIND,
    PROVENANCE,
    SCOPE,
    LIMITS,
    DEFAULT_SETTINGS,
    THRESHOLDS,
    emptyStore,
    normalizeSettings,
    normalizeObservation,
    normalizeStore,
    summarizeStore,
    readStore,
    writeStore,
    readSettings,
    saveSettings,
    addObservations,
    rebuildStore,
    clearStore,
    buildDiscoveredEvidence,
    collectWatchedUids
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
