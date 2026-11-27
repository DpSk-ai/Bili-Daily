"use strict";

/**
 * Bili Daily —— 推荐排序与双通道融合（MVP 算法层）
 *
 * 纯函数模块：只做「相关性打分 → 双通道配额 → MMR 多样性 → 推荐理由」。
 * 不调用 chrome.*、DOM、fetch、Cookie，不读写存储，不访问网络，不修改输入。
 * 不产出"推荐准确率"，也不把用户导入内容伪装成观看行为。
 *
 * 依赖（只读取，不修改）：
 *   - stats.js                      UID 排序、日期工具
 *   - candidate-features.js         extractTitleBigrams
 *   - candidate-pool.js             C2-1 / C2-2 候选与资格
 *   - candidate-content-import.js   C2-4B 导入证据与准入
 *   - recommend-core.js             C3-1 向量 / TF-IDF / 余弦
 *   - recommend-quality.js          C3-2 衰减 / 可靠性 / 冷启动
 *
 * 双通道：
 *   main        —— 本地观看记录里 eligible 的 UP 主（回访推荐）
 *   exploration —— 用户主动导入且 eligibleForExploration 的 UP 主（探索推荐）
 * 两条通道独立打分、独立配额，原始分数不相加；同一 UID 以 main 为准且只出现一次。
 */

(function (global) {
  const Stats = global.BiliDailyStats;
  const Features = global.BiliDailyCandidateFeatures;
  const Pool = global.BiliDailyCandidatePool;
  const Import = global.BiliDailyCandidateContentImport;
  const Core = global.BiliDailyRecommendCore;
  const Quality = global.BiliDailyRecommendQuality;

  if (
    !Stats ||
    typeof Stats.parseDateKey !== "function" ||
    typeof Stats.shiftLocalDate !== "function" ||
    typeof Stats.localDateKey !== "function"
  ) {
    throw new Error("Bili Daily recommend-rank.js 需要先加载 stats.js");
  }
  if (!Features || typeof Features.extractTitleBigrams !== "function") {
    throw new Error("Bili Daily recommend-rank.js 需要先加载 candidate-features.js");
  }
  if (!Pool || typeof Pool.assessCandidate !== "function") {
    throw new Error("Bili Daily recommend-rank.js 需要先加载 candidate-pool.js");
  }
  if (!Import || typeof Import.assessImportedContentCandidates !== "function") {
    throw new Error(
      "Bili Daily recommend-rank.js 需要先加载 candidate-content-import.js"
    );
  }
  if (!Core || typeof Core.compareVectors !== "function") {
    throw new Error("Bili Daily recommend-rank.js 需要先加载 recommend-core.js");
  }
  if (!Quality || typeof Quality.assessFeatureReliability !== "function") {
    throw new Error("Bili Daily recommend-rank.js 需要先加载 recommend-quality.js");
  }

  const MODULE_KIND = "bili-daily-recommend-rank";
  const MODULE_VERSION = 1;
  const RESULT_KIND = "bili-daily-recommendations";

  const LANE = Core.LANE;

  const DEFAULT_CONFIG = Object.freeze({
    K: 5,
    lambda: 0.7,
    explorationQuota: 1,
    maxPoolMultiplier: 2,
    maxK: 20,
    // 相关性权重：只用于同通道内的内容相似度合成，不跨通道相加
    partitionWeight: 0.6,
    textWeight: 0.4,
    // MVP 默认开启时间衰减；关闭后与 C3-1 行为一致（由 Quality 保证）
    decay: Object.freeze({ enabled: true, halfLifeDays: 14 }),
    windowDays: 30
  });

  const SPACE_URL_PREFIX = "https://space.bilibili.com/";

  /* ---------------------------------------------------------------- 工具 */

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function compareText(left, right) {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }

  function reason(code, message, evidence) {
    return {
      code,
      message,
      evidence: isPlainObject(evidence) ? evidence : {}
    };
  }

  function toInteger(value, fallback, min, max) {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    const rounded = Math.floor(value);
    if (rounded < min) return fallback;
    if (rounded > max) return max;
    return rounded;
  }

  function toNumber(value, fallback, min, max) {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  }

  function normalizeConfig(options) {
    const opts = isPlainObject(options) ? options : {};
    const decayOptions = isPlainObject(opts.decay) ? opts.decay : {};
    const decayEnabled =
      typeof decayOptions.enabled === "boolean"
        ? decayOptions.enabled
        : DEFAULT_CONFIG.decay.enabled;
    const halfLifeDays =
      typeof decayOptions.halfLifeDays === "number" &&
      Number.isFinite(decayOptions.halfLifeDays) &&
      decayOptions.halfLifeDays > 0
        ? decayOptions.halfLifeDays
        : DEFAULT_CONFIG.decay.halfLifeDays;

    const K = toInteger(opts.K, DEFAULT_CONFIG.K, 1, DEFAULT_CONFIG.maxK);
    return {
      K,
      lambda: toNumber(opts.lambda, DEFAULT_CONFIG.lambda, 0, 1),
      explorationQuota: toInteger(
        opts.explorationQuota,
        DEFAULT_CONFIG.explorationQuota,
        0,
        K
      ),
      maxPool: K * DEFAULT_CONFIG.maxPoolMultiplier,
      partitionWeight: DEFAULT_CONFIG.partitionWeight,
      textWeight: DEFAULT_CONFIG.textWeight,
      decay: { enabled: decayEnabled, halfLifeDays },
      windowDays: toInteger(opts.windowDays, DEFAULT_CONFIG.windowDays, 1, 366),
      endDate:
        typeof opts.endDate === "string" && Stats.parseDateKey(opts.endDate)
          ? opts.endDate
          : Stats.localDateKey(
              opts.now == null ? Date.now() : opts.now
            ) || Stats.localDateKey(Date.now())
    };
  }

  function resolveNowMs(options) {
    const raw = isPlainObject(options) ? options.now : undefined;
    if (raw === undefined || raw === null) return { ok: true, ms: Date.now() };
    if (typeof raw === "number" && Number.isFinite(raw)) return { ok: true, ms: raw };
    if (typeof raw === "string") {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) return { ok: true, ms: parsed };
    }
    if (raw instanceof Date && Number.isFinite(raw.getTime())) {
      return { ok: true, ms: raw.getTime() };
    }
    return { ok: false, ms: null };
  }

  function candidateList(pool) {
    if (Array.isArray(pool)) return pool.slice();
    if (isPlainObject(pool) && Array.isArray(pool.candidates)) {
      return pool.candidates.slice();
    }
    return [];
  }

  function featureList(features) {
    if (Array.isArray(features)) return features.slice();
    if (isPlainObject(features) && Array.isArray(features.candidates)) {
      return features.candidates.slice();
    }
    return [];
  }

  function percent(ratio) {
    return `${Math.round(ratio * 1000) / 10}%`;
  }

  function minutes(ms) {
    return Math.round(ms / 6000) / 10;
  }

  function dominantDimension(vectorWrapper) {
    if (!isPlainObject(vectorWrapper) || !isPlainObject(vectorWrapper.vector)) {
      return null;
    }
    const vector = vectorWrapper.vector;
    let best = null;
    let bestValue = -1;
    Object.keys(vector)
      .sort(compareText)
      .forEach((key) => {
        const value = vector[key];
        if (typeof value === "number" && value > bestValue) {
          best = key;
          bestValue = value;
        }
      });
    return best === null ? null : { name: best, share: bestValue };
  }

  /* ---------------------------------------------------------------- 相似度 */

  /**
   * 计算一组相似度组件并合成相关性。
   * 缺失组件返回 null，不当作 0；可靠性不参与相乘（避免单一组件时被约掉）。
   */
  function combineSimilarity(components) {
    let weightSum = 0;
    let scoreSum = 0;
    const usable = [];
    components.forEach((component) => {
      if (
        component &&
        typeof component.similarity === "number" &&
        Number.isFinite(component.similarity)
      ) {
        weightSum += component.weight;
        scoreSum += component.weight * component.similarity;
        usable.push(component.space);
      }
    });
    if (weightSum <= 0) {
      return { score: null, usable, weightSum: 0 };
    }
    return { score: scoreSum / weightSum, usable, weightSum };
  }

  /** 用户与候选共享的词元（按两侧 TF-IDF 乘积排序），只用于解释。 */
  function sharedTokensOf(userVector, candidateVector) {
    const user =
      userVector && isPlainObject(userVector.vector) ? userVector.vector : null;
    const candidate =
      candidateVector && isPlainObject(candidateVector.vector)
        ? candidateVector.vector
        : null;
    if (!user || !candidate) return [];
    return Object.keys(candidate)
      .filter((token) => typeof user[token] === "number" && user[token] > 0)
      .map((token) => ({ token, weight: user[token] * candidate[token] }))
      .sort(
        (left, right) =>
          right.weight - left.weight || compareText(left.token, right.token)
      )
      .slice(0, 3)
      .map((item) => item.token);
  }

  /** 候选之间的相似度，用于 MMR；缺失组件按可用组件重新归一化。 */
  function pairSimilarity(left, right) {
    const components = [];
    const partition = Core.compareVectors(left.partitionVector, right.partitionVector);
    if (typeof partition.similarity === "number") {
      components.push({ space: "partition", weight: 0.6, similarity: partition.similarity });
    }
    const text = Core.compareVectors(left.textVector, right.textVector);
    if (typeof text.similarity === "number") {
      components.push({ space: "title", weight: 0.4, similarity: text.similarity });
    }
    const combined = combineSimilarity(components);
    return combined.score === null ? 0 : combined.score;
  }

  /**
   * MMR 重排：λ 越大越偏相关性；λ = 1 退化为纯相关性排序。
   * 只在 Top（K × 2）候选内运行，避免为了多样性牺牲长尾之外的相关性。
   */
  function mmrSelect(entries, K, lambda, maxPool) {
    const limit = Math.max(K, maxPool || K * 2);
    const seenUids = new Set();
    const pool = [];
    entries.forEach((entry) => {
      if (!entry || typeof entry.upUid !== "string") return;
      if (seenUids.has(entry.upUid)) return; // 同一 UID 只出现一次
      if (pool.length >= limit) return;
      seenUids.add(entry.upUid);
      pool.push(entry);
    });
    const selected = [];
    const remaining = pool.slice();
    const cache = new Map();

    function similarityOf(a, b) {
      const key =
        a.upUid < b.upUid ? `${a.upUid}|${b.upUid}` : `${b.upUid}|${a.upUid}`;
      if (cache.has(key)) return cache.get(key);
      const value = pairSimilarity(a, b);
      cache.set(key, value);
      return value;
    }

    while (selected.length < K && remaining.length > 0) {
      let bestIndex = 0;
      let bestValue = -Infinity;
      for (let index = 0; index < remaining.length; index += 1) {
        const current = remaining[index];
        let maxSim = 0;
        selected.forEach((chosen) => {
          const sim = similarityOf(current, chosen);
          if (sim > maxSim) maxSim = sim;
        });
        const value = lambda * current.score - (1 - lambda) * maxSim;
        if (
          value > bestValue + 1e-12 ||
          (Math.abs(value - bestValue) <= 1e-12 &&
            compareText(current.upUid, remaining[bestIndex].upUid) < 0)
        ) {
          bestValue = value;
          bestIndex = index;
        }
      }
      selected.push(remaining[bestIndex]);
      remaining.splice(bestIndex, 1);
    }

    return selected;
  }

  /* ---------------------------------------------------------------- 推荐理由 */

  function buildReasons(entry, context) {
    const reasons = [];

    if (entry.lane === LANE.MAIN && entry.watchedVideoCount > 0) {
      reasons.push(
        reason(
          "watched-before",
          `你在本地记录中看过该 UP 主 ${entry.watchedVideoCount} 个视频，累计约 ${minutes(
            entry.watchedWatchMs
          )} 分钟`,
          {
            watchedVideoCount: entry.watchedVideoCount,
            watchedWatchMs: entry.watchedWatchMs
          }
        )
      );
    }

    if (entry.lane === LANE.EXPLORATION) {
      if (entry.provenance === "page-observed") {
        reasons.push(
          reason(
            "page-observed",
            `该候选来自你在 B 站视频页「相关推荐」中实际观察到的页面卡片，共 ${entry.importedVideoCount} 个不同视频；本地未观看过；只记录页面当时展示的信息，不代表账号经过平台验证`,
            {
              provenance: "page-observed",
              observedVideoCount: entry.importedVideoCount,
              onlineVerified: false
            }
          )
        );
      } else {
        reasons.push(
          reason(
            "user-imported",
            `该候选来自你主动导入的候选资料，共 ${entry.importedVideoCount} 个视频；本地未观看过；未经平台在线核验`,
            {
              provenance: "user-provided",
              importedVideoCount: entry.importedVideoCount,
              onlineVerified: false
            }
          )
        );
      }
    }

    const partition = entry.dominantPartition;
    const userShare =
      partition && isPlainObject(context.userPartitionVector)
        ? context.userPartitionVector[partition.name]
        : null;
    if (
      partition &&
      typeof userShare === "number" &&
      userShare > 0 &&
      entry.partitionSimilarity !== null
    ) {
      reasons.push(
        reason(
          "partition-match",
          `你近 ${context.windowDays} 天有 ${percent(
            userShare
          )} 的观看时长在「${partition.name}」，该 UP 主的内容也以该分区为主`,
          {
            partition: partition.name,
            userShare,
            candidateShare: partition.share,
            basis: entry.partitionBasis
          }
        )
      );
    }

    if (entry.sharedTokens.length > 0) {
      reasons.push(
        reason(
          "title-match",
          `标题中有 ${entry.sharedTokens.length} 个词元与你近期关注的内容重合：${entry.sharedTokens.join("、")}`,
          { tokens: entry.sharedTokens.slice() }
        )
      );
    }

    if (entry.reliability && entry.reliability.level === "low") {
      reasons.push(
        reason("low-coverage", "该候选的内容覆盖数据较少，匹配可靠性较低", {
          partitionCoverage: entry.partitionCoverage,
          titleCoverage: entry.titleCoverage
        })
      );
    }

    return reasons.slice(0, 4);
  }

  /* ---------------------------------------------------------------- 主入口 */

  /**
   * 生成推荐。
   *
   * @param {object} input { records, pool, features, sidecar }
   * @param {object} [options] { now, endDate, K, lambda, explorationQuota, decay, windowDays }
   */
  function buildRecommendations(input, options) {
    const opts = isPlainObject(options) ? options : {};
    const config = normalizeConfig(opts);
    const nowInfo = resolveNowMs(opts);
    const source = isPlainObject(input) ? input : {};
    const reasons = [];

    if (!nowInfo.ok) {
      return emptyResult("invalid", "invalid-now", [reason("invalid-now", "now 不是合法时间")], config);
    }
    if (!isPlainObject(source.records)) {
      return emptyResult(
        "invalid",
        "invalid-records",
        [reason("invalid-records", "观看记录不是普通对象")],
        config
      );
    }

    const vectorOptions = {
      endDate: config.endDate,
      windowDays: config.windowDays,
      now: nowInfo.ms,
      decayEnabled: config.decay.enabled,
      halfLifeDays: config.decay.halfLifeDays
    };

    const userPartition = Quality.buildDecayedUserPartitionVector(
      source.records,
      vectorOptions
    );
    const userText = Quality.buildDecayedUserTextCounts(source.records, vectorOptions);
    const evidence = Quality.assessUserEvidence(source.records, {
      endDate: config.endDate,
      windowDays: config.windowDays
    });
    const coldStart = evidence.coldStart;

    if (coldStart.status === "empty") {
      return buildResult({
        config,
        now: nowInfo.ms,
        coldStart,
        mode: "none",
        recommendations: [],
        lanes: emptyLanes(),
        reasons: [reason("no-watch-history", "本地还没有可用的观看记录，暂不生成推荐")],
        diagnostics: { mainCandidates: 0, explorationCandidates: 0, dropped: 0 }
      });
    }

    const similarityMode = coldStart.status !== "insufficient";

    const main = collectMainLane({
      source,
      userPartition,
      userText,
      now: nowInfo.ms,
      config,
      similarityMode
    });
    main.reasons.forEach((item) => reasons.push(item));

    let exploration = { entries: [], diagnostics: {}, reasons: [] };
    if (similarityMode) {
      exploration = collectExplorationLane({
        source,
        userPartition,
        userText,
        now: nowInfo.ms,
        config
      });
    } else {
      exploration.reasons.push(
        reason("cold-start-exploration-skipped", "观看数据不足，探索通道暂不参与排序")
      );
    }
    exploration.reasons.forEach((item) => reasons.push(item));

    // 同一 UID 跨通道去重：main 优先；main 被阻断的 UID 在探索通道也不出现。
    const mainUids = new Set(main.entries.map((entry) => entry.upUid));
    const mainBlocked = new Set(main.blockedUids);
    const filteredExploration = exploration.entries.filter((entry) => {
      if (mainUids.has(entry.upUid)) return false;
      if (mainBlocked.has(entry.upUid)) return false;
      return true;
    });
    const laneDuplicateDropped = exploration.entries.length - filteredExploration.length;

    const ranked = similarityMode
      ? finalizeSimilarityLanes(main.entries, filteredExploration, config)
      : finalizeReturningOnly(main.entries, config);

    return buildResult({
      config,
      now: nowInfo.ms,
      coldStart,
      mode: similarityMode ? "similarity" : "returning-only",
      recommendations: ranked.recommendations,
      lanes: ranked.lanes,
      reasons: reasons.concat(ranked.reasons),
      diagnostics: {
        mainCandidates: main.entries.length,
        explorationCandidates: filteredExploration.length,
        laneDuplicateDropped,
        mainBlocked: main.blockedUids.length,
        droppedNoSimilarity: main.droppedNoSimilarity + exploration.droppedNoSimilarity
      }
    });
  }

  function emptyLanes() {
    return {
      main: { available: 0, selected: 0, quota: 0 },
      exploration: { available: 0, selected: 0, quota: 0 }
    };
  }

  /* ---------------------------------------------------------------- main lane */

  function collectMainLane(context) {
    const { source, userPartition, userText, now, config, similarityMode } = context;
    const reasons = [];
    const blockedUids = [];
    const entries = [];
    let droppedNoSimilarity = 0;

    const poolCandidates = candidateList(source.pool);
    const features = featureList(source.features);
    const featureByUid = new Map();
    features.forEach((feature) => {
      if (isPlainObject(feature) && typeof feature.upUid === "string") {
        featureByUid.set(feature.upUid, feature);
      }
    });

    const candidates = [];
    poolCandidates.forEach((candidate) => {
      if (!isPlainObject(candidate) || typeof candidate.upUid !== "string") return;
      const assessment = Pool.assessCandidate(candidate, { now });
      if (assessment.eligibility !== "eligible") {
        if (assessment.hasUidConflict) blockedUids.push(candidate.upUid);
        return;
      }
      const feature = featureByUid.get(candidate.upUid);
      if (!feature) return;
      if (feature.featureStatus !== "ready" && feature.featureStatus !== "partial") {
        return;
      }
      candidates.push({ candidate, assessment, feature });
    });

    // 第一遍：构建分区向量与词频
    const drafts = candidates.map((item) => {
      const partitionVector = Core.buildCandidatePartitionVector(item.feature, {
        lane: LANE.MAIN
      });
      const textCounts = Core.buildCandidateTextCounts(item.feature, { lane: LANE.MAIN });
      return Object.assign({}, item, { partitionVector, textCounts });
    });

    // 第二遍：main lane 独立 IDF 语料
    const model = Core.computeIdf(
      drafts.map((draft) => draft.textCounts.counts),
      { minIdfDocuments: 20, lane: LANE.MAIN }
    );
    const userTextVector = Core.buildTfIdfVector(userText.counts, model);

    drafts.forEach((draft) => {
      const textVector = Core.buildTfIdfVector(draft.textCounts.counts, model);
      const partitionSimilarity = Core.compareVectors(
        userPartition,
        draft.partitionVector
      );
      const textSimilarity = Core.compareVectors(userTextVector, textVector);

      if (!similarityMode) {
        entries.push(buildEntry(draft, null, null, null, config));
        return;
      }

      const combined = combineSimilarity([
        {
          space: "partition",
          weight: config.partitionWeight,
          similarity: partitionSimilarity.similarity
        },
        {
          space: "title",
          weight: config.textWeight,
          similarity: textSimilarity.similarity
        }
      ]);

      if (combined.score === null) {
        droppedNoSimilarity += 1;
        return;
      }

      entries.push(
        buildEntry(draft, combined.score, partitionSimilarity, textSimilarity, config, {
          partitionVector: draft.partitionVector,
          textVector,
          userTextVector,
          userPartitionVector: userPartition
        })
      );
    });

    if (entries.length === 0) {
      reasons.push(
        reason(
          "no-main-candidates",
          similarityMode
            ? "没有可匹配的历史 UP 主候选"
            : "没有可用的历史 UP 主候选"
        )
      );
    }

    return { entries, blockedUids, droppedNoSimilarity, reasons };
  }

  function buildEntry(draft, score, partitionSimilarity, textSimilarity, config, vectors) {
    const feature = draft.feature;
    const candidate = draft.candidate;
    const reliability = Quality.assessFeatureReliability(feature, { lane: LANE.MAIN });
    const evidence = isPlainObject(candidate.evidence) ? candidate.evidence : {};
    const vectorInfo = vectors || {};

    return {
      upUid: candidate.upUid,
      upName: candidate.upName || feature.upName || `UID ${candidate.upUid}`,
      lane: LANE.MAIN,
      provenance: "watched",
      score: score === null ? null : score,
      partitionSimilarity:
        partitionSimilarity && typeof partitionSimilarity.similarity === "number"
          ? partitionSimilarity.similarity
          : null,
      textSimilarity:
        textSimilarity && typeof textSimilarity.similarity === "number"
          ? textSimilarity.similarity
          : null,
      partitionVector: vectorInfo.partitionVector || draft.partitionVector,
      textVector: vectorInfo.textVector || null,
      dominantPartition: dominantDimension(draft.partitionVector),
      partitionBasis: draft.partitionVector.basis,
      sharedTokens: sharedTokensOf(vectorInfo.userTextVector, vectorInfo.textVector),
      userPartitionVector:
        vectorInfo.userPartitionVector &&
        isPlainObject(vectorInfo.userPartitionVector.vector)
          ? vectorInfo.userPartitionVector.vector
          : null,
      reliability,
      confidence: reliability.level,
      watchedVideoCount: Number.isInteger(evidence.watchedVideoCount)
        ? evidence.watchedVideoCount
        : 0,
      watchedWatchMs: Number.isFinite(evidence.watchedWatchMs)
        ? evidence.watchedWatchMs
        : 0,
      importedVideoCount: null,
      partitionCoverage: reliability.coverage.partition.ratio,
      titleCoverage: reliability.coverage.title.ratio,
      reasons: [],
      config
    };
  }

  /* ---------------------------------------------------------------- exploration lane */

  function collectExplorationLane(context) {
    const { source, userPartition, userText, now, config } = context;
    const reasons = [];
    let droppedNoSimilarity = 0;

    const entries = [];
    const drafts = [];
    const importedDrafts = collectImportedDrafts(source, now, reasons);
    importedDrafts.forEach((draft) => drafts.push(draft));
    const importedUids = new Set(
      importedDrafts.map((draft) => draft.assessment.upUid)
    );

    const discoveredDrafts = collectDiscoveredDrafts(
      source.discovery,
      importedUids,
      reasons
    );
    discoveredDrafts.forEach((draft) => drafts.push(draft));

    const model = Core.computeIdf(
      drafts.map((draft) => draft.textCounts.counts),
      { minIdfDocuments: 20, lane: LANE.EXPLORATION }
    );
    const userTextVector = Core.buildTfIdfVector(userText.counts, model);

    drafts.forEach((draft) => {
      const textVector = Core.buildTfIdfVector(draft.textCounts.counts, model);
      // 用户侧是 watch-ms，页面观察 / 导入侧是 video-count：属于显式近似，必须打标。
      const partitionSimilarity = Core.compareVectors(
        userPartition,
        draft.partitionVector,
        { allowCrossBasis: true }
      );
      const textSimilarity = Core.compareVectors(userTextVector, textVector);

      const combined = combineSimilarity([
        {
          space: "partition",
          weight: config.partitionWeight,
          similarity: partitionSimilarity.similarity
        },
        {
          space: "title",
          weight: config.textWeight,
          similarity: textSimilarity.similarity
        }
      ]);

      if (combined.score === null) {
        droppedNoSimilarity += 1;
        return;
      }

      entries.push(
        buildExplorationEntry(draft, combined.score, partitionSimilarity, textSimilarity, config, {
          partitionVector: draft.partitionVector,
          textVector,
          userTextVector,
          userPartitionVector: userPartition
        })
      );
    });

    return { entries, droppedNoSimilarity, reasons };
  }

  function collectImportedDrafts(source, now, reasons) {
    if (!isPlainObject(source.sidecar) || !Array.isArray(source.sidecar.candidates)) {
      if (!isPlainObject(source.discovery)) {
        reasons.push(
          reason("no-imported-candidates", "还没有导入任何候选资料，探索通道为空")
        );
      }
      return [];
    }

    let assessment;
    try {
      assessment = Import.assessImportedContentCandidates(
        source.sidecar,
        source.records,
        { now }
      );
    } catch (error) {
      reasons.push(reason("import-assessment-failed", "导入候选评估失败，探索通道已跳过"));
      return [];
    }

    if (!Array.isArray(assessment.candidates)) {
      reasons.push(reason("no-imported-candidates", "没有可用的导入候选"));
      return [];
    }

    const sidecarByUid = new Map();
    source.sidecar.candidates.forEach((candidate) => {
      if (isPlainObject(candidate) && typeof candidate.upUid === "string") {
        sidecarByUid.set(candidate.upUid, candidate);
      }
    });

    const eligible = assessment.candidates.filter(
      (item) =>
        isPlainObject(item) &&
        isPlainObject(item.promotion) &&
        item.promotion.eligibleForExploration === true &&
        isPlainObject(item.identityEvidence) &&
        item.identityEvidence.hasIdentityConflict !== true &&
        sidecarByUid.has(item.upUid)
    );

    if (
      eligible.length === 0 &&
      (source.sidecar.candidates.length > 0 || !isPlainObject(source.discovery))
    ) {
      reasons.push(
        reason("no-eligible-imported", "没有满足探索准入条件的导入候选")
      );
    }

    return eligible.map((item) => {
      const sidecarCandidate = sidecarByUid.get(item.upUid);
      return {
        assessment: item,
        sidecarCandidate,
        provenance: "user-provided",
        partitionVector: Core.buildCandidatePartitionVector(sidecarCandidate, {
          lane: LANE.EXPLORATION
        }),
        textCounts: Core.buildCandidateTextCounts(sidecarCandidate, {
          lane: LANE.EXPLORATION
        })
      };
    });
  }

  function collectDiscoveredDrafts(discovery, importedUids, reasons) {
    if (
      !isPlainObject(discovery) ||
      !isPlainObject(discovery.sidecar) ||
      !Array.isArray(discovery.sidecar.candidates) ||
      !isPlainObject(discovery.assessment) ||
      !Array.isArray(discovery.assessment.candidates)
    ) {
      return [];
    }

    const sidecarByUid = new Map();
    discovery.sidecar.candidates.forEach((candidate) => {
      if (isPlainObject(candidate) && typeof candidate.upUid === "string") {
        sidecarByUid.set(candidate.upUid, candidate);
      }
    });

    const eligible = discovery.assessment.candidates.filter(
      (item) =>
        isPlainObject(item) &&
        isPlainObject(item.promotion) &&
        item.promotion.eligibleForExploration === true &&
        isPlainObject(item.identityEvidence) &&
        item.identityEvidence.hasIdentityConflict !== true &&
        item.identityEvidence.onlineVerified !== true &&
        sidecarByUid.has(item.upUid) &&
        !importedUids.has(item.upUid)
    );

    if (eligible.length === 0) {
      const relevant = discovery.sidecar.candidates.some(
        (candidate) =>
          isPlainObject(candidate) &&
          typeof candidate.upUid === "string" &&
          !importedUids.has(candidate.upUid)
      );
      if (relevant) {
        reasons.push(
          reason("no-eligible-discovered", "页面观察到的候选尚未达到探索准入条件")
        );
      }
    }

    return eligible.map((item) => {
      const sidecarCandidate = sidecarByUid.get(item.upUid);
      return {
        assessment: item,
        sidecarCandidate,
        provenance: "page-observed",
        partitionVector: Core.buildCandidatePartitionVector(sidecarCandidate, {
          lane: LANE.EXPLORATION
        }),
        textCounts: Core.buildCandidateTextCounts(sidecarCandidate, {
          lane: LANE.EXPLORATION
        })
      };
    });
  }

  function buildExplorationEntry(draft, score, partitionSimilarity, textSimilarity, config, vectors) {
    const sidecarCandidate = draft.sidecarCandidate;
    const provenance =
      draft.provenance === "page-observed" ? "page-observed" : "user-provided";
    const reliability = Quality.assessFeatureReliability(sidecarCandidate, {
      lane: LANE.EXPLORATION
    });
    // 页面观察不是用户主动提供，且分区/标题覆盖可能降级，统一按近似结果处理。
    const approximate =
      provenance === "page-observed" ||
      (partitionSimilarity && partitionSimilarity.approximate === true) ||
      false;

    return {
      upUid: draft.assessment.upUid,
      upName:
        draft.assessment.upName ||
        sidecarCandidate.upName ||
        `UID ${draft.assessment.upUid}`,
      lane: LANE.EXPLORATION,
      provenance,
      score,
      partitionSimilarity:
        partitionSimilarity && typeof partitionSimilarity.similarity === "number"
          ? partitionSimilarity.similarity
          : null,
      textSimilarity:
        textSimilarity && typeof textSimilarity.similarity === "number"
          ? textSimilarity.similarity
          : null,
      partitionVector: vectors.partitionVector,
      textVector: vectors.textVector,
      dominantPartition: dominantDimension(vectors.partitionVector),
      partitionBasis: vectors.partitionVector.basis,
      sharedTokens: sharedTokensOf(vectors.userTextVector, vectors.textVector),
      userPartitionVector:
        vectors.userPartitionVector && isPlainObject(vectors.userPartitionVector.vector)
          ? vectors.userPartitionVector.vector
          : null,
      reliability,
      // 跨口径近似 → 不得标为高可信
      confidence: approximate ? "low" : reliability.level,
      watchedVideoCount: 0,
      watchedWatchMs: 0,
      importedVideoCount: Number.isInteger(sidecarCandidate.importedVideoCount)
        ? sidecarCandidate.importedVideoCount
        : Array.isArray(sidecarCandidate.videos)
          ? sidecarCandidate.videos.length
          : 0,
      partitionCoverage: reliability.coverage.partition.ratio,
      titleCoverage: reliability.coverage.title.ratio,
      approximate,
      reasons: [],
      config
    };
  }

  /* ---------------------------------------------------------------- 融合 */

  function compareEntries(left, right) {
    const leftScore = left.score === null ? -1 : left.score;
    const rightScore = right.score === null ? -1 : right.score;
    return (
      rightScore - leftScore ||
      compareText(left.upUid, right.upUid)
    );
  }

  /**
   * 相似度模式：两条通道分别排序，再按配额合并。
   * main 优先；探索只使用合格候选，不为了凑数提升不合格项。
   */
  function finalizeSimilarityLanes(mainEntries, explorationEntries, config) {
    const mainSorted = mainEntries.slice().sort(compareEntries);
    const explorationSorted = explorationEntries.slice().sort(compareEntries);

    const mainQuota = config.K - config.explorationQuota;
    const mainSelected = mmrSelect(mainSorted, mainQuota, config.lambda, config.maxPool);
    const explorationSelected =
      config.explorationQuota > 0
        ? mmrSelect(
            explorationSorted,
            config.explorationQuota,
            config.lambda,
            config.maxPool
          )
        : [];

    // main 不足时把空余名额留给合格探索候选，但不超过总 K。
    // 探索配额显式为 0 时视为关闭探索，不允许用空余名额绕过配额。
    let remaining = config.K - mainSelected.length - explorationSelected.length;
    if (
      config.explorationQuota > 0 &&
      remaining > 0 &&
      explorationSorted.length > explorationSelected.length
    ) {
      const extra = mmrSelect(
        explorationSorted.filter(
          (entry) => explorationSelected.indexOf(entry) === -1
        ),
        remaining,
        config.lambda,
        config.maxPool
      );
      explorationSelected.push.apply(explorationSelected, extra);
    }

    return assemble(mainSelected, explorationSelected, {
      mainAvailable: mainSorted.length,
      explorationAvailable: explorationSorted.length,
      mainQuota,
      explorationQuota: config.explorationQuota
    });
  }

  /** 冷启动（insufficient）：只按熟悉度回访，不做相似度、不出探索项。 */
  function finalizeReturningOnly(mainEntries, config) {
    const sorted = mainEntries
      .slice()
      .sort((left, right) => {
        return (
          right.watchedWatchMs - left.watchedWatchMs ||
          right.watchedVideoCount - left.watchedVideoCount ||
          compareText(left.upUid, right.upUid)
        );
      });
    const selected = [];
    const maxMs = sorted.length > 0 ? sorted[0].watchedWatchMs : 0;
    sorted.slice(0, config.K).forEach((entry) => {
      const normalized = maxMs > 0 ? entry.watchedWatchMs / maxMs : 0;
      selected.push(
        Object.assign({}, entry, {
          score: normalized,
          confidence: "low",
          partitionSimilarity: null,
          textSimilarity: null
        })
      );
    });

    return assemble(selected, [], {
      mainAvailable: sorted.length,
      explorationAvailable: 0,
      mainQuota: config.K,
      explorationQuota: 0
    });
  }

  function assemble(mainSelected, explorationSelected, laneInfo) {
    const recommendations = [];
    const usedUids = new Set();

    mainSelected.forEach((entry) => {
      if (usedUids.has(entry.upUid)) return;
      usedUids.add(entry.upUid);
      recommendations.push(toRecommendation(entry));
    });
    explorationSelected.forEach((entry) => {
      if (usedUids.has(entry.upUid)) return;
      usedUids.add(entry.upUid);
      recommendations.push(toRecommendation(entry));
    });

    return {
      recommendations,
      lanes: {
        main: {
          available: laneInfo.mainAvailable,
          selected: mainSelected.length,
          quota: laneInfo.mainQuota
        },
        exploration: {
          available: laneInfo.explorationAvailable,
          selected: explorationSelected.length,
          quota: laneInfo.explorationQuota
        }
      },
      reasons:
        recommendations.length === 0
          ? [reason("no-recommendations", "当前没有满足条件的推荐候选")]
          : []
    };
  }

  function toRecommendation(entry) {
    const partition = entry.dominantPartition;
    const reasons = buildReasons(entry, {
      userPartitionVector: entry.userPartitionVector,
      windowDays: entry.config.windowDays
    });

    return {
      upUid: entry.upUid,
      upName: entry.upName,
      lane: entry.lane,
      provenance: entry.provenance,
      score: entry.score === null ? null : Math.round(entry.score * 10000) / 10000,
      confidence: entry.confidence,
      similarity: {
        partition: entry.partitionSimilarity,
        title: entry.textSimilarity,
        basis: entry.partitionBasis,
        approximate: entry.approximate === true
      },
      reliability: {
        level: entry.reliability.level,
        partitionCoverage: entry.partitionCoverage,
        titleCoverage: entry.titleCoverage,
        onlineVerified: false
      },
      reasons,
      spaceUrl:
        typeof entry.upUid === "string" && entry.upUid
          ? `${SPACE_URL_PREFIX}${entry.upUid}`
          : null,
      onlineVerified: false
    };
  }

  function buildResult(payload) {
    return {
      kind: RESULT_KIND,
      module: MODULE_KIND,
      version: MODULE_VERSION,
      status: payload.recommendations.length > 0 ? "ok" : "empty",
      mode: payload.mode,
      generatedAt: payload.now,
      coldStart: payload.coldStart,
      config: {
        K: payload.config.K,
        lambda: payload.config.lambda,
        explorationQuota: payload.config.explorationQuota,
        decay: payload.config.decay,
        windowDays: payload.config.windowDays,
        endDate: payload.config.endDate
      },
      lanes: payload.lanes,
      recommendations: payload.recommendations,
      diagnostics: payload.diagnostics,
      reasons: payload.reasons,
      note:
        "推荐基于本地观看记录、用户主动导入的候选资料，以及用户开启后在视频页相关推荐中观察到的候选信息；" +
        "本地计算、不上传；不代表平台核验，也不构成对推荐效果的承诺。"
    };
  }

  function emptyResult(status, reasonCode, reasons, config) {
    return {
      kind: RESULT_KIND,
      module: MODULE_KIND,
      version: MODULE_VERSION,
      status,
      mode: "none",
      generatedAt: null,
      coldStart: null,
      config: {
        K: config.K,
        lambda: config.lambda,
        explorationQuota: config.explorationQuota,
        decay: config.decay,
        windowDays: config.windowDays,
        endDate: config.endDate
      },
      lanes: emptyLanes(),
      recommendations: [],
      diagnostics: {},
      reasons,
      note:
        "输入不可用，未生成任何推荐。" + (reasonCode ? ` (${reasonCode})` : "")
    };
  }

  /* ---------------------------------------------------------------- 导出 */

  global.BiliDailyRecommendRank = Object.freeze({
    MODULE_KIND,
    MODULE_VERSION,
    RESULT_KIND,
    DEFAULT_CONFIG,
    buildRecommendations,
    // 供单元测试与后续 UI 复用；不修改输入
    mmrSelect
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
