"use strict";

/**
 * Bili Daily —— UP 主候选池（阶段 C2-1）
 *
 * 纯函数模块：不调用 chrome.*、DOM、fetch、Cookie、文件系统，也不写任何存储。
 * 只做两件事：
 *   1. 从本地观看记录（biliDailyRecords）里提取**有可靠 UID** 的回访候选；
 *   2. 接收调用方手动提供的候选 UID，做同样的规范化与合并。
 * 本阶段不做个性化排序、不计算相似度、不采信任何候选的"推荐质量"。
 *
 * 依赖：必须先加载 stats.js。UID 归一化、记录清洗、同 BV 合并全部复用
 * stats.js 的既有规则（cleanRecord / mergeByBvid），不另立一套身份口径。
 *
 * ---------------------------------------------------------------------------
 * uidVerified 的语义（重要，不得误读）
 * ---------------------------------------------------------------------------
 * uidVerified === true 只表示：
 *   - UID 格式合法（正整数、不超过安全整数、统一为字符串），且
 *   - 至少有一条**本地观看记录**把它记录为 upUid ——
 *     这个值由 content.js 在视频页从页面已渲染的 owner.mid 采集而来。
 *
 * 它**不代表**：
 *   - 该账号已经过哔哩哔哩在线核实（本模块从不联网）；
 *   - 该 UID 当前仍然存在、仍然活跃；
 *   - 该候选值得推荐。
 *
 * evidence.onlineVerified **恒为 false**，因为本阶段没有任何在线核验能力。
 * 只由用户手动输入的 UID 属于"格式通过 + 用户提供"，uidVerified 为 false。
 *
 * ---------------------------------------------------------------------------
 * 候选类型
 * ---------------------------------------------------------------------------
 *   returning —— 本地观看记录中存在该 UID（回访候选）。
 *   new       —— 本地没有观看记录，但来源中包含用户手动提供。
 *   unknown   —— 本地没有观看记录，且来源未声明（证据不足，不能可靠判断）。
 *
 * 由本模块的两个构建函数产出的池子只会出现 returning / new；
 * unknown 用于 mergePools 接收调用方自行声明的候选（例如未来新增的来源）。
 * ---------------------------------------------------------------------------
 * C2-2 扩展（向后兼容，只增不改）
 * ---------------------------------------------------------------------------
 * candidate.evidence 新增三个字段，用于身份冲突与昵称冲突的可追踪诊断：
 *   conflictVideoCount —— 该 UID 涉及身份冲突的视频数（与正常观看数分开计）
 *   conflicts          —— 冲突明细 [{ otherUid, dateKey }]，按日期 + UID 排序去重
 *   nameConflict       —— 手动提供的昵称与观看记录中的昵称不一致（仅信息提示）
 *
 * 新增纯函数：
 *   assessCandidateFreshness(candidate, options)  观察时间新鲜度（fresh / stale / unknown）
 *   assessCandidate(candidate, options)           候选资格（eligible / review / excluded）
 *   filterEligibleCandidates(pool, options)       按资格分组，保留结构化原因
 *
 * onlineVerified 在本阶段仍然是恒 false：本模块从不联网，
 * 任何调用方声明的 onlineVerified 都会被忽略，不允许被"自动设为 true"。
 * 身份冲突的默认处理是 review（不静默进入可推荐集合），不是删除候选。
 * ---------------------------------------------------------------------------
 */

(function (global) {
  const Stats = global.BiliDailyStats;
  if (
    !Stats ||
    typeof Stats.cleanRecord !== "function" ||
    typeof Stats.mergeByBvid !== "function" ||
    typeof Stats.parseDateKey !== "function"
  ) {
    throw new Error("Bili Daily candidate-pool.js 需要先加载 stats.js");
  }

  /* ---------------------------------------------------------------- 常量 */

  const SOURCE_WATCHED = "watched";
  const SOURCE_MANUAL = "manual";
  const SOURCE_ORDER = Object.freeze([SOURCE_WATCHED, SOURCE_MANUAL]);

  const CANDIDATE_TYPE = Object.freeze({
    RETURNING: "returning",
    NEW: "new",
    UNKNOWN: "unknown"
  });

  const TYPE_RANK = Object.freeze({
    returning: 0,
    new: 1,
    unknown: 2
  });

  const NAME_SOURCE = Object.freeze({
    WATCH_HISTORY: "watch-history",
    MANUAL: "manual",
    NONE: ""
  });

  /* ---------------------------------------------------------------- 基础工具 */

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  /**
   * 规范化 UID：直接复用 stats.cleanRecord 里的 normalizeUpUid 规则
   * （字符串去空格、安全正整数、统一字符串、超出范围返回 null），
   * 避免在候选层重新定义一套不一致的身份规则。
   */
  function normalizeUid(value) {
    const probe = Stats.cleanRecord({ upUid: value }, "");
    return probe ? probe.upUid : null;
  }

  /** 把 Date / 毫秒时间戳 / ISO 字符串转成毫秒；不可靠一律返回 null，不做猜测。 */
  function toTimestamp(value) {
    if (value instanceof Date) {
      const time = value.getTime();
      return Number.isNaN(time) ? null : time;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) && value > 0 ? value : null;
    }
    if (typeof value === "string") {
      const text = value.trim();
      if (!text) return null;
      const time = Date.parse(text);
      return Number.isNaN(time) ? null : time;
    }
    return null;
  }

  /**
   * 取「日期 → 记录表」映射。
   * 与 interest-profile.js 的 readDays 保持同样的输入兼容性：
   * 根结构 { version, days } 或直接传入的日期映射；
   * 其余输入一律当作空数据，不猜测层级。
   */
  function readDays(records) {
    if (!isPlainObject(records)) return { days: {}, kind: "empty" };
    if (isPlainObject(records.days)) return { days: records.days, kind: "root" };
    // 只有 version 没有 days 时，不能把 "version" 当成日期键去解析。
    if (Object.prototype.hasOwnProperty.call(records, "version")) {
      return { days: {}, kind: "root" };
    }
    return { days: records, kind: "days" };
  }

  /** UID 是纯数字字符串，按"长度优先、再字典序"比较，避免超出安全整数时精度丢失。 */
  function compareUid(left, right) {
    if (left.length !== right.length) return left.length - right.length;
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }

  function compareCandidates(left, right) {
    const rank = TYPE_RANK[left.candidateType] - TYPE_RANK[right.candidateType];
    if (rank !== 0) return rank;
    return compareUid(left.upUid, right.upUid);
  }

  function bump(counter, key) {
    counter[key] = (counter[key] || 0) + 1;
  }

  function minTime(current, next) {
    if (next === null) return current;
    if (current === null) return next;
    return next < current ? next : current;
  }

  function maxTime(current, next) {
    if (next === null) return current;
    if (current === null) return next;
    return next > current ? next : current;
  }

  /* ---------------------------------------------------------------- 累加器 */

  /** 新建一个候选累加器；所有构建路径共用它，保证输出结构唯一。 */
  function createAccumulator(upUid) {
    return {
      upUid,
      // name → { watchMs, watched }：watchMs 用于选展示昵称，watched 表示该昵称来自观看记录
      names: new Map(),
      sources: new Set(),
      fromWatchHistory: false,
      fromUserInput: false,
      firstObservedAt: null,
      lastObservedAt: null,
      watchedVideoCount: 0,
      watchedWatchMs: 0,
      // C2-2：身份冲突证据（与正常观看数分开统计）
      conflictVideoCount: 0,
      conflicts: []
    };
  }

  function addName(acc, name, watchMs, fromWatch) {
    const text = typeof name === "string" ? name.trim() : "";
    if (!text) return;
    const entry = acc.names.get(text);
    if (!entry) {
      acc.names.set(text, { watchMs, watched: fromWatch });
      return;
    }
    // 同名在不同记录里出现时，观看时长累加；只要有一次来自观看记录就算 watched。
    entry.watchMs += watchMs;
    entry.watched = entry.watched || fromWatch;
  }

  /** 取出（必要时新建）某 UID 的累加器；调用方必须保证 UID 已规范化且非 null。 */
  function ensureAcc(accs, upUid) {
    const existing = accs.get(upUid);
    if (existing) return existing;
    const created = createAccumulator(upUid);
    accs.set(upUid, created);
    return created;
  }

  /**
   * 昵称选择规则（可解释、可复现）：
   *   1. 观看时长最多的昵称优先（反映用户实际看到的名字）；
   *   2. 时长并列时，来自观看记录的昵称优先于手动输入的昵称；
   *   3. 仍然并列时，按码点升序取最小值。
   */
  function chooseName(names) {
    let chosen = "";
    let chosenEntry = null;
    names.forEach((entry, name) => {
      if (!chosenEntry) {
        chosen = name;
        chosenEntry = entry;
        return;
      }
      if (entry.watchMs > chosenEntry.watchMs) {
        chosen = name;
        chosenEntry = entry;
        return;
      }
      if (entry.watchMs < chosenEntry.watchMs) return;
      if (entry.watched && !chosenEntry.watched) {
        chosen = name;
        chosenEntry = entry;
        return;
      }
      if (entry.watched === chosenEntry.watched && name < chosen) {
        chosen = name;
        chosenEntry = entry;
      }
    });
    return { name: chosen, entry: chosenEntry };
  }

  function classify(watchedBefore, sources) {
    if (watchedBefore) return CANDIDATE_TYPE.RETURNING;
    if (sources.indexOf(SOURCE_MANUAL) !== -1) return CANDIDATE_TYPE.NEW;
    return CANDIDATE_TYPE.UNKNOWN;
  }

  /**
   * 冲突明细去重并稳定排序（dateKey → otherUid）。
   * 只保留两个可追踪字段：对方 UID 与观察到对方的日期键，
   * 不写入标题、昵称或完整观看记录。
   */
  function dedupeConflicts(list) {
    const seen = new Set();
    const out = [];
    list.forEach((item) => {
      if (!isPlainObject(item)) return;
      const otherUid = normalizeUid(item.otherUid);
      if (otherUid === null) return;
      const dateKey = typeof item.dateKey === "string" ? item.dateKey : "";
      const key = `${dateKey}|${otherUid}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ otherUid, dateKey });
    });
    return out.sort((left, right) => {
      if (left.dateKey !== right.dateKey) return left.dateKey < right.dateKey ? -1 : 1;
      return compareUid(left.otherUid, right.otherUid);
    });
  }

  /**
   * 昵称冲突：既有观看记录中的昵称，又有只来自手动输入的昵称。
   * 同名不会产生冲突（addName 会把同名合并成 watched）。
   */
  function detectNameConflict(names) {
    let hasWatchedName = false;
    let hasManualOnlyName = false;
    names.forEach((entry) => {
      if (entry.watched) hasWatchedName = true;
      else hasManualOnlyName = true;
    });
    return hasWatchedName && hasManualOnlyName;
  }

  /** 把累加器固化成对外候选对象。绝不虚构分区、标签或昵称。 */
  function finalizeCandidate(acc) {
    const chosen = chooseName(acc.names);
    const sources = SOURCE_ORDER.filter((source) => acc.sources.has(source));
    const watchedBefore = acc.watchedVideoCount > 0 || acc.fromWatchHistory;

    return {
      upUid: acc.upUid,
      upName: chosen.name,
      sources,
      firstObservedAt: acc.firstObservedAt,
      lastObservedAt: acc.lastObservedAt,
      watchedBefore,
      candidateType: classify(watchedBefore, sources),
      uidVerified: acc.fromWatchHistory,
      evidence: {
        uidFormatValid: true,
        fromWatchHistory: acc.fromWatchHistory,
        fromUserInput: acc.fromUserInput,
        // 本阶段没有任何在线核验能力，恒为 false，不得改成 true。
        onlineVerified: false,
        watchedVideoCount: acc.watchedVideoCount,
        watchedWatchMs: acc.watchedWatchMs,
        names: Array.from(acc.names.keys()).sort(),
        nameSource: chosen.name
          ? chosen.entry.watched
            ? NAME_SOURCE.WATCH_HISTORY
            : NAME_SOURCE.MANUAL
          : NAME_SOURCE.NONE,
        // C2-2：身份冲突与昵称冲突证据
        conflictVideoCount: acc.conflictVideoCount,
        conflicts: dedupeConflicts(acc.conflicts),
        nameConflict: detectNameConflict(acc.names)
      }
    };
  }

  /** 统一生成池子结果：排序、统计、状态一次完成。 */
  function createPool(accs, diagnostics) {
    return poolFromCandidates(
      Array.from(accs.values()).map(finalizeCandidate),
      diagnostics
    );
  }

  /** 直接用现成的候选对象生成池子结果（筛选时复用，避免重新推导昵称）。 */
  function poolFromCandidates(candidates, diagnostics) {
    const sorted = candidates.slice().sort(compareCandidates);

    const summary = {
      total: sorted.length,
      byType: {
        returning: 0,
        new: 0,
        unknown: 0
      },
      bySource: {
        watched: 0,
        manual: 0
      },
      uidVerified: 0
    };

    sorted.forEach((candidate) => {
      summary.byType[candidate.candidateType] += 1;
      candidate.sources.forEach((source) => {
        summary.bySource[source] += 1;
      });
      if (candidate.uidVerified) summary.uidVerified += 1;
    });

    return {
      status: sorted.length > 0 ? "ok" : "empty",
      reason: sorted.length > 0 ? "" : "no-candidates",
      candidates: sorted,
      summary,
      diagnostics
    };
  }

  /* ---------------------------------------------------------------- 来源 A：本地观看记录 */

  /**
   * 从本地观看记录构建候选池。
   *
   * 规则：
   * - 只有带可靠 UID 的记录才会成为候选；缺失 UID 的昵称记录只进诊断统计，
   *   不会凭昵称并入任何 UID 分组，也不会伪造 UID。
   * - 同一 BV 跨天 / 同一天重复出现时，复用 stats.mergeByBvid 合并，视频数不重复。
   * - 昵称与 UID 的对应来自记录本身；新旧记录混合时以有 UID 的记录为准。
   * - 时间只取记录里可解析的 startedAt / lastWatchedAt；
   *   全部缺失或非法时返回 null，不用日期键反推一个假时间。
   * - 不修改传入的任何对象。
   *
   * @param {object} records 根结构 { version, days } 或「日期 → 记录表」映射
   * @returns {object} { status, reason, candidates, summary, diagnostics }
   */
  function buildFromRecords(records) {
    const source = readDays(records);
    const diagnostics = {
      inputKind: source.kind,
      daysScanned: 0,
      daysInvalid: 0,
      recordsScanned: 0,
      recordsInvalid: 0,
      nameOnlyVideos: 0,
      anonymousVideos: 0,
      uidConflictVideos: 0
    };

    const cleaned = [];
    // upUid → 累加器（昵称权重与观测时间在记录层先收集，视频数在合并后统计）
    const accs = new Map();
    // bvid → Set(upUid)，用于发现同一视频被记录成不同 UID 的异常数据
    const uidByBvid = new Map();

    Object.keys(source.days).sort().forEach((dayKey) => {
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

      Object.keys(day).sort().forEach((recordKey) => {
        diagnostics.recordsScanned += 1;
        const record = Stats.cleanRecord(day[recordKey], recordKey);
        if (!record) {
          diagnostics.recordsInvalid += 1;
          return;
        }
        if (!record.bvid) record.bvid = recordKey;

        const startedAt = toTimestamp(record.startedAt);
        const lastWatchedAt = toTimestamp(record.lastWatchedAt);

        if (record.upUid) {
          const acc = ensureAcc(accs, record.upUid);
          acc.sources.add(SOURCE_WATCHED);
          acc.fromWatchHistory = true;
          addName(acc, record.upName, record.watchMs, true);

          // 记录里没有可靠时间时不写入任何时间。
          acc.firstObservedAt = minTime(acc.firstObservedAt, startedAt);
          acc.lastObservedAt = maxTime(acc.lastObservedAt, lastWatchedAt);
          acc.lastObservedAt = maxTime(acc.lastObservedAt, startedAt);

          if (!uidByBvid.has(record.bvid)) uidByBvid.set(record.bvid, new Map());
          const uids = uidByBvid.get(record.bvid);
          // 记录每个 UID 在该视频上第一次被观察到的日期键（用于冲突诊断）。
          if (!uids.has(record.upUid)) uids.set(record.upUid, dayKey);
        }

        cleaned.push(record);
      });
    });

    // 跨天、同日重复的同一 BV 合并为一个视频，避免重复计数（复用 stats 规则）。
    const videos = Stats.mergeByBvid(cleaned);
    videos.forEach((video) => {
      if (video.upUid) {
        const acc = ensureAcc(accs, video.upUid);
        acc.watchedVideoCount += 1;
        acc.watchedWatchMs += video.watchMs;
        return;
      }
      if (video.upName) diagnostics.nameOnlyVideos += 1;
      else diagnostics.anonymousVideos += 1;
    });

    // 同一 BV 被记录成多个 UID：保留全部证据，不猜测谁正确。
    // 每个涉及的 UID 都会拿到冲突明细，并把冲突视频数与正常观看数分开统计。
    uidByBvid.forEach((uids) => {
      if (uids.size < 2) return;
      diagnostics.uidConflictVideos += 1;
      const entries = Array.from(uids.entries());
      entries.forEach(([uid]) => {
        const acc = ensureAcc(accs, uid);
        acc.conflictVideoCount += 1;
        entries.forEach(([otherUid, otherDayKey]) => {
          if (otherUid === uid) return;
          acc.conflicts.push({ otherUid, dateKey: otherDayKey });
        });
      });
    });

    return createPool(accs, diagnostics);
  }

  /* ---------------------------------------------------------------- 来源 B：用户手动提供 */

  /**
   * 解析一条手动输入。
   * 接受三种形态：数字 / 字符串 UID，或 { upUid, upName?, observedAt? }。
   * 返回 { ok, reason, uid, name, time }；reason 只描述问题类型，不回显用户输入。
   */
  function parseManualEntry(entry) {
    let rawUid;
    let rawName;
    let rawTime;

    if (typeof entry === "string" || typeof entry === "number") {
      rawUid = entry;
    } else if (isPlainObject(entry)) {
      rawUid = entry.upUid;
      rawName = entry.upName;
      rawTime = entry.observedAt;
    } else {
      return { ok: false, reason: "not-object" };
    }

    const uid = normalizeUid(rawUid);
    if (uid === null) {
      const missing =
        rawUid === undefined || rawUid === null || (typeof rawUid === "string" && !rawUid.trim());
      return { ok: false, reason: missing ? "missing-uid" : "invalid-uid" };
    }

    if (rawName !== undefined && rawName !== null && typeof rawName !== "string") {
      return { ok: false, reason: "invalid-name" };
    }

    return {
      ok: true,
      uid,
      name: typeof rawName === "string" ? rawName.trim() : "",
      time: rawTime === undefined || rawTime === null ? null : toTimestamp(rawTime)
    };
  }

  /**
   * 从调用方提供的手动候选列表构建候选池。
   *
   * - 只做规范化、去重与分类，不写存储、不联网、不校验账号是否真实存在。
   * - 手动 UID 只能得到"格式通过 + 用户提供"的证据等级，uidVerified 为 false。
   * - 不虚构分区、标签或作品特征；这些字段在候选对象里根本不存在。
   *
   * @param {Array<number|string|object>} list 调用方传入的候选列表
   * @returns {object} 同 buildFromRecords
   */
  function buildFromManual(list) {
    const entries = Array.isArray(list) ? list : [];
    const diagnostics = {
      inputKind: "manual",
      entries: entries.length,
      accepted: 0,
      rejected: 0,
      duplicatesInInput: 0,
      invalidTimes: 0,
      rejectedReasons: {}
    };

    const accs = new Map();
    const seen = new Set();

    entries.forEach((entry) => {
      const parsed = parseManualEntry(entry);
      if (!parsed.ok) {
        diagnostics.rejected += 1;
        bump(diagnostics.rejectedReasons, parsed.reason);
        return;
      }
      diagnostics.accepted += 1;
      if (seen.has(parsed.uid)) diagnostics.duplicatesInInput += 1;
      seen.add(parsed.uid);

      if (parsed.time === null && entry && typeof entry === "object" && entry.observedAt != null) {
        diagnostics.invalidTimes += 1;
      }

      const acc = ensureAcc(accs, parsed.uid);
      acc.sources.add(SOURCE_MANUAL);
      acc.fromUserInput = true;
      addName(acc, parsed.name, 0, false);
      acc.firstObservedAt = minTime(acc.firstObservedAt, parsed.time);
      acc.lastObservedAt = maxTime(acc.lastObservedAt, parsed.time);
    });

    return createPool(accs, diagnostics);
  }

  /* ---------------------------------------------------------------- 多来源合并 */

  /**
   * 合并多个池子（或调用方自行声明的候选数组）。
   *
   * 合并规则：
   * - 身份只按 UID；不同 UID 即使昵称相同也保持分开。
   * - 同一 UID 的 sources 取并集，watch 侧证据优先。
   * - watchedVideoCount / watchedWatchMs 取各输入中的最大值而不是求和，
   *   这样把同一个观看池重复合并也不会把视频数翻倍。
   * - 时间取各来源中可靠的 min / max。
   * - 来源未声明的候选会被归为 unknown，并保持 upUid 不变。
   * - 不修改任何输入对象。
   */
  function mergePools(pools) {
    const inputs = Array.isArray(pools) ? pools : [pools];
    const diagnostics = {
      inputKind: "merged",
      inputs: inputs.length,
      candidatesIn: 0,
      candidatesInvalid: 0,
      poolsWithoutCandidates: 0
    };

    const accs = new Map();

    inputs.forEach((input) => {
      const list = Array.isArray(input)
        ? input
        : isPlainObject(input) && Array.isArray(input.candidates)
          ? input.candidates
          : null;
      if (!list) {
        diagnostics.poolsWithoutCandidates += 1;
        return;
      }

      list.forEach((candidate) => {
        diagnostics.candidatesIn += 1;
        if (!isPlainObject(candidate)) {
          diagnostics.candidatesInvalid += 1;
          return;
        }
        const uid = normalizeUid(candidate.upUid);
        if (uid === null) {
          diagnostics.candidatesInvalid += 1;
          return;
        }

        const acc = ensureAcc(accs, uid);
        const sources = Array.isArray(candidate.sources) ? candidate.sources : [];
        sources.forEach((source) => {
          if (source === SOURCE_WATCHED || source === SOURCE_MANUAL) acc.sources.add(source);
        });

        const evidence = isPlainObject(candidate.evidence) ? candidate.evidence : {};
        const candidateSources = Array.isArray(candidate.sources) ? candidate.sources : [];
        const candidateWatched =
          candidate.watchedBefore === true ||
          candidateSources.indexOf(SOURCE_WATCHED) !== -1 ||
          evidence.fromWatchHistory === true;

        if (candidateWatched) {
          acc.fromWatchHistory = true;
          acc.sources.add(SOURCE_WATCHED);
        }
        if (evidence.fromUserInput === true || acc.sources.has(SOURCE_MANUAL)) {
          acc.fromUserInput = true;
        }

        const videoCount = Number.isInteger(evidence.watchedVideoCount)
          ? Math.max(0, evidence.watchedVideoCount)
          : 0;
        const watchMs = Number.isFinite(evidence.watchedWatchMs)
          ? Math.max(0, evidence.watchedWatchMs)
          : 0;
        acc.watchedVideoCount = Math.max(acc.watchedVideoCount, videoCount);
        acc.watchedWatchMs = Math.max(acc.watchedWatchMs, watchMs);

        // C2-2：冲突证据取并集，冲突视频数取最大值（重复合并不翻倍）。
        const conflicts = Array.isArray(evidence.conflicts) ? evidence.conflicts : [];
        let conflictCount = Number.isInteger(evidence.conflictVideoCount)
          ? Math.max(0, evidence.conflictVideoCount)
          : 0;
        if (conflictCount === 0 && conflicts.length > 0) conflictCount = conflicts.length;
        acc.conflictVideoCount = Math.max(acc.conflictVideoCount, conflictCount);
        conflicts.forEach((item) => {
          if (isPlainObject(item)) acc.conflicts.push(item);
        });

        // 昵称：展示名用带权重的方式参与选择；额外被观察到的昵称也保留在 evidence.names。
        addName(acc, candidate.upName, watchMs, candidateWatched);
        if (Array.isArray(evidence.names)) {
          evidence.names.forEach((name) => addName(acc, name, 0, candidateWatched));
        }

        acc.firstObservedAt = minTime(acc.firstObservedAt, toTimestamp(candidate.firstObservedAt));
        acc.lastObservedAt = maxTime(acc.lastObservedAt, toTimestamp(candidate.lastObservedAt));
      });
    });

    return createPool(accs, diagnostics);
  }

  /* ---------------------------------------------------------------- 查询与筛选 */

  function candidateList(pool) {
    if (Array.isArray(pool)) return pool;
    if (isPlainObject(pool) && Array.isArray(pool.candidates)) return pool.candidates;
    return [];
  }

  /** 按 UID 查询候选；UID 非法或不存在返回 null，不返回"近似匹配"。 */
  function getCandidate(pool, upUid) {
    const target = normalizeUid(upUid);
    if (target === null) return null;
    return candidateList(pool).find((candidate) => candidate.upUid === target) || null;
  }

  /**
   * 按条件筛选候选，返回新的池子结果（不修改原池）。
   * 支持：candidateType、source、watchedBefore、uidVerified。
   */
  function filterCandidates(pool, criteria) {
    const options = isPlainObject(criteria) ? criteria : {};
    const list = candidateList(pool);
    const filtered = list.filter((candidate) => {
      if (options.candidateType && candidate.candidateType !== options.candidateType) return false;
      if (options.source && candidate.sources.indexOf(options.source) === -1) return false;
      if (typeof options.watchedBefore === "boolean" && candidate.watchedBefore !== options.watchedBefore) {
        return false;
      }
      if (typeof options.uidVerified === "boolean" && candidate.uidVerified !== options.uidVerified) {
        return false;
      }
      return true;
    });

    const baseDiagnostics = isPlainObject(pool) && isPlainObject(pool.diagnostics)
      ? pool.diagnostics
      : {};
    const diagnostics = Object.assign({}, baseDiagnostics, {
      filteredBy: {
        candidateType: options.candidateType || "",
        source: options.source || "",
        watchedBefore: typeof options.watchedBefore === "boolean" ? options.watchedBefore : null,
        uidVerified: typeof options.uidVerified === "boolean" ? options.uidVerified : null
      },
      filteredOut: list.length - filtered.length
    });

    return poolFromCandidates(filtered, diagnostics);
  }

  /* ---------------------------------------------------------------- 候选质量评估（C2-2） */

  /** 默认过期阈值：90 天。只是"很久没观察到"的提示线，不代表账号失效。 */
  const DEFAULT_STALE_DAYS = 90;
  const DAY_MS = 24 * 60 * 60 * 1000;

  function resolveNowMs(options) {
    const value = options && options.now != null ? options.now : Date.now();
    if (value instanceof Date) {
      const time = value.getTime();
      return Number.isNaN(time) ? Date.now() : time;
    }
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const parsed = toTimestamp(value);
    return parsed === null ? Date.now() : parsed;
  }

  function resolveStaleDays(options) {
    const raw = options && options.staleDays != null ? Number(options.staleDays) : DEFAULT_STALE_DAYS;
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_STALE_DAYS;
    return raw;
  }

  /**
   * 判断候选的观察新鲜度。纯函数，可注入 now。
   *
   *   超过阈值         → state "stale"（延迟未观察到，不代表账号注销）
   *   阈值以内         → state "fresh"
   *   缺少 / 非法 / 未来 → state "unknown"（绝不默认成新鲜）
   *
   * 阈值语义：ageDays > staleDays 才算 stale，恰好等于阈值仍算 fresh。
   * 时间差按毫秒计算，与本地时区无关；ISO 字符串按 Date.parse 规则解析。
   */
  function assessCandidateFreshness(candidate, options) {
    const opts = isPlainObject(options) ? options : {};
    const now = resolveNowMs(opts);
    const staleDays = resolveStaleDays(opts);
    const candidateObject = isPlainObject(candidate) ? candidate : null;
    const raw = candidateObject ? candidateObject.lastObservedAt : undefined;
    const last = toTimestamp(raw);

    const base = {
      state: "unknown",
      ageDays: null,
      thresholdDays: staleDays,
      lastObservedAt: last,
      now,
      reason: "missing-observation-time",
      note: "缺少最近观察时间，无法判断新鲜度；不代表账号已注销"
    };

    if (raw === undefined || raw === null) return base;
    if (last === null) {
      return Object.assign({}, base, {
        reason: "invalid-observation-time",
        note: "最近观察时间无法解析，无法判断新鲜度；不代表账号已注销"
      });
    }
    if (last > now) {
      return Object.assign({}, base, {
        reason: "future-observation-time",
        note: "最近观察时间晚于当前时间，可能是设备时间异常；不代表账号有效或已注销"
      });
    }

    const ageDays = (now - last) / DAY_MS;
    if (ageDays > staleDays) {
      return {
        state: "stale",
        ageDays: Math.round(ageDays * 1000) / 1000,
        thresholdDays: staleDays,
        lastObservedAt: last,
        now,
        reason: "stale-observation",
        note: `超过 ${staleDays} 天未观察到该候选；只表示本地很久没有观察到，不代表账号已注销`
      };
    }
    return {
      state: "fresh",
      ageDays: Math.round(ageDays * 1000) / 1000,
      thresholdDays: staleDays,
      lastObservedAt: last,
      now,
      reason: "",
      note: ""
    };
  }

  /**
   * 评估单个候选能否进入后续排序。
   *
   * eligibility：
   *   excluded —— 不是对象或没有合法 UID，连候选身份都不成立。
   *   review   —— 身份或证据存在需要人工确认的问题：
   *               UID 冲突、仅手动来源、观察时间缺失/非法/未来、超过过期阈值。
   *   eligible —— 合法 UID + 观看历史证据 + 无冲突 + 新鲜度正常。
   *
   * 昵称不一致只作为 info 原因记录：身份按 UID 判定，昵称从不参与身份合并。
   * onlineVerified 恒为 false：本阶段不联网，也不采信调用方自称的核验结果。
   */
  function assessCandidate(candidate, options) {
    const opts = isPlainObject(options) ? options : {};
    const freshness = assessCandidateFreshness(candidate, opts);
    const candidateObject = isPlainObject(candidate) ? candidate : null;
    const evidence = candidateObject && isPlainObject(candidateObject.evidence)
      ? candidateObject.evidence
      : {};
    const sources = candidateObject && Array.isArray(candidateObject.sources)
      ? candidateObject.sources.slice()
      : [];

    const uid = candidateObject ? normalizeUid(candidateObject.upUid) : null;
    const fromWatchHistory =
      evidence.fromWatchHistory === true ||
      sources.indexOf(SOURCE_WATCHED) !== -1 ||
      (candidateObject !== null && candidateObject.watchedBefore === true);
    const fromUserInput =
      evidence.fromUserInput === true || sources.indexOf(SOURCE_MANUAL) !== -1;

    const conflicts = Array.isArray(evidence.conflicts) ? evidence.conflicts : [];
    const conflictVideoCount = Number.isInteger(evidence.conflictVideoCount)
      ? Math.max(0, evidence.conflictVideoCount)
      : 0;
    const hasUidConflict = conflictVideoCount > 0 || conflicts.length > 0;
    const watchedVideoCount = Number.isInteger(evidence.watchedVideoCount)
      ? Math.max(0, evidence.watchedVideoCount)
      : 0;
    const nameConflict = evidence.nameConflict === true;

    const reasons = [];
    const addReason = (code, level, message) => reasons.push({ code, level, message });
    let eligibility = "eligible";

    if (!candidateObject) {
      addReason("invalid-candidate", "excluded", "候选不是对象，无法评估身份");
      eligibility = "excluded";
    } else if (uid === null) {
      addReason("invalid-uid", "excluded", "候选缺少合法 UID，不能进入候选集合");
      eligibility = "excluded";
    } else {
      if (hasUidConflict) {
        addReason(
          "uid-conflict",
          "review",
          "同一视频出现多个 UID，身份归属待人工确认（不猜测哪个正确）"
        );
      }
      if (nameConflict) {
        addReason(
          "nickname-mismatch",
          "info",
          "手动昵称与观看记录昵称不一致；身份仍按 UID 处理，未被昵称覆盖"
        );
      }
      if (!fromWatchHistory && fromUserInput) {
        addReason(
          "manual-unverified",
          "review",
          "用户手动提供，只证明该 UID 被输入过，未经在线核验"
        );
      }
      if (!fromWatchHistory && !fromUserInput) {
        addReason("no-trusted-source", "review", "没有观看历史或手动输入作为来源证据");
      }
      if (freshness.state === "stale") {
        addReason("stale-observation", "review", freshness.note || "超过过期阈值未观察到该候选");
      } else if (freshness.state === "unknown") {
        addReason(freshness.reason, "review", freshness.note);
      }
      if (reasons.some((reason) => reason.level === "review")) eligibility = "review";
    }

    return {
      eligibility,
      reasons,
      identityEvidence: {
        uid,
        uidFormatValid: uid !== null && evidence.uidFormatValid !== false,
        fromWatchHistory,
        fromUserInput,
        // 本阶段不联网：无论调用方声明什么，这里都只能是 false。
        onlineVerified: false,
        sources,
        sourceCount: sources.length,
        evidenceLevel: fromWatchHistory
          ? "watch-history"
          : fromUserInput
            ? "user-input"
            : "none",
        hasNickname: Boolean(candidateObject && candidateObject.upName),
        nameSource: typeof evidence.nameSource === "string" ? evidence.nameSource : "",
        hasUidConflict,
        conflictVideoCount,
        watchedVideoCount
      },
      hasUidConflict,
      stale: freshness.state === "stale",
      freshness: {
        state: freshness.state,
        ageDays: freshness.ageDays,
        thresholdDays: freshness.thresholdDays,
        lastObservedAt: freshness.lastObservedAt,
        reason: freshness.reason,
        note: freshness.note
      },
      onlineVerified: false
    };
  }

  /**
   * 把候选池按资格分为 eligible / review / excluded 三组。
   * 每个条目保留 { candidate, assessment }，原因结构完整，便于人工复核。
   * 不修改输入对象，顺序与池内候选顺序一致。
   */
  function filterEligibleCandidates(pool, options) {
    const opts = isPlainObject(options) ? options : {};
    const list = candidateList(pool);

    const eligible = [];
    const review = [];
    const excluded = [];
    const reasonCounts = {};
    const counters = {
      conflictCandidates: 0,
      staleCandidates: 0,
      unknownFreshnessCandidates: 0,
      manualOnlyCandidates: 0,
      nameMismatchCandidates: 0,
      malformedCandidates: 0
    };

    list.forEach((candidate) => {
      const assessment = assessCandidate(candidate, opts);
      const entry = { candidate, assessment };
      if (assessment.eligibility === "eligible") eligible.push(entry);
      else if (assessment.eligibility === "review") review.push(entry);
      else excluded.push(entry);

      assessment.reasons.forEach((reason) => bump(reasonCounts, reason.code));
      if (assessment.hasUidConflict) counters.conflictCandidates += 1;
      if (assessment.freshness.state === "stale") counters.staleCandidates += 1;
      if (assessment.freshness.state === "unknown") counters.unknownFreshnessCandidates += 1;
      if (
        assessment.identityEvidence.fromUserInput &&
        !assessment.identityEvidence.fromWatchHistory
      ) {
        counters.manualOnlyCandidates += 1;
      }
      if (
        isPlainObject(candidate) &&
        isPlainObject(candidate.evidence) &&
        candidate.evidence.nameConflict === true
      ) {
        counters.nameMismatchCandidates += 1;
      }
      if (assessment.eligibility === "excluded") counters.malformedCandidates += 1;
    });

    return {
      eligible,
      review,
      excluded,
      summary: {
        total: list.length,
        eligible: eligible.length,
        review: review.length,
        excluded: excluded.length
      },
      diagnostics: Object.assign(
        {
          now: resolveNowMs(opts),
          staleDays: resolveStaleDays(opts),
          // 本阶段不存在在线核验，恒为 0。
          onlineVerified: 0,
          reasonCounts
        },
        counters
      )
    };
  }

  /* ---------------------------------------------------------------- 导出 */

  global.BiliDailyCandidatePool = Object.freeze({
    SOURCE_WATCHED,
    SOURCE_MANUAL,
    CANDIDATE_TYPE,
    NAME_SOURCE,
    normalizeUid,
    buildFromRecords,
    buildFromManual,
    mergePools,
    getCandidate,
    filterCandidates,
    // C2-2 新增（纯增量，不影响既有函数）
    DEFAULT_STALE_DAYS,
    assessCandidateFreshness,
    assessCandidate,
    filterEligibleCandidates
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
