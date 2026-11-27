"use strict";

/**
 * Bili Daily —— 推荐基础算法（阶段 C3-1）
 *
 * 纯函数模块：只做「内容向量化 → TF-IDF → 余弦相似度」这一层数学与特征适配。
 * 不调用 chrome.*、DOM、fetch、XMLHttpRequest、Cookie，不读文件系统，不访问网络，
 * 不写任何存储，不修改传入对象。
 *
 * 依赖（只读取，不修改）：
 *   - stats.js                 cleanRecord / mergeByBvid / 本地日期工具
 *   - candidate-features.js    extractTitleBigrams（与 C2-3 完全同一套标题归一化）
 * 必须先加载 stats.js 与 candidate-features.js。
 *
 * ---------------------------------------------------------------------------
 * 本阶段明确不做
 * ---------------------------------------------------------------------------
 *   - 不做推荐排序、不出推荐列表、不做 MMR、不做最终综合评分；
 *   - 不做时间衰减、不做重复曝光抑制（C3-2）；
 *   - 不读取 biliDailyRecords 的真实存储，只处理调用方传入的对象；
 *   - 不修改 C2-2 的 eligible / review / excluded；
 *   - 不修改 C2-4B 的 eligibleForExploration；
 *   - 不把导入内容当作观看行为。
 *
 * ---------------------------------------------------------------------------
 * 三条语义约束（对应 C3-0 补充说明）
 * ---------------------------------------------------------------------------
 *   1. similarity / coverage / confidence 三层分离：
 *      本模块只产出 similarity 与 coverage 元数据，confidence 策略推迟到 C3-2，
 *      输出中标记 confidencePolicy = "deferred-to-c3-2"。
 *   2. 每个向量带 basis 与 space：
 *      - 不同 feature space（partition vs title）**任何情况下都不允许比较**，
 *        allowCrossBasis 只放宽统计口径，不放宽特征空间；
 *      - 不同 basis 默认拒绝；显式 allowCrossBasis 时返回 approximation 标记。
 *   3. 用户向量使用原始计数 / 原始观看时长（decay = "none"），
 *      仅保留 recordWeight 接入点，供 C3-2 的衰减函数使用。
 *
 * 外部 IDF 模型必须通过结构校验：损坏模型返回 status = "invalid-idf-model"，
 * 不做静默修正，也不吞掉异常。
 */

(function (global) {
  const Stats = global.BiliDailyStats;
  const Features = global.BiliDailyCandidateFeatures;

  if (
    !Stats ||
    typeof Stats.cleanRecord !== "function" ||
    typeof Stats.mergeByBvid !== "function" ||
    typeof Stats.parseDateKey !== "function" ||
    typeof Stats.shiftLocalDate !== "function" ||
    typeof Stats.localDateKey !== "function"
  ) {
    throw new Error("Bili Daily recommend-core.js 需要先加载 stats.js");
  }
  if (!Features || typeof Features.extractTitleBigrams !== "function") {
    throw new Error(
      "Bili Daily recommend-core.js 需要先加载 candidate-features.js"
    );
  }

  /* ---------------------------------------------------------------- 常量 */

  const MODULE_KIND = "bili-daily-recommend-core";
  const MODULE_VERSION = 1;

  const FEATURE_SPACE = Object.freeze({
    PARTITION: "partition",
    TITLE: "title"
  });

  const LANE = Object.freeze({
    MAIN: "main",
    EXPLORATION: "exploration"
  });

  const SIDE = Object.freeze({
    USER: "user",
    CANDIDATE: "candidate"
  });

  const BASIS = Object.freeze({
    WATCH_MS: "watch-ms",
    VIDEO_COUNT: "video-count",
    TOKEN_COUNT: "token-count",
    UNSPECIFIED: "unspecified"
  });

  const STATUS = Object.freeze({
    OK: "ok",
    EMPTY: "empty",
    UNAVAILABLE: "unavailable",
    BLOCKED: "blocked",
    INVALID: "invalid"
  });

  const UNKNOWN_PARTITION =
    typeof Features.UNKNOWN_PARTITION === "string" && Features.UNKNOWN_PARTITION
      ? Features.UNKNOWN_PARTITION
      : "未知";

  const DEFAULT_CONFIG = Object.freeze({
    // 用户侧统计窗口（本地日历日，含 endDate）。C1 默认 7 / 30，这里取 30。
    windowDays: 30,
    // 候选文档少于此值时关闭 IDF，改用统一权重 1（C3-0 的实验默认值）。
    minIdfDocuments: 20,
    // 每个用户文本向量的最大唯一词元数，避免异常数据造成无界内存。
    maxTokens: 2000,
    // 窗口上限，防止调用方传入过大窗口。
    maxWindowDays: 366
  });

  const IDF_FORMULA = "ln((N+1)/(df+1))+1";
  const TF_FORMULA = "1+ln(tf)";

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

  /** 有限、非负的数字；其余一律返回 null（不把非法值当 0）。 */
  function toNonNegativeNumber(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return null;
    }
    return value;
  }

  /** 安全写入任意键（避免 "__proto__" 等键污染原型）。 */
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

  /** L2 范数；键顺序固定为码点升序，保证浮点累加顺序确定。 */
  function computeNorm(vector) {
    const keys = Object.keys(vector).sort(compareText);
    let sum = 0;
    keys.forEach((key) => {
      const value = vector[key];
      sum += value * value;
    });
    return Math.sqrt(sum);
  }

  /** 只保留正权重并按键排序，产出可 JSON 往返的普通对象。 */
  function normalizeVector(entries) {
    const vector = {};
    Object.keys(entries)
      .sort(compareText)
      .forEach((key) => {
        const value = entries[key];
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
          setOwn(vector, key, value);
        }
      });
    return vector;
  }

  function reason(code, message) {
    return { code, message };
  }

  /* ---------------------------------------------------------------- 时间窗口 */

  /**
   * 读取「日期 → 记录表」映射。与 interest-profile.js / candidate-pool.js 一致：
   * 有 version 但没有 days 视为空根结构，不把 "version" 当日期键。
   */
  function readDays(records) {
    if (!isPlainObject(records)) return { days: {}, kind: "empty" };
    if (isPlainObject(records.days)) return { days: records.days, kind: "root" };
    if (hasOwn(records, "version")) return { days: {}, kind: "root" };
    return { days: records, kind: "days" };
  }

  /**
   * 本地基准日：优先 options.endDate，其次 options.now，最后当前时间。
   * C3-1 的测试一律显式传 endDate，避免依赖运行机器时区。
   */
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

  /** 窗口天数：默认 30，允许 1..366，非法值回退默认并记录原因。 */
  function resolveWindowDays(options, reasons) {
    const raw = options.windowDays;
    if (raw === undefined || raw === null) return DEFAULT_CONFIG.windowDays;
    const value = Number(raw);
    if (
      !Number.isFinite(value) ||
      Math.floor(value) !== value ||
      value < 1 ||
      value > DEFAULT_CONFIG.maxWindowDays
    ) {
      reasons.push(
        reason(
          "invalid-window-days",
          `窗口天数 ${String(raw)} 非法，已回退默认 ${DEFAULT_CONFIG.windowDays} 天`
        )
      );
      return DEFAULT_CONFIG.windowDays;
    }
    return value;
  }

  /**
   * 合并前的确定性排序：BV → 标题 → 观看时长降序 → 分 P。
   * mergeByBvid 取「第一条非空标题」，因此先排序才能保证结果与输入顺序无关。
   */
  function compareRecordsForMerge(left, right) {
    return (
      compareText(left.bvid || "", right.bvid || "") ||
      compareText(left.title || "", right.title || "") ||
      right.watchMs - left.watchMs ||
      (left.page == null ? -1 : left.page) - (right.page == null ? -1 : right.page)
    );
  }

  /**
   * 收集窗口内的观看记录：
   *   1. 只读取 dateKeys 覆盖的本地日历日；
   *   2. 每天先 cleanRecord（复用 stats 的口径）再合并同一 BV 的分 P / 重复；
   *   3. 跨天再按 BV 合并一次（同一视频跨天只算一个视频，时长累加）。
   * 不修改 records。
   */
  function collectWindowVideos(records, options) {
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
        videos: [],
        invalidRecords: 0,
        reasons
      };
    }

    const dateKeys = [];
    for (let index = 0; index < dayCount; index += 1) {
      dateKeys.push(Stats.shiftLocalDate(startDate, index));
    }

    const collected = [];
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
      });

      // 同一天内先确定性排序，再合并同一 BV。
      cleaned.sort(compareRecordsForMerge);
      Stats.mergeByBvid(cleaned).forEach((video) => collected.push(video));
    });

    // 跨天合并：同一 BV 跨多天只算一个视频，watchMs 累加。
    collected.sort(compareRecordsForMerge);
    const videos = Stats.mergeByBvid(collected);

    return {
      ok: true,
      endDate,
      startDate,
      dayCount,
      dateKeys,
      videos,
      invalidRecords,
      reasons
    };
  }

  /* ---------------------------------------------------------------- 分区口径 */

  /**
   * 与 C1 完全一致的分区识别规则：
   *   - 非空字符串，且不等于保留名「未知」 → 已识别；
   *   - 其余（含空串、字面「未知」）→ 未识别。
   * 不根据标题或昵称猜测分区。
   */
  function isIdentifiedPartition(name) {
    return typeof name === "string" && name !== "" && name !== UNKNOWN_PARTITION;
  }

  function emptyWindowBlock(windowInfo) {
    return {
      endDate: windowInfo.endDate,
      startDate: windowInfo.startDate,
      dayCount: windowInfo.dayCount,
      includeZeroWatch: false,
      decay: "none"
    };
  }

  /* ---------------------------------------------------------------- 用户分区向量 */

  /**
   * 从观看记录构建用户分区向量（basis = watch-ms）。
   *
   * - 只统计窗口内 watchMs > 0 的视频；
   * - 同一 BV 跨天 / 分 P 已由 stats.mergeByBvid 合并，不会重复计视频；
   * - 权重 = 实际观看时长（watchMs），本阶段无时间衰减；
   * - 「未知」不进入可匹配维度，但仍保留在覆盖率分母中；
   * - 没有有效分区时返回 status = "unavailable"，vector = null；
   * - 覆盖率为 null 而不是 0 或 100，避免把缺失伪造成占比。
   *
   * @param {object} records biliDailyRecords 根结构或日期映射
   * @param {object} [options] { endDate, now, windowDays }
   * @returns {object} 可 JSON 往返的普通对象
   */
  function buildUserPartitionVector(records, options) {
    const opts = isPlainObject(options) ? options : {};
    const window = collectWindowVideos(records, opts);
    const reasons = window.reasons.slice();

    const bucket = new Map();
    let totalWatchMs = 0;
    let identifiedWatchMs = 0;
    let unknownWatchMs = 0;
    let videoCount = 0;
    let identifiedVideoCount = 0;
    let unknownVideoCount = 0;
    let excludedZeroWatchVideos = 0;

    window.videos.forEach((video) => {
      const watchMs = toNonNegativeNumber(video.watchMs);
      if (watchMs === null || watchMs <= 0) {
        excludedZeroWatchVideos += 1;
        return;
      }
      videoCount += 1;
      totalWatchMs += watchMs;

      if (isIdentifiedPartition(video.partition)) {
        identifiedWatchMs += watchMs;
        identifiedVideoCount += 1;
        bucket.set(video.partition, (bucket.get(video.partition) || 0) + watchMs);
      } else {
        unknownWatchMs += watchMs;
        unknownVideoCount += 1;
      }
    });

    const entries = {};
    if (identifiedWatchMs > 0) {
      bucket.forEach((ms, name) => {
        setOwn(entries, name, ms / identifiedWatchMs);
      });
    }
    const vector = normalizeVector(entries);
    const dimensions = Object.keys(vector);
    const available = dimensions.length > 0;

    let status = STATUS.OK;
    if (!window.ok) {
      status = STATUS.INVALID;
    } else if (videoCount === 0) {
      status = STATUS.EMPTY;
      reasons.push(reason("no-watched-videos", "统计窗口内没有实际观看时长的视频"));
    } else if (!available) {
      status = STATUS.UNAVAILABLE;
      reasons.push(
        reason("no-identified-partition", "窗口内没有任何可识别的分区，分区向量不可用")
      );
    }

    return {
      kind: "bili-daily-recommend-vector",
      module: MODULE_KIND,
      version: MODULE_VERSION,
      space: FEATURE_SPACE.PARTITION,
      side: SIDE.USER,
      lane: null,
      basis: BASIS.WATCH_MS,
      status,
      available,
      vector: available ? vector : null,
      dimensions,
      norm: available ? computeNorm(vector) : 0,
      weighting: "watch-ms-raw",
      decay: "none",
      coverage: {
        basis: BASIS.WATCH_MS,
        // 与 C1 的 coverage.ratio 同口径（分母含「未知」），
        // 但无数据时返回 null，不返回 0，避免把缺失伪造成 0%。
        ratio: totalWatchMs > 0 ? identifiedWatchMs / totalWatchMs : null,
        totalWatchMs,
        identifiedWatchMs,
        unknownWatchMs
      },
      sample: {
        videoCount,
        identifiedVideoCount,
        unknownVideoCount,
        excludedZeroWatchVideos,
        invalidRecords: window.invalidRecords
      },
      window: emptyWindowBlock(window),
      reasons,
      note:
        "分区权重来自真实观看时长，未知分区不参与匹配但计入覆盖率；" +
        "本阶段不做时间衰减，也不产出任何推荐分数。"
    };
  }

  /* ---------------------------------------------------------------- 用户标题词频 */

  /**
   * 从观看记录构建用户标题 bigram 词频（basis = token-count）。
   *
   * - 复用 candidate-features.js 的 extractTitleBigrams，与 C2-3 同一套归一化；
   * - 同一 BV 跨天 / 分 P 合并后只贡献一个标题文档，文档数不会虚假膨胀；
   * - 默认词频是**原始出现次数**（weighting = "raw-count"）；
   * - options.recordWeight 是 C3-2 的接入点：默认 null，本阶段不实现任何时间权重；
   * - 无标题 / 单字符 / 全标点 → 安全降级，不虚构词元。
   *
   * @param {object} records
   * @param {object} [options] { endDate, now, windowDays, maxTokens, recordWeight }
   */
  function buildUserTextCounts(records, options) {
    const opts = isPlainObject(options) ? options : {};
    const window = collectWindowVideos(records, opts);
    const reasons = window.reasons.slice();

    const rawWeight =
      typeof opts.recordWeight === "function" ? opts.recordWeight : null;
    const weighting = rawWeight ? "custom-record-weight" : "raw-count";

    const maxTokens =
      Number.isFinite(opts.maxTokens) && opts.maxTokens >= 1
        ? Math.floor(opts.maxTokens)
        : DEFAULT_CONFIG.maxTokens;

    const counts = new Map();
    let videoCount = 0;
    let titledVideoCount = 0;
    let tokenizedVideoCount = 0;
    let tokenlessVideoCount = 0;
    let missingTitleCount = 0;
    let excludedZeroWatchVideos = 0;
    let invalidWeights = 0;
    let truncatedTokens = 0;

    window.videos.forEach((video) => {
      const watchMs = toNonNegativeNumber(video.watchMs);
      if (watchMs === null || watchMs <= 0) {
        excludedZeroWatchVideos += 1;
        return;
      }
      videoCount += 1;

      const title = typeof video.title === "string" ? video.title.trim() : "";
      if (!title) {
        missingTitleCount += 1;
        return;
      }
      titledVideoCount += 1;

      let tokens = [];
      try {
        tokens = Features.extractTitleBigrams(title);
      } catch (error) {
        // 极端标题导致归一化异常时按「无词元」处理，不中断整批计算。
        tokens = [];
      }
      if (!Array.isArray(tokens) || tokens.length === 0) {
        tokenlessVideoCount += 1;
        return;
      }
      tokenizedVideoCount += 1;

      // 权重校验：非法返回一律按 1 处理并计数，不静默吞掉。
      let weight = 1;
      if (rawWeight) {
        const value = rawWeight(video);
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
          weight = value;
        } else {
          invalidWeights += 1;
        }
      }
      if (weight === 0) return;

      tokens.forEach((token) => {
        if (typeof token !== "string" || !token) return;
        counts.set(token, (counts.get(token) || 0) + weight);
      });
    });

    const sortedTokens = Array.from(counts.entries())
      .map(([token, count]) => ({ token, count }))
      .sort(
        (left, right) =>
          right.count - left.count || compareText(left.token, right.token)
      );

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

    let status = STATUS.OK;
    if (!window.ok) {
      status = STATUS.INVALID;
    } else if (videoCount === 0) {
      status = STATUS.EMPTY;
      reasons.push(reason("no-watched-videos", "统计窗口内没有实际观看时长的视频"));
    } else if (!available) {
      status = STATUS.UNAVAILABLE;
      reasons.push(reason("no-title-tokens", "窗口内没有可生成词元的标题"));
    }

    return {
      kind: "bili-daily-recommend-counts",
      module: MODULE_KIND,
      version: MODULE_VERSION,
      space: FEATURE_SPACE.TITLE,
      side: SIDE.USER,
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
      weighting,
      decay: "none",
      coverage: {
        basis: BASIS.VIDEO_COUNT,
        videoCount,
        titledVideoCount,
        tokenizedVideoCount,
        // 无数据时为 null，不伪造为 0%。
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
        invalidRecords: window.invalidRecords,
        invalidWeights
      },
      window: emptyWindowBlock(window),
      config: { maxTokens },
      reasons,
      note:
        "标题词频为原始出现次数；同 BV 已合并为一个文档。" +
        "时间权重留待 C3-2 通过 recordWeight 接入，本阶段不启用。"
    };
  }

  /* ---------------------------------------------------------------- 候选侧适配 */

  function detectLane(candidate, options) {
    if (isPlainObject(options) && typeof options.lane === "string") {
      if (options.lane === LANE.MAIN || options.lane === LANE.EXPLORATION) {
        return { lane: options.lane, source: "explicit", reasons: [] };
      }
    }
    if (!isPlainObject(candidate)) {
      return { lane: null, source: "none", reasons: [] };
    }
    const hasMain =
      isPlainObject(candidate.partitionFeatures) ||
      isPlainObject(candidate.titleFeatures);
    const hasExploration =
      Array.isArray(candidate.partitionCounts) ||
      Array.isArray(candidate.titleTokens);
    if (hasMain && !hasExploration) {
      return { lane: LANE.MAIN, source: "detected", reasons: [] };
    }
    if (hasExploration && !hasMain) {
      return { lane: LANE.EXPLORATION, source: "detected", reasons: [] };
    }
    return { lane: null, source: "none", reasons: [] };
  }

  /**
   * 身份冲突检查：冲突优先于内容完整度。
   * 只读取既有字段，不重新判定冲突，也不修改候选。
   */
  function readIdentityBlock(candidate) {
    const reasons = [];
    let blocked = false;

    if (!isPlainObject(candidate)) {
      return { blocked: false, reasons };
    }
    if (candidate.hasUidConflict === true) {
      blocked = true;
      reasons.push(reason("uid-conflict", "候选存在 UID 身份冲突，内容特征不可用于推荐"));
    }

    const evidence = isPlainObject(candidate.evidence) ? candidate.evidence : null;
    if (
      evidence &&
      Number.isInteger(evidence.conflictVideoCount) &&
      evidence.conflictVideoCount > 0
    ) {
      blocked = true;
      reasons.push(
        reason(
          "uid-conflict-videos",
          `${evidence.conflictVideoCount} 个视频存在身份冲突，内容归属不可信`
        )
      );
    }

    if (
      Number.isInteger(candidate.conflictVideoCount) &&
      candidate.conflictVideoCount > 0
    ) {
      blocked = true;
      reasons.push(
        reason(
          "uid-conflict-videos",
          `${candidate.conflictVideoCount} 个视频存在身份冲突，内容归属不可信`
        )
      );
    }

    const identity = isPlainObject(candidate.identityEvidence)
      ? candidate.identityEvidence
      : null;
    if (identity) {
      if (identity.hasIdentityConflict === true) {
        blocked = true;
        reasons.push(
          reason("identity-conflict", "评估结果显示候选存在身份冲突")
        );
      }
      if (
        Number.isInteger(identity.crossSourceConflictVideoCount) &&
        identity.crossSourceConflictVideoCount > 0
      ) {
        blocked = true;
        reasons.push(
          reason(
            "cross-source-conflict",
            `${identity.crossSourceConflictVideoCount} 个视频与本地观看记录冲突`
          )
        );
      }
    }

    // 去重（同一 code 只保留一条）
    const seen = new Set();
    const deduped = [];
    reasons.forEach((item) => {
      if (seen.has(item.code)) return;
      seen.add(item.code);
      deduped.push(item);
    });
    return { blocked, reasons: deduped };
  }

  function candidateCoverage(candidate, fallbackBasis) {
    const value =
      typeof candidate.partitionCoverage === "number" &&
      Number.isFinite(candidate.partitionCoverage)
        ? clamp(candidate.partitionCoverage, 0, 1)
        : null;
    return {
      ratio: value,
      basis:
        typeof candidate.partitionCoverageBasis === "string" &&
        candidate.partitionCoverageBasis
          ? candidate.partitionCoverageBasis
          : fallbackBasis
    };
  }

  /**
   * 候选分区向量。
   *
   * main lane：读 C2-3 的 partitionFeatures.partitions[].shareOfIdentified（watch-ms）。
   * exploration lane：读 C2-4B 的 partitionCounts[].shareOfImportedVideos（video-count）。
   *
   * 只读取、不修改候选；字段缺失时返回 unavailable，绝不虚构向量。
   *
   * @param {object} candidate 候选对象（C2-3 输出或 C2-4B sidecar 候选）
   * @param {object} [options] { lane }
   */
  function buildCandidatePartitionVector(candidate, options) {
    const opts = isPlainObject(options) ? options : {};
    const detected = detectLane(candidate, opts);
    const lane = detected.lane;
    const reasons = detected.reasons.slice();

    if (!isPlainObject(candidate)) {
      return candidateUnavailable(
        FEATURE_SPACE.PARTITION,
        lane,
        BASIS.UNSPECIFIED,
        [reason("invalid-candidate", "候选不是对象，无法构建分区向量")],
        detected
      );
    }

    const identity = readIdentityBlock(candidate);
    if (identity.blocked) {
      return candidateBlocked(
        FEATURE_SPACE.PARTITION,
        lane,
        identity.reasons,
        detected
      );
    }

    if (lane === null) {
      return candidateUnavailable(
        FEATURE_SPACE.PARTITION,
        null,
        BASIS.UNSPECIFIED,
        [reason("unknown-lane", "无法从候选结构判断属于 main 还是 exploration")],
        detected
      );
    }

    const entries = {};
    let skippedUnidentified = 0;
    let invalidEntries = 0;

    if (lane === LANE.MAIN) {
      const features = isPlainObject(candidate.partitionFeatures)
        ? candidate.partitionFeatures
        : null;
      const partitions =
        features && Array.isArray(features.partitions) ? features.partitions : null;
      if (partitions) {
        partitions.forEach((entry) => {
          if (!isPlainObject(entry)) {
            invalidEntries += 1;
            return;
          }
          const name = entry.name;
          if (!isIdentifiedPartition(name)) {
            skippedUnidentified += 1;
            return;
          }
          const share = toNonNegativeNumber(entry.shareOfIdentified);
          if (share === null) {
            invalidEntries += 1;
            return;
          }
          setOwn(entries, name, share);
        });
      } else if (features && isPlainObject(features.vector)) {
        Object.keys(features.vector).forEach((name) => {
          if (!isIdentifiedPartition(name)) {
            skippedUnidentified += 1;
            return;
          }
          const share = toNonNegativeNumber(features.vector[name]);
          if (share === null) {
            invalidEntries += 1;
            return;
          }
          setOwn(entries, name, share);
        });
      } else {
        reasons.push(
          reason("missing-partition-features", "候选没有 C2-3 分区特征（partitionFeatures）")
        );
      }
    } else {
      const counts = Array.isArray(candidate.partitionCounts)
        ? candidate.partitionCounts
        : null;
      if (counts) {
        counts.forEach((entry) => {
          if (!isPlainObject(entry)) {
            invalidEntries += 1;
            return;
          }
          const name = entry.name;
          if (!isIdentifiedPartition(name)) {
            skippedUnidentified += 1;
            return;
          }
          const share = toNonNegativeNumber(entry.shareOfImportedVideos);
          if (share === null) {
            invalidEntries += 1;
            return;
          }
          setOwn(entries, name, share);
        });
      } else {
        reasons.push(
          reason("missing-partition-counts", "候选没有 C2-4B 分区计数（partitionCounts）")
        );
      }
    }

    const vector = normalizeVector(entries);
    const dimensions = Object.keys(vector);
    const available = dimensions.length > 0;
    const basis =
      lane === LANE.MAIN ? BASIS.WATCH_MS : BASIS.VIDEO_COUNT;
    const coverage = candidateCoverage(candidate, basis);

    if (!available && reasons.length === 0) {
      reasons.push(
        reason("no-identified-partition", "候选没有任何可识别的分区")
      );
    }

    return {
      kind: "bili-daily-recommend-vector",
      module: MODULE_KIND,
      version: MODULE_VERSION,
      space: FEATURE_SPACE.PARTITION,
      side: SIDE.CANDIDATE,
      lane,
      laneSource: detected.source,
      basis,
      status: available ? STATUS.OK : STATUS.UNAVAILABLE,
      available,
      vector: available ? vector : null,
      dimensions,
      norm: available ? computeNorm(vector) : 0,
      weighting: lane === LANE.MAIN ? "watch-ms-share" : "video-count-share",
      decay: "none",
      coverage: {
        basis: coverage.basis,
        ratio: coverage.ratio,
        source:
          lane === LANE.MAIN
            ? "candidate.partitionCoverage"
            : "candidate.partitionCoverage"
      },
      sample: {
        skippedUnidentified,
        invalidEntries
      },
      source: {
        module: lane === LANE.MAIN ? "candidate-features.js" : "candidate-content-import.js",
        field:
          lane === LANE.MAIN
            ? "partitionFeatures.partitions[].shareOfIdentified"
            : "partitionCounts[].shareOfImportedVideos"
      },
      reasons,
      note:
        lane === LANE.MAIN
          ? "main lane 分区权重来自观看时长，与用户向量同口径。"
          : "exploration lane 分区权重来自导入视频数量，与用户向量口径不同，" +
            "比较时必须显式声明近似。"
    };
  }

  /**
   * 候选标题词频。
   *
   * main lane：C2-3 的 titleFeatures.tokens[].count
   * exploration lane：C2-4B 的 titleTokens[].count
   *
   * count 是跨视频的总出现次数；documentCount 属于视频级统计，
   * 不参与 IDF 的候选文档频次计算（df 按候选文档统计，见 computeIdf）。
   */
  function buildCandidateTextCounts(candidate, options) {
    const opts = isPlainObject(options) ? options : {};
    const detected = detectLane(candidate, opts);
    const lane = detected.lane;
    const reasons = detected.reasons.slice();

    if (!isPlainObject(candidate)) {
      return candidateTextUnavailable(
        lane,
        [reason("invalid-candidate", "候选不是对象，无法构建标题词频")],
        detected
      );
    }

    const identity = readIdentityBlock(candidate);
    if (identity.blocked) {
      return candidateTextBlocked(identity.reasons, detected);
    }

    if (lane === null) {
      return candidateTextUnavailable(
        null,
        [reason("unknown-lane", "无法从候选结构判断属于 main 还是 exploration")],
        detected
      );
    }

    const reasonsList = reasons;
    let tokens = null;
    let invalidEntries = 0;

    if (lane === LANE.MAIN) {
      const features = isPlainObject(candidate.titleFeatures)
        ? candidate.titleFeatures
        : null;
      tokens = features && Array.isArray(features.tokens) ? features.tokens : null;
      if (!tokens) {
        reasonsList.push(
          reason("missing-title-features", "候选没有 C2-3 标题特征（titleFeatures.tokens）")
        );
      }
    } else {
      tokens = Array.isArray(candidate.titleTokens) ? candidate.titleTokens : null;
      if (!tokens) {
        reasonsList.push(
          reason("missing-title-tokens", "候选没有 C2-4B 标题词元（titleTokens）")
        );
      }
    }

    const counts = new Map();
    if (tokens) {
      tokens.forEach((entry) => {
        if (!isPlainObject(entry)) {
          invalidEntries += 1;
          return;
        }
        const token = entry.token;
        const count = toNonNegativeNumber(entry.count);
        if (typeof token !== "string" || !token || count === null || count <= 0) {
          invalidEntries += 1;
          return;
        }
        counts.set(token, (counts.get(token) || 0) + count);
      });
    }

    const sorted = Array.from(counts.entries())
      .map(([token, count]) => ({ token, count }))
      .sort(
        (left, right) =>
          right.count - left.count || compareText(left.token, right.token)
      );

    const countObject = {};
    let totalTokenCount = 0;
    sorted.forEach((entry) => {
      setOwn(countObject, entry.token, entry.count);
      totalTokenCount += entry.count;
    });

    const dimensions = sorted.map((entry) => entry.token);
    const available = dimensions.length > 0;
    if (!available && reasonsList.length === 0) {
      reasonsList.push(reason("no-title-tokens", "候选没有任何可用标题词元"));
    }

    const titleCoverage =
      typeof candidate.titleCoverage === "number" &&
      Number.isFinite(candidate.titleCoverage)
        ? clamp(candidate.titleCoverage, 0, 1)
        : null;

    return {
      kind: "bili-daily-recommend-counts",
      module: MODULE_KIND,
      version: MODULE_VERSION,
      space: FEATURE_SPACE.TITLE,
      side: SIDE.CANDIDATE,
      lane,
      laneSource: detected.source,
      basis: BASIS.TOKEN_COUNT,
      status: available ? STATUS.OK : STATUS.UNAVAILABLE,
      available,
      counts: countObject,
      dimensions,
      tokenCount: dimensions.length,
      totalTokenCount,
      truncated: false,
      truncatedTokens: 0,
      weighting: "raw-count",
      decay: "none",
      coverage: {
        basis: BASIS.VIDEO_COUNT,
        ratio: titleCoverage,
        source: "candidate.titleCoverage"
      },
      sample: {
        invalidEntries,
        documentCount:
          lane === LANE.MAIN && isPlainObject(candidate.titleFeatures) &&
          Number.isInteger(candidate.titleFeatures.documentCount)
            ? candidate.titleFeatures.documentCount
            : null
      },
      source: {
        module: lane === LANE.MAIN ? "candidate-features.js" : "candidate-content-import.js",
        field: lane === LANE.MAIN ? "titleFeatures.tokens[].count" : "titleTokens[].count"
      },
      reasons: reasonsList,
      note:
        "词元为字符 bigram，与 C2-3 同一套归一化；" +
        "此处 count 是出现次数，IDF 的 df 按候选文档统计，二者不可混用。"
    };
  }

  function candidateUnavailable(space, lane, basis, reasons, detected) {
    return {
      kind: "bili-daily-recommend-vector",
      module: MODULE_KIND,
      version: MODULE_VERSION,
      space,
      side: SIDE.CANDIDATE,
      lane: lane === undefined ? null : lane,
      laneSource: detected ? detected.source : "none",
      basis,
      status: STATUS.UNAVAILABLE,
      available: false,
      vector: null,
      dimensions: [],
      norm: 0,
      weighting: "none",
      decay: "none",
      coverage: { basis, ratio: null, source: "" },
      sample: { skippedUnidentified: 0, invalidEntries: 0 },
      source: { module: "", field: "" },
      reasons,
      note: "缺少内容特征，返回不可用状态，不虚构向量。"
    };
  }

  function candidateTextUnavailable(lane, reasons, detected) {
    return {
      kind: "bili-daily-recommend-counts",
      module: MODULE_KIND,
      version: MODULE_VERSION,
      space: FEATURE_SPACE.TITLE,
      side: SIDE.CANDIDATE,
      lane: lane === undefined ? null : lane,
      laneSource: detected ? detected.source : "none",
      basis: BASIS.TOKEN_COUNT,
      status: STATUS.UNAVAILABLE,
      available: false,
      counts: {},
      dimensions: [],
      tokenCount: 0,
      totalTokenCount: 0,
      truncated: false,
      truncatedTokens: 0,
      weighting: "none",
      decay: "none",
      coverage: { basis: BASIS.VIDEO_COUNT, ratio: null, source: "" },
      sample: { invalidEntries: 0, documentCount: null },
      source: { module: "", field: "" },
      reasons,
      note: "缺少标题特征，返回不可用状态，不虚构词元。"
    };
  }

  function candidateBlocked(space, lane, reasons, detected) {
    return {
      kind: "bili-daily-recommend-vector",
      module: MODULE_KIND,
      version: MODULE_VERSION,
      space,
      side: SIDE.CANDIDATE,
      lane: lane === undefined ? null : lane,
      laneSource: detected ? detected.source : "none",
      basis: BASIS.UNSPECIFIED,
      status: STATUS.BLOCKED,
      available: false,
      vector: null,
      dimensions: [],
      norm: 0,
      weighting: "none",
      decay: "none",
      coverage: { basis: BASIS.UNSPECIFIED, ratio: null, source: "" },
      sample: { skippedUnidentified: 0, invalidEntries: 0 },
      source: { module: "", field: "" },
      reasons,
      note: "身份冲突优先于内容完整度：即使特征齐全，也不提供可匹配向量。"
    };
  }

  function candidateTextBlocked(reasons, detected) {
    return {
      kind: "bili-daily-recommend-counts",
      module: MODULE_KIND,
      version: MODULE_VERSION,
      space: FEATURE_SPACE.TITLE,
      side: SIDE.CANDIDATE,
      lane: detected && detected.lane ? detected.lane : null,
      laneSource: detected ? detected.source : "none",
      basis: BASIS.TOKEN_COUNT,
      status: STATUS.BLOCKED,
      available: false,
      counts: {},
      dimensions: [],
      tokenCount: 0,
      totalTokenCount: 0,
      truncated: false,
      truncatedTokens: 0,
      weighting: "none",
      decay: "none",
      coverage: { basis: BASIS.VIDEO_COUNT, ratio: null, source: "" },
      sample: { invalidEntries: 0, documentCount: null },
      source: { module: "", field: "" },
      reasons,
      note: "身份冲突优先于内容完整度：即使标题齐全，也不提供可匹配词频。"
    };
  }

  /* ---------------------------------------------------------------- IDF */

  /**
   * 计算 IDF 模型。每个候选 UP 主是一个「文档」。
   *
   *   N        = 至少含一个有效词元的候选文档数
   *   df(t)    = 含词元 t 的候选文档数（不是视频数）
   *   idf(t)   = ln((N+1)/(df(t)+1)) + 1
   *
   * 规则：
   *   - 文档数 < minIdfDocuments（默认 20）时关闭 IDF，统一权重 1；
   *   - 空语料不产生 NaN / Infinity；
   *   - options.frozen 标记模型可用于离线评测冻结复用；
   *   - 只读入参，不修改任何文档。
   *
   * @param {Array} documents 词频对象数组，或 [{counts: {...}}]
   * @param {object} [options] { minIdfDocuments, idfEnabled, frozen, lane }
   */
  function computeIdf(documents, options) {
    const opts = isPlainObject(options) ? options : {};
    const reasons = [];
    const list = Array.isArray(documents) ? documents : [];

    const minDocuments =
      Number.isFinite(opts.minIdfDocuments) && opts.minIdfDocuments >= 1
        ? Math.floor(opts.minIdfDocuments)
        : DEFAULT_CONFIG.minIdfDocuments;

    const df = new Map();
    let validDocuments = 0;
    let skippedDocuments = 0;
    let emptyDocuments = 0;
    let invalidEntries = 0;

    list.forEach((doc) => {
      // 变量名刻意不用 document，避免在浏览器扩展里与 DOM 全局混淆。
      let counts = null;
      if (isPlainObject(doc) && isPlainObject(doc.counts)) {
        counts = doc.counts;
      } else if (isPlainObject(doc)) {
        counts = doc;
      } else {
        skippedDocuments += 1;
        return;
      }

      const tokens = Object.keys(counts).filter((token) => {
        if (!token) return false;
        const value = toNonNegativeNumber(counts[token]);
        if (value === null) {
          invalidEntries += 1;
          return false;
        }
        return value > 0;
      });

      if (tokens.length === 0) {
        emptyDocuments += 1;
        return;
      }
      validDocuments += 1;
      tokens.forEach((token) => {
        df.set(token, (df.get(token) || 0) + 1);
      });
    });

    const enabledByConfig = opts.idfEnabled !== false;
    const enabled = enabledByConfig && validDocuments >= minDocuments;
    if (!enabledByConfig) {
      reasons.push(reason("idf-disabled", "调用方显式关闭 IDF，使用统一权重 1"));
    } else if (validDocuments === 0) {
      reasons.push(reason("empty-corpus", "IDF 语料为空，不产生任何权重"));
    } else if (validDocuments < minDocuments) {
      reasons.push(
        reason(
          "small-corpus",
          `候选文档数 ${validDocuments} 少于阈值 ${minDocuments}，关闭 IDF`
        )
      );
    }

    const sortedTokens = Array.from(df.keys()).sort(compareText);
    const dfObject = {};
    const idfObject = {};
    const N = validDocuments;
    sortedTokens.forEach((token) => {
      const value = df.get(token);
      setOwn(dfObject, token, value);
      setOwn(idfObject, token, Math.log((N + 1) / (value + 1)) + 1);
    });

    // 未登录词权重 = df 0 时的平滑值；N = 0 时为 ln(1)+1 = 1。
    const oovIdf = Math.log(N + 1) + 1;

    return {
      kind: "bili-daily-idf-model",
      module: MODULE_KIND,
      version: MODULE_VERSION,
      space: FEATURE_SPACE.TITLE,
      basis: BASIS.TOKEN_COUNT,
      lane: typeof opts.lane === "string" ? opts.lane : null,
      enabled,
      documentBasis: "candidate-up",
      documentCount: N,
      inputDocumentCount: list.length,
      emptyDocuments,
      skippedDocuments,
      invalidEntries,
      tokenCount: sortedTokens.length,
      df: dfObject,
      idf: idfObject,
      formula: IDF_FORMULA,
      tfFormula: TF_FORMULA,
      minDocuments,
      oovIdf,
      frozen: opts.frozen === true,
      reasons,
      note:
        "df 按候选文档统计，不按视频数统计；用户文档不得进入候选语料。" +
        "模型可 JSON 往返后复用，用于时间切分的离线评测。"
    };
  }

  /* ---------------------------------------------------------------- TF-IDF 向量 */

  /**
   * 校验外部 IDF 模型的结构。
   *
   * 合法模型（computeIdf 的返回值或 JSON 往返后的冻结模型）必须满足：
   *   - enabled 是布尔值；
   *   - documentCount 是非负整数；
   *   - oovIdf 是有限正数；
   *   - idf 是普通对象，且每个值都是有限正数；
   *   - 若存在 df / minDocuments，也必须是合法结构。
   *
   * 返回值：
   *   - { ok: true, model: null }  —— 未提供模型，调用方明确使用统一权重 1；
   *   - { ok: true, model }        —— 结构合法；
   *   - { ok: false, code, message } —— 结构损坏，调用方必须显式拒绝。
   *
   * 注意：这里**不做任何修补**（不补默认值、不丢弃坏字段），
   * 否则会把损坏数据伪装成有效模型。
   */
  function validateIdfModel(model) {
    if (model === null || model === undefined) {
      return { ok: true, model: null };
    }
    if (!isPlainObject(model)) {
      return {
        ok: false,
        code: "invalid-model-object",
        message: "IDF 模型不是普通对象"
      };
    }
    if (typeof model.enabled !== "boolean") {
      return {
        ok: false,
        code: "invalid-model-enabled",
        message: "IDF 模型缺少布尔型 enabled 字段"
      };
    }
    if (
      typeof model.documentCount !== "number" ||
      !Number.isInteger(model.documentCount) ||
      model.documentCount < 0
    ) {
      return {
        ok: false,
        code: "invalid-model-document-count",
        message: "IDF 模型 documentCount 必须是非负整数"
      };
    }
    if (
      typeof model.oovIdf !== "number" ||
      !Number.isFinite(model.oovIdf) ||
      model.oovIdf <= 0
    ) {
      return {
        ok: false,
        code: "invalid-model-oov-idf",
        message: "IDF 模型 oovIdf 必须是有限正数"
      };
    }
    if (!isPlainObject(model.idf)) {
      return {
        ok: false,
        code: "invalid-model-idf",
        message: "IDF 模型 idf 必须是普通对象"
      };
    }

    const idfKeys = Object.keys(model.idf);
    for (let index = 0; index < idfKeys.length; index += 1) {
      const token = idfKeys[index];
      const value = model.idf[token];
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value <= 0
      ) {
        return {
          ok: false,
          code: "invalid-model-idf-value",
          message: `IDF 模型 idf["${token}"] 不是有限正数`
        };
      }
    }

    if (
      model.minDocuments !== undefined &&
      (typeof model.minDocuments !== "number" ||
        !Number.isFinite(model.minDocuments) ||
        model.minDocuments < 0)
    ) {
      return {
        ok: false,
        code: "invalid-model-min-documents",
        message: "IDF 模型 minDocuments 必须是非负有限数"
      };
    }

    if (model.df !== undefined) {
      if (!isPlainObject(model.df)) {
        return {
          ok: false,
          code: "invalid-model-df",
          message: "IDF 模型 df 必须是普通对象"
        };
      }
      const dfKeys = Object.keys(model.df);
      for (let index = 0; index < dfKeys.length; index += 1) {
        const token = dfKeys[index];
        const value = model.df[token];
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < 0
        ) {
          return {
            ok: false,
            code: "invalid-model-df-value",
            message: `IDF 模型 df["${token}"] 必须是非负整数`
          };
        }
      }
    }

    return { ok: true, model };
  }

  /** 损坏 IDF 模型的显式拒绝输出（结构与其他向量一致，可 JSON 往返）。 */
  function rejectedTfIdfVector(modelCheck) {
    return {
      kind: "bili-daily-tfidf-vector",
      module: MODULE_KIND,
      version: MODULE_VERSION,
      space: FEATURE_SPACE.TITLE,
      basis: BASIS.TOKEN_COUNT,
      status: "invalid-idf-model",
      available: false,
      vector: null,
      dimensions: [],
      norm: 0,
      tokenCount: 0,
      totalCount: 0,
      oovTokens: 0,
      invalidEntries: 0,
      config: {
        idfEnabled: false,
        documentCount: null,
        minDocuments: null,
        oovIdf: null,
        tfFormula: TF_FORMULA,
        idfFormula: IDF_FORMULA,
        modelFrozen: false,
        modelLane: null,
        modelRejected: true,
        modelRejectCode: modelCheck.code
      },
      reasons: [reason(modelCheck.code, modelCheck.message)],
      note:
        "外部 IDF 模型结构不合法，已显式拒绝构建向量；" +
        "不做静默修补，避免把损坏模型伪装成有效结果。"
    };
  }

  /**
   * 由词频与 IDF 模型构建 TF-IDF 向量。
   *
   *   tf'(t,d) = 1 + ln(tf(t,d))            （tf > 0 时）
   *   w(t,d)   = tf'(t,d) × idf(t)          （IDF 关闭时 idf 恒为 1）
   *
   * - model 可以是 computeIdf 的返回值，也可以是 JSON 往返后的冻结模型；
   * - model 为 null / undefined → 统一权重 1（这是明确语义，不是降级）；
   * - 模型结构损坏 → status = "invalid-idf-model"，vector = null，
   *   不抛异常、不静默修正；
   * - 未登录词使用 model.oovIdf，不产生 NaN；
   * - 不修改 counts 或 model。
   */
  function buildTfIdfVector(counts, model, options) {
    const opts = isPlainObject(options) ? options : {};
    const reasons = [];
    const input = isPlainObject(counts) ? counts : {};
    if (!isPlainObject(counts)) {
      reasons.push(reason("invalid-counts", "词频不是对象，按空向量处理"));
    }

    const modelCheck = validateIdfModel(model);
    if (!modelCheck.ok) {
      return rejectedTfIdfVector(modelCheck);
    }

    const idfModel = modelCheck.model;
    const idfEnabled =
      idfModel !== null && idfModel.enabled === true;

    let documentCount = 0;
    let minDocuments = DEFAULT_CONFIG.minIdfDocuments;
    let oovIdf = 1;
    if (idfModel) {
      documentCount = Number.isFinite(idfModel.documentCount)
        ? idfModel.documentCount
        : 0;
      minDocuments = Number.isFinite(idfModel.minDocuments)
        ? idfModel.minDocuments
        : DEFAULT_CONFIG.minIdfDocuments;
      oovIdf =
        typeof idfModel.oovIdf === "number" && Number.isFinite(idfModel.oovIdf)
          ? idfModel.oovIdf
          : Math.log(documentCount + 1) + 1;
    }

    const entries = {};
    let totalCount = 0;
    let invalidEntries = 0;
    let oovTokens = 0;

    Object.keys(input)
      .sort(compareText)
      .forEach((token) => {
        const count = toNonNegativeNumber(input[token]);
        if (!token || count === null || count <= 0) {
          invalidEntries += 1;
          return;
        }
        totalCount += count;
        const tf = 1 + Math.log(count);

        let idf = 1;
        if (idfEnabled) {
          if (hasOwn(idfModel.idf, token)) {
            const value = idfModel.idf[token];
            if (typeof value === "number" && Number.isFinite(value) && value > 0) {
              idf = value;
            } else {
              invalidEntries += 1;
              idf = oovIdf;
            }
          } else {
            oovTokens += 1;
            idf = oovIdf;
          }
        }

        const weight = tf * idf;
        if (!Number.isFinite(weight) || weight <= 0) {
          invalidEntries += 1;
          return;
        }
        setOwn(entries, token, weight);
      });

    const vector = normalizeVector(entries);
    const dimensions = Object.keys(vector);

    return {
      kind: "bili-daily-tfidf-vector",
      module: MODULE_KIND,
      version: MODULE_VERSION,
      space: FEATURE_SPACE.TITLE,
      basis: BASIS.TOKEN_COUNT,
      status: dimensions.length > 0 ? STATUS.OK : STATUS.UNAVAILABLE,
      available: dimensions.length > 0,
      vector: dimensions.length > 0 ? vector : null,
      dimensions,
      norm: dimensions.length > 0 ? computeNorm(vector) : 0,
      tokenCount: dimensions.length,
      totalCount,
      oovTokens,
      invalidEntries,
      config: {
        idfEnabled,
        documentCount,
        minDocuments,
        oovIdf,
        tfFormula: TF_FORMULA,
        idfFormula: IDF_FORMULA,
        modelFrozen: idfModel ? idfModel.frozen === true : false,
        modelLane: idfModel && typeof idfModel.lane === "string" ? idfModel.lane : null
      },
      reasons,
      note:
        "IDF 关闭时 idf 恒为 1，等价于次线性 TF；" +
        "本函数不产出推荐分数，只产出可比较的向量。" +
        (opts.note ? ` ${opts.note}` : "")
    };
  }

  /* ---------------------------------------------------------------- 余弦 */

  function readVectorInput(input) {
    // 只把「带 vector 字段的对象」当作向量包装；vector === null 表示
    // 该组件不可用，而不是一个装着字符串字段的普通向量。
    if (
      isPlainObject(input) &&
      hasOwn(input, "vector") &&
      (isPlainObject(input.vector) || input.vector === null)
    ) {
      return {
        ok: true,
        vector: input.vector,
        basis:
          typeof input.basis === "string" && input.basis
            ? input.basis
            : BASIS.UNSPECIFIED,
        space: typeof input.space === "string" ? input.space : null,
        side: typeof input.side === "string" ? input.side : null,
        lane: typeof input.lane === "string" ? input.lane : null,
        coverage:
          isPlainObject(input.coverage) &&
          typeof input.coverage.ratio === "number" &&
          Number.isFinite(input.coverage.ratio)
            ? clamp(input.coverage.ratio, 0, 1)
            : null,
        coverageBasis:
          isPlainObject(input.coverage) && typeof input.coverage.basis === "string"
            ? input.coverage.basis
            : null,
        reasons: Array.isArray(input.reasons) ? input.reasons.slice() : []
      };
    }
    if (isPlainObject(input)) {
      return {
        ok: true,
        vector: input,
        basis: BASIS.UNSPECIFIED,
        space: null,
        side: null,
        lane: null,
        coverage: null,
        coverageBasis: null,
        reasons: []
      };
    }
    return {
      ok: false,
      vector: null,
      basis: BASIS.UNSPECIFIED,
      space: null,
      side: null,
      lane: null,
      coverage: null,
      coverageBasis: null,
      reasons: []
    };
  }

  /**
   * 校验稀疏向量：
   *   - 只接受普通对象（拒绝数组 / null）；
   *   - 权重必须是有限、非负的数字；非法权重 → 整个向量不可用（rejected）。
   * 不修改入参。
   */
  function validateVector(vector) {
    if (!isPlainObject(vector)) {
      return { ok: false, reason: "not-object", dimensions: [], norm: 0 };
    }
    const keys = Object.keys(vector).sort(compareText);
    let invalid = false;
    let normSum = 0;
    const dimensions = [];
    keys.forEach((key) => {
      const value = vector[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        invalid = true;
        return;
      }
      if (value > 0) {
        dimensions.push(key);
        normSum += value * value;
      }
    });
    if (invalid) {
      return { ok: false, reason: "invalid-weight", dimensions: [], norm: 0 };
    }
    return {
      ok: true,
      reason: "",
      dimensions,
      norm: Math.sqrt(normSum)
    };
  }

  function basisComparable(leftBasis, rightBasis) {
    if (leftBasis === rightBasis) return true;
    return leftBasis === BASIS.UNSPECIFIED || rightBasis === BASIS.UNSPECIFIED;
  }

  /** 两侧都声明了 space 且不一致 → 特征空间不匹配。 */
  function spaceMismatch(leftSpace, rightSpace) {
    return (
      typeof leftSpace === "string" &&
      typeof rightSpace === "string" &&
      leftSpace !== rightSpace
    );
  }

  /**
   * 余弦相似度（纯函数）。
   *
   * 返回：
   *   - number ∈ [0,1]：正常结果；
   *   - 0：两侧非空但没有共同维度（确实不相似）；
   *   - null：空向量 / 零范数 / 非法权重 /
   *           特征空间不一致 / 未声明的跨口径比较。
   *
   * null 表示“无法判断”，调用方不得把它当成 0。
   * 显式允许跨口径时传 options.allowCrossBasis = true；
   * **该选项只放宽统计口径，绝不放宽特征空间**（partition vs title 永远返回 null）。
   * 未声明 space 的原始稀疏向量保持纯数学兼容，限制由 compareVectors 说明。
   */
  function cosineSimilarity(left, right, options) {
    const opts = isPlainObject(options) ? options : {};
    const leftInput = readVectorInput(left);
    const rightInput = readVectorInput(right);
    if (!leftInput.ok || !rightInput.ok) return null;

    // 特征空间优先于统计口径：不同空间的向量没有共同语义，任何选项都不放行。
    if (spaceMismatch(leftInput.space, rightInput.space)) return null;

    const leftCheck = validateVector(leftInput.vector);
    const rightCheck = validateVector(rightInput.vector);
    if (!leftCheck.ok || !rightCheck.ok) return null;
    if (leftCheck.norm === 0 || rightCheck.norm === 0) return null;

    if (
      !basisComparable(leftInput.basis, rightInput.basis) &&
      opts.allowCrossBasis !== true
    ) {
      return null;
    }

    const leftKeys = leftCheck.dimensions;
    const rightKeys = rightCheck.dimensions;
    const keySet = new Set(leftKeys.concat(rightKeys));
    const keys = Array.from(keySet).sort(compareText);

    let dot = 0;
    keys.forEach((key) => {
      const leftValue = hasOwn(leftInput.vector, key) ? leftInput.vector[key] : 0;
      const rightValue = hasOwn(rightInput.vector, key) ? rightInput.vector[key] : 0;
      dot += leftValue * rightValue;
    });

    const value = dot / (leftCheck.norm * rightCheck.norm);
    if (!Number.isFinite(value)) return null;
    // 非负向量理论上落在 [0,1]；浮点误差在 1e-12 内按边界处理。
    if (value > 1 && value - 1 < 1e-12) return 1;
    if (value < 0 && value > -1e-12) return 0;
    if (value < 0 || value > 1) return null;
    return value;
  }

  /**
   * 带审计信息的向量比较。
   *
   * 与 cosineSimilarity 使用同一套数学，但返回：
   *   - status：ok / approximation / cross-basis-rejected / space-mismatch /
   *             insufficient-data / invalid-input
   *   - similarity：number 或 null（null 绝不等价于 0）
   *   - spaces：两侧声明的特征空间（未声明为 null）
   *   - approximate + bases + limitations：跨口径时的可审计标记
   *   - coverage / evidence：两侧证据质量元数据
   *   - confidencePolicy：固定为 "deferred-to-c3-2"，本模块不产出置信度等级
   */
  function compareVectors(left, right, options) {
    const opts = isPlainObject(options) ? options : {};
    const leftInput = readVectorInput(left);
    const rightInput = readVectorInput(right);
    const reasons = [];
    const limitations = [];

    const leftBlock = summarizeSide(leftInput);
    const rightBlock = summarizeSide(rightInput);
    const bases = { left: leftInput.basis, right: rightInput.basis };
    const spaces = { left: leftInput.space, right: rightInput.space };
    const approximateRequested = opts.allowCrossBasis === true;
    const crossBasis = !basisComparable(leftInput.basis, rightInput.basis);
    const crossSpace = spaceMismatch(leftInput.space, rightInput.space);
    const spaceUnknown =
      leftInput.space === null || rightInput.space === null;

    const result = {
      kind: "bili-daily-similarity",
      module: MODULE_KIND,
      version: MODULE_VERSION,
      space:
        typeof opts.space === "string"
          ? opts.space
          : leftInput.space || rightInput.space || null,
      lane:
        typeof opts.lane === "string"
          ? opts.lane
          : leftInput.lane || rightInput.lane || null,
      status: "ok",
      similarity: null,
      approximate: false,
      bases,
      spaces,
      evidence: {
        left: leftBlock,
        right: rightBlock,
        minCoverage: minCoverage(leftBlock.coverage, rightBlock.coverage),
        // 置信度分级规则属于 C3-2，C3-1 只提供输入。
        confidencePolicy: "deferred-to-c3-2"
      },
      limitations,
      reasons,
      config: {
        allowCrossBasis: approximateRequested,
        cosineClamp: [0, 1]
      }
    };

    if (!leftInput.ok || !rightInput.ok) {
      result.status = "invalid-input";
      reasons.push(reason("invalid-vector-input", "向量不是普通对象"));
      return result;
    }

    // 特征空间不一致：partition 与 title 没有共同语义，任何选项都不放行。
    // allowCrossBasis 只放宽统计口径，不放宽特征空间。
    if (crossSpace) {
      result.status = "space-mismatch";
      limitations.push(
        `特征空间不同（${leftInput.space} vs ${rightInput.space}），相似度没有意义`
      );
      reasons.push(
        reason(
          "space-mismatch",
          "partition 与 title 属于不同特征空间，不允许互相比较"
        )
      );
      return result;
    }

    // 组件不可用（vector = null）≠ 输入非法，更 ≠ 不相似。
    if (leftInput.vector === null || rightInput.vector === null) {
      result.status = "insufficient-data";
      reasons.push(
        reason("vector-unavailable", "至少一侧没有可用向量（内容组件不可用）")
      );
      return result;
    }

    const leftCheck = validateVector(leftInput.vector);
    const rightCheck = validateVector(rightInput.vector);
    if (!leftCheck.ok) {
      result.status = "invalid-input";
      reasons.push(reason("invalid-left-vector", "左侧向量包含非法权重"));
      return result;
    }
    if (!rightCheck.ok) {
      result.status = "invalid-input";
      reasons.push(reason("invalid-right-vector", "右侧向量包含非法权重"));
      return result;
    }

    if (leftCheck.norm === 0 || rightCheck.norm === 0) {
      result.status = "insufficient-data";
      reasons.push(
        reason("zero-norm", "至少一侧向量为空或零范数，相似度无法计算")
      );
      return result;
    }

    if (crossBasis && !approximateRequested) {
      result.status = "cross-basis-rejected";
      limitations.push(
        `两侧统计口径不同（${leftInput.basis} vs ${rightInput.basis}），默认不允许比较`
      );
      reasons.push(
        reason("cross-basis-rejected", "跨口径比较需要显式声明 allowCrossBasis")
      );
      return result;
    }

    const similarity = cosineSimilarity(leftInput, rightInput, {
      allowCrossBasis: approximateRequested
    });
    if (similarity === null) {
      result.status = "insufficient-data";
      reasons.push(reason("similarity-unavailable", "余弦相似度不可计算"));
      return result;
    }

    result.similarity = similarity;

    if (crossBasis) {
      result.status = "approximation";
      result.approximate = true;
      limitations.push(
        `左侧口径 ${leftInput.basis}，右侧口径 ${rightInput.basis}；` +
          "结果只是近似，不得与同口径结果直接比较"
      );
      reasons.push(
        reason("cross-basis-approximation", "调用方显式允许跨口径近似比较")
      );
    } else if (
      leftInput.basis === BASIS.UNSPECIFIED ||
      rightInput.basis === BASIS.UNSPECIFIED
    ) {
      limitations.push("至少一侧没有声明 basis，无法确认两侧口径一致");
      reasons.push(reason("basis-unspecified", "存在未声明口径的向量"));
    }

    if (spaceUnknown) {
      limitations.push(
        "至少一侧没有声明 feature space，无法确认比较的是同一类特征；" +
          "原始稀疏向量保留纯数学兼容，但调用方需自行保证语义"
      );
      reasons.push(reason("space-unspecified", "存在未声明特征空间的向量"));
    }

    if (leftInput.coverage === null || rightInput.coverage === null) {
      reasons.push(
        reason("coverage-unknown", "至少一侧没有覆盖率数据，证据质量未知")
      );
    }

    return result;
  }

  function summarizeSide(input) {
    const check = validateVector(input.vector);
    return {
      side: input.side,
      lane: input.lane,
      space: input.space,
      basis: input.basis,
      available: check.ok && check.norm > 0,
      dimensions: check.ok ? check.dimensions.length : 0,
      norm: check.ok ? check.norm : 0,
      coverage: input.coverage,
      coverageBasis: input.coverageBasis,
      missingReasons: input.reasons
    };
  }

  function minCoverage(left, right) {
    if (typeof left !== "number" || typeof right !== "number") return null;
    return Math.min(left, right);
  }

  /* ---------------------------------------------------------------- 导出 */

  global.BiliDailyRecommendCore = Object.freeze({
    MODULE_KIND,
    MODULE_VERSION,
    FEATURE_SPACE,
    LANE,
    SIDE,
    BASIS,
    STATUS,
    UNKNOWN_PARTITION,
    DEFAULT_CONFIG,
    IDF_FORMULA,
    TF_FORMULA,
    buildUserPartitionVector,
    buildUserTextCounts,
    buildCandidatePartitionVector,
    buildCandidateTextCounts,
    computeIdf,
    buildTfIdfVector,
    cosineSimilarity,
    compareVectors
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
