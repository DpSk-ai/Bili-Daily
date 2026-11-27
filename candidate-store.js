"use strict";

/**
 * Bili Daily —— 候选内容持久化（MVP 工作包 B）
 *
 * 独立于观看记录（biliDailyRecords）的本地存储层，使用独立键
 * biliDailyCandidateImports，只保存用户主动确认导入的候选内容。
 *
 * 数据来源约定：
 *   - 只接受 candidate-content-import.js 校验通过的文档；
 *   - provenance 必须是 user-provided，userConfirmed 必须为 true；
 *   - 不写入观看记录，不修改 biliDailyRecords；
 *   - 不保存 Cookie、token、账号凭据或任何网络请求结果。
 *
 * 存储结构：
 * {
 *   version: 1,
 *   kind: "bili-daily-candidate-store",
 *   updatedAt: "ISO",
 *   batches: [
 *     {
 *       id, importedAt, sourceName, provenance: "user-provided",
 *       candidates: [{ upUid, upName, observedAt, videos: [{ bvid, title, partition, tags, url }] }]
 *     }
 *   ]
 * }
 *
 * 所有候选对象都按白名单逐字段重建，绝不把未校验对象直接写入存储，
 * 避免 JSON 中的 __proto__ / constructor 等键造成原型污染。
 */

(function (global) {
  const Import = global.BiliDailyCandidateContentImport;

  if (!Import || typeof Import.parseCandidateContentImport !== "function") {
    throw new Error("Bili Daily candidate-store.js 需要先加载 candidate-content-import.js");
  }

  const STORE_KEY = "biliDailyCandidateImports";
  const STORE_VERSION = 1;
  const STORE_KIND = "bili-daily-candidate-store";
  const SOURCE_USER = "user-provided";

  /** 存储层安全上限：防止单次导入或长期累积撑爆 chrome.storage.local。 */
  const LIMITS = Object.freeze({
    maxStoreBytes: 2 * 1024 * 1024,
    maxBatches: 50,
    maxCandidates: 500,
    maxSourceNameLength: 120,
    maxBatchIdLength: 80
  });

  const REASON_TEXT = Object.freeze({
    "empty-input": "文件内容为空",
    "invalid-json": "文件不是合法 JSON",
    "input-too-large": "文件超过 1 MiB 上限",
    "invalid-document": "顶层结构不是对象",
    "unsupported-schema": "schemaVersion 不受支持（当前要求 1）",
    "invalid-kind": "kind 必须是 bili-daily-candidate-content-import",
    "unsupported-provenance": "provenance 必须是 user-provided",
    "confirmation-required": "userConfirmed 必须为 true",
    "no-candidates": "文件里没有候选",
    "no-valid-candidates": "没有任何通过校验的候选",
    "storage-read-failed": "读取本地候选存储失败，旧数据保持不变",
    "storage-write-failed": "写入本地候选存储失败，旧数据保持不变",
    "store-too-large": "候选数据累计超过 2 MiB 上限，请先删除不需要的批次",
    "too-many-batches": "导入批次已达 50 个上限，请先删除旧批次",
    "too-many-candidates": "候选总数已达 500 个上限，请先删除不需要的候选",
    "candidate-not-found": "要删除的候选不存在",
    "batch-not-found": "要删除的批次不存在",
    "invalid-store": "本地候选存储结构损坏"
  });

  /* ---------------------------------------------------------------- 基础工具 */

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function utf8ByteLength(text) {
    if (typeof TextEncoder === "function") {
      return new TextEncoder().encode(text).length;
    }
    let bytes = 0;
    const source = String(text);
    for (let index = 0; index < source.length; index += 1) {
      const code = source.charCodeAt(index);
      if (code <= 0x7f) bytes += 1;
      else if (code <= 0x7ff) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    }
    return bytes;
  }

  /** 去控制字符并截断，用于来源文件名等展示字段。 */
  function sanitizeLabel(value, maxLength) {
    if (typeof value !== "string") return "";
    const cleaned = value
      .replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁯﻿]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length <= maxLength) return cleaned;
    return cleaned.slice(0, maxLength);
  }

  function toIso(ms) {
    const value = typeof ms === "number" && Number.isFinite(ms) ? ms : Date.now();
    return new Date(value).toISOString();
  }

  function randomSuffix() {
    try {
      if (global.crypto && typeof global.crypto.randomUUID === "function") {
        return global.crypto.randomUUID().replace(/-/g, "").slice(0, 8);
      }
    } catch (error) {
      /* 忽略：回退到时间戳 + 随机数 */
    }
    return Math.random().toString(36).slice(2, 10);
  }

  function makeBatchId(now) {
    const stamp = (typeof now === "number" && Number.isFinite(now) ? now : Date.now()).toString(36);
    return `batch-${stamp}-${randomSuffix()}`;
  }

  function reasonText(code) {
    return REASON_TEXT[code] || `导入失败（${code || "unknown"}）`;
  }

  /* -------------------------------------------------------------- 白名单复制 */

  function pickVideo(video) {
    if (!isPlainObject(video)) return null;
    if (typeof video.bvid !== "string") return null;
    const picked = {
      bvid: video.bvid,
      title: typeof video.title === "string" ? video.title : "",
      partition: typeof video.partition === "string" ? video.partition : ""
    };
    if (Array.isArray(video.tags)) {
      picked.tags = video.tags.filter((tag) => typeof tag === "string");
    }
    if (typeof video.url === "string" && video.url) picked.url = video.url;
    return picked;
  }

  function pickCandidate(candidate) {
    if (!isPlainObject(candidate)) return null;
    if (typeof candidate.upUid !== "string") return null;
    const picked = {
      upUid: candidate.upUid,
      upName: typeof candidate.upName === "string" ? candidate.upName : "",
      videos: []
    };
    if (typeof candidate.observedAt === "number" && Number.isFinite(candidate.observedAt)) {
      picked.observedAt = candidate.observedAt;
    }
    if (Array.isArray(candidate.videos)) {
      candidate.videos.forEach((video) => {
        const item = pickVideo(video);
        if (item) picked.videos.push(item);
      });
    }
    return picked;
  }

  /**
   * 把一份已验证的导入文档转换成可持久化的候选数组。
   * 逐字段白名单复制，丢弃 __proto__ / constructor 等未知键。
   */
  function pickCandidates(document) {
    const candidates = [];
    if (!isPlainObject(document) || !Array.isArray(document.candidates)) return candidates;
    document.candidates.forEach((candidate) => {
      const picked = pickCandidate(candidate);
      if (picked) candidates.push(picked);
    });
    return candidates;
  }

  /** 重新走一遍 C2-4B 校验，确保持久化数据仍符合 schema。 */
  function validateCandidates(candidates) {
    const parsed = Import.parseCandidateContentImport({
      schemaVersion: Import.SCHEMA_VERSION,
      kind: Import.IMPORT_KIND,
      provenance: SOURCE_USER,
      userConfirmed: true,
      candidates
    });
    if (parsed.status !== "ok") return parsed;
    return parsed;
  }

  /* ---------------------------------------------------------------- 结构规范 */

  function emptyStore() {
    return { version: STORE_VERSION, kind: STORE_KIND, updatedAt: null, batches: [] };
  }

  function normalizeBatch(raw) {
    if (!isPlainObject(raw)) return null;
    const candidates = pickCandidates({ candidates: raw.candidates });
    if (candidates.length === 0) return null;
    const parsed = validateCandidates(candidates);
    if (parsed.status !== "ok") return null;

    const id =
      typeof raw.id === "string" &&
      raw.id.length > 0 &&
      raw.id.length <= LIMITS.maxBatchIdLength &&
      /^[A-Za-z0-9-]+$/.test(raw.id)
        ? raw.id
        : makeBatchId(Date.parse(raw.importedAt));

    const importedAt =
      typeof raw.importedAt === "string" && !Number.isNaN(Date.parse(raw.importedAt))
        ? new Date(Date.parse(raw.importedAt)).toISOString()
        : new Date(0).toISOString();

    return {
      id,
      importedAt,
      sourceName: sanitizeLabel(raw.sourceName, LIMITS.maxSourceNameLength),
      provenance: SOURCE_USER,
      candidates: parsed.document.candidates.map((candidate) => ({
        upUid: candidate.upUid,
        upName: candidate.upName,
        observedAt: candidate.observedAt,
        videos: candidate.videos.map((video) => ({
          bvid: video.bvid,
          title: video.title,
          partition: video.partition,
          tags: video.tags,
          url: video.url
        }))
      }))
    };
  }

  /**
   * 规范化任意存储值。损坏的批次会被跳过并记录 warning，
   * 不会抛异常，也不会把损坏数据写回。
   */
  function normalizeStore(value) {
    const warnings = [];
    if (!isPlainObject(value) || value.kind !== STORE_KIND) {
      if (value !== undefined && value !== null) warnings.push("invalid-store");
      return { store: emptyStore(), warnings };
    }
    const store = emptyStore();
    const seenIds = new Set();
    const batches = Array.isArray(value.batches) ? value.batches : [];
    batches.forEach((raw, index) => {
      if (store.batches.length >= LIMITS.maxBatches) {
        warnings.push("too-many-batches");
        return;
      }
      const batch = normalizeBatch(raw);
      if (!batch) {
        warnings.push(`invalid-batch:${index}`);
        return;
      }
      if (seenIds.has(batch.id)) {
        warnings.push(`duplicate-batch-id:${index}`);
        return;
      }
      seenIds.add(batch.id);
      store.batches.push(batch);
    });

    if (typeof value.updatedAt === "string" && !Number.isNaN(Date.parse(value.updatedAt))) {
      store.updatedAt = new Date(Date.parse(value.updatedAt)).toISOString();
    }
    return { store, warnings };
  }

  function countCandidates(store) {
    return store.batches.reduce((total, batch) => total + batch.candidates.length, 0);
  }

  function countVideos(store) {
    return store.batches.reduce(
      (total, batch) =>
        total + batch.candidates.reduce((sum, candidate) => sum + candidate.videos.length, 0),
      0
    );
  }

  function summarizeStore(store) {
    const newest = store.batches.reduce((latest, batch) => {
      const time = Date.parse(batch.importedAt);
      return Number.isFinite(time) && time > latest ? time : latest;
    }, 0);
    return {
      batchCount: store.batches.length,
      candidateCount: countCandidates(store),
      videoCount: countVideos(store),
      newestImportAt: newest > 0 ? new Date(newest).toISOString() : null
    };
  }

  /* ---------------------------------------------------------------- 导入 */

  function previewImport(text, options) {
    if (typeof text !== "string") {
      return { ok: false, reason: "invalid-document", message: reasonText("invalid-document") };
    }
    const limits = Import.DEFAULT_LIMITS;
    if (text.length > limits.maxInputBytes || utf8ByteLength(text) > limits.maxInputBytes) {
      return { ok: false, reason: "input-too-large", message: reasonText("input-too-large") };
    }

    const parsed = Import.parseCandidateContentImport(text, options);
    if (parsed.status !== "ok") {
      const reason = parsed.reason || parsed.status;
      return {
        ok: false,
        reason,
        message: reasonText(reason),
        diagnostics: parsed.diagnostics
      };
    }

    const document = parsed.document;
    const videoCount = document.candidates.reduce(
      (total, candidate) => total + candidate.videos.length,
      0
    );
    return {
      ok: true,
      reason: "",
      document,
      summary: {
        candidateCount: document.candidates.length,
        videoCount,
        rejected: parsed.diagnostics ? parsed.diagnostics.candidatesInvalid : 0
      },
      diagnostics: parsed.diagnostics
    };
  }

  function ensureLimit(store) {
    if (store.batches.length > LIMITS.maxBatches) {
      return { ok: false, reason: "too-many-batches" };
    }
    if (countCandidates(store) > LIMITS.maxCandidates) {
      return { ok: false, reason: "too-many-candidates" };
    }
    if (utf8ByteLength(JSON.stringify(store)) > LIMITS.maxStoreBytes) {
      return { ok: false, reason: "store-too-large" };
    }
    return { ok: true };
  }

  /**
   * 把一份预览成功的文档追加为新的导入批次。
   * 失败时返回错误，调用方不得写入存储。
   */
  function addDocument(store, document, meta) {
    const source = isPlainObject(meta) ? meta : {};
    const candidates = pickCandidates(document);
    if (candidates.length === 0) {
      return { ok: false, reason: "no-valid-candidates", message: reasonText("no-valid-candidates") };
    }
    const parsed = validateCandidates(candidates);
    if (parsed.status !== "ok") {
      const reason = parsed.reason || "invalid-document";
      return { ok: false, reason, message: reasonText(reason) };
    }
    const now = typeof source.now === "number" && Number.isFinite(source.now) ? source.now : Date.now();
    const batch = {
      id: makeBatchId(now),
      importedAt: toIso(now),
      sourceName: sanitizeLabel(source.sourceName, LIMITS.maxSourceNameLength),
      provenance: SOURCE_USER,
      candidates: parsed.document.candidates.map((candidate) => ({
        upUid: candidate.upUid,
        upName: candidate.upName,
        observedAt: candidate.observedAt,
        videos: candidate.videos.map((video) => ({
          bvid: video.bvid,
          title: video.title,
          partition: video.partition,
          tags: video.tags,
          url: video.url
        }))
      }))
    };
    const next = {
      version: STORE_VERSION,
      kind: STORE_KIND,
      updatedAt: toIso(now),
      batches: store.batches.concat([batch])
    };
    const limit = ensureLimit(next);
    if (!limit.ok) return { ok: false, reason: limit.reason, message: reasonText(limit.reason) };
    return { ok: true, store: next, batchId: batch.id, addedCandidates: batch.candidates.length };
  }

  /* ---------------------------------------------------------------- 删除 */

  function removeCandidate(store, batchId, upUid) {
    if (!isPlainObject(store) || !Array.isArray(store.batches)) {
      return { ok: false, reason: "invalid-store", message: reasonText("invalid-store") };
    }
    let found = false;
    const batches = [];
    store.batches.forEach((batch) => {
      if (batch.id !== batchId) {
        batches.push(batch);
        return;
      }
      const remaining = batch.candidates.filter((candidate) => candidate.upUid !== upUid);
      if (remaining.length !== batch.candidates.length) found = true;
      if (remaining.length > 0) batches.push(Object.assign({}, batch, { candidates: remaining }));
    });
    if (!found) {
      return { ok: false, reason: "candidate-not-found", message: reasonText("candidate-not-found") };
    }
    return {
      ok: true,
      store: {
        version: STORE_VERSION,
        kind: STORE_KIND,
        updatedAt: toIso(Date.now()),
        batches
      }
    };
  }

  function removeBatch(store, batchId) {
    if (!isPlainObject(store) || !Array.isArray(store.batches)) {
      return { ok: false, reason: "invalid-store", message: reasonText("invalid-store") };
    }
    const batches = store.batches.filter((batch) => batch.id !== batchId);
    if (batches.length === store.batches.length) {
      return { ok: false, reason: "batch-not-found", message: reasonText("batch-not-found") };
    }
    return {
      ok: true,
      store: { version: STORE_VERSION, kind: STORE_KIND, updatedAt: toIso(Date.now()), batches }
    };
  }

  /* ------------------------------------------------------------ 转回导入文档 */

  function toImportDocument(store) {
    if (!isPlainObject(store) || !Array.isArray(store.batches)) return null;
    const candidates = [];
    store.batches.forEach((batch) => {
      batch.candidates.forEach((candidate) => {
        candidates.push({
          upUid: candidate.upUid,
          upName: candidate.upName,
          observedAt: candidate.observedAt,
          videos: candidate.videos.map((video) => ({
            bvid: video.bvid,
            title: video.title,
            partition: video.partition,
            tags: video.tags,
            url: video.url
          }))
        });
      });
    });
    if (candidates.length === 0) return null;
    return {
      schemaVersion: Import.SCHEMA_VERSION,
      kind: Import.IMPORT_KIND,
      provenance: SOURCE_USER,
      userConfirmed: true,
      candidates
    };
  }

  /**
   * 构建 C2-4B 的 sidecar（探索通道输入）。
   * 每次使用前重新校验，避免手工改坏存储后把脏数据送进推荐。
   */
  function buildSidecar(store, options) {
    const document = toImportDocument(store);
    if (!document) return null;
    const parsed = Import.parseCandidateContentImport(document);
    if (parsed.status !== "ok") return null;
    return Import.buildCandidateContentEvidence(parsed, options);
  }

  /* ------------------------------------------------------------ 浏览器存储 */

  function getArea() {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        return chrome.storage.local;
      }
    } catch (error) {
      /* 忽略：由调用方处理不可用 */
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

  function readStore() {
    return new Promise((resolve) => {
      const area = getArea();
      if (!area) {
        resolve({ ok: false, reason: "storage-read-failed", message: reasonText("storage-read-failed"), store: emptyStore(), warnings: [] });
        return;
      }
      try {
        area.get(STORE_KEY, (result) => {
          const error = lastRuntimeError();
          if (error) {
            resolve({
              ok: false,
              reason: "storage-read-failed",
              message: reasonText("storage-read-failed"),
              store: emptyStore(),
              warnings: []
            });
            return;
          }
          const raw = result ? result[STORE_KEY] : null;
          const normalized = normalizeStore(raw);
          resolve({ ok: true, store: normalized.store, warnings: normalized.warnings });
        });
      } catch (error) {
        resolve({
          ok: false,
          reason: "storage-read-failed",
          message: reasonText("storage-read-failed"),
          store: emptyStore(),
          warnings: []
        });
      }
    });
  }

  function writeStore(store) {
    return new Promise((resolve) => {
      const area = getArea();
      if (!area) {
        resolve({ ok: false, reason: "storage-write-failed", message: reasonText("storage-write-failed") });
        return;
      }
      const normalized = normalizeStore(store);
      if (normalized.warnings.length > 0) {
        resolve({ ok: false, reason: "invalid-store", message: reasonText("invalid-store") });
        return;
      }
      const limit = ensureLimit(normalized.store);
      if (!limit.ok) {
        resolve({ ok: false, reason: limit.reason, message: reasonText(limit.reason) });
        return;
      }
      try {
        area.set({ [STORE_KEY]: normalized.store }, () => {
          const error = lastRuntimeError();
          if (error) {
            resolve({ ok: false, reason: "storage-write-failed", message: reasonText("storage-write-failed") });
          } else {
            resolve({ ok: true, store: normalized.store });
          }
        });
      } catch (error) {
        resolve({ ok: false, reason: "storage-write-failed", message: reasonText("storage-write-failed") });
      }
    });
  }

  /**
   * 读取 → 校验 → 合并 → 写入。
   * 任何一步失败都不会写入；写入只发生一次，旧数据保持完整。
   */
  async function importText(text, meta) {
    const preview = previewImport(text);
    if (!preview.ok) return preview;

    const current = await readStore();
    if (!current.ok) return { ok: false, reason: current.reason, message: current.message };

    const merged = addDocument(current.store, preview.document, meta);
    if (!merged.ok) return { ok: false, reason: merged.reason, message: merged.message };

    const written = await writeStore(merged.store);
    if (!written.ok) return { ok: false, reason: written.reason, message: written.message };

    return {
      ok: true,
      store: written.store,
      batchId: merged.batchId,
      addedCandidates: merged.addedCandidates,
      summary: preview.summary
    };
  }

  async function importDocument(document, meta) {
    const preview = Import.parseCandidateContentImport(document);
    if (preview.status !== "ok") {
      const reason = preview.reason || preview.status;
      return { ok: false, reason, message: reasonText(reason) };
    }
    return importText(JSON.stringify(document), meta);
  }

  async function deleteCandidate(batchId, upUid) {
    const current = await readStore();
    if (!current.ok) return { ok: false, reason: current.reason, message: current.message };
    const next = removeCandidate(current.store, batchId, upUid);
    if (!next.ok) return next;
    const written = await writeStore(next.store);
    if (!written.ok) return { ok: false, reason: written.reason, message: written.message };
    return { ok: true, store: written.store };
  }

  async function deleteBatch(batchId) {
    const current = await readStore();
    if (!current.ok) return { ok: false, reason: current.reason, message: current.message };
    const next = removeBatch(current.store, batchId);
    if (!next.ok) return next;
    const written = await writeStore(next.store);
    if (!written.ok) return { ok: false, reason: written.reason, message: written.message };
    return { ok: true, store: written.store };
  }

  async function clearStore() {
    return writeStore(emptyStore());
  }

  global.BiliDailyCandidateStore = Object.freeze({
    STORE_KEY,
    STORE_VERSION,
    STORE_KIND,
    SOURCE_USER,
    LIMITS,
    emptyStore,
    normalizeStore,
    summarizeStore,
    previewImport,
    addDocument,
    removeCandidate,
    removeBatch,
    toImportDocument,
    buildSidecar,
    readStore,
    writeStore,
    importText,
    importDocument,
    deleteCandidate,
    deleteBatch,
    clearStore,
    reasonText
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
