// Bili Daily - Mock Data for E-R1 Prototype
// 模拟数据，用于设计原型预览，不读取 chrome.storage

const MOCK_DATA = {
  // 昨日观看总结
  yesterday: {
    date: "2026-11-12",
    count: 12,
    durationMinutes: 187,
    topPartition: { name: "动画", percentage: 42 },
    secondPartition: { name: "游戏", percentage: 28 },
    periods: [
      { label: "午间", count: 3 },
      { label: "晚间", count: 7 },
      { label: "深夜", count: 2 }
    ],
    topUps: [
      { uid: "12345678", name: "某科技UP主", avatar: "", videoCount: 4 },
      { uid: "23456789", name: "动画解说", avatar: "", videoCount: 3 },
      { uid: "34567890", name: "游戏实况", avatar: "", videoCount: 2 }
    ]
  },

  // 7 天兴趣画像
  profile: {
    status: "ready",
    mainDimensions: [
      { name: "动画", value: 0.82, color: "#9B7BFF" },
      { name: "游戏", value: 0.65, color: "#5CF2FF" },
      { name: "科技", value: 0.58, color: "#FF4FD8" },
      { name: "知识", value: 0.45, color: "#FFC46B" },
      { name: "生活", value: 0.32, color: "#B8FF6A" }
    ],
    topUps: [
      { name: "某科技UP主", count: 15 },
      { name: "动画解说", count: 12 },
      { name: "游戏实况", count: 10 }
    ],
    totalDays: 7,
    activeDays: 6
  },

  // 今日推荐
  recommendations: [
    {
      uid: "45678901",
      name: "新锐科技评测",
      reason: "内容相似度高",
      confidence: "high",
      provenance: "watched",
      lane: "main",
      score: 0.87
    },
    {
      uid: "56789012",
      name: "独立动画工作室",
      reason: "分区偏好匹配",
      confidence: "medium",
      provenance: "watched",
      lane: "main",
      score: 0.76
    },
    {
      uid: "67890123",
      name: "游戏音乐精选",
      reason: "探索推荐",
      confidence: "medium",
      provenance: "page-observed",
      lane: "exploration",
      score: 0.68
    },
    {
      uid: "78901234",
      name: "跨界设计频道",
      reason: "多维度相关",
      confidence: "low",
      provenance: "user-provided",
      lane: "main",
      score: 0.54
    },
    {
      uid: "89012345",
      name: "实验性动画",
      reason: "探索推荐",
      confidence: "unavailable",
      provenance: "page-observed",
      lane: "exploration",
      score: 0.45
    }
  ],

  // 自动发现
  discovery: {
    enabled: true,
    discovered: 23,
    recommendable: 8,
    insufficient: 15,
    message: "已从相关推荐中发现 23 位新 UP 主，其中 8 位数据充足可进入探索通道。"
  },

  // 候选导入
  imports: {
    totalCount: 5,
    items: [
      { uid: "11111111", name: "用户手动导入1", date: "2026-11-10", videoCount: 3 },
      { uid: "22222222", name: "用户手动导入2", date: "2026-11-09", videoCount: 2 }
    ]
  },

  // 观看时间轴 (Dashboard 专用)
  timeline: [
    { time: "09:30", title: "早间科技新闻", up: "科技资讯", duration: 12 },
    { time: "12:15", title: "游戏实况精彩集锦", up: "游戏实况", duration: 28 },
    { time: "14:00", title: "动画分析：构图美学", up: "动画解说", duration: 35 },
    { time: "18:45", title: "晚间观看：新番追更", up: "番剧推荐", duration: 24 },
    { time: "21:30", title: "深夜知识：物理原理", up: "知识科普", duration: 18 },
    { time: "23:00", title: "音乐欣赏", up: "游戏音乐精选", duration: 15 }
  ],

  // UP 主排行榜 (Dashboard 专用)
  upLeaderboard: [
    { uid: "12345678", name: "某科技UP主", videoCount: 15, totalMinutes: 342, partition: "科技" },
    { uid: "23456789", name: "动画解说", videoCount: 12, totalMinutes: 298, partition: "动画" },
    { uid: "34567890", name: "游戏实况", videoCount: 10, totalMinutes: 256, partition: "游戏" },
    { uid: "45678901", name: "知识科普", videoCount: 8, totalMinutes: 187, partition: "知识" },
    { uid: "56789012", name: "生活记录", videoCount: 6, totalMinutes: 134, partition: "生活" },
    { uid: "67890123", name: "美食探店", videoCount: 5, totalMinutes: 98, partition: "美食" },
    { uid: "78901234", name: "音乐分享", videoCount: 4, totalMinutes: 76, partition: "音乐" },
    { uid: "89012345", name: "影视解说", videoCount: 3, totalMinutes: 54, partition: "影视" }
  ]
};

// 工具函数
const formatDuration = (minutes) => {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return hours > 0 ? `${hours} 小时 ${mins} 分` : `${mins} 分钟`;
};

const formatDate = (dateStr) => {
  const date = new Date(dateStr);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${month} 月 ${day} 日`;
};

// 导出 (Node.js 环境)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MOCK_DATA, formatDuration, formatDate };
}

// 浏览器全局暴露
if (typeof window !== 'undefined') {
  window.MOCK_DATA = MOCK_DATA;
  window.formatDuration = formatDuration;
  window.formatDate = formatDate;
}
