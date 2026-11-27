"use strict";

/**
 * Bili Daily —— 候选 UP 主内容特征（阶段 C2-3）
 *
 * 纯函数模块：不调用 chrome.*、DOM、fetch、Cookie，不读文件，不写任何存储。
 * 只从本地观看记录（biliDailyRecords）和 C2-1 / C2-2 候选池中提取**已真实存在**的
 * 分区与标题特征，供后续 C3 排序使用。本模块不生成推荐分数，也不改变候选资格。
 *
 * 依赖：必须先加载 stats.js。
 * 记录清洗、UID 归一化、同 BV 合并全部复用 stats.cleanRecord / mergeByBvid，
 * 不另立一套身份口径。
 *
 * ---------------------------------------------------------------------------
 * 本模块明确不做的事
 * ---------------------------------------------------------------------------
 *   - 不联网、不调用 B 站 API、不读 Cookie；
 *   - 不采集 DOM、不新增存储键；
 *   - 不计算 TF-IDF、余弦相似度、MMR 或推荐分；
 *   - 不修改传入的 records / pool，也不修改 C2-1 / C2-2 的观看计数；
 *   - 不根据昵称把缺失 UID 的老记录并入候选；
 *   - 不因为特征完整而改变 C2-2 的 eligible / review / excluded 结论。
 *
 * ---------------------------------------------------------------------------
 * 身份冲突（保守策略）
 * ---------------------------------------------------------------------------
 * 同一 BV 在记录中出现 ≥2 个不同 UID 时，整个 BV 被视为冲突视频：
 *   - 不计入任何一方的分区 / 标题特征；
 *   - 不计入任何一方的 observedVideoCount / observedWatchMs；
 *   - 单独计入 conflictVideoCount 和 diagnostics.uidConflictVideos。
 * C2-1 的「先出现者」只用于观看计数，本模块不把它当作可信内容归属。
 *
 * ---------------------------------------------------------------------------
 * 特征口径摘要
 * ---------------------------------------------------------------------------
 *   observedVideoCount —— 去重后、无冲突、有真实 watchMs (>0) 的该 UID 视频数。
 *                         同一 BV 跨天 / 多分 P / 同日重复只算 1 个视频，时长累加。
 *   partitionCoverage  —— 已识别分区的观看时长 / observedWatchMs；无数据显示 null。
 *   titleCoverage      —— 至少能生成一个 bigram 的视频数 / observedVideoCount；
 *                         无数据显示 null。
 *   featureStatus      —— ready / partial / missing，只描述技术数据条件，
 *                         不表示推荐质量，也不影响 C2-2 eligibility。
 *
 * 阈值与上限见 DEFAULT_THRESHOLDS，并会随结果一起输出，便于后续调整与审计。
 */

(function (global) {
  const Stats = global.BiliDailyStats;
  if (
    !Stats ||
    typeof Stats.cleanRecord !== "function" ||
    typeof Stats.mergeByBvid !== "function" ||
    typeof Stats.parseDateKey !== "function"
  ) {
    throw new Error("Bili Daily candidate-features.js 需要先加载 stats.js");
  }

  /* ---------------------------------------------------------------- 常量 */

  const UNKNOWN_PARTITION = "未知";

  /** 全部阈值与安全上限。调整时必须同步更新 C2-3 报告。 */
  const DEFAULT_THRESHOLDS = Object.freeze({
    // ready 的最低样本量：至少 2 个视频、累计 5 分钟真实观看。
    minObservedVideos: 2,
    minObservedWatchMs: 5 * 60 * 1000,
    // ready 的最低数据覆盖率（按观看时长 / 按视频数）。
    minPartitionCoverage: 0.5,
    minTitleCoverage: 0.5,
    // 标题安全上限：先截断原始字符串，再按 Unicode 码点截断，最后归一化。
    maxTitleRawLength: 1000,
    maxTitleLength: 200,
    // 每个候选最多保留的词元数与输出词元数，避免异常数据造成无界内存增长。
    maxUniqueTokens: 4000,
    maxOutputTokens: 2000,
    // 分区名安全上限；超长或含控制字符的分区按「未知」处理。
    maxPartitionLength: 64
  });

  const THRESHOLD_KEYS = Object.freeze(Object.keys(DEFAULT_THRESHOLDS));
  const SOURCE_ORDER = Object.freeze(["watched", "manual"]);

  /** 控制字符、零宽字符与双向格式字符：替换为空格，避免跨字符拼接 bigram。 */
  const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;
  /** 只把字母 / 数字 / 组合附加符视为词内字符；标点、空白、符号一律分段。 */
  const WORD_SPLIT = /[^\p{L}\p{N}\p{M}]+/u;
  /** 无状态版本，用于分区名校验，避免 /g 正则的 lastIndex 副作用。 */
  const UNSAFE_CHARS_TEST = new RegExp(UNSAFE_CHARS.source);

  /* ---------------------------------------------------------------- 基础工具 */

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  /** 复用 stats.cleanRecord 的 UID 规则，与 candidate-pool.normalizeUid 保持一致。 */
  function normalizeUid(value) {
    const probe = Stats.cleanRecord({ upUid: value }, "");
    return probe ? probe.upUid : null;
  }

  /** 观看时长累加：非法值按 0，超过安全整数时封顶，避免精度丢失。 */
  function addWatchMs(current, value) {
    const next = current + value;
    if (!Number.isFinite(next) || next > Number.MAX_SAFE_INTEGER) {
      return Number.MAX_SAFE_INTEGER;
    }
    return next;
  }

  /**
   * 取「日期 → 记录表」映射，兼容 { version, days } 与直接日期映射。
   * 与 candidate-pool.js / interest-profile.js 的 readDays 一致：
   * 有 version 但没有 days 时视为空根结构，不把 "version" 当日期键。
   */
  function readDays(records) {
    if (!isPlainObject(records)) return { days: {}, kind: "empty" };
    if (isPlainObject(records.days)) return { days: records.days, kind: "root" };
    if (Object.prototype.hasOwnProperty.call(records, "version")) {
      return { days: {}, kind: "root" };
    }
    return { days: records, kind: "days" };
  }

  /** 阈值覆盖：只接受有限、非负的数值；覆盖率类阈值钳制在 0..1。 */
  function resolveThresholds(options) {
    const opts = isPlainObject(options) ? options : {};
    const input = isPlainObject(opts.thresholds) ? opts.thresholds : {};
    const resolved = {};
    THRESHOLD_KEYS.forEach((key) => {
      const fallback = DEFAULT_THRESHOLDS[key];
      const value = input[key];
      resolved[key] =
        typeof value === "number" && Number.isFinite(value) && value >= 0
          ? value
          : fallback;
    });
    ["minPartitionCoverage", "minTitleCoverage"].forEach((key) => {
      resolved[key] = Math.min(1, resolved[key]);
    });
    ["maxTitleRawLength", "maxTitleLength", "maxUniqueTokens", "maxOutputTokens", "maxPartitionLength"]
      .forEach((key) => {
        resolved[key] = Math.max(1, Math.floor(resolved[key]));
      });
    return resolved;
  }

  /* ---------------------------------------------------------------- 标题特征 */

  /**
   * 标题归一化（可解释、确定性）：
   *   1. 原始字符串先按 UTF-16 长度截断，避免超长标题造成无界开销；
   *   2. NFKC 统一全角 / 兼容字符（如 ＡＩ → AI）；
   *   3. 控制字符、零宽字符、双向控制符替换为空格（不删除，避免两侧字符粘连）；
   *   4. 去除首尾空白，Latin 字母统一小写；
   *   5. 最后按 Unicode 码点截断到 maxTitleLength。
   * 返回 { text, truncated }；非字符串一律视为空标题，不猜测。
   */
  function normalizeTitle(raw, limits) {
    if (typeof raw !== "string") return { text: "", truncated: false };
    let text = raw;
    let truncated = false;

    if (text.length > limits.maxTitleRawLength) {
      text = text.slice(0, limits.maxTitleRawLength);
      truncated = true;
      // 避免截断在 UTF-16 代理对中间。
      const last = text.charCodeAt(text.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
    }

    try {
      text = text.normalize("NFKC");
    } catch (error) {
      // 旧环境不支持 normalize 时保留原文，不因此丢弃标题。
    }

    text = text.replace(UNSAFE_CHARS, " ").trim().toLowerCase();

    const chars = Array.from(text);
    if (chars.length > limits.maxTitleLength) {
      text = chars.slice(0, limits.maxTitleLength).join("");
      truncated = true;
    }
    return { text, truncated };
  }

  /**
   * 标题 bigram 提取。
   * 只连接同一「字母 / 数字 / 组合符」连续段内的相邻字符；
   * 标点、空白、emoji、符号都是分隔符，不会跨段生成词元。
   * 单字符段不产生 bigram（例如标题只有「猫」时词元为空）。
   */
  function extractTitle(raw, limits) {
    const normalized = normalizeTitle(raw, limits);
    const tokens = [];
    if (normalized.text) {
      const runs = normalized.text.split(WORD_SPLIT);
      runs.forEach((run) => {
        if (!run) return;
        const chars = Array.from(run);
        for (let index = 0; index + 1 < chars.length; index += 1) {
          tokens.push(chars[index] + chars[index + 1]);
        }
      });
    }
    return {
      tokens,
      truncated: normalized.truncated,
      isEmpty: normalized.text.length === 0
    };
  }

  /** 对外暴露的纯辅助函数：按默认上限提取标题 bigram，便于 C3 复用与单测。 */
  function extractTitleBigrams(title) {
    return extractTitle(title, DEFAULT_THRESHOLDS).tokens.slice();
  }

  /* ---------------------------------------------------------------- 分区特征 */

  /**
   * 分区规范化：
   *   - 非字符串、空白、字面「未知」、含控制字符、超长名称 → 未识别；
   *   - 未识别分区统一归入「未知」桶，真实观看时长仍保留在分母里。
   * 不根据标题 / 昵称猜测分区。
   */
  function normalizePartition(raw, limits) {
    if (typeof raw !== "string") {
      return { name: UNKNOWN_PARTITION, identified: false };
    }
    const name = raw.trim();
    if (!name || name === UNKNOWN_PARTITION) {
      return { name: UNKNOWN_PARTITION, identified: false };
    }
    // 先按 UTF-16 长度快速拒绝超长名称，避免对异常大字符串做码点展开。
    if (name.length > limits.maxPartitionLength * 2) {
      return { name: UNKNOWN_PARTITION, identified: false };
    }
    if (UNSAFE_CHARS_TEST.test(name)) {
      return { name: UNKNOWN_PARTITION, identified: false };
    }
    if (Array.from(name).length > limits.maxPartitionLength) {
      return { name: UNKNOWN_PARTITION, identified: false };
    }
    return { name, identified: true };
  }

  /* ---------------------------------------------------------------- 候选池读取 */

  function collectSources(candidate, target) {
    if (Array.isArray(candidate.sources)) {
      candidate.sources.forEach((source) => {
        if (typeof source === "string" && source) target.add(source);
      });
    }
    const evidence = isPlainObject(candidate.evidence) ? candidate.evidence : {};
    if (evidence.fromWatchHistory === true || candidate.watchedBefore === true) {
      target.add("watched");
    }
    if (evidence.fromUserInput === true) {
      target.add("manual");
    }
  }

  function orderedSources(sourceSet) {
    const ordered = SOURCE_ORDER.filter((source) => sourceSet.has(source));
    Array.from(sourceSet)
      .filter((source) => SOURCE_ORDER.indexOf(source) === -1)
      .sort()
      .forEach((source) => ordered.push(source));
    return ordered;
  }

  /**
   * 读取候选列表，兼容三种形态：
   *   1. 候选数组；
   *   2. C2-1 / C2-2 的 { candidates: [...] }；
   *   3. C2-2 filterEligibleCandidates 的 { eligible, review, excluded }，
   *      每组元素可以是 { candidate, assessment } 或裸候选对象。
   * 只读取，不修改。
   */
  function readPoolList(pool) {
    if (Array.isArray(pool)) return pool;
    if (!isPlainObject(pool)) return [];
    if (Array.isArray(pool.candidates)) return pool.candidates;

    const groups = ["eligible", "review", "excluded"];
    const hasGroups = groups.some((group) => Array.isArray(pool[group]));
    if (!hasGroups) return [];

    const list = [];
    groups.forEach((group) => {
      if (!Array.isArray(pool[group])) return;
      pool[group].forEach((entry) => {
        if (isPlainObject(entry) && isPlainObject(entry.candidate)) {
          list.push(entry.candidate);
        } else if (isPlainObject(entry)) {
          list.push(entry);
        }
      });
    });
    return list;
  }

  function createCandidateState(uid, candidate) {
    const sources = new Set();
    collectSources(candidate, sources);
    return {
      upUid: uid,
      upName: typeof candidate.upName === "string" ? candidate.upName.trim() : "",
      candidateType: typeof candidate.candidateType === "string" ? candidate.candidateType : "",
      sources,
      partitions: new Map(),
      identifiedWatchMs: 0,
      unknownWatchMs: 0,
      identifiedVideoCount: 0,
      unknownVideoCount: 0,
      tokenCounts: new Map(),
      tokenDocs: new Map(),
      titledVideoCount: 0,
      missingTitleCount: 0,
      tokenlessTitleCount: 0,
      truncatedTitleCount: 0,
      tokenMapOverflow: false,
      observedVideoCount: 0,
      observedWatchMs: 0,
      featureVideoCount: 0,
      missingPartitionCount: 0,
      conflictVideoCount: 0
    };
  }

  /** 建立 UID → 候选状态表；重复 UID 只保留首个，来源取并集。 */
  function buildCandidateStates(pool, diagnostics) {
    const list = readPoolList(pool);
    const states = new Map();

    list.forEach((candidate) => {
      diagnostics.candidatesInPool += 1;
      if (!isPlainObject(candidate)) {
        diagnostics.candidatesInvalid += 1;
        return;
      }
      const uid = normalizeUid(candidate.upUid);
      if (uid === null) {
        diagnostics.candidatesInvalid += 1;
        return;
      }

      const existing = states.get(uid);
      if (existing) {
        diagnostics.duplicateCandidates += 1;
        collectSources(candidate, existing.sources);
        if (!existing.upName && typeof candidate.upName === "string") {
          existing.upName = candidate.upName.trim();
        }
        if (!existing.candidateType && typeof candidate.candidateType === "string") {
          existing.candidateType = candidate.candidateType;
        }
        return;
      }
      states.set(uid, createCandidateState(uid, candidate));
    });

    return states;
  }

  /* ---------------------------------------------------------------- 记录扫描 */

  /**
   * 扫描全部记录：
   *   - 复用 stats.cleanRecord 清洗字段与 UID；
   *   - 记录每个 BV 出现过的全部 UID（用于冲突检测）；
   *   - 复用 stats.mergeByBvid 合并同一 BV 的同日重复、跨天记录与多分 P。
   * 不修改原始记录；cleanRecord / mergeByBvid 都返回新对象。
   */
  function scanRecords(records) {
    const source = readDays(records);
    const diagnostics = {
      inputKind: source.kind,
      daysScanned: 0,
      daysInvalid: 0,
      recordsScanned: 0,
      recordsInvalid: 0,
      recordsWithoutBvid: 0
    };
    const cleaned = [];
    const uidByBvid = new Map();

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
            // 记录键为空且没有 bvid 时无法可靠去重，保守跳过；
            // 不把多个无 BV 的记录合并成一个虚构视频。
            if (!record.bvid) {
              diagnostics.recordsWithoutBvid += 1;
              return;
            }

            if (record.upUid) {
              if (!uidByBvid.has(record.bvid)) uidByBvid.set(record.bvid, new Map());
              const uids = uidByBvid.get(record.bvid);
              if (!uids.has(record.upUid)) uids.set(record.upUid, dayKey);
            }
            cleaned.push(record);
          });
      });

    const conflictBvids = new Set();
    uidByBvid.forEach((uids, bvid) => {
      if (uids.size >= 2) conflictBvids.add(bvid);
    });

    const videos = Stats.mergeByBvid(cleaned);
    diagnostics.videosScanned = videos.length;
    diagnostics.uidConflictVideos = conflictBvids.size;

    return { videos, conflictBvids, uidByBvid, diagnostics };
  }

  /* ---------------------------------------------------------------- 特征累加 */

  function accumulatePartition(state, partition, watchMs) {
    let entry = state.partitions.get(partition.name);
    if (!entry) {
      entry = { name: partition.name, watchMs: 0, videoCount: 0 };
      state.partitions.set(partition.name, entry);
    }
    entry.watchMs = addWatchMs(entry.watchMs, watchMs);
    entry.videoCount += 1;
    state.identifiedVideoCount += 1;
    state.identifiedWatchMs = addWatchMs(state.identifiedWatchMs, watchMs);
  }

  function accumulateTitle(state, title, limits) {
    if (title.truncated) state.truncatedTitleCount += 1;
    if (title.isEmpty) {
      state.missingTitleCount += 1;
      return;
    }
    if (title.tokens.length === 0) {
      state.tokenlessTitleCount += 1;
      return;
    }

    state.titledVideoCount += 1;
    const seenInDocument = new Set();
    title.tokens.forEach((token) => {
      const known = state.tokenCounts.has(token);
      if (!known && state.tokenCounts.size >= limits.maxUniqueTokens) {
        // 词表达到上限：不再接收新词元，已有词元仍正常累计。
        state.tokenMapOverflow = true;
        return;
      }
      state.tokenCounts.set(token, (known ? state.tokenCounts.get(token) : 0) + 1);
      if (!seenInDocument.has(token)) {
        seenInDocument.add(token);
        state.tokenDocs.set(token, (state.tokenDocs.get(token) || 0) + 1);
      }
    });
  }

  /** 单次遍历已合并的视频，把特征累加到对应 UID；冲突视频整体跳过。 */
  function accumulateFeatures(scan, states, thresholds, diagnostics) {
    scan.videos.forEach((video) => {
      if (scan.conflictBvids.has(video.bvid)) {
        diagnostics.conflictVideosSeen += 1;
        const uids = scan.uidByBvid.get(video.bvid);
        if (uids) {
          uids.forEach((dayKey, uid) => {
            const state = states.get(uid);
            if (state) state.conflictVideoCount += 1;
          });
        }
        return;
      }

      if (!video.upUid) {
        diagnostics.uidlessVideos += 1;
        return;
      }
      if (video.watchMs <= 0) {
        diagnostics.zeroWatchVideos += 1;
        return;
      }

      const state = states.get(video.upUid);
      if (!state) return;

      state.observedVideoCount += 1;
      state.observedWatchMs = addWatchMs(state.observedWatchMs, video.watchMs);

      const partition = normalizePartition(video.partition, thresholds);
      if (partition.identified) {
        accumulatePartition(state, partition, video.watchMs);
      } else {
        state.missingPartitionCount += 1;
        state.unknownVideoCount += 1;
        state.unknownWatchMs = addWatchMs(state.unknownWatchMs, video.watchMs);
      }

      const title = extractTitle(video.title, thresholds);
      accumulateTitle(state, title, thresholds);

      if (partition.identified || title.tokens.length > 0) {
        state.featureVideoCount += 1;
      }
    });
  }

  /* ---------------------------------------------------------------- 结果固化 */

  function compareUid(left, right) {
    if (left.length !== right.length) return left.length - right.length;
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }

  function comparePartitions(left, right) {
    return (
      right.watchMs - left.watchMs ||
      (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    );
  }

  function defineVectorValue(vector, name, value) {
    // 使用 defineProperty，避免分区名恰为 "__proto__" 时污染原型。
    Object.defineProperty(vector, name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true
    });
  }

  function formatPercent(ratio) {
    return `${Math.round(ratio * 1000) / 10}%`;
  }

  /**
   * 评估 featureStatus。只依据技术数据条件：
   *   ready   —— 样本量、观看时长、分区覆盖率、标题覆盖率均达标；
   *   partial —— 有真实特征，但至少一项未达标；
   *   missing —— 没有可用内容特征（含无观看历史的新候选）。
   * 身份冲突只作为 info 原因输出，不改变特征状态，也不改变 C2-2 资格。
   */
  function assessFeatureStatus(state, thresholds, partitionCoverage, titleCoverage) {
    const reasons = [];

    if (state.observedVideoCount === 0) {
      reasons.push({
        code: "no-observed-videos",
        level: "warning",
        message: "本地没有该 UID 的非冲突观看记录，无法提取内容特征"
      });
    }
    if (state.conflictVideoCount > 0) {
      reasons.push({
        code: "uid-conflicts-excluded",
        level: "info",
        message: `${state.conflictVideoCount} 个视频因同一 BV 出现多个 UID 被排除，不参与任何一方的特征`
      });
    }

    if (state.observedVideoCount > 0) {
      if (partitionCoverage === null) {
        reasons.push({
          code: "partition-coverage-no-data",
          level: "warning",
          message: "没有可用的分区观看时长，分区覆盖率为无数据"
        });
      } else if (partitionCoverage < thresholds.minPartitionCoverage) {
        reasons.push({
          code: "partition-coverage-low",
          level: "warning",
          message: `分区覆盖率 ${formatPercent(partitionCoverage)} 低于最低要求 ${formatPercent(thresholds.minPartitionCoverage)}`
        });
      }

      if (titleCoverage === null) {
        reasons.push({
          code: "title-coverage-no-data",
          level: "warning",
          message: "没有可用标题，标题覆盖率为无数据"
        });
      } else if (titleCoverage < thresholds.minTitleCoverage) {
        reasons.push({
          code: "title-coverage-low",
          level: "warning",
          message: `标题覆盖率 ${formatPercent(titleCoverage)} 低于最低要求 ${formatPercent(thresholds.minTitleCoverage)}`
        });
      }

      if (state.observedVideoCount < thresholds.minObservedVideos) {
        reasons.push({
          code: "insufficient-videos",
          level: "warning",
          message: `参与特征统计的视频数 ${state.observedVideoCount} 少于最低要求 ${thresholds.minObservedVideos}`
        });
      }
      if (state.observedWatchMs < thresholds.minObservedWatchMs) {
        reasons.push({
          code: "insufficient-watch-time",
          level: "warning",
          message: `参与统计的真实观看时长不足 ${Math.round(thresholds.minObservedWatchMs / 60000)} 分钟`
        });
      }
      if (state.featureVideoCount === 0) {
        reasons.push({
          code: "no-usable-features",
          level: "warning",
          message: "没有可用的分区或标题特征"
        });
      }
    }

    let featureStatus;
    if (state.observedVideoCount === 0 || state.featureVideoCount === 0) {
      featureStatus = "missing";
    } else {
      const ready =
        state.observedVideoCount >= thresholds.minObservedVideos &&
        state.observedWatchMs >= thresholds.minObservedWatchMs &&
        partitionCoverage !== null &&
        partitionCoverage >= thresholds.minPartitionCoverage &&
        titleCoverage !== null &&
        titleCoverage >= thresholds.minTitleCoverage;
      featureStatus = ready ? "ready" : "partial";
    }

    return { featureStatus, reasons };
  }

  function finalizeCandidate(state, thresholds) {
    const observedWatchMs = state.observedWatchMs;
    const partitionCoverage =
      observedWatchMs > 0 ? state.identifiedWatchMs / observedWatchMs : null;
    const titleCoverage =
      state.observedVideoCount > 0
        ? state.titledVideoCount / state.observedVideoCount
        : null;

    const partitions = Array.from(state.partitions.values())
      .map((entry) => ({
        name: entry.name,
        watchMs: entry.watchMs,
        videoCount: entry.videoCount,
        shareOfIdentified:
          state.identifiedWatchMs > 0 ? entry.watchMs / state.identifiedWatchMs : 0,
        shareOfAll: observedWatchMs > 0 ? entry.watchMs / observedWatchMs : 0
      }))
      .sort(comparePartitions);

    const vector = {};
    partitions.forEach((entry) => {
      defineVectorValue(vector, entry.name, entry.shareOfIdentified);
    });

    const unknown =
      state.unknownWatchMs > 0 && observedWatchMs > 0
        ? {
            name: UNKNOWN_PARTITION,
            watchMs: state.unknownWatchMs,
            videoCount: state.unknownVideoCount,
            shareOfIdentified: 0,
            shareOfAll: state.unknownWatchMs / observedWatchMs
          }
        : null;

    const sortedTokens = Array.from(state.tokenCounts.entries())
      .map(([token, count]) => ({
        token,
        count,
        documentCount: state.tokenDocs.get(token) || 0
      }))
      .sort(
        (left, right) =>
          right.count - left.count ||
          (left.token < right.token ? -1 : left.token > right.token ? 1 : 0)
      );
    const tokens = sortedTokens.slice(0, thresholds.maxOutputTokens);

    const assessment = assessFeatureStatus(
      state,
      thresholds,
      partitionCoverage,
      titleCoverage
    );

    return {
      upUid: state.upUid,
      upName: state.upName,
      candidateType: state.candidateType,
      sources: orderedSources(state.sources),
      hasUidConflict: state.conflictVideoCount > 0,
      partitionFeatures: {
        partitions,
        vector,
        unknown,
        identifiedWatchMs: state.identifiedWatchMs,
        unknownWatchMs: state.unknownWatchMs,
        identifiedVideoCount: state.identifiedVideoCount,
        unknownVideoCount: state.unknownVideoCount
      },
      titleFeatures: {
        tokens,
        uniqueTokenCount: state.tokenCounts.size,
        totalTokenCount: sortedTokens.reduce((sum, item) => sum + item.count, 0),
        documentCount: state.titledVideoCount,
        truncatedTitleCount: state.truncatedTitleCount,
        tokenlessTitleCount: state.tokenlessTitleCount,
        tokenMapOverflow: state.tokenMapOverflow,
        outputTruncated: sortedTokens.length > tokens.length
      },
      partitionCoverage,
      partitionCoverageState: observedWatchMs > 0 ? "available" : "no-data",
      partitionCoverageBasis: "watch-ms",
      titleCoverage,
      titleCoverageState:
        state.observedVideoCount > 0 ? "available" : "no-data",
      titleCoverageBasis: "video-count",
      observedVideoCount: state.observedVideoCount,
      featureVideoCount: state.featureVideoCount,
      observedWatchMs,
      missingPartitionCount: state.missingPartitionCount,
      missingTitleCount: state.missingTitleCount,
      tokenlessTitleCount: state.tokenlessTitleCount,
      conflictVideoCount: state.conflictVideoCount,
      featureStatus: assessment.featureStatus,
      featureReasons: assessment.reasons
    };
  }

  /* ---------------------------------------------------------------- 主入口 */

  /**
   * 构建候选 UP 主内容特征。
   *
   * @param {object} records biliDailyRecords 根结构 { version, days }，或直接日期映射
   * @param {object|Array} pool C2-1 / C2-2 候选池、候选数组，或 filterEligibleCandidates 结果
   * @param {object} [options]
   * @param {object} [options.thresholds] 覆盖 DEFAULT_THRESHOLDS 中的阈值（便于后续调参）
   * @returns {object} { status, reason, candidates, summary, diagnostics, thresholds, note }
   */
  function buildCandidateFeatures(records, pool, options) {
    const thresholds = resolveThresholds(options);
    const diagnostics = {
      candidatesInPool: 0,
      candidatesInvalid: 0,
      duplicateCandidates: 0,
      candidatesWithoutObservedVideos: 0,
      conflictVideosSeen: 0,
      uidlessVideos: 0,
      zeroWatchVideos: 0
    };

    const states = buildCandidateStates(pool, diagnostics);
    const scan = scanRecords(records);
    Object.assign(diagnostics, scan.diagnostics);

    accumulateFeatures(scan, states, thresholds, diagnostics);

    const candidates = Array.from(states.values())
      .map((state) => finalizeCandidate(state, thresholds))
      .sort((left, right) => compareUid(left.upUid, right.upUid));

    const summary = {
      total: candidates.length,
      ready: 0,
      partial: 0,
      missing: 0,
      withPartitionFeatures: 0,
      withTitleFeatures: 0,
      observedVideoCount: 0,
      observedWatchMs: 0,
      conflictVideoCount: 0,
      conflictedCandidates: 0
    };

    candidates.forEach((candidate) => {
      summary[candidate.featureStatus] += 1;
      if (candidate.partitionFeatures.identifiedWatchMs > 0) {
        summary.withPartitionFeatures += 1;
      }
      if (candidate.titleFeatures.documentCount > 0) {
        summary.withTitleFeatures += 1;
      }
      summary.observedVideoCount += candidate.observedVideoCount;
      summary.observedWatchMs = addWatchMs(
        summary.observedWatchMs,
        candidate.observedWatchMs
      );
      if (candidate.hasUidConflict) summary.conflictedCandidates += 1;
      if (candidate.observedVideoCount === 0) {
        diagnostics.candidatesWithoutObservedVideos += 1;
      }
    });
    // 跨候选汇总时按「唯一冲突视频」计数，避免同一 BV 涉及两个 UID 被算两次。
    summary.conflictVideoCount = diagnostics.uidConflictVideos;

    return {
      status: candidates.length > 0 ? "ok" : "empty",
      reason: candidates.length > 0 ? "" : "no-candidates",
      candidates,
      summary,
      diagnostics,
      thresholds,
      unknownPartition: UNKNOWN_PARTITION,
      note:
        "featureStatus 只描述技术数据条件，不表示推荐质量；" +
        "本模块不改变 C2-2 的 eligible / review / excluded，也不生成推荐分数。"
    };
  }

  /* ---------------------------------------------------------------- 导出 */

  global.BiliDailyCandidateFeatures = Object.freeze({
    UNKNOWN_PARTITION,
    DEFAULT_THRESHOLDS,
    buildCandidateFeatures,
    extractTitleBigrams
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
