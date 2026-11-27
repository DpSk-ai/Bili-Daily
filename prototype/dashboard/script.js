// Bili Daily Dashboard - NEON DREAM Prototype Script

(function() {
  'use strict';

  const { MOCK_DATA, formatDuration, formatDate } = window;

  // Initialize
  function init() {
    renderHero();
    renderTimeline();
    renderProfileRadar();
    renderDimensionBars();
    renderLeaderboard();
    renderRecommendations();
    renderDiscovery();
    initBackgroundParticles();
    attachEventListeners();
    animateEntrance();
  }

  // Hero section
  function renderHero() {
    const { yesterday } = MOCK_DATA;
    document.getElementById('heroVideoCount').textContent = yesterday.count;
    const hours = (yesterday.durationMinutes / 60).toFixed(1);
    document.getElementById('heroDuration').textContent = hours;

    const summary = `主要观看${yesterday.topPartition.name} ${yesterday.topPartition.percentage}%、${yesterday.secondPartition.name} ${yesterday.secondPartition.percentage}%，活跃时段：${yesterday.periods.map(p => p.label).join('、')}`;
    document.getElementById('heroSummary').textContent = summary;
  }

  // Timeline
  function renderTimeline() {
    const container = document.getElementById('timeline');
    const { timeline } = MOCK_DATA;

    timeline.forEach((item, index) => {
      const el = document.createElement('div');
      el.className = 'timeline-item';
      el.style.animationDelay = `${index * 80}ms`;

      el.innerHTML = `
        <div class="timeline-time">${item.time}</div>
        <div class="timeline-title">${item.title}</div>
        <div class="timeline-up">${item.up} · ${item.duration} 分钟</div>
      `;

      container.appendChild(el);
    });
  }

  // Profile Radar Chart
  function renderProfileRadar() {
    const canvas = document.getElementById('radarChartLarge');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    canvas.width = 600 * dpr;
    canvas.height = 300 * dpr;
    ctx.scale(dpr, dpr);

    const centerX = 300;
    const centerY = 150;
    const maxRadius = 100;
    const { mainDimensions } = MOCK_DATA.profile;
    const angleStep = (Math.PI * 2) / mainDimensions.length;

    ctx.clearRect(0, 0, 600, 300);

    // Background circles
    ctx.strokeStyle = 'rgba(92, 242, 255, 0.1)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      ctx.beginPath();
      ctx.arc(centerX, centerY, (maxRadius / 4) * i, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Axes
    ctx.strokeStyle = 'rgba(92, 242, 255, 0.15)';
    mainDimensions.forEach((_, index) => {
      const angle = angleStep * index - Math.PI / 2;
      const x = centerX + Math.cos(angle) * maxRadius;
      const y = centerY + Math.sin(angle) * maxRadius;
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.lineTo(x, y);
      ctx.stroke();
    });

    // Data polygon
    ctx.beginPath();
    mainDimensions.forEach((dim, index) => {
      const angle = angleStep * index - Math.PI / 2;
      const radius = dim.value * maxRadius;
      const x = centerX + Math.cos(angle) * radius;
      const y = centerY + Math.sin(angle) * radius;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();

    ctx.fillStyle = 'rgba(155, 123, 255, 0.2)';
    ctx.fill();
    ctx.strokeStyle = '#5CF2FF';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Points
    mainDimensions.forEach((dim, index) => {
      const angle = angleStep * index - Math.PI / 2;
      const radius = dim.value * maxRadius;
      const x = centerX + Math.cos(angle) * radius;
      const y = centerY + Math.sin(angle) * radius;

      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = dim.color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    // Labels
    ctx.font = '14px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    mainDimensions.forEach((dim, index) => {
      const angle = angleStep * index - Math.PI / 2;
      const labelRadius = maxRadius + 30;
      const x = centerX + Math.cos(angle) * labelRadius;
      const y = centerY + Math.sin(angle) * labelRadius;

      ctx.fillStyle = dim.color;
      ctx.fillText(dim.name, x, y);
    });
  }

  // Dimension bars
  function renderDimensionBars() {
    const container = document.getElementById('dimensionBars');
    const { mainDimensions } = MOCK_DATA.profile;

    mainDimensions.forEach((dim, index) => {
      const bar = document.createElement('div');
      bar.className = 'dimension-bar';
      bar.style.animationDelay = `${index * 100}ms`;

      const percentage = Math.round(dim.value * 100);
      bar.innerHTML = `
        <div class="dimension-name">${dim.name}</div>
        <div class="dimension-track">
          <div class="dimension-fill" style="width: ${percentage}%; background: ${dim.color};"></div>
        </div>
        <div class="dimension-value">${percentage}%</div>
      `;

      container.appendChild(bar);
    });
  }

  // Leaderboard
  function renderLeaderboard() {
    const container = document.getElementById('leaderboard');
    const { upLeaderboard } = MOCK_DATA;

    upLeaderboard.forEach((up, index) => {
      const item = document.createElement('div');
      item.className = 'leaderboard-item';
      item.style.animationDelay = `${index * 60}ms`;

      item.innerHTML = `
        <div class="leaderboard-name">${up.name}</div>
        <div class="leaderboard-stat">${up.videoCount} 个视频</div>
        <div class="leaderboard-stat">${up.totalMinutes} 分钟</div>
        <div class="leaderboard-partition">${up.partition}</div>
      `;

      item.addEventListener('click', () => {
        window.open(`https://space.bilibili.com/${up.uid}`, '_blank');
      });

      container.appendChild(item);
    });
  }

  // Recommendations
  function renderRecommendations() {
    const container = document.getElementById('recCards');
    const { recommendations } = MOCK_DATA;

    recommendations.forEach((rec, index) => {
      const card = document.createElement('div');
      card.className = 'rec-card';
      card.style.animationDelay = `${index * 80}ms`;

      const confidenceLabel = {
        high: '高可信',
        medium: '中可信',
        low: '低可信',
        unavailable: '可信度未知'
      }[rec.confidence];

      const provenanceLabel = {
        watched: '来源：观看记录',
        'user-provided': '来源：用户导入',
        'page-observed': '来源：页面发现'
      }[rec.provenance];

      card.innerHTML = `
        <div class="rec-card-name">${rec.name}</div>
        <div class="rec-card-meta">
          <span>${rec.reason}</span>
          <span>·</span>
          <span>${confidenceLabel}</span>
          <span>·</span>
          <span>${provenanceLabel}</span>
        </div>
      `;

      card.addEventListener('click', () => {
        window.open(`https://space.bilibili.com/${rec.uid}`, '_blank');
      });

      container.appendChild(card);
    });
  }

  // Discovery
  function renderDiscovery() {
    const { discovery } = MOCK_DATA;
    document.getElementById('discoveredCount').textContent = discovery.discovered;
    document.getElementById('recommendableCount').textContent = discovery.recommendable;
    document.getElementById('discoveryStatus').textContent = discovery.enabled ? '已开启' : '已关闭';
  }

  // Background particles
  function initBackgroundParticles() {
    const canvas = document.getElementById('bgParticles');
    const ctx = canvas.getContext('2d');

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const particles = [];
    const particleCount = 60;

    for (let i = 0; i < particleCount; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        radius: Math.random() * 1.5 + 0.5,
        opacity: Math.random() * 0.5 + 0.2
      });
    }

    function animate() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;

        if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
        if (p.y < 0 || p.y > canvas.height) p.vy *= -1;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(92, 242, 255, ${p.opacity})`;
        ctx.fill();
      });

      requestAnimationFrame(animate);
    }

    animate();

    window.addEventListener('resize', () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    });
  }

  // Event listeners
  function attachEventListeners() {
    const refreshBtn = document.getElementById('refreshRec');
    refreshBtn.addEventListener('click', () => {
      refreshBtn.innerHTML = '<span class="btn-icon">↻</span>刷新中...';
      refreshBtn.disabled = true;

      setTimeout(() => {
        const container = document.getElementById('recCards');
        container.innerHTML = '';
        renderRecommendations();
        refreshBtn.innerHTML = '<span class="btn-icon">↻</span>刷新';
        refreshBtn.disabled = false;
      }, 1000);
    });
  }

  // Entrance animation
  function animateEntrance() {
    const cards = document.querySelectorAll('.card');
    cards.forEach((card, index) => {
      card.style.opacity = '0';
      card.style.transform = 'translateY(30px)';

      setTimeout(() => {
        card.style.transition = 'all 500ms cubic-bezier(0.4, 0.0, 0.2, 1)';
        card.style.opacity = '1';
        card.style.transform = 'translateY(0)';
      }, index * 120);
    });
  }

  // Run on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
