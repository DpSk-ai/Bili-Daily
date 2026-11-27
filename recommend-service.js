"use strict";

/**
 * Bili Daily —— 推荐数据流编排（MVP 工作包 C）
 *
 * 纯函数：观看记录 + 已持久化的候选 → 7 天画像 + 今日推荐视图模型。
 * 不访问 chrome.*、DOM、网络；存储读取由调用方传入，便于测试与验收。
 *
 * 数据流：
 *   records → candidate-pool → candidate-features → recommend-quality / recommend-rank
 *   用户导入候选 → candidate-store（已验证）→ C2-4B sidecar → exploration 通道
 *
 * 默认 K = 5，探索配额 = 1；只有通过 C2-2 / C2-3 / C2-4B 准入的候选才会出现在结果中。
 */

(function (global) {
  const Rank = global.BiliDailyRecommendRank;
  const Pool = global.BiliDailyCandidatePool;
  const Features = global.BiliDailyCandidateFeatures;
  const Profile = global.BiliDailyInterestProfile;
  const CandidateStore = global.BiliDailyCandidateStore;
  const DiscoveredStore = global.BiliDailyDiscoveredCandidateStore;
  const Stats = global.BiliDailyStats;

  const DEFAULT_K = 5;
  const DEFAULT_EXPLORATION_QUOTA = 1;
  const MAX_NAME_LENGTH = 120;
  const SPACE_URL_PATTERN = /^https:\/\/space\.bilibili\.com\/([1-9]\d{0,15})$/;

  const COLD_START_COPY = Object.freeze({
    empty: {
      label: "暂无记录",
      message: "本地还没有可用的观看记录。打开 B 站视频页观看后，数据会自动记录在本地。"
    },
    insufficient: {
      label: "数据不足",
      message: "观看数据还不足（需要至少 10 分钟且 2 个活跃日），当前只显示回访列表，不做相似度推荐。"
    },
    limited: {
      label: "画像积累中",
      message: "画像样本仍在积累，推荐按较低置信度处理。"
    },
    ready: {
      label: "画像就绪",
      message: "画像样本充足，按内容相似度排序。"
    }
  });

  const LANE_LABELS = Object.freeze({
    main: "回访推荐",
    exploration: "探索推荐"
  });

  const PROVENANCE_LABELS = Object.freeze({
    watched: "来源：本地观看记录",
    "user-provided": "来源：用户导入（未在线核验）",
    "page-observed": "来源：页面相关推荐发现（本地观察，未在线核验）"
  });

  const CONFIDENCE_LABELS = Object.freeze({
    high: "可信度 高",
    medium: "可信度 中",
    low: "可信度 低",
    unavailable: "可信度未知"
  });

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function resolveNow(options) {
    const raw = isPlainObject(options) ? options.now : undefined;
    if (raw === undefined || raw === null) return Date.now();
    if (raw instanceof Date) {
      const time = raw.getTime();
      return Number.isNaN(time) ? Date.now() : time;
    }
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string") {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
    return Date.now();
  }

  function resolveEndDate(options, now) {
    const opts = isPlainObject(options) ? options : {};
    if (typeof opts.endDate === "string" && Stats.parseDateKey(opts.endDate)) {
      return opts.endDate;
    }
    return Stats.localDateKey(now) || Stats.localDateKey(Date.now());
  }

  function safeName(value) {
    if (typeof value !== "string") return "";
    const cleaned = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim();
    return cleaned.length > MAX_NAME_LENGTH ? cleaned.slice(0, MAX_NAME_LENGTH) : cleaned;
  }

  /**
   * 只接受由 UID 拼出的 UP 主空间地址；与 UID 不一致或协议不对时返回 null。
   * 任何按钮跳转都必须经过这一层校验。
   */
  function safeSpaceUrl(url, upUid) {
    if (typeof url !== "string") return null;
    const match = SPACE_URL_PATTERN.exec(url.trim());
    if (!match) return null;
    if (typeof upUid === "string" && match[1] !== upUid) return null;
    return `https://space.bilibili.com/${match[1]}`;
  }

  function toCard(recommendation) {
    if (!isPlainObject(recommendation)) return null;
    const upUid = typeof recommendation.upUid === "string" ? recommendation.upUid : "";
    if (!upUid) return null;
    const lane = recommendation.lane === "exploration" ? "exploration" : "main";
    const provenance =
      recommendation.provenance === "page-observed"
        ? "page-observed"
        : recommendation.provenance === "user-provided"
          ? "user-provided"
          : "watched";
    const reasons = Array.isArray(recommendation.reasons)
      ? recommendation.reasons
          .filter((item) => isPlainObject(item) && typeof item.message === "string")
          .slice(0, 3)
          .map((item) => ({ code: String(item.code || ""), message: item.message }))
      : [];
    const similarity = isPlainObject(recommendation.similarity) ? recommendation.similarity : {};
    const reliability = isPlainObject(recommendation.reliability)
      ? recommendation.reliability
      : {};
    const confidence =
      typeof recommendation.confidence === "string" ? recommendation.confidence : "unavailable";

    return {
      upUid,
      upName: safeName(recommendation.upName) || `UID ${upUid}`,
      lane,
      laneLabel: LANE_LABELS[lane],
      provenance,
      provenanceLabel: PROVENANCE_LABELS[provenance],
      confidence,
      confidenceLabel: CONFIDENCE_LABELS[confidence] || CONFIDENCE_LABELS.unavailable,
      score: typeof recommendation.score === "number" ? recommendation.score : null,
      reasons,
      similarity: {
        partition:
          typeof similarity.partition === "number" ? similarity.partition : null,
        title: typeof similarity.title === "number" ? similarity.title : null,
        basis: typeof similarity.basis === "string" ? similarity.basis : null,
        approximate: similarity.approximate === true
      },
      reliability: {
        level: typeof reliability.level === "string" ? reliability.level : "unavailable",
        partitionCoverage:
          typeof reliability.partitionCoverage === "number"
            ? reliability.partitionCoverage
            : null,
        titleCoverage:
          typeof reliability.titleCoverage === "number" ? reliability.titleCoverage : null,
        onlineVerified: false
      },
      spaceUrl: safeSpaceUrl(recommendation.spaceUrl, upUid)
    };
  }

  function toProfile(profile) {
    if (!isPlainObject(profile) || !isPlainObject(profile.windows)) {
      return { status: "empty", hasData: false, reasons: ["兴趣画像不可用"], bars: [], topUp: null };
    }
    const window = profile.windows["7d"] || null;
    if (!isPlainObject(window) || window.hasData !== true) {
      return {
        status: window && typeof window.status === "string" ? window.status : "empty",
        hasData: false,
        reasons: window && Array.isArray(window.reasons) ? window.reasons.slice(0, 3) : [],
        bars: [],
        topUp: null
      };
    }
    const bars = Array.isArray(window.partitions)
      ? window.partitions
          .filter((item) => isPlainObject(item) && typeof item.name === "string" && item.watchMs > 0)
          .slice(0, 4)
          .map((item) => ({
            name: safeName(item.name) || "未知",
            share: typeof item.share === "number" ? item.share : 0,
            watchMs: typeof item.watchMs === "number" ? item.watchMs : 0
          }))
      : [];
    const topUp = isPlainObject(window.topUp)
      ? {
          upName: safeName(window.topUp.upName) || "",
          upUid: typeof window.topUp.upUid === "string" ? window.topUp.upUid : null,
          effectiveWatchMs:
            typeof window.topUp.effectiveWatchMs === "number" ? window.topUp.effectiveWatchMs : 0,
          effectiveVideoCount:
            typeof window.topUp.effectiveVideoCount === "number"
              ? window.topUp.effectiveVideoCount
              : 0
        }
      : null;

    return {
      status: window.status === "ok" || window.status === "insufficient" ? window.status : "ok",
      hasData: true,
      startDate: window.startDate,
      endDate: window.endDate,
      activeDays: window.activeDays,
      totalWatchMs: window.totalWatchMs,
      effectiveWatchMs: window.effectiveWatchMs,
      effectiveVideoCount: window.effectiveVideoCount,
      favoritePartition:
        window.favoritePartition && typeof window.favoritePartition.name === "string"
          ? {
              name: safeName(window.favoritePartition.name) || "未知",
              share:
                typeof window.favoritePartition.share === "number"
                  ? window.favoritePartition.share
                  : 0
            }
          : null,
      bars,
      topUp,
      reasons: Array.isArray(window.reasons) ? window.reasons.slice(0, 3) : []
    };
  }

  function coldStartView(result) {
    const status =
      result && isPlainObject(result.coldStart) && typeof result.coldStart.status === "string"
        ? result.coldStart.status
        : "empty";
    const copy = COLD_START_COPY[status] || COLD_START_COPY.empty;
    return {
      status,
      label: copy.label,
      message: copy.message,
      thresholds:
        result && isPlainObject(result.coldStart) && isPlainObject(result.coldStart.thresholds)
          ? result.coldStart.thresholds
          : null
    };
  }

  function statusText(result, cards, coldStart) {
    if (coldStart.status === "empty") {
      return "还没有观看记录，生成不了推荐。先去看几个 B 站视频吧。";
    }
    if (result.mode === "returning-only") {
      return `数据不足，仅显示 ${cards.length} 个你曾经看过的 UP 主（按熟悉度）。`;
    }
    if (cards.length === 0) {
      const mainCount =
        result.diagnostics && Number.isInteger(result.diagnostics.mainCandidates)
          ? result.diagnostics.mainCandidates
          : 0;
      const explorationCount =
        result.diagnostics && Number.isInteger(result.diagnostics.explorationCandidates)
          ? result.diagnostics.explorationCandidates
          : 0;
      if (mainCount === 0 && explorationCount === 0) {
        return "没有满足准入条件的候选：需要特征完整的本地 UP 主，或导入候选，或在视频页开启自动发现并继续浏览以积累页面观察候选。";
      }
      return "候选存在，但相似度不足，暂未生成推荐。";
    }
    const mainCount = cards.filter((card) => card.lane === "main").length;
    const explorationCount = cards.length - mainCount;
    return `共 ${cards.length} 条 · 回访 ${mainCount} · 探索 ${explorationCount}`;
  }

  function footnote(result) {
    const notes = [];
    if (result && Array.isArray(result.reasons)) {
      result.reasons.forEach((item) => {
        if (!isPlainObject(item) || typeof item.code !== "string") return;
        if (item.code === "cold-start-exploration-skipped") {
          notes.push("观看数据不足，探索通道未参与排序");
        }
        if (item.code === "no-imported-candidates") {
          notes.push("还没有导入候选，探索通道为空");
        }
        if (item.code === "no-eligible-imported") {
          notes.push("导入候选未通过探索准入（需要至少 3 个视频、分区/标题覆盖达标且未过期）");
        }
        if (item.code === "no-eligible-discovered") {
          notes.push("页面观察候选尚未达到探索准入条件（需要至少 3 个不同视频且标题覆盖达标）");
        }
        if (item.code === "no-main-candidates") {
          notes.push("本地观看记录里没有可用的 UP 主候选");
        }
      });
    }
    notes.push("本地计算，不上传；不代表平台核验。");
    return notes.join("；");
  }

  function buildDiscoveryView(settings, evidence) {
    const normalized =
      DiscoveredStore && typeof DiscoveredStore.normalizeSettings === "function"
        ? DiscoveredStore.normalizeSettings(settings)
        : null;
    const enabled = Boolean(normalized && normalized.enabled === true);
    if (!DiscoveredStore || typeof DiscoveredStore.buildDiscoveredEvidence !== "function") {
      return {
        status: "unavailable",
        statusLabel: "不可用",
        enabled: false,
        message: "自动发现脚本未加载，请重新加载扩展后重试。",
        counts: { discovered: 0, recommendable: 0, insufficient: 0, pendingReview: 0 }
      };
    }
    const summary =
      evidence && isPlainObject(evidence.summary) ? evidence.summary : null;
    const counts = {
      discovered: summary && Number.isInteger(summary.total) ? summary.total : 0,
      recommendable: summary && Number.isInteger(summary.eligible) ? summary.eligible : 0,
      insufficient:
        summary && Number.isInteger(summary.insufficientData)
          ? summary.insufficientData
          : 0,
      pendingReview:
        summary && Number.isInteger(summary.pendingReview) ? summary.pendingReview : 0,
      observedVideos:
        summary && Number.isInteger(summary.observedVideoCount)
          ? summary.observedVideoCount
          : 0
    };
    if (!enabled) {
      return {
        status: "disabled",
        statusLabel: "已关闭",
        enabled: false,
        message:
          "自动发现当前关闭，不会读取视频页推荐卡片。已积累的本地候选仍会参与探索推荐；开启后才会继续累积。",
        counts
      };
    }
    if (counts.recommendable > 0) {
      return {
        status: "has-candidates",
        statusLabel: "已有可推荐候选",
        enabled: true,
        message: `已从页面相关推荐中积累 ${counts.discovered} 个陌生 UP 主，其中 ${counts.recommendable} 个可进入探索推荐。`,
        counts
      };
    }
    if (counts.discovered > 0) {
      return {
        status: "insufficient",
        statusLabel: "数据不足",
        enabled: true,
        message: `已观察到 ${counts.discovered} 个陌生 UP 主，但还没有候选达到探索准入条件（至少 3 个不同视频且标题覆盖达标）。继续正常浏览视频页可逐步积累。`,
        counts
      };
    }
    return {
      status: "enabled",
      statusLabel: "已开启",
      enabled: true,
      message:
        "已在视频页开启观察。候选只会在你正常浏览、页面已渲染相关推荐卡片时逐步积累，不会自动点击、滚动或批量打开视频。",
      counts
    };
  }

  /**
   * 组装弹窗所需的完整视图。
   *
   * @param {object} input { records, store, now, endDate, options }
   * @returns {object} 成功 { ok:true, ... }；失败 { ok:false, error:{code,message} }
   */
  function buildView(input) {
    const source = isPlainObject(input) ? input : {};
    const records = source.records;

    if (!Rank || !Pool || !Features || !Stats) {
      return {
        ok: false,
        error: { code: "missing-script", message: "推荐脚本未加载，请重新加载扩展" }
      };
    }
    if (!isPlainObject(records) || !isPlainObject(records.days)) {
      return {
        ok: false,
        error: { code: "invalid-records", message: "观看记录结构不可用，无法生成推荐" }
      };
    }

    const now = resolveNow({ now: source.now });
    const optionSource = Object.assign({}, source.options || {}, {
      endDate: source.endDate || (source.options && source.options.endDate)
    });
    const endDate = resolveEndDate(optionSource, now);
    if (!endDate) {
      return {
        ok: false,
        error: { code: "invalid-date", message: "无法确定本地日期，无法生成推荐" }
      };
    }

    const options = isPlainObject(source.options) ? source.options : {};
    const K =
      Number.isInteger(options.K) && options.K > 0 && options.K <= 20 ? options.K : DEFAULT_K;
    const explorationQuota =
      Number.isInteger(options.explorationQuota) &&
      options.explorationQuota >= 0 &&
      options.explorationQuota <= K
        ? options.explorationQuota
        : DEFAULT_EXPLORATION_QUOTA;

    try {
      const profile =
        Profile && typeof Profile.buildInterestProfile === "function"
          ? Profile.buildInterestProfile(records, {
              now,
              endDate,
              windows: [7],
              includeComparisons: false
            })
          : null;

      const pool = Pool.buildFromRecords(records);
      const features = Features.buildCandidateFeatures(records, pool);
      const sidecar =
        CandidateStore && source.store ? CandidateStore.buildSidecar(source.store, { now }) : null;
      let discovery = null;
      let discoveryEvidence = null;
      if (
        DiscoveredStore &&
        typeof DiscoveredStore.buildDiscoveredEvidence === "function"
      ) {
        const discoveredStore =
          isPlainObject(source.discoveredStore) && Array.isArray(source.discoveredStore.observations)
            ? source.discoveredStore
            : DiscoveredStore.emptyStore();
        discoveryEvidence = DiscoveredStore.buildDiscoveredEvidence(
          discoveredStore,
          records,
          { now, settings: source.discoverySettings }
        );
        discovery = {
          sidecar: discoveryEvidence.sidecar,
          assessment: discoveryEvidence.assessment
        };
      }

      const result = Rank.buildRecommendations(
        { records, pool, features, sidecar, discovery },
        {
          now,
          endDate,
          K,
          explorationQuota,
          windowDays:
            Number.isInteger(options.windowDays) && options.windowDays > 0
              ? options.windowDays
              : 30,
          decay: isPlainObject(options.decay) ? options.decay : { enabled: true, halfLifeDays: 14 }
        }
      );

      const cards = (Array.isArray(result.recommendations) ? result.recommendations : [])
        .map(toCard)
        .filter(Boolean);
      const coldStart = coldStartView(result);

      return {
        ok: true,
        generatedAt: typeof result.generatedAt === "number" ? result.generatedAt : now,
        endDate,
        mode: result.mode,
        coldStart,
        profile: toProfile(profile),
        recommendations: cards,
        statusText: statusText(result, cards, coldStart),
        footnote: footnote(result),
        discovery: buildDiscoveryView(source.discoverySettings, discoveryEvidence),
        counts: {
          total: cards.length,
          main: cards.filter((card) => card.lane === "main").length,
          exploration: cards.filter((card) => card.lane === "exploration").length
        },
        diagnostics: isPlainObject(result.diagnostics) ? result.diagnostics : {},
        lanes: isPlainObject(result.lanes) ? result.lanes : null
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "compute-failed",
          message: `推荐计算失败：${error && error.message ? error.message : String(error)}`
        }
      };
    }
  }

  global.BiliDailyRecommendService = Object.freeze({
    DEFAULT_K,
    DEFAULT_EXPLORATION_QUOTA,
    COLD_START_COPY,
    buildView,
    safeSpaceUrl,
    _internal: Object.freeze({ toCard, toProfile, statusText, footnote, buildDiscoveryView })
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
