"use strict";

/**
 * Bili Daily —— 自动发现可复现性能 / 上限测试
 * 运行：node test-auto-discovery-performance.js
 *
 * 使用固定规模的合成 DOM 与固定条数的观察记录，验证每次扫描的
 * 锚点 / 卡片 / 写入上限确实生效。时间阈值放宽，仅用于发现明显退化；
 * 同一输入可重复运行。
 */

const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "stats.js"));
require(path.join(__dirname, "candidate-features.js"));
require(path.join(__dirname, "discovered-candidate-store.js"));
require(path.join(__dirname, "candidate-discovery.js"));

const Discovery = globalThis.BiliDailyDiscovery;
const Store = globalThis.BiliDailyDiscoveredCandidateStore;

const results = [];
function test(name, fn) {
  try {
    const started = Date.now();
    fn();
    results.push({ name, ok: true, ms: Date.now() - started });
  } catch (error) {
    results.push({ name, ok: false, error, ms: 0 });
  }
}

function matches(element, selector) {
  const list = String(selector)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return list.some((raw) => {
    const tagMatch = /^([a-z0-9]*)\[/i.exec(raw);
    if (tagMatch && tagMatch[1] && element.tagName.toLowerCase() !== tagMatch[1]) {
      return false;
    }
    const attr = /\[([a-z0-9-]+)(\*?=)?"([^"]*)?"?\]/i.exec(raw) || /\[([a-z0-9-]+)\]/i.exec(raw);
    if (!attr) return false;
    const value = element.getAttribute(attr[1]);
    if (value === null) return false;
    if (attr[2] === "*=") return value.includes(attr[3]);
    return true;
  });
}

function node(attrs, text, children) {
  const element = {
    nodeType: 1,
    tagName: (attrs && attrs.tag ? attrs.tag : "div").toUpperCase(),
    attrs: Object.assign({}, (attrs && attrs.attrs) || {}),
    children: children || [],
    ownText: text || "",
    parentElement: null,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
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
  element.children.forEach((child) => {
    child.parentElement = element;
  });
  Object.defineProperty(element, "textContent", {
    get() {
      return `${this.ownText} ${this.children.map((child) => child.textContent).join(" ")}`.trim();
    }
  });
  return element;
}

function bvid(index) {
  return `BV1${String(index).padStart(9, "0")}`;
}

function makeCard(index) {
  const video = node(
    { tag: "a", attrs: { href: `/video/${bvid(index)}/`, title: `性能测试标题 ${index}` } },
    ""
  );
  const space = node(
    { tag: "a", attrs: { href: `https://space.bilibili.com/${5000 + index}` } },
    `性能UP${index}`
  );
  return node({ attrs: { "data-tname": "科技" } }, "", [video, space]);
}

test("1. 400 张卡片的扫描遵守锚点与卡片上限，耗时可控", () => {
  const cards = [];
  for (let index = 0; index < 400; index += 1) cards.push(makeCard(index));
  const root = node({}, "", cards);
  const started = Date.now();
  const result = Discovery._internal.scanRoot(root, {
    pageHref: "/video/BV1aa411c7m1",
    observedAt: "2026-11-12T12:00:00.000Z",
    maxCards: 40
  });
  const elapsed = Date.now() - started;
  assert.equal(result.observations.length, 40);
  assert.ok(result.diagnostics.anchorsScanned <= 400);
  assert.ok(elapsed < 5000, `扫描耗时 ${elapsed}ms 超出上限`);
});

test("2. 固定 300 条观察的证据适配保持线性规模并可重复", () => {
  const observations = [];
  for (let index = 0; index < 300; index += 1) {
    observations.push({
      upUid: String(6000 + index),
      upName: `性能UP${index}`,
      bvid: bvid(index),
      title: `性能测试标题 ${index}`,
      partition: "科技",
      observedAt: "2026-11-12T00:00:00.000Z",
      sourcePageBvid: bvid(900 + index),
      provenance: "page-observed",
      observationScope: "related-recommendation-card"
    });
  }
  const store = {
    version: Store.STORE_VERSION,
    kind: Store.STORE_KIND,
    updatedAt: "2026-11-12T00:00:00.000Z",
    observations
  };
  const now = Date.parse("2026-11-12T12:00:00.000Z");
  const started = Date.now();
  const first = Store.buildDiscoveredEvidence(store, { version: 1, days: {} }, {
    now,
    settings: { enabled: true }
  });
  const elapsed = Date.now() - started;
  assert.equal(first.summary.total, 300);
  assert.equal(first.summary.eligible, 0);
  assert.equal(first.summary.insufficientData, 300);
  assert.ok(elapsed < 5000, `证据适配耗时 ${elapsed}ms 超出上限`);

  const second = Store.buildDiscoveredEvidence(store, { version: 1, days: {} }, {
    now,
    settings: { enabled: true }
  });
  assert.deepEqual(first, second);
});

test("3. 500 条观察的证据适配规模稳定，不依赖未声明的裁剪", () => {
  const entries = [];
  const base = Date.parse("2026-11-12T00:00:00.000Z");
  for (let index = 0; index < 500; index += 1) {
    entries.push(
      Store.normalizeObservation({
        upUid: String(7000 + index),
        bvid: bvid(index),
        title: `标题 ${index}`,
        partition: "科技",
        observedAt: new Date(base + index * 1000).toISOString(),
        sourcePageBvid: bvid(900 + index),
        provenance: "page-observed",
        observationScope: "related-recommendation-card"
      })
    );
  }
  const store = {
    version: Store.STORE_VERSION,
    kind: Store.STORE_KIND,
    updatedAt: new Date(base).toISOString(),
    observations: entries
  };
  const evidence = Store.buildDiscoveredEvidence(store, { version: 1, days: {} }, {
    now: base + 600000,
    settings: { enabled: true, maxCandidates: 120 }
  });
  // buildDiscoveredEvidence 不做写入裁剪；容量由 addObservations / rebuildStore 执行。
  assert.equal(evidence.summary.total, 500);
  assert.equal(evidence.summary.insufficientData, 500);
});

const failed = results.filter((item) => !item.ok);
results.forEach((item) => {
  if (item.ok) console.log(`PASS ${item.name} (${item.ms}ms)`);
  else {
    console.log(`FAIL ${item.name}`);
    console.log(item.error && item.error.stack ? item.error.stack : String(item.error));
  }
});
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) process.exitCode = 1;
