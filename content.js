"use strict";

/**
 * 本地记录结构由 storage.js 统一定义与维护（chrome.storage.local 的 biliDailyRecords）：
 * {
 *   version: 1,
 *   days: {
 *     "YYYY-MM-DD": {
 *       "BVxxxx": {
 *         bvid, page, title, upName, upUid, partition,
 *         videoDuration, watchMs, watchMsByHour,
 *         startedAt, lastWatchedAt, updatedAt
 *       }
 *     }
 *   }
 * }
 * 同一天同一个 BV 只保留一条记录，实际播放时间累加；不同分 P 视为同一个视频。
 * 读不到的文字留空字符串，读不到的时长留 null，无法确认的 UP 主 UID 留 null。
 *
 * 本文件只负责「采集观看行为」，存储读写一律交给 BiliDailyStorage。
 */

const Store = globalThis.BiliDailyStorage;
const FLUSH_EVERY_MS = 4000;
const MAX_SEGMENT_MS = 20000;

const session = {
  key: "",
  bvid: "",
  page: 1,
  segmentStart: null,
  meta: emptyMeta()
};

let boundVideo = null;
let videoAbort = null;
let saveQueue = Promise.resolve();
const scriptCache = new Map();

function emptyMeta() {
  return {
    title: "",
    upName: "",
    upUid: null,
    partition: "",
    videoDuration: null
  };
}

/* ------------------------------------------------------------ UP 主 UID 工具 */

const UID_PATTERN = /^[1-9]\d{0,15}$/;
const UP_UID_SELECTORS = [
  ".up-info-container .up-name",
  ".up-detail-top .up-name",
  ".up-panel-container .up-name",
  ".video-owner .up-name"
];

/**
 * 校验并规范化 UP 主 UID：只接受正整数字符串 / 安全整数，统一返回字符串。
 * 其余（null、空串、0、负数、小数、非数字、超出安全整数）一律返回 null。
 */
function normalizeUpUid(value) {
  let text = "";
  if (typeof value === "string") {
    text = value.trim();
  } else if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    text = String(value);
  } else {
    return null;
  }
  if (!UID_PATTERN.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? String(number) : null;
}

/**
 * 只从明确的个人空间链接中取 UID：
 *   //space.bilibili.com/123456
 *   https://space.bilibili.com/123456?spm=...
 * 其他站点的链接、评论区 / 推荐卡片的链接都不会匹配。
 */
function extractUidFromSpaceHref(href) {
  const text = String(href == null ? "" : href).trim();
  const match = /^(?:https?:)?\/\/space\.bilibili\.com\/(\d+)(?:[/?#]|$)/i.exec(text);
  return match ? normalizeUpUid(match[1]) : null;
}

/**
 * 从视频页内嵌的 videoData JSON 片段中读取 owner.mid。
 * 只认 owner 对象内部的 mid，不会取评论区或推荐数据里的其他 mid。
 */
function extractOwnerUid(slice) {
  const text = String(slice == null ? "" : slice);
  const owner = /"owner"\s*:\s*\{[\s\S]{0,800}?\}/.exec(text);
  if (!owner) return null;
  const mid = /"mid"\s*:\s*(\d+)/.exec(owner[0]);
  return mid ? normalizeUpUid(mid[1]) : null;
}

/**
 * 从 start 处的 "{" 开始做字符串感知的括号配对，返回完整的对象文本。
 * 避免直接截取固定长度时把后面的相关推荐 / 评论 JSON 一起带进来。
 */
function takeBalancedObject(text, start) {
  if (start < 0 || text[start] !== "{") return "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return "";
}

/**
 * 以当前 BV 号为锚点，从一段页面脚本文本中定位 videoData 并读取 owner.mid。
 * 找不到当前 BV 的标记或 videoData 对象不完整时返回 null ——
 * 避免 SPA 切换后把上一个视频、相关推荐或评论区的 UID 错配过来。
 */
function extractUidFromVideoDataText(text, bvid) {
  if (!bvid) return null;
  const source = String(text == null ? "" : text);
  const marker = `"videoData":{"bvid":"${bvid}"`;
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const brace = source.indexOf("{", start);
  if (brace < 0) return null;
  const videoObject = takeBalancedObject(source, brace);
  if (!videoObject) return null;
  return extractOwnerUid(videoObject);
}

/**
 * 结构化元数据（与 BV 锚定）优先；只有确认页面 DOM 属于当前视频时才使用 DOM 链接兜底。
 */
function selectUpUid(structuredUid, domUid, domIsLive) {
  const fromStructure = normalizeUpUid(structuredUid);
  if (fromStructure) return fromStructure;
  if (domIsLive !== true) return null;
  return normalizeUpUid(domUid);
}

/** 只从当前视频 UP 主信息区域的个人空间链接读取 UID，不扫描评论区 / 推荐。 */
function readDomUpUid() {
  for (const selector of UP_UID_SELECTORS) {
    const element = document.querySelector(selector);
    if (!element) continue;
    // 兼容 .up-name 本身是 <a> 或被 <a> 包裹两种结构。
    const anchor = typeof element.closest === "function" ? element.closest("a") : null;
    const href = anchor ? anchor.getAttribute("href") : element.getAttribute("href");
    const uid = extractUidFromSpaceHref(href);
    if (uid) return uid;
  }
  return null;
}

function logError(error) {
  console.error("[Bili Daily] 观看数据采集失败", error);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanTitle(value) {
  return cleanText(value)
    .replace(/_哔哩哔哩_bilibili$/i, "")
    .replace(/_哔哩哔哩$/i, "")
    .replace(/ - 哔哩哔哩$/i, "");
}

function firstText(values) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return "";
}

function asDuration(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 48 * 60 * 60) return null;
  return Math.round(number);
}

function readBvid() {
  try {
    const match = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    return match ? match[1] : "";
  } catch (error) {
    logError(error);
    return "";
  }
}

function readPage() {
  try {
    const value = Number(new URL(location.href).searchParams.get("p") || "1");
    if (!Number.isInteger(value) || value < 1) return 1;
    return value;
  } catch (error) {
    logError(error);
    return 1;
  }
}

function attribute(selector, name) {
  try {
    const element = document.querySelector(selector);
    return element ? cleanText(element.getAttribute(name)) : "";
  } catch (error) {
    logError(error);
    return "";
  }
}

function textOf(selector) {
  try {
    const element = document.querySelector(selector);
    if (!element) return "";
    return cleanText(element.getAttribute("data-title") || element.getAttribute("title") || element.textContent);
  } catch (error) {
    logError(error);
    return "";
  }
}

function domMatches(bvid) {
  const canonical = attribute('link[rel="canonical"]', "href");
  const ogUrl = attribute('meta[property="og:url"]', "content");
  const markers = [canonical, ogUrl].filter(Boolean);
  if (markers.length === 0) return true;
  return markers.some((value) => value.includes(bvid));
}

/**
 * 比 domMatches 更严格：必须存在 canonical / og:url，且其中一个包含当前 BV。
 * 仅用于 DOM UID 兜底 —— 页面没有确认标记时宁可不取 UID，也不冒 SPA 错配风险。
 */
function domConfirmsBvid(bvid) {
  if (!bvid) return false;
  const canonical = attribute('link[rel="canonical"]', "href");
  const ogUrl = attribute('meta[property="og:url"]', "content");
  const markers = [canonical, ogUrl].filter(Boolean);
  return markers.length > 0 && markers.some((value) => value.includes(bvid));
}

function readDomMeta() {
  return {
    title: cleanTitle(firstText([
      textOf("h1.video-title"),
      textOf("#viewbox_report h1"),
      attribute('meta[property="og:title"]', "content")
    ])),
    upName: firstText([
      textOf(".up-info-container .up-name"),
      textOf(".up-detail-top .up-name"),
      textOf("a.up-name")
    ]),
    partition: firstText([
      textOf(".video-partition a"),
      textOf("a.partition"),
      textOf(".partition-name")
    ]),
    videoDuration: null
  };
}

function parseClock(value) {
  const parts = cleanText(value).split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const numbers = parts.map((item) => Number(item));
  if (numbers.some((item) => !Number.isInteger(item) || item < 0)) return null;
  if (numbers.length === 2) return asDuration(numbers[0] * 60 + numbers[1]);
  return asDuration(numbers[0] * 3600 + numbers[1] * 60 + numbers[2]);
}

function readPlayerDuration(video) {
  if (!video) return null;
  try {
    const fromMedia = asDuration(video.duration);
    if (fromMedia) return fromMedia;
  } catch (error) {
    logError(error);
  }
  return parseClock(textOf(".bpx-player-ctrl-time-duration, .bilibili-player-video-time-total"));
}

function parseIsoDuration(value) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(String(value || ""));
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return asDuration(hours * 3600 + minutes * 60 + seconds);
}

function authorName(author) {
  if (!author) return "";
  if (typeof author === "string") return cleanText(author);
  if (Array.isArray(author)) return authorName(author[0]);
  if (typeof author === "object") return cleanText(author.name);
  return "";
}

function walkLinkedData(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((item) => walkLinkedData(item, visit));
    return;
  }
  visit(node);
  if (node["@graph"]) walkLinkedData(node["@graph"], visit);
}

function readLinkedData(bvid) {
  const result = emptyMeta();
  let found = false;
  try {
    document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
      try {
        walkLinkedData(JSON.parse(script.textContent || ""), (item) => {
          const type = item["@type"];
          const identity = String(item.url || item["@id"] || item.item || "");
          if (type === "BreadcrumbList") {
            const list = Array.isArray(item.itemListElement) ? item.itemListElement : [];
            const belongs = list.some((entry) => String(entry.item || "").includes(bvid));
            if (!belongs) return;
            const names = list
              .filter((entry) => entry && entry.name && entry.name !== "首页")
              .filter((entry) => !String(entry.item || "").includes("/video/"))
              .map((entry) => cleanText(entry.name));
            if (names.length > 0) result.partition = names[names.length - 1];
            return;
          }
          if (!identity.includes(bvid)) return;
          found = true;
          result.title = result.title || cleanTitle(item.name);
          result.upName = result.upName || authorName(item.author);
          if (!result.partition) {
            const genre = Array.isArray(item.genre) ? item.genre[0] : item.genre;
            result.partition = cleanText(genre);
          }
          result.videoDuration = result.videoDuration || parseIsoDuration(item.duration);
        });
      } catch (error) {
        logError(error);
      }
    });
  } catch (error) {
    logError(error);
  }
  return found || result.partition ? result : emptyMeta();
}

function matchJsonString(slice, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(slice);
  if (!match) return "";
  try {
    return cleanText(JSON.parse(`"${match[1]}"`));
  } catch (error) {
    logError(error);
    return "";
  }
}

function readScriptVideoData(bvid) {
  if (!bvid) return null;
  if (scriptCache.has(bvid)) return scriptCache.get(bvid);
  let result = null;
  try {
    const marker = `"videoData":{"bvid":"${bvid}"`;
    for (const script of document.scripts) {
      const text = script.textContent || "";
      const start = text.indexOf(marker);
      if (start < 0) continue;
      const slice = text.slice(start, start + 5000);
      const videoObject = takeBalancedObject(text, text.indexOf("{", start));
      result = {
        title: cleanTitle(matchJsonString(slice, "title")),
        upName: matchJsonString(slice, "name"),
        upUid: null,
        partition: firstText([matchJsonString(slice, "tname_v2"), matchJsonString(slice, "tname")]),
        videoDuration: asDuration((/"duration"\s*:\s*(\d+(?:\.\d+)?)/.exec(slice) || [])[1])
      };
      const owner = videoObject ? /"owner"\s*:\s*\{[\s\S]{0,800}?\}/.exec(videoObject) : null;
      if (owner) {
        const nameMatch = /"name"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(owner[0]);
        if (nameMatch) {
          try {
            result.upName = cleanText(JSON.parse(`"${nameMatch[1]}"`)) || result.upName;
          } catch (error) {
            logError(error);
          }
        }
        const midMatch = /"mid"\s*:\s*(\d+)/.exec(owner[0]);
        result.upUid = normalizeUpUid(midMatch ? midMatch[1] : null);
      }
      break;
    }
  } catch (error) {
    logError(error);
    result = null;
  }
  scriptCache.set(bvid, result);
  return result;
}

function captureMeta(video) {
  const bvid = session.bvid;
  const live = domMatches(bvid);
  const dom = live ? readDomMeta() : emptyMeta();
  const linked = readLinkedData(bvid);
  const scripted = readScriptVideoData(bvid) || emptyMeta();
  const duration = live ? readPlayerDuration(video) : null;
  const structuredUid = normalizeUpUid(scripted.upUid);
  // 结构化元数据（已按 BV 锚定）优先；缺失时才读 DOM，且必须由 canonical / og:url
  // 正向确认 DOM 属于当前视频，避免 SPA 切换瞬间把上一个视频的 UP 主错配过来。
  const domUid = !structuredUid && domConfirmsBvid(bvid) ? readDomUpUid() : null;
  return {
    title: firstText([dom.title, linked.title, scripted.title]),
    upName: firstText([dom.upName, linked.upName, scripted.upName]),
    upUid: selectUpUid(structuredUid, domUid, live),
    partition: firstText([scripted.partition, linked.partition, dom.partition]),
    videoDuration: duration || scripted.videoDuration || linked.videoDuration || null
  };
}

function findMainVideo() {
  const selectors = [
    ".bpx-player-video-wrap video",
    "#bilibili-player video",
    ".bilibili-player video",
    "video"
  ];
  try {
    for (const selector of selectors) {
      const video = document.querySelector(selector);
      if (video) return video;
    }
  } catch (error) {
    logError(error);
  }
  return null;
}

function bindVideo(nextVideo) {
  if (nextVideo === boundVideo) return;
  if (videoAbort) videoAbort.abort();
  boundVideo = nextVideo;
  videoAbort = null;
  if (!nextVideo) return;
  try {
    videoAbort = new AbortController();
    const options = { signal: videoAbort.signal };
    ["play", "playing", "pause", "ended", "emptied", "loadedmetadata"].forEach((eventName) => {
      nextVideo.addEventListener(eventName, sync, options);
    });
  } catch (error) {
    logError(error);
  }
}

function isActivelyPlaying() {
  if (document.visibilityState === "hidden") return false;
  if (!boundVideo) return false;
  try {
    return !boundVideo.paused && !boundVideo.ended;
  } catch (error) {
    logError(error);
    return false;
  }
}

/* 存储读写、数据结构规范、时间工具与记录累加统一由 storage.js（BiliDailyStorage）提供。 */

function enqueueSave(payload, startMs, endMs) {
  if (!Store) {
    logError(new Error("storage.js 未加载，本次观看数据未保存"));
    return;
  }
  const snapshot = {
    bvid: payload.bvid,
    page: payload.page,
    title: payload.title || "",
    upName: payload.upName || "",
    upUid: normalizeUpUid(payload.upUid),
    partition: payload.partition || "",
    videoDuration: payload.videoDuration
  };
  saveQueue = saveQueue
    .then(() => Store.addWatch(snapshot, startMs, endMs))
    .catch((error) => logError(error));
}

function consumeSegment(restart) {
  if (session.segmentStart == null) {
    if (restart) session.segmentStart = Date.now();
    return;
  }
  const started = session.segmentStart;
  const now = Date.now();
  const delta = now - started;
  if (delta > MAX_SEGMENT_MS) {
    session.segmentStart = restart ? now : null;
    return;
  }
  session.segmentStart = restart ? now : null;
  if (delta <= 0 || !session.bvid) return;
  enqueueSave(Object.assign({ bvid: session.bvid, page: session.page }, session.meta), started, now);
}

function sync() {
  try {
    const bvid = readBvid();
    const page = readPage();
    const key = bvid ? `${bvid}#${page}` : "";
    if (session.key !== key) {
      consumeSegment(false);
      session.key = key;
      session.bvid = bvid;
      session.page = page;
      session.segmentStart = null;
      session.meta = emptyMeta();
    }
    if (!bvid) return;
    bindVideo(findMainVideo());
    session.meta = captureMeta(boundVideo);
    if (isActivelyPlaying()) {
      if (session.segmentStart == null) session.segmentStart = Date.now();
      if (Date.now() - session.segmentStart >= FLUSH_EVERY_MS) consumeSegment(true);
      return;
    }
    if (session.segmentStart != null) consumeSegment(false);
  } catch (error) {
    logError(error);
  }
}

function installNavigationWatch() {
  window.addEventListener("popstate", sync);
  document.addEventListener("visibilitychange", sync);
  window.addEventListener("pagehide", () => consumeSegment(false));
  try {
    if (window.navigation && typeof window.navigation.addEventListener === "function") {
      window.navigation.addEventListener("navigatesuccess", sync);
    }
  } catch (error) {
    logError(error);
  }
  window.setInterval(sync, 1000);
}

function init() {
  if (!location.pathname.includes("/video/")) return;
  installNavigationWatch();
  sync();
}

/* 仅供单元测试使用的纯函数出口；内容脚本仍运行在隔离环境，不影响页面。 */
globalThis.BiliDailyContent = Object.freeze({
  normalizeUpUid,
  extractUidFromSpaceHref,
  extractOwnerUid,
  extractUidFromVideoDataText,
  selectUpUid
});

if (typeof document !== "undefined" && typeof location !== "undefined" && typeof window !== "undefined") {
  try {
    init();
  } catch (error) {
    logError(error);
  }
}
