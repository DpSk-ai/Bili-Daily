"use strict";

/**
 * Bili Daily —— 弹窗渲染（MVP 工作包 B + C）
 *
 * 数据来源（全部只在本地）：
 * - biliDailyRecords          观看记录（storage.js，只读）
 * - biliDailyCandidateImports 用户确认导入的候选（candidate-store.js）
 * - biliDailyDiscoveredCandidates / biliDailyDiscoverySettings（自动发现）
 * - 数据舱通过 data-backup.js 导出/恢复上述四个键，写入前必须预览并确认
 *
 * 本文件不发起网络请求、不读取 Cookie / token、不使用 innerHTML。
 * 所有外部文本（UP 主名称、分区、导入文件名等）一律通过 textContent 写入。
 * 推荐卡片链接必须经过 RecommendService.safeSpaceUrl 校验，只允许 UID 拼出的
 * https://space.bilibili.com/<uid> 地址。
 *
 * 展示约定：
 * - 「昨日观看总结」默认展示本地时区的昨天，开发模式下可切到今天。
 * - 「最近 7 天兴趣画像」「今日 UP 主推荐」始终以今天为终点。
 * - 读取失败 → 明确错误文案，不伪装成空数据。
 */

(function (global) {
  const Store = global.BiliDailyStorage;
  const Stats = global.BiliDailyStats;
  const CandidateStore = global.BiliDailyCandidateStore;
  const DiscoveredStore = global.BiliDailyDiscoveredCandidateStore;
  const RecommendService = global.BiliDailyRecommendService;
  const DataBackup = global.BiliDailyDataBackup;
  const DevConfig = global.BiliDailyDevConfig;

  const LOADING_MESSAGE = "正在读取本地数据…";
  const MISSING_SCRIPT_MESSAGE = "脚本未加载，请重新加载扩展";
  const FALLBACK_MAX_IMPORT_BYTES = 1024 * 1024;

  /** 开发模式下可切换的展示日期；默认「昨日」与正式版行为一致。 */
  const DATE_WORDS = { yesterday: "昨日", today: "今日" };
  let dateOption = "yesterday";

  const fields = {
    date: document.querySelector('[data-field="date"]'),
    count: document.querySelector('[data-field="count"]'),
    duration: document.querySelector('[data-field="duration"]'),
    partition: document.querySelector('[data-field="partition"]'),
    periodsSummary: document.querySelector('[data-field="periods-summary"]'),
    ups: document.querySelector('[data-field="ups"]'),
    upsEmpty: document.querySelector('[data-field="ups-empty"]'),
    upsNote: document.querySelector('[data-field="ups-note"]'),
    profileStatus: document.querySelector('[data-field="profile-status"]'),
    profileMain: document.querySelector('[data-field="profile-main"]'),
    profileUps: document.querySelector('[data-field="profile-ups"]'),
    profileBars: document.querySelector("[data-profile-bars]"),
    recStatus: document.querySelector('[data-field="rec-status"]'),
    recList: document.querySelector("[data-recommendations]"),
    recFootnote: document.querySelector('[data-field="rec-footnote"]'),
    refresh: document.querySelector("[data-refresh]"),
    discoveryStatus: document.querySelector('[data-field="discovery-status"]'),
    discoveryDiscovered: document.querySelector('[data-field="discovery-discovered"]'),
    discoveryRecommendable: document.querySelector('[data-field="discovery-recommendable"]'),
    discoveryInsufficient: document.querySelector('[data-field="discovery-insufficient"]'),
    discoveryMessage: document.querySelector('[data-field="discovery-message"]'),
    discoveryToggle: document.querySelector("[data-discovery-toggle]"),
    discoveryReorganize: document.querySelector("[data-discovery-reorganize]"),
    discoveryClear: document.querySelector("[data-discovery-clear]"),
    discoveryActionStatus: document.querySelector('[data-field="discovery-action-status"]'),
    importFile: document.querySelector("[data-import-file]"),
    importPreview: document.querySelector("[data-import-preview]"),
    importPreviewText: document.querySelector('[data-field="import-preview-text"]'),
    importConfirm: document.querySelector("[data-import-confirm]"),
    importCancel: document.querySelector("[data-import-cancel]"),
    importStatus: document.querySelector('[data-field="import-status"]'),
    importList: document.querySelector("[data-import-list]"),
    importClear: document.querySelector("[data-import-clear]"),
    dataExport: document.querySelector("[data-data-export]"),
    dataFile: document.querySelector("[data-data-file]"),
    dataPreview: document.querySelector("[data-data-preview]"),
    dataPreviewText: document.querySelector('[data-field="data-preview-text"]'),
    dataConfirm: document.querySelector("[data-data-confirm]"),
    dataCancel: document.querySelector("[data-data-cancel]"),
    dataStatus: document.querySelector('[data-field="data-status"]'),
    dataStatusLine: document.querySelector('[data-field="data-status-line"]'),
    heroStatus: document.querySelector("[data-hero-status]"),
    heroStatusText: document.querySelector("[data-hero-status-text]"),
    heroDot: document.querySelector("[data-hero-dot]"),
    assistant: document.querySelector(".assistant")
  };

  const dayLabels = Array.from(document.querySelectorAll("[data-day-label]"));

  let renderSeq = 0;
  let pendingPreview = null;
  let pendingDataImport = null;
  let currentStore = null;
  let currentDiscoveryStore = null;
  let currentDiscoverySettings = null;
  let refreshTimer = null;

  /* ---------------------------------------------------------------- 渲染工具 */

  function setField(element, text, isError) {
    if (!element) return;
    element.textContent = text;
    if (isError) element.classList.add("is-error");
    else element.classList.remove("is-error");
  }

  function clearChildren(element) {
    if (!element) return;
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  function describeDate(dateKey) {
    const parsed = Stats && Stats.parseDateKey ? Stats.parseDateKey(dateKey) : null;
    const word = DATE_WORDS[dateOption] || DATE_WORDS.yesterday;
    if (!parsed) return `${word}回顾`;
    return `${word}回顾 · ${parsed.month} 月 ${parsed.day} 日`;
  }

  /** 当前展示日期对应的本地日期键；today 复用 stats.js 的 localDateKey。 */
  function currentDateKey() {
    if (!Stats) return "";
    return dateOption === "today" ? Stats.localDateKey() : Stats.yesterdayKey();
  }

  function timeLabel(ms) {
    const date = new Date(typeof ms === "number" && Number.isFinite(ms) ? ms : Date.now());
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  /* -------------------------------------------------------- 头部状态 / 助手 */

  function setHeroStatus(state, text) {
    if (fields.heroStatus) {
      fields.heroStatus.className = `hero-status ${state || ""}`.trim();
    }
    if (fields.heroStatusText) fields.heroStatusText.textContent = text;
  }

  function rootHasRecords(root) {
    if (!root || typeof root !== "object" || !root.days || typeof root.days !== "object") {
      return false;
    }
    return Object.keys(root.days).some((dateKey) => {
      const day = root.days[dateKey];
      return Boolean(day) && typeof day === "object" && Object.keys(day).length > 0;
    });
  }

  function updateHeroFromData(rootResult, discoveredResult, settingsResult) {
    if (
      (rootResult && rootResult.ok === false) ||
      (discoveredResult && discoveredResult.ok === false) ||
      (settingsResult && settingsResult.ok === false)
    ) {
      setHeroStatus("is-alert", "本地链路 · 读取异常");
      return;
    }
    const enabled = Boolean(
      settingsResult &&
        settingsResult.ok &&
        settingsResult.settings &&
        settingsResult.settings.enabled === true
    );
    let discoveredCount = 0;
    if (discoveredResult && discoveredResult.ok && DiscoveredStore) {
      try {
        discoveredCount = DiscoveredStore.summarizeStore(discoveredResult.store).uniqueUpCount;
      } catch (error) {
        discoveredCount = 0;
      }
    }
    if (enabled && discoveredCount > 0) {
      setHeroStatus("is-active", `数据链路 · ${discoveredCount} 个候选已就绪`);
      return;
    }
    if (enabled) {
      setHeroStatus("is-active", "数据链路 · 自动发现开启");
      return;
    }
    if (rootResult && rootResult.ok && rootHasRecords(rootResult.root)) {
      setHeroStatus("is-ready", "本地链路 · 已连接");
      return;
    }
    setHeroStatus("is-off", "本地链路 · 待机");
  }

  function setupAssistant() {
    const image = document.querySelector("[data-assistant]");
    const box = image && image.closest ? image.closest(".assistant") : null;
    if (!image || !box) return;
    const fallback = () => {
      box.classList.add("is-fallback");
    };
    image.addEventListener("error", fallback);
    if (image.complete && image.naturalWidth === 0) fallback();
  }

  /* -------------------------------------------------------- 昨日观看总结 */

  function textCount(result) {
    if (result.effectiveVideoCount > 0) {
      const skipped = result.videoCount - result.effectiveVideoCount;
      return skipped > 0
        ? `${result.effectiveVideoCount} 个视频（另有 ${skipped} 个不足 30 秒）`
        : `${result.effectiveVideoCount} 个视频`;
    }
    if (result.videoCount > 0) return `0 个视频（${result.videoCount} 个视频均不足 30 秒）`;
    return "0 个视频";
  }

  function textPartition(result) {
    if (!result.partitionAvailable || !result.favoritePartition) {
      return result.partitionReason || "记录中缺少分区信息，无法统计";
    }
    const favorite = result.favoritePartition;
    const base = `${favorite.name}（占观看时长 ${Stats.formatPercent(favorite.share)}）`;
    return result.partitionReason ? `${base} · ${result.partitionReason}` : base;
  }

  function textPeriods(result) {
    if (!result.periodsAvailable) {
      return result.periodsReason || "记录中缺少精确观看时间戳，无法统计观看时段分布";
    }
    let total = 0;
    let top = result.periods[0];
    result.periods.forEach((period) => {
      total += period.watchMs;
      if (period.watchMs > top.watchMs) top = period;
    });
    if (total <= 0) return "记录中缺少精确观看时间戳，无法统计观看时段分布";
    return `共 ${Stats.formatDuration(total)} · ${top.label}最多`;
  }

  /** 清空并显示 UP 主模块的单一状态文案（隐藏列表与备注）。 */
  function setUpsState(text, isError) {
    if (fields.ups) {
      clearChildren(fields.ups);
      fields.ups.hidden = true;
    }
    if (fields.upsNote) {
      fields.upsNote.textContent = "";
      fields.upsNote.hidden = true;
    }
    if (fields.upsEmpty) fields.upsEmpty.hidden = false;
    setField(fields.upsEmpty, text, Boolean(isError));
  }

  /** 用 DOM API 构建条目，绝不拼接 innerHTML，避免 UP 主名称被当作标记解析。 */
  function buildUpItem(item, index) {
    const row = document.createElement("li");
    row.className = "up-item";

    const rank = document.createElement("span");
    rank.className = "up-rank";
    rank.textContent = String(index + 1);
    rank.setAttribute("aria-hidden", "true");

    const body = document.createElement("div");
    body.className = "up-body";

    const name = document.createElement("p");
    name.className = "up-name";
    name.textContent = item.upName || (item.upUid ? `UID ${item.upUid}` : "未知 UP 主");

    const meta = document.createElement("p");
    meta.className = "up-meta";
    meta.textContent = `有效观看 ${Stats.formatDuration(item.effectiveWatchMs)} · ${item.effectiveVideoCount} 个有效视频`;

    body.appendChild(name);
    body.appendChild(meta);
    row.appendChild(rank);
    row.appendChild(body);
    return row;
  }

  function renderUps(root, dateKey) {
    if (!fields.ups || !fields.upsEmpty) return;
    if (!Stats || typeof Stats.summarizeUps !== "function") {
      setUpsState(MISSING_SCRIPT_MESSAGE, true);
      return;
    }

    const word = DATE_WORDS[dateOption] || DATE_WORDS.yesterday;
    const result = Stats.summarizeUps(root, dateKey);

    if (!result.hasData) {
      setUpsState(`${word}没有观看记录`, false);
      return;
    }

    const items = result.items.slice(0, 3);
    if (items.length === 0) {
      setUpsState(result.reason || "记录中缺少 UP 主信息，无法排名", false);
      return;
    }

    clearChildren(fields.ups);
    items.forEach((item, index) => {
      fields.ups.appendChild(buildUpItem(item, index));
    });
    fields.ups.hidden = false;
    fields.upsEmpty.hidden = true;
    setField(fields.upsEmpty, "", false);

    if (fields.upsNote) {
      const notes = [];
      if (result.unknown.videoCount > 0) {
        notes.push(`另有 ${result.unknown.videoCount} 个视频缺少 UP 主信息，未参与排名`);
      }
      if (result.nameOnlyUpCount > 0 && result.uidUpCount > 0) {
        notes.push(`有 ${result.nameOnlyUpCount} 个 UP 主缺少 UID，已按昵称单独统计`);
      }
      if (result.belowThresholdVideoCount > 0) {
        notes.push(`有 ${result.belowThresholdVideoCount} 个视频不足 30 秒，未计入有效观看`);
      }
      fields.upsNote.textContent = notes.join("；");
      fields.upsNote.hidden = notes.length === 0;
    }
  }

  function renderYesterday(rootResult) {
    const word = DATE_WORDS[dateOption] || DATE_WORDS.yesterday;

    if (!rootResult || !rootResult.ok) {
      const detail =
        rootResult && rootResult.error && rootResult.error.message
          ? rootResult.error.message
          : "未知错误";
      if (fields.date) fields.date.textContent = `${word}回顾`;
      ["count", "duration", "partition", "periodsSummary"].forEach((key) => {
        setField(fields[key], `读取本地数据失败：${detail}`, true);
      });
      setUpsState(`读取本地数据失败：${detail}`, true);
      return;
    }

    const dateKey = currentDateKey();
    if (!dateKey || !Stats) {
      if (fields.date) fields.date.textContent = `${word}回顾`;
      ["count", "duration", "partition", "periodsSummary"].forEach((key) => {
        setField(fields[key], MISSING_SCRIPT_MESSAGE, true);
      });
      setUpsState(MISSING_SCRIPT_MESSAGE, true);
      return;
    }

    if (fields.date) fields.date.textContent = describeDate(dateKey);

    const result = Stats.summarizeDay(rootResult.root, dateKey);
    if (!result.hasData) {
      setField(fields.count, `${word}没有观看记录`, false);
      setField(fields.duration, `${word}没有观看记录`, false);
      setField(fields.partition, `${word}没有观看记录`, false);
      setField(fields.periodsSummary, `${word}没有观看记录`, false);
      renderUps(rootResult.root, dateKey);
      return;
    }

    setField(fields.count, textCount(result), false);
    setField(fields.duration, Stats.formatDuration(result.totalWatchMs), false);
    setField(fields.partition, textPartition(result), false);
    setField(fields.periodsSummary, textPeriods(result), false);
    renderUps(rootResult.root, dateKey);
  }

  /* -------------------------------------------------------- 7 天兴趣画像 */

  function renderProfile(view) {
    if (!fields.profileMain) return;

    if (!view || !view.ok) {
      setField(fields.profileStatus, "不可用", true);
      setField(
        fields.profileMain,
        view && view.error ? view.error.message : MISSING_SCRIPT_MESSAGE,
        true
      );
      if (fields.profileUps) fields.profileUps.textContent = "";
      clearChildren(fields.profileBars);
      return;
    }

    const profile = view.profile;
    const cold = view.coldStart;
    setField(fields.profileStatus, cold.label, false);

    if (!profile || !profile.hasData) {
      setField(fields.profileMain, cold.message, false);
      if (fields.profileUps) fields.profileUps.textContent = "";
      clearChildren(fields.profileBars);
      return;
    }

    const parts = [];
    if (profile.favoritePartition && profile.favoritePartition.name) {
      parts.push(
        `最常看：${profile.favoritePartition.name} · 占 ${Stats.formatPercent(profile.favoritePartition.share)}`
      );
    } else {
      parts.push("分区信息不足，暂未形成稳定偏好");
    }
    if (Number.isInteger(profile.activeDays) && profile.activeDays > 0) {
      parts.push(`${profile.activeDays} 个活跃日`);
    }
    if (profile.effectiveVideoCount > 0) {
      parts.push(`${profile.effectiveVideoCount} 个有效视频`);
    }
    setField(fields.profileMain, parts.join(" · "), false);

    clearChildren(fields.profileBars);
    (profile.bars || []).forEach((bar) => {
      const row = document.createElement("div");
      row.className = "bar";

      const label = document.createElement("span");
      label.className = "bar-label";
      label.textContent = bar.name;

      const track = document.createElement("span");
      track.className = "bar-track";
      const fill = document.createElement("span");
      fill.className = "bar-fill";
      const share = Number.isFinite(bar.share) ? Math.max(0, Math.min(1, bar.share)) : 0;
      fill.style.width = `${Math.round(share * 1000) / 10}%`;
      track.appendChild(fill);

      const value = document.createElement("span");
      value.className = "bar-value";
      value.textContent = Stats.formatPercent(bar.share);

      row.appendChild(label);
      row.appendChild(track);
      row.appendChild(value);
      fields.profileBars.appendChild(row);
    });

    if (fields.profileUps) {
      const topUp = profile.topUp;
      fields.profileUps.textContent =
        topUp && topUp.upName
          ? `常看 UP 主：${topUp.upName} · 有效观看 ${Stats.formatDuration(topUp.effectiveWatchMs)}`
          : "还没有足够稳定的 UP 主偏好。";
    }
  }

  /* -------------------------------------------------------- 今日推荐列表 */

  function confidenceBadgeClass(confidence) {
    return "badge badge-confidence";
  }

  function buildReasonList(reasons) {
    const list = document.createElement("ul");
    list.className = "reason-list";
    (reasons || []).forEach((reason) => {
      const item = document.createElement("li");
      item.textContent = reason.message;
      list.appendChild(item);
    });
    return list;
  }

  function reliabilityText(card) {
    const pieces = [];
    const reliability = card.reliability || {};
    if (typeof reliability.partitionCoverage === "number") {
      pieces.push(`分区覆盖 ${Stats.formatPercent(reliability.partitionCoverage)}`);
    }
    if (typeof reliability.titleCoverage === "number") {
      pieces.push(`标题覆盖 ${Stats.formatPercent(reliability.titleCoverage)}`);
    }
    if (pieces.length === 0) return "缺少在线核验，仅按本地数据计算。";
    return `${pieces.join(" · ")} · 未在线核验`;
  }

  function buildRecommendationCard(card, index) {
    const item = document.createElement("li");
    item.className = `rec-card rec-${card.lane === "exploration" ? "exploration" : "main"}`;

    const top = document.createElement("div");
    top.className = "rec-top";

    const rank = document.createElement("span");
    rank.className = "rec-rank";
    rank.textContent = String(index + 1);

    const lane = document.createElement("span");
    lane.className = `badge ${card.lane === "exploration" ? "badge-explore" : "badge-main"}`;
    lane.textContent = card.laneLabel;

    const confidence = document.createElement("span");
    confidence.className = confidenceBadgeClass(card.confidence);
    confidence.textContent = card.confidenceLabel;

    top.appendChild(rank);
    top.appendChild(lane);
    if (card.provenance === "page-observed") {
      const observed = document.createElement("span");
      observed.className = "badge badge-observed";
      observed.textContent = "页面相关推荐发现";
      top.appendChild(observed);
    }
    top.appendChild(confidence);

    let name;
    if (card.spaceUrl) {
      name = document.createElement("a");
      name.className = "rec-name";
      name.href = card.spaceUrl;
      name.target = "_blank";
      name.rel = "noopener noreferrer";
      name.title = "打开 UP 主个人空间";
    } else {
      name = document.createElement("span");
      name.className = "rec-name";
    }
    name.textContent = card.upName;

    const meta = document.createElement("p");
    meta.className = "rec-meta";
    meta.textContent = card.provenanceLabel;

    item.appendChild(top);
    item.appendChild(name);
    item.appendChild(meta);
    if (card.reasons.length > 0) item.appendChild(buildReasonList(card.reasons));

    const source = document.createElement("p");
    source.className = "rec-source";
    source.textContent = reliabilityText(card);
    item.appendChild(source);

    return item;
  }

  function renderRecommendations(view) {
    if (!fields.recStatus) return;

    if (!RecommendService || typeof RecommendService.buildView !== "function") {
      setField(fields.recStatus, MISSING_SCRIPT_MESSAGE, true);
      clearChildren(fields.recList);
      if (fields.recFootnote) fields.recFootnote.hidden = true;
      return;
    }

    if (!view || !view.ok) {
      const message =
        view && view.error ? view.error.message : "推荐计算失败，请点击刷新重试";
      setField(fields.recStatus, message, true);
      clearChildren(fields.recList);
      if (fields.recFootnote) fields.recFootnote.hidden = true;
      return;
    }

    setField(fields.recStatus, `${view.statusText} · 更新于 ${timeLabel(view.generatedAt)}`, false);
    clearChildren(fields.recList);
    view.recommendations.forEach((card, index) => {
      fields.recList.appendChild(buildRecommendationCard(card, index));
    });

    if (fields.recFootnote) {
      fields.recFootnote.textContent = view.footnote || "";
      fields.recFootnote.hidden = !view.footnote;
    }
  }

  /* -------------------------------------------------------- 自动发现状态 */

  function discoveryFallbackView(settings, storeResult) {
    const enabled = Boolean(settings && settings.enabled === true);
    let discovered = 0;
    if (storeResult && storeResult.ok && DiscoveredStore) {
      discovered = DiscoveredStore.summarizeStore(storeResult.store).uniqueUpCount;
    }
    return {
      status: enabled ? "enabled" : "disabled",
      statusLabel: enabled ? "已开启" : "已关闭",
      counts: { discovered, recommendable: 0, insufficient: 0, pendingReview: 0 },
      message: enabled
        ? "已在视频页开启观察。候选只会在你正常浏览、页面已渲染相关推荐卡片时逐步积累。"
        : "自动发现当前关闭，不会读取视频页推荐卡片。开启后才会在正常浏览视频页时逐步积累候选。"
    };
  }

  function renderDiscovery(discoveryView, storeResult, settingsResult, rootResult) {
    if (!fields.discoveryStatus) return;

    if (!DiscoveredStore) {
      setField(fields.discoveryStatus, "不可用", true);
      fields.discoveryStatus.className = "pill pill-gray is-error";
      setField(fields.discoveryMessage, MISSING_SCRIPT_MESSAGE, true);
      [fields.discoveryDiscovered, fields.discoveryRecommendable, fields.discoveryInsufficient].forEach(
        (element) => setField(element, "—", false)
      );
      if (fields.discoveryToggle) fields.discoveryToggle.disabled = true;
      if (fields.discoveryReorganize) fields.discoveryReorganize.disabled = true;
      if (fields.discoveryClear) fields.discoveryClear.hidden = true;
      return;
    }

    const settings =
      settingsResult && settingsResult.ok
        ? settingsResult.settings
        : DiscoveredStore.normalizeSettings(null);

    if (storeResult && storeResult.ok === false) {
      setField(fields.discoveryStatus, "不可用", true);
      fields.discoveryStatus.className = "pill pill-gray is-error";
      setField(
        fields.discoveryMessage,
        "页面观察候选读取失败，暂不显示数量，也不会在本次弹窗中改动候选。",
        true
      );
      [fields.discoveryDiscovered, fields.discoveryRecommendable, fields.discoveryInsufficient].forEach(
        (element) => setField(element, "—", false)
      );
      if (fields.discoveryToggle) fields.discoveryToggle.disabled = true;
      if (fields.discoveryReorganize) fields.discoveryReorganize.disabled = true;
      if (fields.discoveryClear) fields.discoveryClear.hidden = true;
      return;
    }

    if (settingsResult && settingsResult.ok === false) {
      setField(fields.discoveryStatus, "不可用", true);
      fields.discoveryStatus.className = "pill pill-gray is-error";
      setField(
        fields.discoveryMessage,
        "自动发现设置读取失败，暂不显示状态，也不会在本次弹窗中改动设置。",
        true
      );
      [fields.discoveryDiscovered, fields.discoveryRecommendable, fields.discoveryInsufficient].forEach(
        (element) => setField(element, "—", false)
      );
      if (fields.discoveryToggle) fields.discoveryToggle.disabled = true;
      if (fields.discoveryReorganize) fields.discoveryReorganize.disabled = true;
      if (fields.discoveryClear) fields.discoveryClear.hidden = true;
      return;
    }

    let view = discoveryView;
    if (
      !view &&
      storeResult &&
      storeResult.ok &&
      rootResult &&
      rootResult.ok
    ) {
      try {
        const evidence = DiscoveredStore.buildDiscoveredEvidence(
          storeResult.store,
          rootResult.root,
          { now: Date.now(), settings }
        );
        view =
          RecommendService && RecommendService._internal
            ? RecommendService._internal.buildDiscoveryView(settings, evidence)
            : null;
      } catch (error) {
        view = null;
      }
    }
    if (!view) view = discoveryFallbackView(settings, storeResult);

    const statusClass =
      view.status === "unavailable"
        ? "is-error"
        : view.status === "insufficient"
          ? "is-warn"
          : view.status === "has-candidates" || view.status === "enabled"
            ? "is-active"
            : "";
    fields.discoveryStatus.className = `pill pill-gray ${statusClass}`.trim();
    setField(fields.discoveryStatus, view.statusLabel || "未知", view.status === "unavailable");

    const counts = view.counts || {};
    setField(
      fields.discoveryDiscovered,
      String(Number.isInteger(counts.discovered) ? counts.discovered : 0),
      false
    );
    setField(
      fields.discoveryRecommendable,
      String(Number.isInteger(counts.recommendable) ? counts.recommendable : 0),
      false
    );
    setField(
      fields.discoveryInsufficient,
      String(Number.isInteger(counts.insufficient) ? counts.insufficient : 0),
      false
    );
    const pending = Number.isInteger(counts.pendingReview) ? counts.pendingReview : 0;
    setField(
      fields.discoveryMessage,
      `${view.message || ""}${pending > 0 ? ` 另有 ${pending} 个候选存在身份冲突，待人工复核，不会进入推荐。` : ""}`,
      false
    );

    const enabled = Boolean(settings.enabled === true);
    if (fields.discoveryToggle) {
      fields.discoveryToggle.disabled = view.status === "unavailable";
      fields.discoveryToggle.textContent = enabled ? "关闭自动发现" : "开启自动发现";
      fields.discoveryToggle.setAttribute("aria-pressed", String(enabled));
      fields.discoveryToggle.classList.toggle("primary", !enabled);
      fields.discoveryToggle.classList.toggle("ghost", enabled);
    }
    if (fields.discoveryReorganize) {
      fields.discoveryReorganize.disabled = view.status === "unavailable";
    }
    if (fields.discoveryClear) {
      const summary = storeResult && storeResult.ok
        ? DiscoveredStore.summarizeStore(storeResult.store)
        : { observationCount: 0 };
      fields.discoveryClear.hidden = summary.observationCount === 0;
    }
  }

  /* -------------------------------------------------------- 导入管理列表 */

  function setImportStatus(text, isError) {
    setField(fields.importStatus, text, Boolean(isError));
  }

  function importReasonText(result) {
    if (!result) return "未知错误";
    if (result.message) return result.message;
    if (result.reason && CandidateStore) return CandidateStore.reasonText(result.reason);
    return "未知错误";
  }

  function renderImportList(storeResult) {
    if (!fields.importList) return;
    clearChildren(fields.importList);

    if (!storeResult || !storeResult.ok) {
      if (fields.importClear) fields.importClear.hidden = true;
      setImportStatus(
        `候选数据读取失败：${importReasonText(storeResult)}。暂不显示已导入内容。`,
        true
      );
      return;
    }

    const store = storeResult.store;
    const batches = store && Array.isArray(store.batches) ? store.batches : [];
    if (fields.importClear) fields.importClear.hidden = batches.length === 0;

    batches.forEach((batch) => {
      const box = document.createElement("div");
      box.className = "import-batch";

      const head = document.createElement("div");
      head.className = "batch-head";

      const name = document.createElement("span");
      name.className = "batch-name";
      name.textContent = batch.sourceName || "导入批次";
      name.title = batch.sourceName || "导入批次";

      const meta = document.createElement("span");
      meta.className = "batch-meta";
      const importedAt = Date.parse(batch.importedAt);
      const countText = `${batch.candidates.length} 个候选`;
      meta.textContent = Number.isFinite(importedAt)
        ? `${countText} · ${timeLabel(importedAt)}`
        : countText;

      const deleteBatchButton = document.createElement("button");
      deleteBatchButton.type = "button";
      deleteBatchButton.className = "ghost";
      deleteBatchButton.textContent = "删除批次";
      deleteBatchButton.addEventListener("click", () => {
        handleDeleteBatch(batch.id);
      });

      head.appendChild(name);
      head.appendChild(meta);
      head.appendChild(deleteBatchButton);
      box.appendChild(head);

      batch.candidates.forEach((candidate) => {
        const row = document.createElement("div");
        row.className = "candidate-row";

        const candidateName = document.createElement("span");
        candidateName.className = "candidate-name";
        candidateName.textContent = candidate.upName || `UID ${candidate.upUid}`;
        candidateName.title = candidateName.textContent;

        const candidateMeta = document.createElement("span");
        candidateMeta.className = "candidate-meta";
        candidateMeta.textContent = `${candidate.videos.length} 个视频`;

        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "ghost";
        deleteButton.textContent = "删除";
        deleteButton.setAttribute("aria-label", `删除候选 ${candidateName.textContent}`);
        deleteButton.addEventListener("click", () => {
          handleDeleteCandidate(batch.id, candidate.upUid);
        });

        row.appendChild(candidateName);
        row.appendChild(candidateMeta);
        row.appendChild(deleteButton);
        box.appendChild(row);
      });

      fields.importList.appendChild(box);
    });
  }

  /* ------------------------------------------------------------ 导入操作 */

  function maxImportBytes() {
    const Import = global.BiliDailyCandidateContentImport;
    if (Import && Import.DEFAULT_LIMITS && Number.isFinite(Import.DEFAULT_LIMITS.maxInputBytes)) {
      return Import.DEFAULT_LIMITS.maxInputBytes;
    }
    return FALLBACK_MAX_IMPORT_BYTES;
  }

  function readFileText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.onerror = () => reject(reader.error || new Error("文件读取失败"));
      reader.readAsText(file, "utf-8");
    });
  }

  function resetFileInput() {
    if (fields.importFile) fields.importFile.value = "";
  }

  function hidePreview() {
    pendingPreview = null;
    if (fields.importPreview) fields.importPreview.hidden = true;
    if (fields.importPreviewText) fields.importPreviewText.textContent = "";
  }

  function showPreview(fileName, preview) {
    pendingPreview = { text: preview.text, sourceName: fileName };
    if (fields.importPreviewText) {
      const rejected = preview.diagnostics ? preview.diagnostics.candidatesInvalid : 0;
      const rejectedText = rejected > 0 ? `，已跳过 ${rejected} 条无效候选` : "";
      fields.importPreviewText.textContent = `已读取 ${fileName}：${preview.summary.candidateCount} 个候选 / ${preview.summary.videoCount} 个视频${rejectedText}。确认后才会写入本地。`;
    }
    if (fields.importPreview) fields.importPreview.hidden = false;
  }

  async function handleFile(file) {
    if (!file) return;
    if (!CandidateStore) {
      setImportStatus(MISSING_SCRIPT_MESSAGE, true);
      resetFileInput();
      return;
    }
    hidePreview();
    setImportStatus("", false);

    const maxBytes = maxImportBytes();
    if (file.size > maxBytes) {
      setImportStatus(`导入失败：文件超过 ${maxBytes} 字节上限，请精简后重试。`, true);
      resetFileInput();
      return;
    }

    let text = "";
    try {
      text = await readFileText(file);
    } catch (error) {
      setImportStatus(`导入失败：无法读取文件（${error && error.message ? error.message : "未知错误"}）`, true);
      resetFileInput();
      return;
    }

    const preview = CandidateStore.previewImport(text);
    if (!preview.ok) {
      setImportStatus(`导入失败：${importReasonText(preview)}。原有候选数据未改动。`, true);
      resetFileInput();
      return;
    }

    showPreview(file.name, Object.assign({ text }, preview));
  }

  async function handleImportConfirm() {
    if (!pendingPreview || !CandidateStore) return;
    const pending = pendingPreview;
    if (fields.importConfirm) fields.importConfirm.disabled = true;
    try {
      const result = await CandidateStore.importText(pending.text, {
        sourceName: pending.sourceName
      });
      if (!result.ok) {
        setImportStatus(`导入失败：${importReasonText(result)}。原有候选数据未改动。`, true);
        return;
      }
      setImportStatus(
        `已保存 ${result.addedCandidates} 个候选（${pending.sourceName}）。探索通道会自动使用通过准入的候选。`,
        false
      );
      hidePreview();
      resetFileInput();
      await refreshAll(false);
    } finally {
      if (fields.importConfirm) fields.importConfirm.disabled = false;
    }
  }

  function handleImportCancel() {
    hidePreview();
    resetFileInput();
    setImportStatus("已取消导入，没有写入任何数据。", false);
  }

  async function handleDeleteCandidate(batchId, upUid) {
    if (!CandidateStore) return;
    const result = await CandidateStore.deleteCandidate(batchId, upUid);
    if (!result.ok) {
      setImportStatus(`删除失败：${importReasonText(result)}`, true);
      return;
    }
    setImportStatus("已删除该候选。", false);
    await refreshAll(false);
  }

  async function handleDeleteBatch(batchId) {
    if (!CandidateStore) return;
    const result = await CandidateStore.deleteBatch(batchId);
    if (!result.ok) {
      setImportStatus(`删除失败：${importReasonText(result)}`, true);
      return;
    }
    setImportStatus("已删除该导入批次。", false);
    await refreshAll(false);
  }

  async function handleClearAll() {
    if (!CandidateStore || !currentStore) return;
    const count = currentStore.batches.reduce(
      (total, batch) => total + batch.candidates.length,
      0
    );
    const confirmed =
      typeof global.confirm === "function"
        ? global.confirm(`确定清空全部导入的 ${count} 个候选？此操作不可撤销，但不影响观看记录。`)
        : false;
    if (!confirmed) {
      setImportStatus("已取消清空操作。", false);
      return;
    }
    const result = await CandidateStore.clearStore();
    if (!result.ok) {
      setImportStatus(`清空失败：${importReasonText(result)}`, true);
      return;
    }
    setImportStatus("已清空全部导入候选，观看记录未受影响。", false);
    await refreshAll(false);
  }

  /* ------------------------------------------------------------ 数据舱：本地备份 */

  function setDataStatus(pillText, detailText, state) {
    if (fields.dataStatus) {
      fields.dataStatus.textContent = pillText;
      const tone = state === "error" ? "is-error" : state === "active" ? "is-active" : "";
      fields.dataStatus.className = `pill pill-gray ${tone}`.trim();
    }
    setField(fields.dataStatusLine, detailText, state === "error");
  }

  function readAllLocal() {
    return new Promise((resolve, reject) => {
      try {
        if (!global.chrome || !chrome.storage || !chrome.storage.local) {
          reject(new Error("chrome.storage.local 不可用"));
          return;
        }
        chrome.storage.local.get(DataBackup ? DataBackup.KEY_LIST : null, (all) => {
          const error = chrome.runtime && chrome.runtime.lastError ? chrome.runtime.lastError : null;
          if (error) {
            reject(new Error(error.message || "读取本地存储失败"));
            return;
          }
          resolve(all && typeof all === "object" ? all : {});
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function dataNormalizers() {
    if (!DataBackup || !Store || !CandidateStore || !DiscoveredStore) return null;
    return {
      [DataBackup.KEYS.records]: (value) => ({
        value: Store.normalizeRoot(value),
        warnings: []
      }),
      [DataBackup.KEYS.imports]: (value) => {
        const result = CandidateStore.normalizeStore(value);
        return { value: result.store, warnings: result.warnings || [] };
      },
      [DataBackup.KEYS.discovered]: (value) => {
        const result = DiscoveredStore.normalizeStore(value);
        return { value: result.store, warnings: result.warnings || [] };
      },
      [DataBackup.KEYS.settings]: (value) => ({
        value: DiscoveredStore.normalizeSettings(value),
        warnings: []
      })
    };
  }

  function resetDataFile() {
    if (fields.dataFile) fields.dataFile.value = "";
  }

  function hideDataPreview() {
    pendingDataImport = null;
    if (fields.dataPreview) fields.dataPreview.hidden = true;
    if (fields.dataPreviewText) fields.dataPreviewText.textContent = "";
  }

  async function handleDataExport() {
    if (!DataBackup) {
      setDataStatus("不可用", MISSING_SCRIPT_MESSAGE, "error");
      return;
    }
    if (fields.dataExport) fields.dataExport.disabled = true;
    try {
      const all = await readAllLocal();
      const now = Date.now();
      const result = DataBackup.serializeBackup(all, now);
      if (!result.ok) {
        setDataStatus("导出失败", `导出失败：${DataBackup.reasonText(result.reason)}。没有写入任何数据。`, "error");
        return;
      }
      const blob = new Blob([result.text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = DataBackup.filename(now);
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      global.setTimeout(() => URL.revokeObjectURL(url), 1500);
      setDataStatus(
        "已导出",
        `已生成备份：${anchor.download}。${DataBackup.formatSummary(result.summary)}。`,
        "active"
      );
    } catch (error) {
      setDataStatus(
        "导出失败",
        `导出失败：${error && error.message ? error.message : "未知错误"}。没有写入任何数据。`,
        "error"
      );
    } finally {
      if (fields.dataExport) fields.dataExport.disabled = false;
    }
  }

  async function handleDataFile(file) {
    if (!file) return;
    if (!DataBackup) {
      setDataStatus("不可用", MISSING_SCRIPT_MESSAGE, "error");
      resetDataFile();
      return;
    }
    hideDataPreview();
    if (file.size > DataBackup.MAX_BYTES) {
      setDataStatus("文件过大", `读取失败：文件超过 ${DataBackup.MAX_BYTES} 字节上限。原有数据未改动。`, "error");
      resetDataFile();
      return;
    }
    setDataStatus("读取中", "正在读取备份文件…", "");
    let text = "";
    try {
      text = await readFileText(file);
    } catch (error) {
      setDataStatus(
        "读取失败",
        `读取失败：${error && error.message ? error.message : "未知错误"}。原有数据未改动。`,
        "error"
      );
      resetDataFile();
      return;
    }
    const normalizers = dataNormalizers();
    if (!normalizers) {
      setDataStatus("不可用", MISSING_SCRIPT_MESSAGE, "error");
      resetDataFile();
      return;
    }
    const result = DataBackup.prepareImport(text, normalizers);
    if (!result.ok) {
      setDataStatus(
        "校验失败",
        `校验失败：${DataBackup.reasonText(result.reason)}。原有数据未改动。`,
        "error"
      );
      resetDataFile();
      return;
    }
    pendingDataImport = {
      payload: result.payload,
      sourceName: file.name,
      keyCount: Object.keys(result.payload).length
    };
    if (fields.dataPreviewText) {
      const warningText =
        result.warnings && result.warnings.length > 0
          ? `；校验时跳过/修正 ${result.warnings.length} 项`
          : "";
      fields.dataPreviewText.textContent =
        `已读取 ${file.name}：${DataBackup.formatSummary(result.summary)}${warningText}。` +
        `确认后将覆盖备份中包含的 ${pendingDataImport.keyCount} 类同名键，未包含的键保持不变。`;
    }
    if (fields.dataPreview) fields.dataPreview.hidden = false;
    setDataStatus("待确认", "预览完成，尚未写入。请确认后再恢复。", "");
  }

  async function handleDataConfirm() {
    if (!pendingDataImport || !DataBackup) return;
    const confirmed =
      typeof global.confirm === "function"
        ? global.confirm(
            `确定恢复 ${pendingDataImport.sourceName}？备份中包含的同名键会被覆盖，未包含的键保持不变。建议先导出当前数据。`
          )
        : false;
    if (!confirmed) {
      setDataStatus("待确认", "已取消恢复，没有写入任何数据。", "");
      return;
    }
    if (fields.dataConfirm) fields.dataConfirm.disabled = true;
    try {
      const result = await DataBackup.writePayload(
        pendingDataImport.payload,
        global.chrome && chrome.storage ? chrome.storage.local : null
      );
      if (!result.ok) {
        setDataStatus(
          "恢复失败",
          `恢复失败：${DataBackup.reasonText(result.reason)}。原有数据未被覆盖。`,
          "error"
        );
        return;
      }
      const name = pendingDataImport.sourceName;
      hideDataPreview();
      resetDataFile();
      setDataStatus("已恢复", `已从 ${name} 恢复本地数据。`, "active");
      await refreshAll(false);
    } finally {
      if (fields.dataConfirm) fields.dataConfirm.disabled = false;
    }
  }

  function handleDataCancel() {
    hideDataPreview();
    resetDataFile();
    setDataStatus("待命", "已取消恢复，没有写入任何数据。", "");
  }

  function setupDataActions() {
    if (fields.dataExport) {
      fields.dataExport.addEventListener("click", () => {
        handleDataExport().catch((error) => {
          setDataStatus(
            "导出失败",
            `导出失败：${error && error.message ? error.message : "未知错误"}`,
            "error"
          );
        });
      });
    }
    if (fields.dataFile) {
      fields.dataFile.addEventListener("change", () => {
        const file = fields.dataFile.files && fields.dataFile.files[0];
        handleDataFile(file).catch((error) => {
          setDataStatus(
            "读取失败",
            `读取失败：${error && error.message ? error.message : "未知错误"}`,
            "error"
          );
        });
      });
    }
    if (fields.dataConfirm) {
      fields.dataConfirm.addEventListener("click", () => {
        handleDataConfirm().catch((error) => {
          setDataStatus(
            "恢复失败",
            `恢复失败：${error && error.message ? error.message : "未知错误"}`,
            "error"
          );
        });
      });
    }
    if (fields.dataCancel) {
      fields.dataCancel.addEventListener("click", handleDataCancel);
    }
  }

  /* ------------------------------------------------------------ 自动发现操作 */

  function setDiscoveryActionStatus(text, isError) {
    setField(fields.discoveryActionStatus, text, Boolean(isError));
  }

  async function handleDiscoveryToggle() {
    if (!DiscoveredStore) return;
    const enabled = Boolean(currentDiscoverySettings && currentDiscoverySettings.enabled === true);
    if (fields.discoveryToggle) fields.discoveryToggle.disabled = true;
    try {
      const result = await DiscoveredStore.saveSettings({ enabled: !enabled });
      if (!result.ok) {
        setDiscoveryActionStatus("切换失败：本地设置写入失败，请重试。", true);
        return;
      }
      currentDiscoverySettings = result.settings;
      setDiscoveryActionStatus(
        result.settings.enabled
          ? "已开启自动发现。之后正常浏览视频页时，会逐步读取已渲染的相关推荐卡片。"
          : "已关闭自动发现。已积累的候选仍保存在本地，之后不会继续写入。",
        false
      );
      await refreshAll(false);
    } finally {
      if (fields.discoveryToggle) fields.discoveryToggle.disabled = false;
    }
  }

  async function handleDiscoveryReorganize() {
    if (!DiscoveredStore) return;
    if (fields.discoveryReorganize) fields.discoveryReorganize.disabled = true;
    try {
      const result = await DiscoveredStore.rebuildStore();
      if (!result.ok) {
        setDiscoveryActionStatus("整理失败：本地候选数据写入失败，请重试。", true);
        return;
      }
      setDiscoveryActionStatus(
        `已重新整理：保留 ${result.total} 条页面观察记录${result.dropped > 0 ? `，清理 ${result.dropped} 条过期或超出容量的记录` : ""}。`,
        false
      );
      await refreshAll(false);
    } finally {
      if (fields.discoveryReorganize) fields.discoveryReorganize.disabled = false;
    }
  }

  async function handleDiscoveryClear() {
    if (!DiscoveredStore) return;
    const summary = currentDiscoveryStore
      ? DiscoveredStore.summarizeStore(currentDiscoveryStore)
      : { observationCount: 0, uniqueUpCount: 0 };
    const confirmed =
      typeof global.confirm === "function"
        ? global.confirm(
            `确定清除全部 ${summary.observationCount} 条页面观察记录（${summary.uniqueUpCount} 个 UP 主）？此操作只影响自动发现候选，不会影响观看记录或手动导入。`
          )
        : false;
    if (!confirmed) {
      setDiscoveryActionStatus("已取消清除操作。", false);
      return;
    }
    if (fields.discoveryClear) fields.discoveryClear.disabled = true;
    try {
      const result = await DiscoveredStore.clearStore();
      if (!result.ok) {
        setDiscoveryActionStatus("清除失败：本地候选数据写入失败，请重试。", true);
        return;
      }
      setDiscoveryActionStatus("已清除页面观察候选。观看记录与手动导入候选未受影响。", false);
      await refreshAll(false);
    } finally {
      if (fields.discoveryClear) fields.discoveryClear.disabled = false;
    }
  }

  /* ---------------------------------------------------------------- 总刷新 */

  function refreshAll(announce) {
    const seq = ++renderSeq;

    if (!Store) {
      renderYesterday({ ok: false, error: new Error(MISSING_SCRIPT_MESSAGE) });
      setField(fields.recStatus, MISSING_SCRIPT_MESSAGE, true);
      setImportStatus(MISSING_SCRIPT_MESSAGE, true);
      renderDiscovery(null, null, null, null);
      setHeroStatus("is-alert", "本地链路 · 脚本缺失");
      return Promise.resolve();
    }
    if (!Stats) {
      renderYesterday({ ok: false, error: new Error(MISSING_SCRIPT_MESSAGE) });
      setField(fields.recStatus, MISSING_SCRIPT_MESSAGE, true);
      setImportStatus(MISSING_SCRIPT_MESSAGE, true);
      renderDiscovery(null, null, null, null);
      setHeroStatus("is-alert", "本地链路 · 脚本缺失");
      return Promise.resolve();
    }

    if (announce) {
      setField(fields.recStatus, "正在重新计算推荐…", false);
      setImportStatus("正在刷新本地数据…", false);
    }

    const storePromise = CandidateStore
      ? CandidateStore.readStore()
      : Promise.resolve({
          ok: false,
          reason: "missing-script",
          message: MISSING_SCRIPT_MESSAGE,
          store: null
        });
    const discoveredStorePromise = DiscoveredStore
      ? DiscoveredStore.readStore()
      : Promise.resolve({ ok: false, reason: "missing-script", store: null });
    const discoveredSettingsPromise = DiscoveredStore
      ? DiscoveredStore.readSettings()
      : Promise.resolve({ ok: false, reason: "missing-script", settings: null });

    return Promise.all([
      Store.readRootSafe(),
      storePromise,
      discoveredStorePromise,
      discoveredSettingsPromise
    ]).then(([rootResult, storeResult, discoveredResult, settingsResult]) => {
      if (seq !== renderSeq) return;

      currentStore = storeResult.ok ? storeResult.store : null;
      currentDiscoveryStore = discoveredResult.ok ? discoveredResult.store : null;
      currentDiscoverySettings = settingsResult.ok ? settingsResult.settings : null;

      renderYesterday(rootResult);
      renderImportList(storeResult);

      if (!RecommendService || typeof RecommendService.buildView !== "function") {
        renderRecommendations({
          ok: false,
          error: { code: "missing-script", message: MISSING_SCRIPT_MESSAGE }
        });
        renderProfile({
          ok: false,
          error: { code: "missing-script", message: MISSING_SCRIPT_MESSAGE }
        });
        renderDiscovery(null, discoveredResult, settingsResult, rootResult);
        updateHeroFromData(rootResult, discoveredResult, settingsResult);
        return;
      }

      let view;
      if (!rootResult.ok) {
        const detail =
          rootResult.error && rootResult.error.message
            ? rootResult.error.message
            : "未知错误";
        view = {
          ok: false,
          error: { code: "records-read-failed", message: `读取本地观看记录失败：${detail}` }
        };
      } else {
        view = RecommendService.buildView({
          records: rootResult.root,
          store: storeResult.ok ? storeResult.store : null,
          discoveredStore: discoveredResult.ok ? discoveredResult.store : null,
          discoverySettings: settingsResult.ok ? settingsResult.settings : null,
          options: { K: RecommendService.DEFAULT_K, explorationQuota: RecommendService.DEFAULT_EXPLORATION_QUOTA }
        });
      }

      renderProfile(view);
      renderRecommendations(view);
      renderDiscovery(
        view && view.ok ? view.discovery : null,
        discoveredResult,
        settingsResult,
        rootResult
      );
      updateHeroFromData(rootResult, discoveredResult, settingsResult);

      if (storeResult.ok && announce) {
        setImportStatus("已刷新。", false);
      } else if (!storeResult.ok) {
        setImportStatus(`候选数据读取失败：${importReasonText(storeResult)}`, true);
      }
    });
  }

  /* -------------------------------------------------------- 开发模式日期切换 */

  /**
   * 仅当 dev-config.js 中 enabled === true 时显示日期切换入口。
   * 正式版（默认 false）入口保持 hidden，DOM 里也不会出现可点击的按钮。
   * 日期选择只保存在本次弹窗的内存中，不写入 chrome.storage.local。
   */
  function setupDevSwitch() {
    const container = document.querySelector("[data-dev-switch]");
    if (!container) return;

    if (!DevConfig || DevConfig.enabled !== true) {
      container.hidden = true;
      return;
    }

    const buttons = Array.from(container.querySelectorAll("[data-date-option]"));
    const options = new Set(
      buttons
        .map((button) => button.getAttribute("data-date-option"))
        .filter((option) => Object.prototype.hasOwnProperty.call(DATE_WORDS, option))
    );
    if (!options.size) return;

    const preferred = DevConfig.defaultDateOption;
    if (typeof preferred === "string" && options.has(preferred)) dateOption = preferred;

    function sync() {
      buttons.forEach((button) => {
        const active = button.getAttribute("data-date-option") === dateOption;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", String(active));
      });
    }

    buttons.forEach((button) => {
      button.addEventListener("click", () => {
        const next = button.getAttribute("data-date-option");
        if (!options.has(next) || next === dateOption) return;
        dateOption = next;
        sync();
        refreshAll(false);
      });
    });

    sync();
    container.hidden = false;
  }

  /* ------------------------------------------------------------ 事件接线 */

  function setupActions() {
    if (fields.refresh) {
      fields.refresh.addEventListener("click", () => {
        refreshAll(true);
      });
    }

    if (fields.importFile) {
      fields.importFile.addEventListener("change", () => {
        const file = fields.importFile.files && fields.importFile.files[0];
        handleFile(file).catch((error) => {
          setImportStatus(`导入失败：${error && error.message ? error.message : "未知错误"}`, true);
        });
      });
    }

    if (fields.importConfirm) {
      fields.importConfirm.addEventListener("click", () => {
        handleImportConfirm().catch((error) => {
          setImportStatus(`导入失败：${error && error.message ? error.message : "未知错误"}`, true);
        });
      });
    }

    if (fields.importCancel) {
      fields.importCancel.addEventListener("click", handleImportCancel);
    }

    if (fields.importClear) {
      fields.importClear.addEventListener("click", () => {
        handleClearAll().catch((error) => {
          setImportStatus(`清空失败：${error && error.message ? error.message : "未知错误"}`, true);
        });
      });
    }

    if (fields.discoveryToggle) {
      fields.discoveryToggle.addEventListener("click", () => {
        handleDiscoveryToggle().catch((error) => {
          setDiscoveryActionStatus(
            `切换失败：${error && error.message ? error.message : "未知错误"}`,
            true
          );
        });
      });
    }

    if (fields.discoveryReorganize) {
      fields.discoveryReorganize.addEventListener("click", () => {
        handleDiscoveryReorganize().catch((error) => {
          setDiscoveryActionStatus(
            `整理失败：${error && error.message ? error.message : "未知错误"}`,
            true
          );
        });
      });
    }

    if (fields.discoveryClear) {
      fields.discoveryClear.addEventListener("click", () => {
        handleDiscoveryClear().catch((error) => {
          setDiscoveryActionStatus(
            `清除失败：${error && error.message ? error.message : "未知错误"}`,
            true
          );
        });
      });
    }
  }

  /* ------------------------------------------------------------ 存储变化监听 */

  function watchStorage() {
    try {
      if (!global.chrome || !chrome.storage || !chrome.storage.onChanged) return;
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName && areaName !== "local") return;
        const watched =
          changes &&
          ((Store && Object.prototype.hasOwnProperty.call(changes, Store.STORAGE_KEY)) ||
            (CandidateStore &&
              Object.prototype.hasOwnProperty.call(changes, CandidateStore.STORE_KEY)) ||
            (DiscoveredStore &&
              (Object.prototype.hasOwnProperty.call(changes, DiscoveredStore.STORE_KEY) ||
                Object.prototype.hasOwnProperty.call(changes, DiscoveredStore.SETTINGS_KEY))));
        if (!watched) return;
        if (refreshTimer) global.clearTimeout(refreshTimer);
        refreshTimer = global.setTimeout(() => {
          refreshTimer = null;
          refreshAll(false);
        }, 200);
      });
    } catch (error) {
      console.error("[Bili Daily] 无法监听本地数据变化", error);
    }
  }

  try {
    setupDevSwitch();
    setupAssistant();
    setupActions();
    setupDataActions();
    refreshAll(false);
    watchStorage();
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    setField(fields.recStatus, `弹窗初始化失败：${detail}`, true);
    setImportStatus(`弹窗初始化失败：${detail}`, true);
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
