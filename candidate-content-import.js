"use strict";

/**
 * Bili Daily —— 用户主动导入的新 UP 主内容证据引擎（阶段 C2-4B）
 *
 * 纯函数模块：不调用 chrome.*、DOM、fetch、Cookie、文件系统，不读写任何存储，
 * 不访问网络，不执行导入内容中的代码。只处理调用方传入的 JSON 字符串或普通对象。
 *
 * 依赖（只读取，不修改）：
 *   - stats.js                   UID 规范化、记录清洗、日期键校验
 *   - candidate-features.js      标题字符 bigram（与 C2-3 完全同一套文本规则）
 * 必须先加载 stats.js 和 candidate-features.js。
 *
 * ---------------------------------------------------------------------------
 * 来源语义（重要，不得误读）
 * ---------------------------------------------------------------------------
 * 本模块产出的一切候选证据都标记 provenance = "user-provided"：
 *   - 只表示“用户主动提供 / 导入”，不是平台观察，也不是官方授权；
 *   - onlineVerified 恒为 false，本模块没有任何在线核验能力；
 *   - 不能把导入内容写进 biliDailyRecords，也不能冒充 watched 来源。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要独立 sidecar
 * ---------------------------------------------------------------------------
 * 导入视频不是观看记录：
 *   - 没有真实 watchMs，因此不参与 C1 的 7 天 / 30 天窗口、分区时长占比；
 *   - 不改变 C2-1 的 watchedBefore / candidateType / 视频计数；
 *   - 不改变 C2-2 的 eligibility（导入-only 候选仍是 review）；
 *   - 不改变 C2-3 的 featureStatus（导入-only 候选仍是 missing）。
 * 本模块只在并列的内容证据通道中工作，供未来 C3 的 exploration lane 使用。
 *
 * ---------------------------------------------------------------------------
 * 三入口职责
 * ---------------------------------------------------------------------------
 *   parseCandidateContentImport(input, options)
 *     解析 JSON 字符串或对象，校验顶层结构、候选、视频字段。
 *     只做校验与清洗，不去重、不生成特征。
 *
 *   buildCandidateContentEvidence(importDoc, options)
 *     按 UID / BV 去重、检测导入内部冲突、生成独立内容证据与基础内容特征。
 *     兼容 parse 的返回值，也接受原始导入文档对象。
 *
 *   assessImportedContentCandidates(sidecar, records, options)
 *     与本地观看记录交叉检查同一 BV 的 UID 冲突，重新计算可信内容完整度，
 *     按 C2-4A 的两轴模型给出 exploration lane 准入结论。不修改 sidecar / records。
 *
 * ---------------------------------------------------------------------------
 * 明确不做
 * ---------------------------------------------------------------------------
 *   - 不联网、不调用 B 站 API、不解析 b23.tv 短链、不打开导入的 URL；
 *   - 不写 chrome.storage.local、不新增存储键、不新增 manifest 权限；
 *   - 不做 TF-IDF、余弦、MMR 或任何推荐排序；
 *   - 不生成正式导入 UI；
 *   - 不因数据不足删除候选，也不因内容完整把用户数据升级为“平台核验”。
 */

(function (global) {
  const Stats = global.BiliDailyStats;
  const Features = global.BiliDailyCandidateFeatures;

  if (
    !Stats ||
    typeof Stats.cleanRecord !== "function" ||
    typeof Stats.parseDateKey !== "function"
  ) {
    throw new Error("Bili Daily candidate-content-import.js 需要先加载 stats.js");
  }
  if (!Features || typeof Features.extractTitleBigrams !== "function") {
    throw new Error(
      "Bili Daily candidate-content-import.js 需要先加载 candidate-features.js"
    );
  }

  /* ---------------------------------------------------------------- 常量 */

  const SCHEMA_VERSION = 1;
  const IMPORT_KIND = "bili-daily-candidate-content-import";
  const EVIDENCE_KIND = "bili-daily-candidate-content";
  const ASSESSMENT_KIND = "bili-daily-candidate-content-assessment";
  const PROVENANCE_USER = "user-provided";
  const UNKNOWN_PARTITION = "未知";
  const LANE_EXPLORATION = "exploration";

  /** 导入侧安全上限。全部可被 options.limits / options.thresholds 覆盖。 */
  const DEFAULT_LIMITS = Object.freeze({
    maxInputBytes: 1024 * 1024, // 1 MiB，以 UTF-8 字节计
    maxCandidates: 500,
    maxVideosPerCandidate: 50,
    maxTotalVideos: 2000,
    maxTitleRawLength: 1000,
    maxPartitionLength: 64,
    maxTags: 20,
    maxTagLength: 50,
    maxUrlLength: 2048,
    maxNameLength: 100,
    maxNoteLength: 500,
    maxUniqueTokens: 4000,
    maxOutputTokens: 2000
  });

  /**
   * 探索通道实验阈值（C2-4A 设计值，不是经过真实数据校准的最优值）。
   * 仅表示“满足本地探索通道的技术准入条件”，不代表账号或内容被平台核验。
   */
  const DEFAULT_THRESHOLDS = Object.freeze({
    minImportedVideos: 3,
    minPartitionCoverage: 0.6,
    minTitleCoverage: 0.6,
    maxAgeDays: 180
  });

  const LIMIT_KEYS = Object.freeze(Object.keys(DEFAULT_LIMITS));
  const THRESHOLD_KEYS = Object.freeze(Object.keys(DEFAULT_THRESHOLDS));
  const DAY_MS = 24 * 60 * 60 * 1000;

  const TOP_LEVEL_KEYS = Object.freeze([
    "schemaVersion",
    "kind",
    "provenance",
    "userConfirmed",
    "exportedAt",
    "sourceNote",
    "candidates"
  ]);
  const CANDIDATE_KEYS = Object.freeze([
    "upUid",
    "upName",
    "observedAt",
    "videos"
  ]);
  const VIDEO_KEYS = Object.freeze([
    "bvid",
    "title",
    "partition",
    "tags",
    "url"
  ]);

  /** 控制字符、零宽字符与双向格式字符：替换为空格，避免跨字符拼接。 */
  const UNSAFE_CHARS = (function buildUnsafeChars() {
    // 用码点构造字符类，避免源码中出现不可见的控制 / 双向格式字符。
    const ranges = [
      [0x0000, 0x001f],
      [0x007f, 0x009f],
      [0x200b, 0x200f],
      [0x202a, 0x202e],
      [0x2060, 0x206f],
      [0xfeff, 0xfeff]
    ];
    const body = ranges
      .map(
        ([start, end]) =>
          String.fromCharCode(start) + "-" + String.fromCharCode(end)
      )
      .join("");
    return new RegExp("[" + body + "]", "g");
  })();
  const UNSAFE_CHARS_TEST = new RegExp(UNSAFE_CHARS.source);

  /** BV：前缀大小写不敏感，统一为 BV；其余 10 位保留原大小写（BV 号区分大小写）。 */
  const BVID_PATTERN = /^[Bb][Vv]([0-9A-Za-z]{10})$/;

  /**
   * 只接受 https 的 B 站视频页；主机名精确匹配，禁止 userinfo / 端口 / 其他域名。
   * 捕获组只取 BV 部分，用于和显式 bvid 交叉验证。
   */
  const VIDEO_URL_PATTERN =
    /^https:\/\/(?:www\.bilibili\.com|m\.bilibili\.com)\/video\/([Bb][Vv][0-9A-Za-z]{10})(?:[/?#].*)?$/i;

  const SHORT_URL_PATTERN = /^https?:\/\/(?:b23\.tv|bili2233\.cn)(?:[/?#]|$)/i;
  const SPACE_URL_PATTERN = /^https?:\/\/space\.bilibili\.com(?:[/?#]|$)/i;

  /* ---------------------------------------------------------------- 基础工具 */

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  /** 复用 stats.cleanRecord 的 UID 规则，不另立一套身份口径。 */
  function normalizeUid(value) {
    const probe = Stats.cleanRecord({ upUid: value }, "");
    return probe ? probe.upUid : null;
  }

  function normalizeBvid(value) {
    if (typeof value !== "string") return null;
    const match = BVID_PATTERN.exec(value.trim());
    if (!match) return null;
    return `BV${match[1]}`;
  }

  /** UID 按“长度优先、再字典序”比较，避免超出安全整数时精度丢失。 */
  function compareUid(left, right) {
    if (left.length !== right.length) return left.length - right.length;
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }

  function compareText(left, right) {
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }

  function bump(counter, key) {
    counter[key] = (counter[key] || 0) + 1;
  }

  /** UTF-8 字节数（不依赖 Buffer / TextEncoder，浏览器与 Node 行为一致）。 */
  function utf8ByteLength(text) {
    let bytes = 0;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code < 0x80) {
        bytes += 1;
      } else if (code < 0x800) {
        bytes += 2;
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          index += 1;
        } else {
          bytes += 3;
        }
      } else {
        bytes += 3;
      }
    }
    return bytes;
  }

  /** 清理控制 / 零宽字符，trim，并按 UTF-16 安全截断。 */
  function sanitizeText(value, maxLength) {
    if (typeof value !== "string") return { text: "", truncated: false };
    let text = value;
    let truncated = false;
    // 先按长度截断再跑正则，避免对异常大的字符串做无界替换。
    if (text.length > maxLength) {
      text = text.slice(0, maxLength);
      truncated = true;
      const last = text.charCodeAt(text.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
    }
    text = text.replace(UNSAFE_CHARS, " ").trim();
    return { text, truncated };
  }

  /**
   * 分区规范化，规则与 C2-3 normalizePartition 一致：
   * 非字符串、空白、字面“未知”、控制字符、超长 → 未识别。
   * 不从标题 / 昵称 / URL 猜测分区。
   */
  function normalizePartition(raw, limits) {
    if (typeof raw !== "string") return { name: "", identified: false };
    const name = raw.trim();
    if (!name || name === UNKNOWN_PARTITION) return { name: "", identified: false };
    if (name.length > limits.maxPartitionLength * 2) return { name: "", identified: false };
    if (UNSAFE_CHARS_TEST.test(name)) return { name: "", identified: false };
    if (Array.from(name).length > limits.maxPartitionLength) return { name: "", identified: false };
    return { name, identified: true };
  }

  /** 时间解析：Date / 毫秒 / 可解析字符串；不可靠一律 null，不猜。 */
  function toTimestamp(value) {
    if (value instanceof Date) {
      const time = value.getTime();
      return Number.isNaN(time) ? null : time;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) && value > 0 && Math.abs(value) <= 8.64e15
        ? value
        : null;
    }
    if (typeof value === "string") {
      const text = value.trim();
      if (!text) return null;
      const time = Date.parse(text);
      return Number.isNaN(time) || Math.abs(time) > 8.64e15 ? null : time;
    }
    return null;
  }

  /** 与 candidate-pool / interest-profile 一致的输入兼容：根结构或日期映射。 */
  function readDays(records) {
    if (!isPlainObject(records)) return { days: {}, kind: "empty" };
    if (isPlainObject(records.days)) return { days: records.days, kind: "root" };
    if (Object.prototype.hasOwnProperty.call(records, "version")) {
      return { days: {}, kind: "root" };
    }
    return { days: records, kind: "days" };
  }

  /* ---------------------------------------------------------------- 选项解析 */

  function resolveLimits(options, fallback) {
    const opts = isPlainObject(options) ? options : {};
    const source = isPlainObject(opts.limits) ? opts.limits : {};
    const base = isPlainObject(fallback) ? fallback : DEFAULT_LIMITS;
    const resolved = {};
    LIMIT_KEYS.forEach((key) => {
      const fallbackValue = Number.isFinite(base[key]) && base[key] > 0 ? base[key] : DEFAULT_LIMITS[key];
      const value = source[key];
      resolved[key] =
        typeof value === "number" && Number.isFinite(value) && value > 0
          ? Math.floor(value)
          : Math.floor(fallbackValue);
    });
    // 1 字节的输入上限没有实际意义，至少允许 1 个字符。
    if (resolved.maxInputBytes < 1) resolved.maxInputBytes = 1;
    return resolved;
  }

  function resolveThresholds(options) {
    const opts = isPlainObject(options) ? options : {};
    const source = isPlainObject(opts.thresholds) ? opts.thresholds : {};
    const resolved = {};
    THRESHOLD_KEYS.forEach((key) => {
      const value = source[key];
      resolved[key] =
        typeof value === "number" && Number.isFinite(value) && value >= 0
          ? value
          : DEFAULT_THRESHOLDS[key];
    });
    resolved.minImportedVideos = Math.max(0, Math.floor(resolved.minImportedVideos));
    resolved.minPartitionCoverage = Math.min(1, resolved.minPartitionCoverage);
    resolved.minTitleCoverage = Math.min(1, resolved.minTitleCoverage);
    if (!(resolved.maxAgeDays > 0)) resolved.maxAgeDays = DEFAULT_THRESHOLDS.maxAgeDays;
    return resolved;
  }

  function resolveNow(options) {
    const value = isPlainObject(options) ? options.now : undefined;
    if (value instanceof Date) {
      const time = value.getTime();
      return Number.isNaN(time) ? Date.now() : time;
    }
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const parsed = toTimestamp(value);
    return parsed === null ? Date.now() : parsed;
  }

  /* ---------------------------------------------------------------- 解析诊断 */

  function createParseDiagnostics(inputKind) {
    return {
      inputKind: inputKind || "empty",
      inputBytes: 0,
      candidatesIn: 0,
      candidatesAccepted: 0,
      candidatesInvalid: 0,
      videosIn: 0,
      videosAccepted: 0,
      videosInvalid: 0,
      invalidUids: 0,
      invalidBvids: 0,
      urlBvMismatch: 0,
      urlRejected: 0,
      unknownFields: 0,
      rejectedReasons: {}
    };
  }

  function parseFailure(status, reason, diagnostics, limits) {
    return {
      status,
      reason,
      document: null,
      diagnostics,
      limits
    };
  }

  function countUnknownFields(raw, knownKeys, diagnostics) {
    Object.keys(raw).forEach((key) => {
      if (knownKeys.indexOf(key) === -1) diagnostics.unknownFields += 1;
    });
  }

  /* ---------------------------------------------------------------- URL 校验 */

  /**
   * URL 只用于验证 BV 是否一致，以及可选地保留一个去参数后的规范链接：
   *   - 不访问、不跟随重定向、不解析短链；
   *   - 危险协议 / 非允许域名 → 丢弃 URL，保留视频；
   *   - URL 中的 BV 与显式 bvid 不一致 → 拒绝整个视频。
   */
  function parseVideoUrl(raw, bvid, limits, diagnostics) {
    if (raw === undefined || raw === null) {
      return { ok: true, url: "", state: "missing" };
    }
    if (typeof raw !== "string") {
      diagnostics.urlRejected += 1;
      bump(diagnostics.rejectedReasons, "invalid-url");
      return { ok: true, url: "", state: "rejected" };
    }
    const text = raw.trim();
    if (!text) return { ok: true, url: "", state: "missing" };
    if (text.length > limits.maxUrlLength) {
      diagnostics.urlRejected += 1;
      bump(diagnostics.rejectedReasons, "url-too-long");
      return { ok: true, url: "", state: "rejected" };
    }
    if (SHORT_URL_PATTERN.test(text)) {
      // 短链需要联网解析，本模块明确不解析，也不猜测目标 BV。
      diagnostics.urlRejected += 1;
      bump(diagnostics.rejectedReasons, "short-link-unsupported");
      return { ok: true, url: "", state: "short-link" };
    }
    if (SPACE_URL_PATTERN.test(text)) {
      // 空间链接不能验证 BV，按“非视频链接”丢弃。
      diagnostics.urlRejected += 1;
      bump(diagnostics.rejectedReasons, "space-link-not-video");
      return { ok: true, url: "", state: "not-video-url" };
    }

    const match = VIDEO_URL_PATTERN.exec(text);
    if (!match) {
      diagnostics.urlRejected += 1;
      bump(diagnostics.rejectedReasons, "url-not-allowed");
      return { ok: true, url: "", state: "rejected" };
    }
    const urlBvid = normalizeBvid(match[1]);
    if (urlBvid === null || urlBvid !== bvid) {
      diagnostics.urlBvMismatch += 1;
      bump(diagnostics.rejectedReasons, "url-bv-mismatch");
      return { ok: false, reason: "url-bv-mismatch" };
    }
    // 只保留规范地址，丢弃 query / hash（可能含跟踪参数）。
    return {
      ok: true,
      url: `https://www.bilibili.com/video/${bvid}`,
      state: "accepted"
    };
  }

  /* ---------------------------------------------------------------- 单视频解析 */

  function parseTags(raw, limits, diagnostics) {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
      bump(diagnostics.rejectedReasons, "invalid-tags");
      return [];
    }
    const seen = new Set();
    const tags = [];
    raw.forEach((item) => {
      if (typeof item !== "string") {
        bump(diagnostics.rejectedReasons, "invalid-tag-item");
        return;
      }
      const cleaned = sanitizeText(item, limits.maxTagLength);
      if (!cleaned.text) return;
      if (seen.has(cleaned.text)) return;
      if (tags.length >= limits.maxTags) {
        bump(diagnostics.rejectedReasons, "too-many-tags");
        return;
      }
      seen.add(cleaned.text);
      tags.push(cleaned.text);
    });
    return tags.sort(compareText);
  }

  function parseVideo(raw, limits, diagnostics) {
    if (!isPlainObject(raw)) {
      diagnostics.videosInvalid += 1;
      bump(diagnostics.rejectedReasons, "invalid-video");
      return null;
    }

    countUnknownFields(raw, VIDEO_KEYS, diagnostics);

    const bvid = normalizeBvid(raw.bvid);
    if (bvid === null) {
      diagnostics.videosInvalid += 1;
      diagnostics.invalidBvids += 1;
      bump(diagnostics.rejectedReasons, "invalid-bvid");
      return null;
    }

    let title = "";
    let titleTruncated = false;
    if (raw.title !== undefined && raw.title !== null) {
      if (typeof raw.title !== "string") {
        bump(diagnostics.rejectedReasons, "invalid-title");
      } else {
        const cleaned = sanitizeText(raw.title, limits.maxTitleRawLength);
        title = cleaned.text;
        titleTruncated = cleaned.truncated;
      }
    }

    const partition = normalizePartition(raw.partition, limits);
    if (!partition.identified && raw.partition !== undefined && raw.partition !== null) {
      bump(diagnostics.rejectedReasons, "invalid-partition");
    }

    const tags = parseTags(raw.tags, limits, diagnostics);
    const urlResult = parseVideoUrl(raw.url, bvid, limits, diagnostics);
    if (!urlResult.ok) {
      diagnostics.videosInvalid += 1;
      return null;
    }

    return {
      bvid,
      title,
      titleTruncated,
      partition: partition.name,
      tags,
      url: urlResult.url,
      urlState: urlResult.state
    };
  }

  /* ---------------------------------------------------------------- 单候选解析 */

  function parseCandidate(raw, limits, diagnostics) {
    if (!isPlainObject(raw)) {
      diagnostics.candidatesInvalid += 1;
      bump(diagnostics.rejectedReasons, "invalid-candidate");
      return null;
    }

    countUnknownFields(raw, CANDIDATE_KEYS, diagnostics);

    const upUid = normalizeUid(raw.upUid);
    if (upUid === null) {
      diagnostics.candidatesInvalid += 1;
      diagnostics.invalidUids += 1;
      bump(diagnostics.rejectedReasons, "invalid-uid");
      return null;
    }

    let upName = "";
    if (raw.upName !== undefined && raw.upName !== null) {
      if (typeof raw.upName !== "string") {
        bump(diagnostics.rejectedReasons, "invalid-name");
      } else {
        upName = sanitizeText(raw.upName, limits.maxNameLength).text;
      }
    }

    let observedAt = null;
    let observedAtState = "unknown";
    if (raw.observedAt !== undefined && raw.observedAt !== null && raw.observedAt !== "") {
      const time = toTimestamp(raw.observedAt);
      if (time === null) {
        observedAtState = "invalid";
        bump(diagnostics.rejectedReasons, "invalid-observed-at");
      } else {
        observedAt = time;
        observedAtState = "available";
      }
    }

    const videos = [];
    if (!Array.isArray(raw.videos)) {
      // 没有 videos 字段 / 类型错误：保留候选，按无内容处理，不虚构视频。
      if (raw.videos !== undefined && raw.videos !== null) {
        bump(diagnostics.rejectedReasons, "invalid-videos");
      }
    } else {
      raw.videos.forEach((item) => {
        diagnostics.videosIn += 1;
        const video = parseVideo(item, limits, diagnostics);
        if (video) {
          diagnostics.videosAccepted += 1;
          videos.push(video);
        }
      });
    }

    return { upUid, upName, observedAt, observedAtState, videos };
  }

  /* ---------------------------------------------------------------- 文档校验 */

  function validateDocument(raw, limits, diagnostics) {
    if (!isPlainObject(raw)) {
      return { status: "invalid", reason: "invalid-document", document: null };
    }

    if (raw.schemaVersion !== SCHEMA_VERSION) {
      return { status: "invalid", reason: "unsupported-schema", document: null };
    }
    if (raw.kind !== IMPORT_KIND) {
      return { status: "invalid", reason: "invalid-kind", document: null };
    }
    if (raw.provenance !== PROVENANCE_USER) {
      // 明确拒绝未实现的来源声明，不把 platform-observed / official-authorized 当作用户导入。
      return { status: "invalid", reason: "unsupported-provenance", document: null };
    }
    if (raw.userConfirmed !== true) {
      return { status: "invalid", reason: "confirmation-required", document: null };
    }
    if (!Array.isArray(raw.candidates)) {
      return { status: "invalid", reason: "invalid-document", document: null };
    }

    countUnknownFields(raw, TOP_LEVEL_KEYS, diagnostics);

    let exportedAt = null;
    if (raw.exportedAt !== undefined && raw.exportedAt !== null && raw.exportedAt !== "") {
      exportedAt = toTimestamp(raw.exportedAt);
      if (exportedAt === null) bump(diagnostics.rejectedReasons, "invalid-exported-at");
    }

    let sourceNote = "";
    if (raw.sourceNote !== undefined && raw.sourceNote !== null) {
      if (typeof raw.sourceNote !== "string") {
        bump(diagnostics.rejectedReasons, "invalid-source-note");
      } else {
        sourceNote = sanitizeText(raw.sourceNote, limits.maxNoteLength).text;
      }
    }

    const document = {
      schemaVersion: SCHEMA_VERSION,
      kind: IMPORT_KIND,
      provenance: PROVENANCE_USER,
      userConfirmed: true,
      exportedAt,
      sourceNote,
      candidates: []
    };

    if (raw.candidates.length === 0) {
      return { status: "empty", reason: "no-candidates", document };
    }

    raw.candidates.forEach((candidate) => {
      diagnostics.candidatesIn += 1;
      const parsed = parseCandidate(candidate, limits, diagnostics);
      if (!parsed) return;
      diagnostics.candidatesAccepted += 1;
      document.candidates.push(parsed);
    });

    if (document.candidates.length === 0) {
      // 所有候选都不合格：仍然是结构合法但无可用候选的输入。
      return { status: "empty", reason: "no-valid-candidates", document };
    }

    return { status: "ok", reason: "", document };
  }

  /* ---------------------------------------------------------------- parse 入口 */

  /**
   * 解析并校验导入文档。
   *
   * @param {string|object} input JSON 字符串或已解析对象
   * @param {object} [options]
   * @param {object} [options.limits] 覆盖 DEFAULT_LIMITS
   * @returns {object} { status: "ok"|"empty"|"invalid", reason, document, diagnostics, limits }
   */
  function parseCandidateContentImport(input, options) {
    const limits = resolveLimits(options);
    const diagnostics = createParseDiagnostics("empty");

    if (input === undefined || input === null) {
      return {
        status: "empty",
        reason: "empty-input",
        document: null,
        diagnostics,
        limits
      };
    }

    let raw = input;
    if (typeof input === "string") {
      diagnostics.inputKind = "string";
      // UTF-8 字节数不会小于 UTF-16 单元数，先用长度快速拒绝明显超限的输入。
      if (input.length > limits.maxInputBytes) {
        return parseFailure("invalid", "input-too-large", diagnostics, limits);
      }
      const bytes = utf8ByteLength(input);
      diagnostics.inputBytes = bytes;
      if (bytes > limits.maxInputBytes) {
        return parseFailure("invalid", "input-too-large", diagnostics, limits);
      }
      if (!input.trim()) {
        return {
          status: "empty",
          reason: "empty-input",
          document: null,
          diagnostics,
          limits
        };
      }
      try {
        raw = JSON.parse(input);
      } catch (error) {
        // 绝不回显原始文本、解析器消息或位置之外的内容。
        return parseFailure("invalid", "invalid-json", diagnostics, limits);
      }
    } else if (isPlainObject(input)) {
      diagnostics.inputKind = "object";
    } else {
      return parseFailure("invalid", "invalid-document", diagnostics, limits);
    }

    const validated = validateDocument(raw, limits, diagnostics);
    return {
      status: validated.status,
      reason: validated.reason,
      document: validated.document,
      diagnostics,
      limits
    };
  }

  /* ---------------------------------------------------------------- 导入合并 */

  function isParseResult(value) {
    return (
      isPlainObject(value) &&
      typeof value.status === "string" &&
      isPlainObject(value.diagnostics) &&
      Object.prototype.hasOwnProperty.call(value, "document")
    );
  }

  function chooseName(nameCounts) {
    let chosen = "";
    let best = -1;
    nameCounts.forEach((count, name) => {
      if (count > best || (count === best && (!chosen || name < chosen))) {
        chosen = name;
        best = count;
      }
    });
    return chosen;
  }

  /** 同一 UID 的多次出现按 UID 合并；昵称只展示，不参与身份判定。 */
  function mergeCandidates(documentCandidates, diagnostics) {
    const states = new Map();

    documentCandidates.forEach((candidate) => {
      let state = states.get(candidate.upUid);
      if (!state) {
        state = {
          upUid: candidate.upUid,
          names: new Map(),
          times: [],
          hasUnknownTime: false,
          hasInvalidTime: false,
          videos: new Map()
        };
        states.set(candidate.upUid, state);
      } else {
        diagnostics.candidatesMerged += 1;
      }

      if (candidate.upName) {
        state.names.set(
          candidate.upName,
          (state.names.get(candidate.upName) || 0) + 1
        );
      }
      if (candidate.observedAtState === "available") {
        state.times.push(candidate.observedAt);
      } else if (candidate.observedAtState === "invalid") {
        state.hasInvalidTime = true;
      } else {
        state.hasUnknownTime = true;
      }

      candidate.videos.forEach((video) => {
        let variants = state.videos.get(video.bvid);
        if (!variants) {
          variants = [];
          state.videos.set(video.bvid, variants);
        }
        variants.push(video);
      });
    });

    return states;
  }

  function resolveObservedAt(state) {
    if (state.times.length > 0) {
      return {
        observedAt: Math.max.apply(null, state.times),
        observedAtState: "available"
      };
    }
    if (state.hasInvalidTime) return { observedAt: null, observedAtState: "invalid" };
    return { observedAt: null, observedAtState: "unknown" };
  }

  /**
   * 合并重复 BV 时 urlState 的确定性优先级：
   *   - 只要有一条变体提供了合法 URL，合并结果就是 accepted（url 已是规范地址）；
   *   - 否则按“由具体到笼统”的顺序取第一个实际出现过的状态；
   *   - 全部未提供才是 missing。
   * 顺序是固定的，因此结果与输入顺序无关（见测试 47）。
   */
  const URL_STATE_PRECEDENCE = [
    "accepted",
    "short-link",
    "not-video-url",
    "rejected",
    "missing"
  ];

  function resolveUrlState(url, states) {
    if (url) return "accepted";
    for (let i = 0; i < URL_STATE_PRECEDENCE.length; i += 1) {
      if (states.has(URL_STATE_PRECEDENCE[i])) return URL_STATE_PRECEDENCE[i];
    }
    return "missing";
  }

  /**
   * 同一 UID 下同一 BV 可能被导入多次：
   *   - 元数据一致 → 只算一个视频，重复计数；
   *   - 标题或分区出现两个不同非空值 → 标记 metadata-conflict，该视频不参与特征；
   *   - 缺失 + 有值不算冲突（缺失只是信息不足）。
   * 所有选择都是确定性的，与输入顺序无关。
   */
  function resolveVideo(bvid, variants, limits, diagnostics) {
    diagnostics.duplicateVideos += Math.max(0, variants.length - 1);

    const titles = new Set();
    const partitions = new Set();
    const tags = new Set();
    const urlStates = new Set();
    let url = "";
    let titleTruncated = false;

    variants.forEach((variant) => {
      if (variant.title) titles.add(variant.title);
      if (variant.partition) partitions.add(variant.partition);
      variant.tags.forEach((tag) => tags.add(tag));
      if (variant.url && (!url || variant.url < url)) url = variant.url;
      if (variant.urlState) urlStates.add(variant.urlState);
      if (variant.titleTruncated) titleTruncated = true;
    });

    const conflictFields = [];
    if (titles.size > 1) conflictFields.push("title");
    if (partitions.size > 1) conflictFields.push("partition");
    const hasConflict = conflictFields.length > 0;

    const title = hasConflict || titles.size === 0 ? "" : titles.values().next().value;
    const partition =
      hasConflict || partitions.size === 0 ? "" : partitions.values().next().value;

    return {
      bvid,
      title,
      partition,
      tags: Array.from(tags).sort(compareText).slice(0, limits.maxTags),
      url,
      urlState: resolveUrlState(url, urlStates),
      titleState: title ? "available" : "missing",
      partitionState: partition ? "available" : "missing",
      titleTruncated,
      status: hasConflict ? "metadata-conflict" : "usable",
      conflictFields
    };
  }

  /* ---------------------------------------------------------------- 内容特征 */

  function emptyFeatureState() {
    return {
      usableVideoCount: 0,
      partitionVideoCount: 0,
      titleVideoCount: 0,
      missingPartitionCount: 0,
      missingTitleCount: 0,
      tokenlessTitleCount: 0,
      partitionCounts: [],
      partitionCoverage: null,
      titleCoverage: null,
      partitionCoverageState: "no-data",
      titleCoverageState: "no-data",
      titleTokens: [],
      uniqueTokenCount: 0,
      totalTokenCount: 0,
      tokenMapOverflow: false,
      outputTruncated: false
    };
  }

  /**
   * 用视频数（不是 watchMs）计算导入内容特征。
   * 只统计 status === "usable" 的视频；冲突视频整体排除，不进入分子或分母。
   * 标题 bigram 复用 candidate-features.js 的 extractTitleBigrams。
   */
  function computeContentFeatures(videos, limits) {
    const feature = emptyFeatureState();
    const usable = videos.filter((video) => video.status === "usable");
    feature.usableVideoCount = usable.length;
    if (usable.length === 0) return feature;

    const partitionMap = new Map();
    const tokenCounts = new Map();
    const tokenDocs = new Map();

    usable.forEach((video) => {
      if (video.partition) {
        feature.partitionVideoCount += 1;
        partitionMap.set(
          video.partition,
          (partitionMap.get(video.partition) || 0) + 1
        );
      } else {
        feature.missingPartitionCount += 1;
        video.partitionState = "missing";
      }

      if (!video.title) {
        feature.missingTitleCount += 1;
        video.titleState = "missing";
        return;
      }

      let tokens = [];
      try {
        tokens = Features.extractTitleBigrams(video.title);
      } catch (error) {
        // 极端环境异常时按“无词元”处理，不中断整个导入。
        tokens = [];
      }

      if (tokens.length === 0) {
        feature.tokenlessTitleCount += 1;
        video.titleState = "tokenless";
        return;
      }

      feature.titleVideoCount += 1;
      video.titleState = "available";
      const seen = new Set();
      tokens.forEach((token) => {
        const known = tokenCounts.has(token);
        if (!known && tokenCounts.size >= limits.maxUniqueTokens) {
          feature.tokenMapOverflow = true;
          return;
        }
        tokenCounts.set(token, (known ? tokenCounts.get(token) : 0) + 1);
        if (!seen.has(token)) {
          seen.add(token);
          tokenDocs.set(token, (tokenDocs.get(token) || 0) + 1);
        }
      });
    });

    feature.partitionCounts = Array.from(partitionMap.entries())
      .map(([name, videoCount]) => ({
        name,
        videoCount,
        shareOfImportedVideos: videoCount / usable.length
      }))
      .sort(
        (left, right) =>
          right.videoCount - left.videoCount || compareText(left.name, right.name)
      );

    feature.partitionCoverage = feature.partitionVideoCount / usable.length;
    feature.titleCoverage = feature.titleVideoCount / usable.length;
    feature.partitionCoverageState = "available";
    feature.titleCoverageState = "available";

    const sortedTokens = Array.from(tokenCounts.entries())
      .map(([token, count]) => ({
        token,
        count,
        documentCount: tokenDocs.get(token) || 0
      }))
      .sort(
        (left, right) =>
          right.count - left.count || compareText(left.token, right.token)
      );

    feature.uniqueTokenCount = sortedTokens.length;
    feature.totalTokenCount = sortedTokens.reduce((sum, item) => sum + item.count, 0);
    feature.outputTruncated = sortedTokens.length > limits.maxOutputTokens;
    feature.titleTokens = sortedTokens.slice(0, limits.maxOutputTokens);
    return feature;
  }

  function statusFromFeatures(feature, thresholds) {
    if (
      feature.usableVideoCount === 0 ||
      (feature.partitionVideoCount === 0 && feature.titleVideoCount === 0)
    ) {
      return "missing";
    }
    const complete =
      feature.usableVideoCount >= thresholds.minImportedVideos &&
      feature.partitionCoverage !== null &&
      feature.partitionCoverage >= thresholds.minPartitionCoverage &&
      feature.titleCoverage !== null &&
      feature.titleCoverage >= thresholds.minTitleCoverage &&
      feature.partitionVideoCount > 0 &&
      feature.titleVideoCount > 0;
    return complete ? "complete" : "partial";
  }

  /* ---------------------------------------------------------------- sidecar 固化 */

  function featureReasons(candidate, feature, thresholds) {
    const reasons = [];
    const add = (code, level, message) => reasons.push({ code, level, message });

    if (candidate.metadataConflictVideoCount > 0) {
      add(
        "metadata-conflict",
        "warning",
        `${candidate.metadataConflictVideoCount} 个视频的标题或分区描述互相矛盾，已排除出内容特征`
      );
    }
    if (candidate.videosTruncated) {
      add("videos-truncated", "warning", "视频数超过单候选上限，已按 BV 顺序截断");
    }
    if (candidate.globalVideoLimitDropped) {
      add("global-video-limit", "warning", "总视频数超过上限，部分视频未纳入证据");
    }
    if (candidate.nameConflict) {
      add("multiple-names", "info", "同一 UID 出现多个昵称；身份仍按 UID 处理，昵称仅展示");
    }
    if (feature.usableVideoCount === 0) {
      add("no-usable-videos", "warning", "没有可用于内容特征的导入视频");
      return reasons;
    }
    if (feature.partitionVideoCount === 0) {
      add("no-partition-features", "warning", "所有导入视频都缺少有效分区");
    } else if (feature.partitionCoverage < thresholds.minPartitionCoverage) {
      add(
        "partition-coverage-low",
        "warning",
        `分区覆盖率 ${Math.round(feature.partitionCoverage * 1000) / 10}% 低于实验阈值`
      );
    }
    if (feature.titleVideoCount === 0) {
      add("no-title-features", "warning", "没有可生成 bigram 的标题");
    } else if (feature.titleCoverage < thresholds.minTitleCoverage) {
      add(
        "title-coverage-low",
        "warning",
        `标题覆盖率 ${Math.round(feature.titleCoverage * 1000) / 10}% 低于实验阈值`
      );
    }
    if (feature.usableVideoCount < thresholds.minImportedVideos) {
      add(
        "insufficient-videos",
        "warning",
        `去重后可用视频数 ${feature.usableVideoCount} 少于实验阈值 ${thresholds.minImportedVideos}`
      );
    }
    if (feature.missingPartitionCount > 0) {
      add(
        "partial-partition-data",
        "info",
        `${feature.missingPartitionCount} 个视频缺少分区，仍计入覆盖率分母`
      );
    }
    if (feature.missingTitleCount > 0) {
      add(
        "partial-title-data",
        "info",
        `${feature.missingTitleCount} 个视频缺少标题，仍计入覆盖率分母`
      );
    }
    if (feature.tokenlessTitleCount > 0) {
      add(
        "tokenless-titles",
        "info",
        `${feature.tokenlessTitleCount} 个标题无法生成 bigram（例如单字符标题）`
      );
    }
    return reasons;
  }

  function buildCandidateEvidence(state, videos, limits, thresholds, diagnostics, flags) {
    const feature = computeContentFeatures(videos, limits);
    const nameList = Array.from(state.names.keys()).sort(compareText);
    const time = resolveObservedAt(state);
    const conflictVideos = videos.filter((video) => video.status === "uid-conflict");
    const metadataConflictVideos = videos.filter(
      (video) => video.status === "metadata-conflict"
    );

    const candidate = {
      upUid: state.upUid,
      upName: chooseName(state.names),
      names: nameList.slice(0, 20),
      nameConflict: nameList.length > 1,
      provenance: PROVENANCE_USER,
      lane: LANE_EXPLORATION,
      observedAt: time.observedAt,
      observedAtState: time.observedAtState,
      videos: videos.map((video) => ({
        bvid: video.bvid,
        title: video.title,
        partition: video.partition,
        tags: video.tags,
        url: video.url,
        urlState: video.urlState,
        titleState: video.titleState,
        partitionState: video.partitionState,
        titleTruncated: video.titleTruncated,
        status: video.status,
        conflictFields: video.conflictFields
      })),
      partitionCounts: feature.partitionCounts,
      titleTokens: feature.titleTokens,
      titleTokenStats: {
        uniqueTokenCount: feature.uniqueTokenCount,
        totalTokenCount: feature.totalTokenCount,
        tokenMapOverflow: feature.tokenMapOverflow,
        outputTruncated: feature.outputTruncated
      },
      importedVideoCount: videos.length,
      // 与设计文档的 importedVideoCount 同义；按 UID + BV 去重后的观察视频数。
      observedVideoCount: videos.length,
      usableVideoCount: feature.usableVideoCount,
      importedTitleCount: feature.titleVideoCount,
      importedPartitionCount: feature.partitionVideoCount,
      partitionCoverage: feature.partitionCoverage,
      titleCoverage: feature.titleCoverage,
      partitionCoverageState: feature.partitionCoverageState,
      titleCoverageState: feature.titleCoverageState,
      coverageBasis: "video-count",
      contentStatus: "missing",
      conflictVideoCount: conflictVideos.length,
      metadataConflictVideoCount: metadataConflictVideos.length,
      conflicts: videos
        .filter((video) => video.status !== "usable")
        .map((video) => ({
          bvid: video.bvid,
          type: video.status,
          fields: video.conflictFields.slice()
        }))
        .sort((left, right) => compareText(left.bvid, right.bvid)),
      videosTruncated: flags.videosTruncated === true,
      globalVideoLimitDropped: flags.globalVideoLimitDropped === true,
      reasons: []
    };

    if (conflictVideos.length > 0) {
      // 导入内部身份冲突：该候选内容不可信，整体标记 conflicted。
      candidate.contentStatus = "conflicted";
    } else {
      candidate.contentStatus = statusFromFeatures(feature, thresholds);
    }

    candidate.reasons = featureReasons(candidate, feature, thresholds);
    if (conflictVideos.length > 0) {
      candidate.reasons.unshift({
        code: "uid-conflict-in-import",
        level: "warning",
        message: `${conflictVideos.length} 个视频在导入内被不同 UID 声明，已排除出所有候选的内容特征`
      });
    }

    diagnostics.metadataConflictVideos += metadataConflictVideos.length;
    diagnostics.conflictVideos += conflictVideos.length;
    return candidate;
  }

  function emptySidecar(status, reason, parseResult, limits, thresholds) {
    const diagnostics = Object.assign(
      createParseDiagnostics(parseResult && parseResult.diagnostics ? parseResult.diagnostics.inputKind : "empty"),
      parseResult && parseResult.diagnostics ? parseResult.diagnostics : {}
    );
    if (!diagnostics.rejectedReasons) diagnostics.rejectedReasons = {};
    return {
      schemaVersion: SCHEMA_VERSION,
      kind: EVIDENCE_KIND,
      provenance: PROVENANCE_USER,
      lane: LANE_EXPLORATION,
      status,
      reason,
      userConfirmed: Boolean(parseResult && parseResult.document && parseResult.document.userConfirmed === true),
      exportedAt: null,
      sourceNote: "",
      candidates: [],
      summary: {
        total: 0,
        complete: 0,
        partial: 0,
        missing: 0,
        conflicted: 0,
        withPartitionFeatures: 0,
        withTitleFeatures: 0,
        importedVideoCount: 0,
        usableVideoCount: 0,
        conflictVideoCount: 0,
        metadataConflictVideoCount: 0
      },
      diagnostics,
      limits,
      thresholds: Object.assign({}, thresholds, { experimental: true }),
      note:
        "用户提供的内容证据，未在线核验；不进入观看记录，不改变 C2-2 / C2-3 的结论。"
    };
  }

  /* ---------------------------------------------------------------- build 入口 */

  /**
   * 构建独立的候选内容证据 sidecar。
   *
   * @param {object} importDoc parseCandidateContentImport 的返回值，或原始导入文档
   * @param {object} [options]
   * @returns {object} sidecar；空 / 非法输入返回结构化结果，不抛异常
   */
  function buildCandidateContentEvidence(importDoc, options) {
    const thresholds = resolveThresholds(options);
    let parsed;
    let limits;

    if (isParseResult(importDoc)) {
      parsed = importDoc;
      limits = resolveLimits(options, importDoc.limits);
    } else {
      limits = resolveLimits(options);
      const diagnostics = createParseDiagnostics("object");
      const validated = validateDocument(importDoc, limits, diagnostics);
      parsed = {
        status: validated.status,
        reason: validated.reason,
        document: validated.document,
        diagnostics,
        limits
      };
    }

    if (parsed.status === "invalid") {
      return emptySidecar("invalid", parsed.reason, parsed, limits, thresholds);
    }
    if (parsed.status === "empty") {
      return emptySidecar("empty", parsed.reason, parsed, limits, thresholds);
    }

    const diagnostics = Object.assign(createParseDiagnostics("object"), parsed.diagnostics);
    // 复制解析阶段的拒绝计数，避免 build 过程反向修改调用方持有的 parse 结果。
    diagnostics.rejectedReasons = Object.assign(
      {},
      parsed.diagnostics && parsed.diagnostics.rejectedReasons
    );
    diagnostics.candidatesMerged = 0;
    diagnostics.candidatesDroppedByLimit = 0;
    diagnostics.duplicateVideos = 0;
    diagnostics.videosTruncated = 0;
    diagnostics.globalVideoLimitDropped = 0;
    diagnostics.conflictVideos = 0;
    diagnostics.metadataConflictVideos = 0;
    diagnostics.nameConflictCandidates = 0;

    const states = mergeCandidates(parsed.document.candidates, diagnostics);
    const uids = Array.from(states.keys()).sort(compareUid);

    let keptUids = uids;
    if (keptUids.length > limits.maxCandidates) {
      diagnostics.candidatesDroppedByLimit = keptUids.length - limits.maxCandidates;
      keptUids = keptUids.slice(0, limits.maxCandidates);
    }

    // 先按 UID 稳定排序，再按 BV 稳定排序；所有截断规则都与输入顺序无关。
    const candidateVideos = keptUids.map((uid) => {
      const state = states.get(uid);
      const bvids = Array.from(state.videos.keys()).sort(compareText);
      let keptBvids = bvids;
      let videosTruncated = false;
      if (keptBvids.length > limits.maxVideosPerCandidate) {
        diagnostics.videosTruncated += keptBvids.length - limits.maxVideosPerCandidate;
        keptBvids = keptBvids.slice(0, limits.maxVideosPerCandidate);
        videosTruncated = true;
      }
      return {
        upUid: uid,
        state,
        videos: keptBvids.map((bvid) =>
          resolveVideo(bvid, state.videos.get(bvid), limits, diagnostics)
        ),
        videosTruncated,
        globalVideoLimitDropped: false
      };
    });

    // 总视频数上限：按 UID、BV 的稳定顺序截断，并逐候选标记。
    let remaining = limits.maxTotalVideos;
    candidateVideos.forEach((entry) => {
      const kept = [];
      entry.videos.forEach((video) => {
        if (remaining > 0) {
          kept.push(video);
          remaining -= 1;
        } else {
          diagnostics.globalVideoLimitDropped += 1;
          entry.globalVideoLimitDropped = true;
        }
      });
      entry.videos = kept;
    });

    // 导入内部不同 UID 声明同一 BV：该 BV 不参与任何一方的内容特征。
    const uidByBvid = new Map();
    candidateVideos.forEach((entry) => {
      entry.videos.forEach((video) => {
        if (!uidByBvid.has(video.bvid)) uidByBvid.set(video.bvid, new Set());
        uidByBvid.get(video.bvid).add(entry.upUid);
      });
    });
    const conflictBvids = new Set();
    uidByBvid.forEach((uids, bvid) => {
      if (uids.size >= 2) conflictBvids.add(bvid);
    });
    diagnostics.conflictBvids = conflictBvids.size;

    const candidates = candidateVideos
      .map((entry) => {
        entry.videos.forEach((video) => {
          if (conflictBvids.has(video.bvid)) {
            video.status = "uid-conflict";
            video.title = "";
            video.partition = "";
            video.titleState = "missing";
            video.partitionState = "missing";
            video.conflictFields = ["upUid"];
          }
        });
        entry.state.nameConflict = entry.state.names.size > 1;
        if (entry.state.nameConflict) diagnostics.nameConflictCandidates += 1;
        const evidence = buildCandidateEvidence(
          entry.state,
          entry.videos,
          limits,
          thresholds,
          diagnostics,
          {
            videosTruncated: entry.videosTruncated,
            globalVideoLimitDropped: entry.globalVideoLimitDropped
          }
        );
        return evidence;
      })
      .sort((left, right) => compareUid(left.upUid, right.upUid));

    const summary = {
      total: candidates.length,
      complete: 0,
      partial: 0,
      missing: 0,
      conflicted: 0,
      withPartitionFeatures: 0,
      withTitleFeatures: 0,
      importedVideoCount: 0,
      usableVideoCount: 0,
      conflictVideoCount: 0,
      metadataConflictVideoCount: 0
    };
    candidates.forEach((candidate) => {
      summary[candidate.contentStatus] += 1;
      if (candidate.importedPartitionCount > 0) summary.withPartitionFeatures += 1;
      if (candidate.importedTitleCount > 0) summary.withTitleFeatures += 1;
      summary.importedVideoCount += candidate.importedVideoCount;
      summary.usableVideoCount += candidate.usableVideoCount;
      summary.conflictVideoCount += candidate.conflictVideoCount;
      summary.metadataConflictVideoCount += candidate.metadataConflictVideoCount;
    });

    return {
      schemaVersion: SCHEMA_VERSION,
      kind: EVIDENCE_KIND,
      provenance: PROVENANCE_USER,
      lane: LANE_EXPLORATION,
      status: "ok",
      reason: "",
      userConfirmed: parsed.document.userConfirmed === true,
      exportedAt: parsed.document.exportedAt,
      sourceNote: parsed.document.sourceNote,
      candidates,
      summary,
      diagnostics,
      limits,
      thresholds: Object.assign({}, thresholds, { experimental: true }),
      note:
        "用户提供的内容证据，未在线核验；不进入观看记录，不改变 C2-2 / C2-3 的结论。"
    };
  }

  /* ---------------------------------------------------------------- 记录扫描 */

  function scanRecords(records) {
    const source = readDays(records);
    const diagnostics = {
      inputKind: source.kind,
      daysScanned: 0,
      daysInvalid: 0,
      recordsScanned: 0,
      recordsInvalid: 0,
      recordsWithoutBvid: 0,
      videosScanned: 0,
      localUidConflictVideos: 0
    };
    const uidByBvid = new Map();
    const bvidsByUid = new Map();

    Object.keys(source.days)
      .sort()
      .forEach((dayKey) => {
        if (!Stats.parseDateKey(dayKey)) {
          diagnostics.daysInvalid += 1;
          return;
        }
        const day = source.days[dayKey];
        if (!isPlainObject(day)) {
          diagnostics.daysInvalid += 1;
          return;
        }
        diagnostics.daysScanned += 1;

        Object.keys(day)
          .sort()
          .forEach((recordKey) => {
            diagnostics.recordsScanned += 1;
            const record = Stats.cleanRecord(day[recordKey], recordKey);
            if (!record) {
              diagnostics.recordsInvalid += 1;
              return;
            }
            if (!record.bvid) {
              diagnostics.recordsWithoutBvid += 1;
              return;
            }
            diagnostics.videosScanned += 1;

            if (record.upUid) {
              if (!uidByBvid.has(record.bvid)) uidByBvid.set(record.bvid, new Set());
              uidByBvid.get(record.bvid).add(record.upUid);
              if (!bvidsByUid.has(record.upUid)) bvidsByUid.set(record.upUid, new Set());
              bvidsByUid.get(record.upUid).add(record.bvid);
            }
          });
      });

    uidByBvid.forEach((uids) => {
      if (uids.size >= 2) diagnostics.localUidConflictVideos += 1;
    });

    return { uidByBvid, bvidsByUid, diagnostics };
  }

  /* ---------------------------------------------------------------- 新鲜度 */

  /**
   * 与 C2-2 相同的判定口径：ageDays > maxAgeDays 才算 stale，恰好等于阈值仍 fresh。
   * 缺失 / 非法 / 未来时间一律不视为新鲜。
   */
  function assessFreshness(observedAt, observedAtState, now, maxAgeDays) {
    const base = {
      state: "unknown",
      ageDays: null,
      thresholdDays: maxAgeDays,
      lastObservedAt: observedAt,
      reason: "missing-observation-time",
      note: "缺少观察时间，无法判断新鲜度；保留候选，不晋升探索通道"
    };

    if (observedAtState === "invalid") {
      return Object.assign({}, base, {
        state: "invalid",
        reason: "invalid-observation-time",
        note: "观察时间无法解析，保留候选但不晋升探索通道"
      });
    }
    if (observedAtState !== "available" || !Number.isFinite(observedAt)) {
      return base;
    }
    if (observedAt > now) {
      return Object.assign({}, base, {
        state: "future",
        reason: "future-observation-time",
        note: "观察时间晚于当前时间，可能是设备时间异常；不晋升探索通道"
      });
    }

    const ageDays = (now - observedAt) / DAY_MS;
    if (ageDays > maxAgeDays) {
      return {
        state: "stale",
        ageDays: Math.round(ageDays * 1000) / 1000,
        thresholdDays: maxAgeDays,
        lastObservedAt: observedAt,
        reason: "stale-observation",
        note: `超过 ${maxAgeDays} 天未观察到，保留候选但不晋升探索通道`
      };
    }
    return {
      state: "fresh",
      ageDays: Math.round(ageDays * 1000) / 1000,
      thresholdDays: maxAgeDays,
      lastObservedAt: observedAt,
      reason: "",
      note: ""
    };
  }

  /* ---------------------------------------------------------------- assess 入口 */

  function invalidAssessment(reason, diagnostics, thresholds, now) {
    return {
      schemaVersion: SCHEMA_VERSION,
      kind: ASSESSMENT_KIND,
      provenance: PROVENANCE_USER,
      lane: LANE_EXPLORATION,
      status: "invalid",
      reason,
      now,
      candidates: [],
      summary: {
        total: 0,
        eligible: 0,
        pendingReview: 0,
        insufficientData: 0,
        conflicted: 0,
        crossSourceConflictVideoCount: 0
      },
      diagnostics,
      thresholds: Object.assign({}, thresholds, { experimental: true }),
      note:
        "eligibleForExploration 只表示满足本地探索通道的技术准入条件，" +
        "不代表 B 站账号已在线认证、视频元数据已被平台核验或推荐质量已被证明。"
    };
  }

  /**
   * 与本地观看记录交叉检查，并给出探索通道准入结论。
   * 不修改 sidecar，不修改 records，不写任何存储。
   *
   * @param {object} sidecar buildCandidateContentEvidence 的结果
   * @param {object} records biliDailyRecords 根结构或日期映射
   * @param {object} [options] { now, thresholds, limits }
   * @returns {object} 评估结果
   */
  function assessImportedContentCandidates(sidecar, records, options) {
    const thresholds = resolveThresholds(options);
    const limits = resolveLimits(options);
    const now = resolveNow(options);
    const scan = scanRecords(records);
    const diagnostics = Object.assign({}, scan.diagnostics, {
      now,
      importedCandidates: 0,
      invalidSidecarCandidates: 0,
      crossSourceConflictVideoCount: 0
    });

    if (!isPlainObject(sidecar) || sidecar.kind !== EVIDENCE_KIND) {
      return invalidAssessment("invalid-sidecar", diagnostics, thresholds, now);
    }
    if (sidecar.status === "invalid") {
      return invalidAssessment(sidecar.reason || "invalid-sidecar", diagnostics, thresholds, now);
    }
    if (!Array.isArray(sidecar.candidates) || sidecar.candidates.length === 0) {
      const empty = invalidAssessment("no-candidates", diagnostics, thresholds, now);
      empty.status = "empty";
      empty.reason = "no-candidates";
      return empty;
    }

    const crossConflictBvids = new Set();
    const candidates = sidecar.candidates
      .map((candidate) => {
        diagnostics.importedCandidates += 1;
        if (!isPlainObject(candidate)) {
          diagnostics.invalidSidecarCandidates += 1;
          return null;
        }

        const upUid = normalizeUid(candidate.upUid);
        if (upUid === null) {
          diagnostics.invalidSidecarCandidates += 1;
          return null;
        }
        const freshness = assessFreshness(
          candidate.observedAt,
          candidate.observedAtState,
          now,
          thresholds.maxAgeDays
        );

        const localBvids = scan.bvidsByUid.get(upUid) || new Set();
        const internalConflictVideoCount = Number.isInteger(candidate.conflictVideoCount)
          ? Math.max(0, candidate.conflictVideoCount)
          : 0;
        const metadataConflictVideoCount = Number.isInteger(candidate.metadataConflictVideoCount)
          ? Math.max(0, candidate.metadataConflictVideoCount)
          : 0;

        const crossConflicts = new Set();
        (Array.isArray(candidate.videos) ? candidate.videos : []).forEach((video) => {
          if (!isPlainObject(video) || typeof video.bvid !== "string") return;
          const localUids = scan.uidByBvid.get(video.bvid);
          if (!localUids) return;
          if (localUids.size >= 2) {
            // 历史记录内部已经冲突：任何导入声明都不可信。
            crossConflicts.add(video.bvid);
            return;
          }
          const localUid = localUids.values().next().value;
          if (localUid && localUid !== upUid) crossConflicts.add(video.bvid);
        });
        crossConflicts.forEach((bvid) => crossConflictBvids.add(bvid));

        const trustedVideos = (candidate.videos || []).filter(
          (video) => video.status === "usable" && !crossConflicts.has(video.bvid)
        );
        const feature = computeContentFeatures(
          trustedVideos.map((video) => Object.assign({}, video)),
          limits
        );

        const hasIdentityConflict =
          internalConflictVideoCount > 0 || crossConflicts.size > 0;
        let contentStatus;
        if (hasIdentityConflict) contentStatus = "conflicted";
        else contentStatus = statusFromFeatures(feature, thresholds);

        const reasons = [];
        const addReason = (code, level, message) => {
          reasons.push({ code, level, message });
        };

        if (candidate.provenance !== PROVENANCE_USER) {
          addReason("unsupported-provenance", "error", "来源必须是 user-provided");
        }
        if (sidecar.provenance !== PROVENANCE_USER) {
          addReason(
            "unsupported-sidecar-provenance",
            "error",
            "sidecar 总体来源必须是 user-provided"
          );
        }
        if (sidecar.userConfirmed !== true) {
          addReason("not-confirmed", "error", "导入未由用户明确确认");
        }
        if (hasIdentityConflict) {
          if (internalConflictVideoCount > 0) {
            addReason(
              "uid-conflict-in-import",
              "warning",
              `${internalConflictVideoCount} 个视频在导入内被不同 UID 声明`
            );
          }
          if (crossConflicts.size > 0) {
            addReason(
              "uid-conflict-with-history",
              "warning",
              `${crossConflicts.size} 个视频的 UID 与本地观看记录冲突`
            );
          }
        }
        if (freshness.state !== "fresh") {
          addReason(freshness.reason, "warning", freshness.note);
        }
        if (feature.usableVideoCount < thresholds.minImportedVideos) {
          addReason(
            "insufficient-videos",
            "warning",
            `可信视频数 ${feature.usableVideoCount} 少于实验阈值 ${thresholds.minImportedVideos}`
          );
        }
        if (feature.partitionCoverage === null) {
          addReason("partition-coverage-no-data", "warning", "没有可用的分区数据");
        } else if (feature.partitionCoverage < thresholds.minPartitionCoverage) {
          addReason(
            "partition-coverage-low",
            "warning",
            `分区覆盖率 ${Math.round(feature.partitionCoverage * 1000) / 10}% 低于实验阈值`
          );
        }
        if (feature.titleCoverage === null) {
          addReason("title-coverage-no-data", "warning", "没有可用的标题数据");
        } else if (feature.titleCoverage < thresholds.minTitleCoverage) {
          addReason(
            "title-coverage-low",
            "warning",
            `标题覆盖率 ${Math.round(feature.titleCoverage * 1000) / 10}% 低于实验阈值`
          );
        }
        if (feature.partitionVideoCount === 0) {
          addReason("no-partition-features", "warning", "没有有效分区特征");
        }
        if (feature.titleVideoCount === 0) {
          addReason("no-title-features", "warning", "没有有效标题 bigram");
        }
        if (metadataConflictVideoCount > 0) {
          addReason(
            "metadata-conflict",
            "warning",
            `${metadataConflictVideoCount} 个视频的标题或分区描述互相矛盾，已排除`
          );
        }

        const blocking = reasons.filter((item) => item.level !== "info");
        const eligibleForExploration = blocking.length === 0;

        let promotionStatus;
        if (eligibleForExploration) {
          promotionStatus = "eligible";
        } else if (hasIdentityConflict) {
          promotionStatus = "pending-review";
        } else if (feature.usableVideoCount === 0) {
          promotionStatus = "insufficient-data";
        } else {
          promotionStatus = "pending-review";
        }

        return {
          upUid,
          upName: typeof candidate.upName === "string" ? candidate.upName : "",
          provenance: candidate.provenance,
          lane: LANE_EXPLORATION,
          observedAt: candidate.observedAt,
          observedAtState: candidate.observedAtState,
          freshness,
          identityEvidence: {
            uid: upUid,
            uidFormatValid: upUid !== null,
            provenance: candidate.provenance,
            userConfirmed: sidecar.userConfirmed === true,
            fromWatchHistory: localBvids.size > 0,
            fromUserInput: true,
            sources: [PROVENANCE_USER],
            // 本阶段没有任何在线核验能力，恒为 false。
            onlineVerified: false,
            localWatchedVideoCount: localBvids.size,
            internalConflictVideoCount,
            metadataConflictVideoCount,
            crossSourceConflictVideoCount: crossConflicts.size,
            hasIdentityConflict
          },
          contentEvidence: {
            importedVideoCount: Array.isArray(candidate.videos) ? candidate.videos.length : 0,
            trustedVideoCount: feature.usableVideoCount,
            partitionVideoCount: feature.partitionVideoCount,
            titleVideoCount: feature.titleVideoCount,
            partitionCoverage: feature.partitionCoverage,
            titleCoverage: feature.titleCoverage,
            partitionCoverageState: feature.partitionCoverageState,
            titleCoverageState: feature.titleCoverageState,
            coverageBasis: "video-count",
            partitionCounts: feature.partitionCounts,
            contentStatus,
            metadataConflictVideoCount
          },
          promotion: {
            eligibleForExploration,
            status: promotionStatus,
            reasons,
            thresholds: Object.assign({}, thresholds, { experimental: true })
          }
        };
      })
      .filter(Boolean)
      .sort((left, right) => compareUid(left.upUid, right.upUid));

    diagnostics.crossSourceConflictVideoCount = crossConflictBvids.size;

    const summary = {
      total: candidates.length,
      eligible: 0,
      pendingReview: 0,
      insufficientData: 0,
      conflicted: 0,
      crossSourceConflictVideoCount: diagnostics.crossSourceConflictVideoCount
    };
    candidates.forEach((candidate) => {
      if (candidate.promotion.status === "eligible") summary.eligible += 1;
      else if (candidate.promotion.status === "insufficient-data") summary.insufficientData += 1;
      else summary.pendingReview += 1;
      if (candidate.contentEvidence.contentStatus === "conflicted") summary.conflicted += 1;
    });

    return {
      schemaVersion: SCHEMA_VERSION,
      kind: ASSESSMENT_KIND,
      provenance: PROVENANCE_USER,
      lane: LANE_EXPLORATION,
      status: "ok",
      reason: "",
      now,
      candidates,
      summary,
      diagnostics,
      thresholds: Object.assign({}, thresholds, { experimental: true }),
      note:
        "所有导入内容均为用户提供、未在线核验；" +
        "eligibleForExploration 只表示满足本地探索通道的技术准入条件，" +
        "不代表 B 站账号已在线认证、视频元数据已被平台核验或推荐质量已被证明；" +
        "也不改变 C2-2 的身份冲突结论。"
    };
  }

  /* ---------------------------------------------------------------- 导出 */

  global.BiliDailyCandidateContentImport = Object.freeze({
    SCHEMA_VERSION,
    IMPORT_KIND,
    EVIDENCE_KIND,
    ASSESSMENT_KIND,
    PROVENANCE_USER,
    LANE_EXPLORATION,
    DEFAULT_LIMITS,
    DEFAULT_THRESHOLDS,
    parseCandidateContentImport,
    buildCandidateContentEvidence,
    assessImportedContentCandidates
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
