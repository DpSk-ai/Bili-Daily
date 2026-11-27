"use strict";

/**
 * Bili Daily v1.1 —— Neon UI 静态契约测试
 * 运行：node test-neon-ui-contract.js
 *
 * 只检查文件结构与安全约束，不代替真实 Edge 渲染验收。
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const html = read("popup.html");
const css = read("popup.css");
const js = read("popup.js");
const backup = read("data-backup.js");
const asset = read(path.join("assets", "neon-assistant.svg"));
const manifest = JSON.parse(read("manifest.json"));

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

test("1. popup.html 引用本地原创助手 SVG", () => {
  assert.equal(html.includes('src="assets/neon-assistant.svg"'), true);
  assert.equal(html.includes('alt="NEO-01 原创全息助手"'), true);
});

test("2. popup.html 在 popup.js 之前加载 data-backup.js", () => {
  const backupIndex = html.indexOf('<script src="data-backup.js"></script>');
  const popupIndex = html.indexOf('<script src="popup.js"></script>');
  assert.ok(backupIndex > 0);
  assert.ok(popupIndex > backupIndex);
});

test("3. 数据舱四个操作入口齐全", () => {
  ["data-data-export", "data-data-file", "data-data-confirm", "data-data-cancel", "data-data-preview"].forEach(
    (hook) => assert.equal(html.includes(hook), true, hook)
  );
});

test("4. 原有数据钩子保持存在", () => {
  [
    "data-field=\"count\"",
    "data-field=\"duration\"",
    "data-field=\"profile-status\"",
    "data-field=\"rec-status\"",
    "data-field=\"discovery-status\"",
    "data-field=\"import-status\"",
    "data-refresh",
    "data-import-file",
    "data-discovery-toggle"
  ].forEach((hook) => assert.equal(html.includes(hook), true, hook));
});

test("5. 六个卡片区块与 420px 宽度存在", () => {
  assert.equal((html.match(/<section class="card/g) || []).length, 6);
  assert.match(css, /body\s*\{[^}]*width:\s*420px/s);
});

test("6. Neon 色彩 token 完整", () => {
  ["--neon-cyan: #5cf2ff", "--neon-magenta: #ff4fd8", "--neon-violet: #9b7bff", "--neon-bg: #05070f"].forEach(
    (token) => assert.equal(css.includes(token), true, token)
  );
});

test("7. 卡片包含 HUD 角标与主题色", () => {
  assert.match(css, /\.card::before/);
  assert.match(css, /\.card::after/);
  assert.match(css, /data-accent="magenta"/);
  assert.match(css, /data-accent="lime"/);
});

test("8. 动效与 reduced-motion 降级均存在", () => {
  assert.match(css, /@keyframes cardIn/);
  assert.match(css, /@keyframes ringSpin/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test("9. 键盘焦点样式存在", () => {
  assert.match(css, /button:focus-visible/);
  assert.match(css, /\.dev-option:focus-visible/);
});

test("10. popup.js 接入 DataBackup 的导出、预览、写入 API", () => {
  assert.equal(js.includes("BiliDailyDataBackup"), true);
  assert.equal(js.includes("serializeBackup("), true);
  assert.equal(js.includes("prepareImport("), true);
  assert.equal(js.includes("writePayload("), true);
});

test("11. popup.js 不使用 innerHTML / document.write / eval", () => {
  assert.equal(/\.innerHTML\s*=/.test(js), false);
  assert.equal(/document\.write\s*\(/.test(js), false);
  assert.equal(/\beval\s*\(/.test(js), false);
  assert.equal(/new Function\s*\(/.test(js), false);
});

test("12. 推荐卡按通道添加视觉类", () => {
  assert.equal(js.includes("rec-exploration"), true);
  assert.match(css, /\.rec-card\.rec-exploration/);
});

test("13. data-backup.js 不发起网络请求、不读 Cookie", () => {
  assert.equal(/\bfetch\s*\(/.test(backup), false);
  assert.equal(/XMLHttpRequest/.test(backup), false);
  assert.equal(/WebSocket/.test(backup), false);
  assert.equal(/document\.cookie/.test(backup), false);
  assert.equal(/chrome\.cookies/.test(backup), false);
});

test("14. SVG 是本地静态文件，无脚本与外部引用", () => {
  assert.equal(asset.startsWith("<svg"), true);
  assert.equal(/<script/i.test(asset), false);
  assert.equal(/href="https?:/i.test(asset), false);
  assert.equal(/src="https?:/i.test(asset), false);
  assert.ok(Buffer.byteLength(asset, "utf8") < 30 * 1024);
});

test("15. popup.html 不引用远程脚本、样式或字体", () => {
  assert.equal(/<script[^>]+src="https?:/i.test(html), false);
  assert.equal(/<link[^>]+href="https?:/i.test(html), false);
  assert.equal(/@import\s+url\(/i.test(css), false);
  assert.equal(/https?:\/\//.test(css), false);
});

test("16. 助手加载失败时有 CSS 降级替身", () => {
  assert.equal(html.includes("assistant-fallback"), true);
  assert.match(css, /\.assistant\.is-fallback \.assistant-fallback/);
  assert.equal(js.includes("is-fallback"), true);
});

test("17. manifest 版本为 1.1.x，权限未扩大", () => {
  assert.match(manifest.version, /^1\.1\./);
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.equal(Object.prototype.hasOwnProperty.call(manifest, "host_permissions"), false);
});

test("18. 备份 UI 明确 5 MiB 上限与四个键说明", () => {
  assert.match(html, /最大 5 MiB/);
  assert.match(html, /四个本地键/);
});

test("19. 开发日期入口默认隐藏，不影响正式界面", () => {
  assert.match(html, /class="dev-switch"[\s\S]*?hidden/);
});

test("20. 页脚包含 v1.1 与本地存储标识", () => {
  assert.match(html, /BILI DAILY v1\.1 \/\/ NEON EDITION/);
  assert.match(html, /LOCAL STORAGE · NO UPLOAD/);
});

const failed = results.filter((item) => !item.ok);
results.forEach((item) => {
  if (item.ok) {
    console.log(`PASS ${item.name}`);
  } else {
    console.log(`FAIL ${item.name}`);
    console.log(item.error && item.error.stack ? item.error.stack : String(item.error));
  }
});
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) process.exitCode = 1;
