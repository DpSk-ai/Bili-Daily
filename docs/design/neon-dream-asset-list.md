# NEON DREAM 资产清单 | E-R1

**项目**: Bili Daily  
**阶段**: E-R1 视觉设计原型  
**日期**: 2026-11-13

---

## 一、原创角色 NEO 立绘资产

### 1. Dashboard 半身立绘
**文件名**: `neo-portrait-main.png`  
**规格**:
- 尺寸: 600×1000px (实际显示 300×500px @2x)
- 格式: PNG 24-bit with alpha
- 透明背景
- 构图: 半身像，肩部或腰部以上，视线朝向画面左侧或正面
- 色彩: 银白/浅紫发色，蓝紫渐变瞳色，深色科技服饰，霓虹蓝/紫装饰线
- 风格: 高完成度日系二次元插画，非 Chibi / SD 风格

**动画分层建议** (如需实现复杂动画):
- `neo-portrait-body.png` — 身体主体(静态)
- `neo-portrait-eyes-open.png` — 睁眼状态
- `neo-portrait-eyes-closed.png` — 闭眼状态(眨眼)
- `neo-portrait-glow.png` — 服饰/配件发光层(可独立淡入淡出)

**占位资产** (当前阶段):
- `prototype/assets/placeholders/neo-portrait-placeholder.svg`
- 内容: 轮廓剪影 + 标注文字 "NEO 立绘占位 · 600×1000px"
- 背景: 深紫色半透明，边框霓虹蓝虚线

---

### 2. Popup 小头像
**文件名**: `neo-avatar-80.png`  
**规格**:
- 尺寸: 160×160px (实际显示 80×80px @2x)
- 格式: PNG 24-bit with alpha
- 圆形或圆角方形构图
- 保留标志性发色、瞳色、表情特征
- 可独立识别，即使缩小到 64×64px

**占位资产**:
- `prototype/assets/placeholders/neo-avatar-placeholder.svg`
- 内容: 圆形轮廓 + NEO 首字母 "N" + 装饰环
- 背景: 径向渐变(深紫→透明)

---

### 3. 表情/状态变体 (可选，后期迭代)
- `neo-portrait-happy.png` — 微笑
- `neo-portrait-thinking.png` — 思考
- `neo-portrait-alert.png` — 警告/注意
- `neo-avatar-{state}.png` — 对应小头像版本

---

## 二、背景与装饰资产

### 1. 背景粒子纹理
**文件名**: `bg-particles.png`  
**规格**:
- 尺寸: 1920×1080px
- 格式: PNG 8-bit with alpha
- 内容: 稀疏的小光点/星点，透明度 10-30%
- 用途: 作为 Dashboard 背景层，配合 CSS animation 实现缓慢浮动

**实现**: 可用 CSS 或 Canvas 动态生成，无需独立文件

---

### 2. 玻璃纹理/噪点
**文件名**: `glass-noise.png`  
**规格**:
- 尺寸: 512×512px (平铺)
- 格式: PNG 8-bit grayscale
- 内容: 细微噪点纹理，增强玻璃卡片质感
- 透明度: 通过 CSS `opacity: 0.03` 叠加

**实现**: 可用 CSS `filter: url(#noise)` SVG 滤镜替代

---

### 3. 网格纹理
**文件名**: 无需独立文件  
**实现**: CSS `linear-gradient` 绘制

```css
background-image:
  linear-gradient(rgba(92, 242, 255, 0.04) 1px, transparent 1px),
  linear-gradient(90deg, rgba(92, 242, 255, 0.04) 1px, transparent 1px);
background-size: 32px 32px;
```

---

## 三、图标与 UI 元素

### 1. 分区图标 (Bilibili 内容分区)
**数量**: 15-20 个  
**规格**:
- 尺寸: 48×48px (实际显示 24×24px @2x)
- 格式: SVG (优先) 或 PNG sprite
- 风格: 线性图标，描边宽度 2px，霓虑蓝/紫配色
- 分区: 动画、游戏、音乐、科技、生活、美食、时尚、娱乐、影视、知识、资讯等

**占位**: 使用 Unicode emoji 或 CSS 绘制简单几何形状

---

### 2. 状态图标
**文件名**: `icon-{name}.svg`  
**数量**: 8-10 个  
**规格**:
- 尺寸: 48×48px
- 格式: SVG
- 风格: 与分区图标一致

**清单**:
- `icon-refresh.svg` — 刷新
- `icon-import.svg` — 导入
- `icon-export.svg` — 导出
- `icon-discovery.svg` — 发现
- `icon-settings.svg` — 设置
- `icon-warning.svg` — 警告
- `icon-success.svg` — 成功
- `icon-info.svg` — 信息

**占位**: 使用浏览器默认图标或纯文字标签

---

### 3. 品牌 LOGO
**文件名**: `logo-bili-daily.svg`  
**规格**:
- 尺寸: 可缩放 SVG
- 内容: "BILI DAILY" 文字 + 抽象几何装饰
- 风格: 等宽字体或未来科技感字体，霓虹蓝描边/填充

**占位**: 纯文字 "BILI DAILY" + CSS 样式

---

## 四、字体资产

### 1. 中文字体
**选择**:
- **在线字体** (via CSS `@font-face`，非 CDN):
  - Google Fonts 本地托管: `Noto Sans SC`
  - 或使用系统字体栈: `"Microsoft YaHei", "PingFang SC", sans-serif`

**推荐**: 使用系统字体，避免增加资源体积

---

### 2. 等宽字体
**选择**:
- 系统等宽: `"Cascadia Code", "JetBrains Mono", Consolas, monospace`

**用途**: 数字展示、代码、UID

---

### 3. 标题字体 (可选)
**选择**:
- 英文标题: `"Rajdhani"`, `"Orbitron"`, `"Exo 2"` (科技感)
- 本地托管或使用系统字体加粗

**推荐**: 不引入额外字体，使用系统字体 + CSS `font-weight: 700`

---

## 五、数据可视化资产

### 1. 雷达图 / 柱状图
**实现**: Canvas 或 SVG 动态绘制  
**无需独立资产**

**配色**:
- 填充: `rgba(155, 123, 255, 0.2)` (紫色半透明)
- 描边: `#5CF2FF` (冰蓝)
- 顶点: `#FF4FD8` (洋红)

---

### 2. 时间轴卡片
**实现**: HTML + CSS  
**无需独立资产**

**样式**:
- 横向滚动容器
- 每个时段一张卡片，带时间戳、视频数、主要 UP 主
- 玻璃毛玻璃效果 + 霓虹边框

---

## 六、占位资产制作规范

### 目的
在最终高品质资产生成之前,使用明确标注的占位资源,确保布局和交互可以正常测试。

### 规范
1. **必须标注**: 所有占位资源必须包含文字说明或明显视觉标记,表明这是占位内容
2. **尺寸匹配**: 占位资源尺寸必须与最终资产规格一致
3. **透明度支持**: PNG 占位使用透明背景,SVG 占位保留 alpha 通道
4. **色彩区分**: 占位资源使用深紫/灰色,避免与最终设计冲突

### 示例 SVG 占位 (NEO 头像)

```svg
<svg width="160" height="160" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="grad" cx="50%" cy="50%" r="50%">
      <stop offset="0%" style="stop-color:#6B4FBF;stop-opacity:0.8" />
      <stop offset="100%" style="stop-color:#2D1B4E;stop-opacity:0.95" />
    </radialGradient>
  </defs>
  <circle cx="80" cy="80" r="78" fill="url(#grad)" stroke="#5CF2FF" stroke-width="2" stroke-dasharray="8,4" opacity="0.6"/>
  <text x="80" y="85" font-family="sans-serif" font-size="48" fill="#5CF2FF" text-anchor="middle" opacity="0.9">N</text>
  <text x="80" y="130" font-family="sans-serif" font-size="12" fill="#8BA2C7" text-anchor="middle">NEO AVATAR</text>
  <text x="80" y="145" font-family="sans-serif" font-size="10" fill="#62749A" text-anchor="middle">PLACEHOLDER</text>
</svg>
```

---

## 七、资产交付时间线

### E-R1 阶段 (当前)
- [x] 所有占位 SVG 资产
- [ ] 品牌 LOGO (SVG)
- [ ] 状态图标 (SVG, 8-10 个)

### E-R2 阶段 (业务集成前)
- [ ] NEO 小头像最终版 (PNG @2x)
- [ ] NEO 半身立绘最终版 (PNG @2x)
- [ ] 分区图标 (SVG sprite 或独立文件)

### E-R3 阶段 (打磨优化)
- [ ] NEO 表情变体 (可选)
- [ ] 动画分层资产 (如需)
- [ ] 背景粒子纹理 (如需)

---

## 八、资产生成建议

### 原创角色立绘生成
**方式 1: AI 图像生成** (Stable Diffusion, Midjourney, NovelAI)
- Prompt 关键词: `anime girl, silver hair, purple eyes, futuristic outfit, holographic accessories, neon lights, cyberpunk, half-body portrait, transparent background, high quality illustration`
- 风格标签: `detailed, clean line art, soft shading, sci-fi`
- 避免: 既有角色名称、版权作品名称

**方式 2: 委托插画师**
- 提供详细角色设定文档
- 要求提供 PSD 分层文件,便于后期调整和动画制作

**方式 3: 使用占位 + 后期替换**
- 当前阶段使用 SVG 占位
- 在 E-R2 前完成最终立绘制作

### 图标制作
**工具**: Figma, Adobe Illustrator, Inkscape (开源)  
**资源**: Heroicons, Lucide Icons (MIT 许可,可修改)

---

## 九、版权与许可

### 原创资产
- NEO 角色立绘和设计为 Bili Daily 项目原创,版权归项目所有
- 不得用于 Bili Daily 项目之外的商业或非商业用途

### 第三方资产
- 系统字体: 遵循操作系统许可
- 第三方图标库: 遵循 MIT / Apache 2.0 许可,需保留原始许可声明
- 占位资源: 项目内部使用,无版权问题

---

**清单版本**: E-R1.0  
**下次更新**: 资产制作完成后更新文件路径
