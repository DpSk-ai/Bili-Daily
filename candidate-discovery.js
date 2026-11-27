"use strict";

/**
 * Bili Daily —— 视频页「相关推荐」页面观察器（page-observed）
 *
 * 只在用户主动开启自动发现、且正常打开 B 站视频页时运行。
 * 读取范围仅限：当前页面已经渲染出来的、同时具备视频 BV 与 UP UID 的卡片。
 *
 * 设计原则：
 * - 不依赖某几个易变的 B 站 CSS 类名；从视频链接向上寻找「只包含一个视频 BV
 *   和至少一个 UP 空间链接」的最近卡片容器。
 * - 只有 BV 与 UID 能可靠对应时才产出观察；标题 / 分区 / 昵称缺失就保留 missing，
 *   绝不根据昵称或标题猜测。
 * - 不自动点击、不自动滚动、不批量打开视频、不请求额外网络资源。
 * - 不读取 Cookie / token / 登录凭据；不保存 HTML 或脚本。
 * - MutationObserver 只负责触发节流后的扫描，不在回调里直接遍历 DOM。
 */

(function (global) {
  const Store = global.BiliDailyDiscoveredCandidateStore;
  const SITE_ORIGIN = "https://www.bilibili.com";
  const SCOPE = "related-recommendation-card";
  const PROVENANCE = "page-observed";
  const MIN_SCAN_GAP_MS = 1500;
  const MUTATION_DELAY_MS = 700;
  const PAGE_CHECK_MS = 2000;
  const MAX_ANCHORS_PER_SCAN = 400;
  const MAX_CARD_DEPTH = 7;
  const MAX_CARDS_PER_SCAN = 40;

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function safeString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function parseVideoHref(href) {
    const text = safeString(href);
    if (!text || /^(?:javascript|data|vbscript):/i.test(text)) return null;
    let url;
    try {
      url = new URL(text, SITE_ORIGIN);
    } catch (error) {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.hostname !== "www.bilibili.com" && url.hostname !== "bilibili.com") return null;
    const match = /^\/video\/([Bb][Vv][0-9A-Za-z]{10})(?:\/|$)/.exec(url.pathname);
    if (!match) return null;
    return `BV${match[1].slice(2)}`;
  }

  function parseSpaceHref(href) {
    const text = safeString(href);
    if (!text || /^(?:javascript|data|vbscript):/i.test(text)) return null;
    let url;
    try {
      url = new URL(text, SITE_ORIGIN);
    } catch (error) {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.hostname !== "space.bilibili.com") return null;
    const match = /^\/([1-9]\d{0,15})(?:\/|$)/.exec(url.pathname);
    return match ? match[1] : null;
  }

  function normalizeAttributeUid(value) {
    const text = safeString(value);
    return /^[1-9]\d{0,15}$/.test(text) ? text : null;
  }

  function cleanCardTitle(value) {
    let text = safeString(value)
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return "";
    // 卡片锚文本常把时长拼在末尾；只移除明确的时钟尾巴，不从标题猜内容。
    text = text.replace(/\s+\d{1,2}:\d{2}(?::\d{2})?\s*$/, "").trim();
    if (!text || /^\d{1,2}:\d{2}(?::\d{2})?$/.test(text)) return "";
    return text;
  }

  function cleanUpName(value) {
    const text = safeString(value)
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.replace(/^UP\s*主?\s*[:：]\s*/i, "").trim();
  }

  function firstAttribute(element, names) {
    if (!element || typeof element.getAttribute !== "function") return "";
    for (const name of names) {
      const value = element.getAttribute(name);
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  }

  /**
   * 纯字段归属：输入都是从同一张卡片读到的原始值，输出完整 observation。
   * BV 或 UID 任一不合法 → 整张卡片不成立，不做猜测。
   */
  function pickObservation(input) {
    const source = isPlainObject(input) ? input : {};
    const bvid = parseVideoHref(source.videoHref);
    const upUid = parseSpaceHref(source.spaceHref) || normalizeAttributeUid(source.uidAttribute);
    const sourcePageBvid = parseVideoHref(source.pageHref);
    if (!bvid || !upUid || !sourcePageBvid) {
      return { ok: false, reason: !bvid ? "missing-bvid" : !upUid ? "missing-uid" : "missing-page-bvid" };
    }
    if (bvid === sourcePageBvid) {
      return { ok: false, reason: "current-video" };
    }
    const observedAt =
      typeof source.observedAt === "string" && Number.isFinite(Date.parse(source.observedAt))
        ? source.observedAt
        : new Date().toISOString();
    return {
      ok: true,
      observation: {
        upUid,
        upName: cleanUpName(source.upName),
        bvid,
        title: cleanCardTitle(source.title),
        partition: safeString(source.partition),
        observedAt,
        sourcePageBvid,
        provenance: PROVENANCE,
        observationScope: SCOPE
      }
    };
  }

  function readHref(element) {
    if (!element || typeof element.getAttribute !== "function") return "";
    return element.getAttribute("href") || "";
  }

  function uniqueVideoBvids(root) {
    const found = new Set();
    if (!root || typeof root.querySelectorAll !== "function") return found;
    Array.prototype.forEach.call(root.querySelectorAll('a[href*="/video/"]'), (anchor) => {
      const bvid = parseVideoHref(readHref(anchor));
      if (bvid) found.add(bvid);
    });
    return found;
  }

  function spaceAnchorsOf(root) {
    if (!root || typeof root.querySelectorAll !== "function") return [];
    return Array.prototype.slice.call(root.querySelectorAll('a[href*="space.bilibili.com/"]'));
  }

  /**
   * 从视频链接向上寻找最近的卡片容器：该容器内只出现一个视频 BV，
   * 且至少存在一个 UP 空间链接。遇到包含多个不同视频的列表就停止向上，
   * 避免把整个推荐列表 / 整页误当成一张卡片。
   */
  function findCardForAnchor(anchor, maxDepth) {
    let node = anchor;
    const depthLimit = Number.isInteger(maxDepth) ? maxDepth : MAX_CARD_DEPTH;
    for (let depth = 0; depth <= depthLimit; depth += 1) {
      if (!node || node.nodeType !== 1 || typeof node.querySelectorAll !== "function") return null;
      const bvids = uniqueVideoBvids(node);
      if (bvids.size > 1) return null;
      const spaceAnchors = spaceAnchorsOf(node);
      if (bvids.size === 1 && spaceAnchors.length > 0) return node;
      node = node.parentElement;
    }
    return null;
  }

  function collectUidsFromCard(card) {
    const uids = new Set();
    spaceAnchorsOf(card).forEach((anchor) => {
      const uid = parseSpaceHref(readHref(anchor));
      if (uid) uids.add(uid);
    });
    if (typeof card.querySelectorAll === "function") {
      Array.prototype.forEach.call(
        card.querySelectorAll("[data-mid], [data-uid], [data-up-id]"),
        (element) => {
          ["data-mid", "data-uid", "data-up-id"].forEach((name) => {
            const uid = normalizeAttributeUid(element.getAttribute(name));
            if (uid) uids.add(uid);
          });
        }
      );
    }
    ["data-mid", "data-uid", "data-up-id"].forEach((name) => {
      const uid = normalizeAttributeUid(card.getAttribute(name));
      if (uid) uids.add(uid);
    });
    return Array.from(uids).sort();
  }

  function findSpaceAnchor(card) {
    const anchors = spaceAnchorsOf(card);
    return anchors.length > 0 ? anchors[0] : null;
  }

  function readUpName(card, spaceAnchor) {
    if (spaceAnchor) {
      const text = cleanUpName(spaceAnchor.textContent);
      if (text) return text;
      const titled = firstAttribute(spaceAnchor, ["title", "aria-label"]);
      if (titled) return cleanUpName(titled);
    }
    const direct = firstAttribute(card, ["data-up-name", "data-author", "data-uname"]);
    if (direct) return cleanUpName(direct);
    if (typeof card.querySelectorAll === "function") {
      const candidates = card.querySelectorAll("[data-up-name], [data-author], [data-uname]");
      for (const element of candidates) {
        const value = firstAttribute(element, ["data-up-name", "data-author", "data-uname"]);
        if (value) return cleanUpName(value);
      }
    }
    return "";
  }

  function readPartition(card) {
    const direct = firstAttribute(card, ["data-tname", "data-partition"]);
    if (direct) return direct;
    if (typeof card.querySelectorAll === "function") {
      const candidates = card.querySelectorAll("[data-tname], [data-partition]");
      for (const element of candidates) {
        const value = firstAttribute(element, ["data-tname", "data-partition"]);
        if (value) return value;
      }
    }
    return "";
  }

  function readTitle(anchor, card, bvid) {
    const sameBvAnchors = [anchor];
    if (bvid && card && typeof card.querySelectorAll === "function") {
      const anchors = card.querySelectorAll('a[href*="/video/"]');
      for (const item of anchors) {
        if (item === anchor) continue;
        if (parseVideoHref(readHref(item)) === bvid) sameBvAnchors.push(item);
      }
    }
    // 显式 title / aria-label 优先于可见文本，避免把时长或播放量当成标题。
    for (const item of sameBvAnchors) {
      const titled = cleanCardTitle(firstAttribute(item, ["title", "aria-label"]));
      if (titled) return titled;
    }
    const cardTitle = cleanCardTitle(firstAttribute(card, ["data-title"]));
    if (cardTitle) return cardTitle;
    let best = "";
    for (const item of sameBvAnchors) {
      const text = cleanCardTitle(item.textContent);
      if (text.length > best.length) best = text;
    }
    return best;
  }

  /**
   * 扫描当前文档中已经渲染出来的视频链接卡片。
   * 返回观察数组与诊断；不写存储，不产生任何网络请求。
   */
  function scanRoot(root, options) {
    const opts = isPlainObject(options) ? options : {};
    const pageHref = typeof opts.pageHref === "string" ? opts.pageHref : "";
    const observedAt = typeof opts.observedAt === "string" ? opts.observedAt : new Date().toISOString();
    const maxCards = Number.isInteger(opts.maxCards) ? opts.maxCards : MAX_CARDS_PER_SCAN;
    const diagnostics = {
      anchorsScanned: 0,
      cardsSeen: 0,
      observations: 0,
      skippedCurrentVideo: 0,
      missingUid: 0,
      ambiguousUid: 0,
      missingTitle: 0,
      missingPartition: 0,
      invalid: 0
    };
    const observations = [];
    if (!root || typeof root.querySelectorAll !== "function" || !pageHref) {
      return { observations, diagnostics };
    }
    const anchors = Array.prototype.slice.call(root.querySelectorAll('a[href*="/video/"]'));
    const seen = new Set();
    for (const anchor of anchors.slice(0, MAX_ANCHORS_PER_SCAN)) {
      diagnostics.anchorsScanned += 1;
      const bvid = parseVideoHref(readHref(anchor));
      if (!bvid) continue;
      if (bvid === parseVideoHref(pageHref)) {
        diagnostics.skippedCurrentVideo += 1;
        continue;
      }
      const card = findCardForAnchor(anchor);
      if (!card) continue;
      diagnostics.cardsSeen += 1;
      const uids = collectUidsFromCard(card);
      if (uids.length === 0) {
        diagnostics.missingUid += 1;
        continue;
      }
      if (uids.length > 1) {
        diagnostics.ambiguousUid += 1;
        continue;
      }
      const result = pickObservation({
        videoHref: readHref(anchor),
        pageHref,
        spaceHref: readHref(findSpaceAnchor(card)),
        uidAttribute: uids[0],
        upName: readUpName(card, findSpaceAnchor(card)),
        title: readTitle(anchor, card, bvid),
        partition: readPartition(card),
        observedAt
      });
      if (!result.ok) {
        diagnostics.invalid += 1;
        continue;
      }
      const key = `${result.observation.upUid}|${result.observation.bvid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (result.observation.title) {
        // 已记录
      } else {
        diagnostics.missingTitle += 1;
      }
      if (!result.observation.partition) diagnostics.missingPartition += 1;
      observations.push(result.observation);
      diagnostics.observations += 1;
      if (observations.length >= maxCards) break;
    }
    return { observations, diagnostics };
  }

  function readPageBvid(win) {
    try {
      const pathname = win && win.location ? win.location.pathname : "";
      const match = /\/video\/([Bb][Vv][0-9A-Za-z]{10})/.exec(pathname);
      return match ? `BV${match[1].slice(2)}` : "";
    } catch (error) {
      return "";
    }
  }

  function pageHrefOf(win) {
    try {
      return win && win.location ? win.location.href : "";
    } catch (error) {
      return "";
    }
  }

  /**
   * 观察器控制器。默认在真实浏览器中自启动；测试可注入 store / document / timers。
   */
  function createController(env) {
    const options = isPlainObject(env) ? env : {};
    const store = options.store || Store;
    const doc = options.document || (typeof document !== "undefined" ? document : null);
    const win = options.window || (typeof window !== "undefined" ? window : null);
    const setTimer = options.setTimeout || global.setTimeout;
    const clearTimer = options.clearTimeout || global.clearTimeout;
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const MutationObserverImpl =
      options.MutationObserver || global.MutationObserver || null;

    let started = false;
    let observer = null;
    let scanTimer = null;
    let pageTimer = null;
    let lastScanAt = 0;
    let pageKey = "";
    let pageObservationCount = 0;
    let seenKeys = new Set();
    let currentSettings = null;
    let generation = 0;
    let writeChain = Promise.resolve();
    let listeners = null;

    function resetPage() {
      pageKey = "";
      pageObservationCount = 0;
      seenKeys = new Set();
    }

    function detachListeners() {
      if (!listeners) return;
      const attached = listeners;
      listeners = null;
      try {
        if (win && typeof win.removeEventListener === "function") {
          win.removeEventListener("popstate", attached.popstate);
          win.removeEventListener("pagehide", attached.pagehide);
          if (attached.navigation && typeof attached.navigation.removeEventListener === "function") {
            attached.navigation.removeEventListener("navigatesuccess", attached.navigatesuccess);
          }
        }
        if (doc && typeof doc.removeEventListener === "function") {
          doc.removeEventListener("visibilitychange", attached.visibilitychange);
        }
      } catch (error) {
        /* 忽略移除失败 */
      }
    }

    function stop() {
      started = false;
      generation += 1;
      detachListeners();
      if (observer) {
        try {
          observer.disconnect();
        } catch (error) {
          /* 忽略 */
        }
        observer = null;
      }
      if (scanTimer !== null) {
        clearTimer(scanTimer);
        scanTimer = null;
      }
      if (pageTimer !== null) {
        clearTimer(pageTimer);
        pageTimer = null;
      }
      resetPage();
    }

    function schedule(delay) {
      if (!started || scanTimer !== null) return;
      const minGap = Math.max(0, MIN_SCAN_GAP_MS - (now() - lastScanAt));
      const wait = Math.max(typeof delay === "number" ? delay : MUTATION_DELAY_MS, minGap);
      scanTimer = setTimer(() => {
        scanTimer = null;
        runScan().catch(() => {
          /* 扫描失败不向页面抛异常 */
        });
      }, wait);
    }

    async function runScan() {
      if (!started || !doc || !win || !store) return;
      if (typeof doc.visibilityState === "string" && doc.visibilityState === "hidden") {
        return;
      }
      const pageHref = pageHrefOf(win);
      const currentBvid = readPageBvid(win);
      if (!currentBvid || !pageHref.includes("/video/")) return;
      if (pageKey !== pageHref) {
        resetPage();
        pageKey = pageHref;
      }
      const maxPerPage =
        currentSettings && Number.isInteger(currentSettings.maxObservationsPerPage)
          ? currentSettings.maxObservationsPerPage
          : 100;
      if (pageObservationCount >= maxPerPage) return;
      lastScanAt = now();
      const result = scanRoot(doc, {
        pageHref,
        observedAt: new Date(now()).toISOString(),
        maxCards: Math.min(MAX_CARDS_PER_SCAN, maxPerPage - pageObservationCount)
      });
      const fresh = result.observations.filter((observation) => {
        const key = `${observation.upUid}|${observation.bvid}`;
        return !seenKeys.has(key);
      });
      if (fresh.length === 0) return;
      fresh.forEach((observation) => {
        seenKeys.add(`${observation.upUid}|${observation.bvid}`);
      });
      pageObservationCount += fresh.length;
      if (!started) return;
      const token = generation;
      writeChain = writeChain
        .then(async () => {
          if (!started || token !== generation) return;
          await store.addObservations(fresh, { now: now() });
        })
        .catch(() => {
          /* 存储失败不重试、不影响页面 */
        });
      await writeChain;
    }

    function armPageCheck() {
      if (!started) return;
      pageTimer = setTimer(() => {
        pageTimer = null;
        if (!started) return;
        const href = pageHrefOf(win);
        if (href && href !== pageKey) schedule(0);
        armPageCheck();
      }, PAGE_CHECK_MS);
    }

    function start(settings) {
      currentSettings = settings || currentSettings;
      if (started) return;
      started = true;
      generation += 1;
      resetPage();
      if (MutationObserverImpl && doc && (doc.documentElement || doc.body)) {
        observer = new MutationObserverImpl(() => schedule(MUTATION_DELAY_MS));
        observer.observe(doc.documentElement || doc.body, {
          childList: true,
          subtree: true
        });
      }
      if (!listeners && win && typeof win.addEventListener === "function") {
        const navigation =
          win.navigation && typeof win.navigation.addEventListener === "function"
            ? win.navigation
            : null;
        listeners = {
          navigation,
          popstate: () => schedule(0),
          pagehide: stop,
          navigatesuccess: () => schedule(0),
          visibilitychange: () => {
            if (doc && doc.visibilityState === "visible") schedule(MUTATION_DELAY_MS);
          }
        };
        win.addEventListener("popstate", listeners.popstate);
        win.addEventListener("pagehide", listeners.pagehide, { once: true });
        if (navigation) {
          navigation.addEventListener("navigatesuccess", listeners.navigatesuccess);
        }
        if (doc && typeof doc.addEventListener === "function") {
          doc.addEventListener("visibilitychange", listeners.visibilitychange);
        }
      }
      armPageCheck();
      schedule(0);
    }

    async function syncSettings(next) {
      currentSettings = next;
      if (next && next.enabled === true) start(next);
      else stop();
    }

    async function init() {
      if (!store || typeof store.readSettings !== "function") return;
      const result = await store.readSettings();
      if (result && result.ok && result.settings && result.settings.enabled === true) {
        start(result.settings);
      }
      if (global.chrome && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, areaName) => {
          if (areaName && areaName !== "local") return;
          if (!changes || !Object.prototype.hasOwnProperty.call(changes, store.SETTINGS_KEY)) {
            return;
          }
          store.readSettings().then((next) => {
            if (next && next.ok) syncSettings(next.settings);
          }).catch(() => {
            /* 设置变更读取失败时保持当前状态 */
          });
        });
      }
    }

    return {
      init,
      start,
      stop,
      syncSettings,
      scanNow: runScan,
      schedule,
      _state: () => ({
        started,
        pageObservationCount,
        seenKeys: Array.from(seenKeys),
        pageKey
      })
    };
  }

  function autoInit() {
    const controller = createController({});
    controller.init().catch(() => {
      /* 自动发现初始化失败不影响观看记录采集 */
    });
    return controller;
  }

  global.BiliDailyDiscovery = Object.freeze({
    PROVENANCE,
    SCOPE,
    _internal: Object.freeze({
      parseVideoHref,
      parseSpaceHref,
      cleanCardTitle,
      cleanUpName,
      pickObservation,
      findCardForAnchor,
      scanRoot,
      createController
    }),
    createController
  });

  if (
    typeof document !== "undefined" &&
    typeof location !== "undefined" &&
    location.pathname.includes("/video/")
  ) {
    try {
      autoInit();
    } catch (error) {
      try {
        console.error("[Bili Daily] 自动发现初始化失败", error);
      } catch (ignored) {
        /* 忽略 */
      }
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
