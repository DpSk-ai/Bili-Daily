"use strict";

/**
 * Bili Daily —— 视频页相关推荐观察器测试
 * 运行：node test-candidate-discovery.js
 *
 * 只使用内存 DOM 与假定时器，不访问网络、不读写 chrome.storage.local。
 * 覆盖：BV / UID 解析、字段归属、缺失字段、恶意链接、卡片歧义、
 * 同卡去重、默认关闭、节流、停止后不写入、SPA 切换、容量上限。
 */

const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "candidate-discovery.js"));

const Discovery = globalThis.BiliDailyDiscovery;
const I = Discovery._internal;

const PAGE_A = "https://www.bilibili.com/video/BV1aa411c7m1";
const PAGE_B = "https://www.bilibili.com/video/BV1bb411c7m2";
const NOW = Date.parse("2026-11-12T04:00:00.000Z");

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

/* ---------------------------------------------------------------- 迷你 DOM */

function matches(element, selector) {
  const list = String(selector)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return list.some((raw) => {
    const tagMatch = /^([a-z0-9]*)\[/i.exec(raw);
    const expectedTag = tagMatch && tagMatch[1] ? tagMatch[1].toLowerCase() : "";
    if (expectedTag && String(element.tagName).toLowerCase() !== expectedTag) return false;
    const attrMatch = /\[([a-z0-9-]+)(\*?=)?"([^"]*)"?\]/i.exec(raw) || /\[([a-z0-9-]+)\]/i.exec(raw);
    if (!attrMatch) return false;
    const name = attrMatch[1];
    const value = element.getAttribute(name);
    if (value === null || value === undefined) return false;
    if (attrMatch[2] === "*=") return String(value).includes(attrMatch[3]);
    if (attrMatch[2] === "=") return String(value) === attrMatch[3];
    return true;
  });
}

function node(spec) {
  const source = spec || {};
  const element = {
    nodeType: 1,
    tagName: (source.tag || "div").toUpperCase(),
    attrs: Object.assign({}, source.attrs || {}),
    children: [],
    parentElement: null,
    ownText: source.text || "",
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name)
        ? this.attrs[name]
        : null;
    },
    querySelectorAll(selector) {
      const found = [];
      const walk = (current) => {
        current.children.forEach((child) => {
          if (matches(child, selector)) found.push(child);
          walk(child);
        });
      };
      walk(this);
      return found;
    }
  };
  Object.defineProperty(element, "textContent", {
    get() {
      const childText = this.children.map((child) => child.textContent).join(" ");
      return `${this.ownText} ${childText}`.trim();
    }
  });
  (source.children || []).forEach((child) => {
    child.parentElement = element;
    element.children.push(child);
  });
  return element;
}

function videoLink(bvid, attrs) {
  return node({
    tag: "a",
    attrs: Object.assign({ href: `/video/${bvid}/` }, attrs || {})
  });
}

function spaceLink(uid, name) {
  return node({
    tag: "a",
    attrs: { href: `https://space.bilibili.com/${uid}` },
    text: name || ""
  });
}

function card(options) {
  const opts = options || {};
  return node({
    attrs: Object.assign({ "data-tname": opts.partition || "" }, opts.attrs || {}),
    children: [
      videoLink(opts.bvid, { title: opts.title || "" }),
      spaceLink(opts.uid, opts.upName || "")
    ]
  });
}

function rootOf(cards) {
  return node({ children: cards });
}

function fakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, delay) {
      const id = nextId++;
      timers.set(id, { fn, delay, canceled: false });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.get(id);
      if (timer) timer.canceled = true;
      timers.delete(id);
    },
    pending() {
      return Array.from(timers.entries())
        .filter(([, timer]) => !timer.canceled)
        .map(([id, timer]) => ({ id, delay: timer.delay }));
    },
    async runNext() {
      const pending = Array.from(timers.entries())
        .filter(([, timer]) => !timer.canceled)
        .sort((left, right) => left[1].delay - right[1].delay || left[0] - right[0]);
      if (pending.length === 0) return false;
      const [id, timer] = pending[0];
      timers.delete(id);
      await timer.fn();
      return true;
    }
  };
}

function fakeObserver() {
  const instances = [];
  function Observer(callback) {
    this.callback = callback;
    this.disconnected = false;
    this.observed = false;
    instances.push(this);
  }
  Observer.prototype.observe = function () {
    this.observed = true;
  };
  Observer.prototype.disconnect = function () {
    this.disconnected = true;
  };
  return { Observer, instances };
}

function fakeStore(enabled, initialState) {
  const calls = [];
  let settings = Object.assign({ enabled: Boolean(enabled) }, initialState || {});
  return {
    SETTINGS_KEY: "biliDailyDiscoverySettings",
    calls,
    readSettings: async () => ({ ok: true, settings: Object.assign({}, settings) }),
    addObservations: async (observations, options) => {
      calls.push({ observations: observations.map((item) => Object.assign({}, item)), options });
      return { ok: true };
    },
    setEnabled(next) {
      settings = Object.assign({}, settings, { enabled: next });
    }
  };
}

function fakeWindow(href) {
  const listeners = new Map();
  const win = {
    location: {
      href,
      pathname: new URL(href).pathname
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    dispatch(type) {
      (listeners.get(type) || []).slice().forEach((fn) => fn());
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
    navigate(nextHref) {
      this.location.href = nextHref;
      this.location.pathname = new URL(nextHref).pathname;
    }
  };
  return win;
}

function fakeDocument(root) {
  const listeners = new Map();
  return {
    documentElement: root,
    visibilityState: "visible",
    querySelectorAll(selector) {
      return this.documentElement.querySelectorAll(selector);
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    dispatch(type) {
      (listeners.get(type) || []).slice().forEach((fn) => fn());
    }
  };
}

function controllerEnv(options) {
  const opts = options || {};
  const timers = fakeTimers();
  const observer = fakeObserver();
  const root = opts.root || rootOf([card({
    bvid: "BV1cc411c7m3",
    uid: "2001",
    upName: "观察UP",
    title: "页面观察标题",
    partition: "科技"
  })]);
  const win = fakeWindow(opts.href || PAGE_A);
  const doc = fakeDocument(root);
  const store = opts.store || fakeStore(opts.enabled !== false);
  const controller = I.createController({
    store,
    document: doc,
    window: win,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: () => NOW,
    MutationObserver: observer.Observer
  });
  return { controller, timers, observer, root, win, doc, store };
}

async function runScanTimer(env) {
  const pending = env.timers.pending();
  if (pending.length === 0) return false;
  await env.timers.runNext();
  return true;
}

/* ---------------------------------------------------------------- 纯解析 */

async function main() {
  await test("1. parseVideoHref 接受标准 BV 链接并规范化大小写", () => {
    assert.equal(I.parseVideoHref("https://www.bilibili.com/video/BV1aa411c7m1"), "BV1aa411c7m1");
    assert.equal(I.parseVideoHref("/video/bv1aa411c7m1/?spm=1"), "BV1aa411c7m1");
    assert.equal(I.parseVideoHref("https://bilibili.com/video/BV1aa411c7m1"), "BV1aa411c7m1");
  });

  await test("2. parseVideoHref 拒绝恶意协议、外部域名与无效 BV", () => {
    [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "https://evil.example/video/BV1aa411c7m1",
      "https://www.bilibili.com.evil.example/video/BV1aa411c7m1",
      "https://www.bilibili.com/video/BV123",
      "https://www.bilibili.com/video/av12345",
      "not a url"
    ].forEach((href) => assert.equal(I.parseVideoHref(href), null, href));
  });

  await test("3. parseSpaceHref 只接受 space.bilibili.com 的正整数 UID", () => {
    assert.equal(I.parseSpaceHref("https://space.bilibili.com/2001"), "2001");
    assert.equal(I.parseSpaceHref("https://space.bilibili.com/2001?spm=1"), "2001");
    [
      "javascript:alert(1)",
      "https://evil.example/2001",
      "https://space.bilibili.com.evil.example/2001",
      "https://space.bilibili.com/0",
      "https://space.bilibili.com/abc"
    ].forEach((href) => assert.equal(I.parseSpaceHref(href), null, href));
  });

  await test("4. 标题清洗去掉控制字符与明确时长尾巴，不猜内容", () => {
    assert.equal(I.cleanCardTitle("  科技\u0000 教程 12:34 "), "科技 教程");
    assert.equal(I.cleanCardTitle("12:34"), "");
    assert.equal(I.cleanCardTitle(""), "");
  });

  await test("5. pickObservation 正确归属 BV / UID / 标题 / 分区 / 来源页", () => {
    const result = I.pickObservation({
      videoHref: "/video/BV1cc411c7m3",
      pageHref: PAGE_A,
      spaceHref: "https://space.bilibili.com/2001",
      upName: "UP主：观察UP",
      title: "页面观察标题 08:12",
      partition: "科技",
      observedAt: "2026-11-12T03:00:00.000Z"
    });
    assert.equal(result.ok, true);
    assert.equal(result.observation.upUid, "2001");
    assert.equal(result.observation.bvid, "BV1cc411c7m3");
    assert.equal(result.observation.upName, "观察UP");
    assert.equal(result.observation.title, "页面观察标题");
    assert.equal(result.observation.partition, "科技");
    assert.equal(result.observation.sourcePageBvid, "BV1aa411c7m1");
    assert.equal(result.observation.provenance, "page-observed");
    assert.equal(result.observation.observationScope, "related-recommendation-card");
  });

  await test("6. 缺少标题 / 分区时保留空值，不从昵称或标题猜测", () => {
    const result = I.pickObservation({
      videoHref: "/video/BV1cc411c7m3",
      pageHref: PAGE_A,
      spaceHref: "https://space.bilibili.com/2001",
      upName: "观察UP",
      observedAt: "2026-11-12T03:00:00.000Z"
    });
    assert.equal(result.ok, true);
    assert.equal(result.observation.title, "");
    assert.equal(result.observation.partition, "");
  });

  await test("7. 缺少 UID / BV / 来源页或指向当前视频时整张卡片不成立", () => {
    const base = {
      videoHref: "/video/BV1cc411c7m3",
      pageHref: PAGE_A,
      spaceHref: "https://space.bilibili.com/2001"
    };
    assert.equal(I.pickObservation(Object.assign({}, base, { spaceHref: "" })).reason, "missing-uid");
    assert.equal(I.pickObservation(Object.assign({}, base, { videoHref: "" })).reason, "missing-bvid");
    assert.equal(I.pickObservation(Object.assign({}, base, { pageHref: "" })).reason, "missing-page-bvid");
    assert.equal(
      I.pickObservation(Object.assign({}, base, { videoHref: "/video/BV1aa411c7m1" })).reason,
      "current-video"
    );
  });

  await test("8. scanRoot 提取有效卡片，并记录缺失标题 / 分区诊断", () => {
    const root = rootOf([
      card({
        bvid: "BV1cc411c7m3",
        uid: "2001",
        upName: "观察UP",
        title: "完整标题",
        partition: "科技"
      }),
      card({ bvid: "BV1dd411c7m4", uid: "2002", upName: "缺字段UP" })
    ]);
    const result = I.scanRoot(root, { pageHref: PAGE_A, observedAt: "2026-11-12T03:00:00.000Z" });
    assert.equal(result.observations.length, 2);
    assert.equal(result.diagnostics.missingTitle, 1);
    assert.equal(result.diagnostics.missingPartition, 1);
    assert.equal(result.observations[0].upUid, "2001");
    assert.equal(result.observations[0].partition, "科技");
    assert.equal(result.observations[1].title, "");
    assert.equal(result.observations[1].partition, "");
  });

  await test("9. 同一卡片内同一 BV 的多个链接只产生一条观察", () => {
    const cardNode = node({
      children: [
        videoLink("BV1cc411c7m3", { title: "封面标题" }),
        videoLink("BV1cc411c7m3", { title: "标题链接" }),
        spaceLink("2001", "观察UP")
      ]
    });
    const result = I.scanRoot(rootOf([cardNode]), {
      pageHref: PAGE_A,
      observedAt: "2026-11-12T03:00:00.000Z"
    });
    assert.equal(result.observations.length, 1);
    assert.equal(result.observations[0].title, "封面标题");
  });

  await test("10. 包含多个 UID 的卡片视为歧义，不猜测归属", () => {
    const ambiguous = node({
      children: [
        videoLink("BV1cc411c7m3", { title: "歧义卡片" }),
        spaceLink("2001", "UP甲"),
        spaceLink("2002", "UP乙")
      ]
    });
    const result = I.scanRoot(rootOf([ambiguous]), {
      pageHref: PAGE_A,
      observedAt: "2026-11-12T03:00:00.000Z"
    });
    assert.equal(result.observations.length, 0);
    assert.equal(result.diagnostics.ambiguousUid, 1);
  });

  await test("11. 推荐列表会按卡片分别观察，不会把整个列表当成一张卡片", () => {
    const list = node({
      children: [
        card({ bvid: "BV1cc411c7m3", uid: "2001", upName: "甲", title: "甲" }),
        card({ bvid: "BV1dd411c7m4", uid: "2002", upName: "乙", title: "乙" })
      ]
    });
    const result = I.scanRoot(rootOf([list]), {
      pageHref: PAGE_A,
      observedAt: "2026-11-12T03:00:00.000Z"
    });
    assert.equal(result.observations.length, 2);
    assert.deepEqual(
      result.observations.map((item) => item.upUid).sort(),
      ["2001", "2002"]
    );
  });

  await test("12. 恶意 / 无效视频链接不会进入观察", () => {
    const malicious = node({
      children: [
        node({ tag: "a", attrs: { href: "javascript:alert(1)" } }),
        node({ tag: "a", attrs: { href: "https://evil.example/video/BV1cc411c7m3" } }),
        spaceLink("2001", "观察UP")
      ]
    });
    const result = I.scanRoot(rootOf([malicious]), {
      pageHref: PAGE_A,
      observedAt: "2026-11-12T03:00:00.000Z"
    });
    assert.equal(result.observations.length, 0);
  });

  await test("13. scanRoot 遵守单次卡片上限与锚点上限", () => {
    const cards = [];
    for (let index = 0; index < 60; index += 1) {
      cards.push(
        card({
          bvid: `BV1${String(index).padStart(9, "0")}`,
          uid: String(3000 + index),
          upName: `UP${index}`,
          title: `标题${index}`,
          partition: "科技"
        })
      );
    }
    const result = I.scanRoot(rootOf(cards), {
      pageHref: PAGE_A,
      observedAt: "2026-11-12T03:00:00.000Z",
      maxCards: 5
    });
    assert.equal(result.observations.length, 5);
    assert.ok(result.diagnostics.anchorsScanned <= 120);
  });

  /* ------------------------------------------------------------ 控制器 */

  await test("14. 默认关闭时不启动观察器、不写入", async () => {
    const env = controllerEnv({ enabled: false });
    await env.controller.init();
    assert.equal(env.controller._state().started, false);
    assert.equal(env.observer.instances.length, 0);
    assert.equal(env.store.calls.length, 0);
  });

  await test("15. 开启后扫描已渲染卡片并写入一次，重复卡片不重复写入", async () => {
    const env = controllerEnv({ enabled: true });
    await env.controller.init();
    assert.equal(env.controller._state().started, true);
    await runScanTimer(env);
    await runScanTimer(env);
    assert.equal(env.store.calls.length, 1);
    assert.equal(env.store.calls[0].observations.length, 1);
    assert.equal(env.store.calls[0].observations[0].upUid, "2001");
    assert.equal(env.store.calls[0].observations[0].bvid, "BV1cc411c7m3");
    env.controller.stop();
  });

  await test("16. MutationObserver 连续回调只保留一个节流中的扫描任务", async () => {
    const env = controllerEnv({ enabled: true });
    await env.controller.init();
    await runScanTimer(env);
    const observer = env.observer.instances[0];
    for (let index = 0; index < 8; index += 1) observer.callback();
    const pending = env.timers.pending().filter((item) => item.delay === 1500);
    assert.equal(pending.length, 1);
    assert.ok(pending[0].delay >= 700);
    env.controller.stop();
  });

  await test("17. stop 后断开观察器、清除定时器，后续回调不再写入", async () => {
    const env = controllerEnv({ enabled: true });
    await env.controller.init();
    await runScanTimer(env);
    const callsBefore = env.store.calls.length;
    const observer = env.observer.instances[0];
    env.controller.stop();
    assert.equal(observer.disconnected, true);
    assert.equal(env.timers.pending().length, 0);
    observer.callback();
    env.win.dispatch("popstate");
    assert.equal(env.timers.pending().length, 0);
    assert.equal(env.store.calls.length, callsBefore);
  });

  await test("18. SPA 切换到另一个视频页后会按新来源页继续观察", async () => {
    const env = controllerEnv({ enabled: true });
    await env.controller.init();
    await runScanTimer(env);
    const rootB = rootOf([
      card({
        bvid: "BV1ee411c7m5",
        uid: "2009",
        upName: "第二页UP",
        title: "第二页标题",
        partition: "生活"
      })
    ]);
    env.doc.documentElement = rootB;
    env.root.children = rootB.children;
    env.win.navigate(PAGE_B);
    env.win.dispatch("popstate");
    await runScanTimer(env);
    assert.equal(env.store.calls.length, 2);
    assert.equal(env.store.calls[1].observations[0].bvid, "BV1ee411c7m5");
    assert.equal(env.store.calls[1].observations[0].sourcePageBvid, "BV1bb411c7m2");
    env.controller.stop();
  });

  await test("19. 页面观察上限生效，超过上限后不再写入", async () => {
    const env = controllerEnv({
      enabled: true,
      store: fakeStore(true, { maxObservationsPerPage: 1 })
    });
    await env.controller.init();
    await runScanTimer(env);
    assert.equal(env.store.calls.length, 1);
    await runScanTimer(env);
    assert.equal(env.store.calls.length, 1);
    env.controller.stop();
  });

  await test("20. 设置变为关闭后 controller 停止，不留下活动定时器", async () => {
    const env = controllerEnv({ enabled: true });
    await env.controller.init();
    await env.controller.syncSettings({ enabled: false });
    assert.equal(env.controller._state().started, false);
    assert.equal(env.timers.pending().length, 0);
  });

  await test("21. 同一次扫描内的相同 UID + BV 只出现一次", () => {
    const duplicate = card({
      bvid: "BV1cc411c7m3",
      uid: "2001",
      upName: "观察UP",
      title: "标题",
      partition: "科技"
    });
    const result = I.scanRoot(rootOf([duplicate, duplicate]), {
      pageHref: PAGE_A,
      observedAt: "2026-11-12T03:00:00.000Z"
    });
    assert.equal(result.observations.length, 1);
  });

  await test("22. 观察器不读取 cookie / localStorage / 发起网络请求", () => {
    const fs = require("node:fs");
    const source = fs.readFileSync(path.join(__dirname, "candidate-discovery.js"), "utf8");
    assert.equal(/document\.cookie/.test(source), false);
    assert.equal(/localStorage/.test(source), false);
    assert.equal(/\bfetch\s*\(/.test(source), false);
    assert.equal(/XMLHttpRequest/.test(source), false);
    assert.equal(/WebSocket/.test(source), false);
    assert.equal(/chrome\.runtime\.sendMessage/.test(source), false);
    assert.equal(/chrome\.cookies/.test(source), false);
  });

  /* ---------------------------------------------------------------- 汇总 */

  const failed = results.filter((item) => !item.ok);
  results.forEach((item) => {
    if (item.ok) console.log(`PASS ${item.name}`);
    else {
      console.log(`FAIL ${item.name}`);
      console.log(item.error && item.error.stack ? item.error.stack : String(item.error));
    }
  });
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
