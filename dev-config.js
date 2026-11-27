"use strict";

/**
 * Bili Daily —— 开发测试配置
 *
 * 只控制弹窗「读取 / 展示」哪一天的数据，不修改系统日期，不读写 chrome.storage.local，
 * 也不影响 content.js 的后台采集（content.js 不会加载本文件）。
 *
 * 正式发布：enabled 必须保持默认值 false，弹窗里不会出现任何开发入口。
 * 本地验收：把 enabled 改为 true → 在扩展管理页点「重新加载」→ 打开弹窗即可看到日期切换。
 *
 * defaultDateOption 决定每次打开弹窗时的初始日期：
 * - "yesterday"：昨天（与正式版默认行为一致）
 * - "today"：今天（仅用于查看今天真实采集的记录）
 * 选择只在本次弹窗内有效，不做持久化 —— 避免写入用户的本地数据。
 */

(function (global) {
  const devConfig = Object.freeze({
    enabled: false,
    defaultDateOption: "yesterday"
  });

  global.BiliDailyDevConfig = devConfig;
})(typeof globalThis !== "undefined" ? globalThis : window);
