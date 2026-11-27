# Bili Daily - NEON DREAM 视觉原型

**阶段**: E-R1 设计原型  
**状态**: 已完成，等待审核  
**日期**: 2026-11-13

---

## 快速预览

### 方法 1: 直接打开 (推荐)
1. 双击 `popup/index.html` - 查看 Popup 原型
2. 双击 `dashboard/index.html` - 查看 Dashboard 原型

### 方法 2: 本地服务器
```bash
# 在当前目录 (prototype/) 运行:
python -m http.server 8080

# 然后访问:
# http://localhost:8080/popup/index.html
# http://localhost:8080/dashboard/index.html
```

---

## 目录结构

```
prototype/
├── README.md                    # 本文件
├── mock-data.js                 # 模拟数据 (共享)
├── popup/                       # Popup 原型 (420×640px)
│   ├── index.html
│   ├── style.css
│   └── script.js
├── dashboard/                   # Dashboard 原型 (响应式)
│   ├── index.html
│   ├── style.css
│   └── script.js
└── assets/                      # 资源文件
    └── placeholders/            # 占位资源
        └── neo-avatar-placeholder.svg
```

---

## 原型特性

### Popup (轻量日常入口)
- ✅ 昨日观看总结 (视频数、时长、主要分区、TOP UP 主)
- ✅ 7 天兴趣雷达图 (紧凑版)
- ✅ 今日推荐 (可展开折叠)
- ✅ 打开完整仪表盘按钮
- ✅ NEO 头像 + 呼吸动画
- ✅ 玻璃毛玻璃材质卡片
- ✅ 霓虹发光效果

### Dashboard (完整仪表盘)
- ✅ 大型 Hero 昨日回顾区域
- ✅ NEO 半身立绘 (占位，右上角固定)
- ✅ 观看时间轴 (横向滚动卡片)
- ✅ 7 天兴趣画像 (大型雷达图 + 维度柱状图)
- ✅ UP 主排行榜 (网格布局)
- ✅ 今日推荐 (完整卡片列表)
- ✅ 自动发现 (统计 + 控制按钮)
- ✅ 候选导入 & 数据舱 (折叠面板)
- ✅ 背景粒子动画 (Canvas)
- ✅ 响应式布局

---

## 注意事项

### 这是设计原型，不是最终产品
- ❌ 不读取 chrome.storage (使用 mock-data.js 模拟数据)
- ❌ 不影响正式扩展 (完全独立)
- ❌ 按钮点击仅有基础演示效果 (无完整业务逻辑)
- ✅ 展示视觉设计、布局、动画、交互方向

### NEO 角色当前为占位
- 当前使用 SVG 占位资源，标注 "PLACEHOLDER"
- 最终需要高品质日系科幻插画风格半身立绘 (600×1000px)
- 参考设定见 `docs/design/neon-dream-asset-list.md`

### 浏览器兼容性
- 目标: Edge (Chromium 110+) / Chrome / Firefox
- 测试环境: Windows 11
- 已支持 `prefers-reduced-motion` (减少动画)

---

## 审核要点

### 视觉设计
- [ ] 色彩方案是否符合"赛博二次元"定位？
- [ ] 霓虹效果是否过度或不足？
- [ ] NEO 角色占位是否能想象最终效果？
- [ ] 卡片层次是否清晰？
- [ ] 文字可读性是否良好？

### 信息架构
- [ ] Popup 是否快速传达关键信息？
- [ ] Dashboard 布局是否合理？
- [ ] 重要功能是否容易找到？
- [ ] 是否有遗漏的现有功能？

### 交互体验
- [ ] 动画是否流畅？(如卡顿，可能需要降低复杂度)
- [ ] 悬停反馈是否明确？
- [ ] 按钮点击是否有反馈？
- [ ] 是否支持键盘导航？(Tab 键测试)

---

## 下一步

### 如果批准设计方向
→ 进入 **E-R2 阶段**: 业务逻辑集成

1. 将原型样式迁移到正式扩展
2. 接入真实 chrome.storage 数据
3. 保留所有现有功能
4. 创建正式 Dashboard 扩展页面
5. 完整测试验收

### 如果需要修改设计
→ 提出具体修改意见，迭代原型

- 色彩调整
- 布局调整
- 动画强度调整
- NEO 角色设定调整

---

## 相关文档

- 完整设计规格: `../docs/design/neon-dream-redesign-spec.md`
- 资产清单: `../docs/design/neon-dream-asset-list.md`
- 交付报告: `../docs/acceptance/e-r1-prototype-delivery.md`

---

**原型版本**: E-R1.0  
**联系方式**: 通过 Claude Code 会话反馈
