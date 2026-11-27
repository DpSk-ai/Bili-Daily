// Bili Daily Popup - NEON DREAM Prototype Script

(function() {
  'use strict';

  const { MOCK_DATA, formatDuration, formatDate } = window;

  // DOM elements
  const elements = {
    yesterdayDate: document.getElementById('yesterdayDate'),
    videoCount: document.getElementById('videoCount'),
    duration: document.getElementById('duration'),
    topPartition: document.getElementById('topPartition'),
    secondPartition: document.getElementById('secondPartition'),
    upAvatars: document.getElementById('upAvatars'),
    radarChart: document.getElementById('radarChart'),
    profileSummary: document.getElementById('profileSummary'),
    toggleRec: document.getElementById('toggleRec'),
    recList: document.getElementById('recList'),
    openDashboard: document.getElementById('openDashboard'),
    refreshRec: document.getElementById('refreshRec')
  };

  // Initialize
  function init() {
    renderYesterday();
    renderProfile();
    renderRecommendations();
    attachEventListeners();
    animateEntrance();
  }

  // Render yesterday's summary
  function renderYesterday() {
    const { yesterday } = MOCK_DATA;

    elements.yesterdayDate.textContent = formatDate(yesterday.date);
    elements.videoCount.textContent = yesterday.count;

    const hours = (yesterday.durationMinutes / 60).toFixed(1);
    elements.duration.textContent = hours;

    elements.topPartition.textContent = `${yesterday.topPartition.name} ${yesterday.topPartition.percentage}%`;
    elements.secondPartition.textContent = `${yesterday.secondPartition.name} ${yesterday.secondPartition.percentage}%`;

    renderUpAvatars(yesterday.topUps);
  }

  // Render UP avatars
  function renderUpAvatars(ups) {
    elements.upAvatars.innerHTML = '';

    ups.forEach((up, index) => {
      const avatar = document.createElement('div');
      avatar.className = 'up-avatar';
      avatar.title = `${up.name} (${up.videoCount} 个视频)`;
      avatar.textContent = up.name.substring(0, 2);
      avatar.style.animationDelay = `${index * 100}ms`;
      elements.upAvatars.appendChild(avatar);
    });
  }

  // Render 7-day profile radar chart
  function renderProfile() {
    const { profile } = MOCK_DATA;
    const canvas = elements.radarChart;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    // Set canvas size
    canvas.width = 360 * dpr;
    canvas.height = 200 * dpr;
    ctx.scale(dpr, dpr);

    const centerX = 180;
    const centerY = 100;
    const maxRadius = 70;
    const dimensions = profile.mainDimensions;
    const angleStep = (Math.PI * 2) / dimensions.length;

    // Clear canvas
    ctx.clearRect(0, 0, 360, 200);

    // Draw background circles
    ctx.strokeStyle = 'rgba(92, 242, 255, 0.1)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(centerX, centerY, (maxRadius / 3) * i, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Draw axes
    ctx.strokeStyle = 'rgba(92, 242, 255, 0.15)';
    ctx.lineWidth = 1;
    dimensions.forEach((_, index) => {
      const angle = angleStep * index - Math.PI / 2;
      const x = centerX + Math.cos(angle) * maxRadius;
      const y = centerY + Math.sin(angle) * maxRadius;
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.lineTo(x, y);
      ctx.stroke();
    });

    // Draw data polygon
    ctx.beginPath();
    dimensions.forEach((dim, index) => {
      const angle = angleStep * index - Math.PI / 2;
      const radius = dim.value * maxRadius;
      const x = centerX + Math.cos(angle) * radius;
      const y = centerY + Math.sin(angle) * radius;

      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.closePath();

    // Fill
    ctx.fillStyle = 'rgba(155, 123, 255, 0.2)';
    ctx.fill();

    // Stroke
    ctx.strokeStyle = '#5CF2FF';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Draw points
    dimensions.forEach((dim, index) => {
      const angle = angleStep * index - Math.PI / 2;
      const radius = dim.value * maxRadius;
      const x = centerX + Math.cos(angle) * radius;
      const y = centerY + Math.sin(angle) * radius;

      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = dim.color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    // Draw labels
    ctx.font = '12px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    dimensions.forEach((dim, index) => {
      const angle = angleStep * index - Math.PI / 2;
      const labelRadius = maxRadius + 20;
      const x = centerX + Math.cos(angle) * labelRadius;
      const y = centerY + Math.sin(angle) * labelRadius;

      ctx.fillStyle = dim.color;
      ctx.fillText(dim.name, x, y);
    });

    // Update summary
    const topDims = dimensions.slice(0, 3).map(d => d.name).join('、');
    elements.profileSummary.textContent = `活跃 ${profile.activeDays} 天 · 主要兴趣：${topDims}`;
  }

  // Render recommendations
  function renderRecommendations() {
    const { recommendations } = MOCK_DATA;
    elements.recList.innerHTML = '';

    recommendations.slice(0, 2).forEach((rec, index) => {
      const item = document.createElement('div');
      item.className = 'rec-item';
      item.style.animationDelay = `${index * 100}ms`;

      item.innerHTML = `
        <div class="rec-name">${rec.name}</div>
        <div class="rec-reason">${rec.reason} · ${getConfidenceLabel(rec.confidence)}</div>
      `;

      item.addEventListener('click', () => {
        window.open(`https://space.bilibili.com/${rec.uid}`, '_blank');
      });

      elements.recList.appendChild(item);
    });
  }

  // Get confidence label
  function getConfidenceLabel(confidence) {
    const labels = {
      high: '高可信',
      medium: '中可信',
      low: '低可信',
      unavailable: '可信度未知'
    };
    return labels[confidence] || '未知';
  }

  // Attach event listeners
  function attachEventListeners() {
    // Toggle recommendations
    elements.toggleRec.addEventListener('click', () => {
      const isExpanded = elements.toggleRec.getAttribute('aria-expanded') === 'true';
      elements.toggleRec.setAttribute('aria-expanded', !isExpanded);
      elements.recList.hidden = isExpanded;
    });

    // Open dashboard
    elements.openDashboard.addEventListener('click', () => {
      window.open('../dashboard/index.html', '_blank');
    });

    // Refresh recommendations
    elements.refreshRec.addEventListener('click', () => {
      elements.refreshRec.textContent = '↻ 刷新中...';
      elements.refreshRec.disabled = true;

      setTimeout(() => {
        renderRecommendations();
        elements.refreshRec.innerHTML = '<span class="btn-icon">↻</span>刷新推荐';
        elements.refreshRec.disabled = false;
      }, 800);
    });
  }

  // Animate entrance
  function animateEntrance() {
    const cards = document.querySelectorAll('.card');
    cards.forEach((card, index) => {
      card.style.opacity = '0';
      card.style.transform = 'translateY(20px)';

      setTimeout(() => {
        card.style.transition = 'all 400ms cubic-bezier(0.4, 0.0, 0.2, 1)';
        card.style.opacity = '1';
        card.style.transform = 'translateY(0)';
      }, index * 100);
    });
  }

  // Run on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
