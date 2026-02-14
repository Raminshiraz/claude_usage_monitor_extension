// popup.js — Claude Usage Monitor

const content = document.getElementById('content');
const refreshBtn = document.getElementById('refreshBtn');
const themeBtn = document.getElementById('themeBtn');
const sunIcon = document.getElementById('sunIcon');
const moonIcon = document.getElementById('moonIcon');

// Theme handling
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  chrome.storage.local.set({ theme });
  if (theme === 'light') {
    sunIcon.style.display = 'none';
    moonIcon.style.display = 'block';
  } else {
    sunIcon.style.display = 'block';
    moonIcon.style.display = 'none';
  }
}

chrome.storage.local.get('theme', (result) => {
  setTheme(result.theme || 'dark');
});

themeBtn.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  setTheme(current === 'dark' ? 'light' : 'dark');
});

refreshBtn.addEventListener('click', () => loadUsage());

async function getOrgId() {
  const cookie = await chrome.cookies.get({ url: 'https://claude.ai', name: 'lastActiveOrg' });
  return cookie?.value || null;
}

async function fetchUsage(orgId) {
  const url = `https://claude.ai/api/organizations/${orgId}/usage`;
  const resp = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: {
      'accept': '*/*',
      'content-type': 'application/json',
      'anthropic-client-platform': 'web_claude_ai'
    }
  });

  if (resp.status === 401 || resp.status === 403) throw new Error('AUTH');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function getStatus(utilization) {
  if (utilization >= 95) return 'crit';
  if (utilization >= 75) return 'high';
  if (utilization >= 50) return 'mid';
  return 'low';
}

function formatCountdown(resetIso) {
  if (!resetIso) return '';
  const now = Date.now();
  const reset = new Date(resetIso).getTime();
  let diff = reset - now;
  if (diff <= 0) return 'Resetting soon\u2026';

  const days = Math.floor(diff / 86400000);
  diff %= 86400000;
  const hrs = Math.floor(diff / 3600000);
  diff %= 3600000;
  const mins = Math.floor(diff / 60000);

  if (days > 0) return `Resets in ${days}d ${hrs}h`;
  if (hrs > 0) return `Resets in ${hrs}h ${mins}m`;
  return `Resets in ${mins}m`;
}

function clockSvg() {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
}

function renderCard(label, utilization, resetsAt) {
  if (utilization == null) return '';
  const status = getStatus(utilization);
  const pct = Math.round(utilization);
  const countdown = formatCountdown(resetsAt);

  return `
    <div class="card status-${status}">
      <div class="card-header">
        <span class="card-label">${label}</span>
        <span class="card-value">${pct}% used</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width: ${pct}%"></div>
      </div>
      ${countdown ? `<div class="reset-info">${clockSvg()}<span>${countdown}</span></div>` : ''}
    </div>
  `;
}

function renderDashboard(data) {
  let html = '<div class="cards">';

  if (data.five_hour) {
    html += renderCard('5-Hour Session', data.five_hour.utilization, data.five_hour.resets_at);
  }
  if (data.seven_day) {
    html += renderCard('7-Day Usage', data.seven_day.utilization, data.seven_day.resets_at);
  }
  if (data.seven_day_opus) {
    html += renderCard('7-Day Opus', data.seven_day_opus.utilization, data.seven_day_opus.resets_at);
  }
  if (data.seven_day_sonnet) {
    html += renderCard('7-Day Sonnet', data.seven_day_sonnet.utilization, data.seven_day_sonnet.resets_at);
  }
  if (data.seven_day_cowork) {
    html += renderCard('7-Day Cowork', data.seven_day_cowork.utilization, data.seven_day_cowork.resets_at);
  }
  if (data.seven_day_oauth_apps) {
    html += renderCard('OAuth Apps', data.seven_day_oauth_apps.utilization, data.seven_day_oauth_apps.resets_at);
  }

  html += '</div>';
  content.innerHTML = html;
}

function showError(type) {
  if (type === 'AUTH') {
    content.innerHTML = `
      <div class="state-msg">
        <div class="icon">\uD83D\uDD12</div>
        <div class="title">Not logged in</div>
        <div class="desc">Open <a href="https://claude.ai" target="_blank">claude.ai</a> and log in first, then try again.</div>
      </div>`;
  } else if (type === 'NO_ORG') {
    content.innerHTML = `
      <div class="state-msg">
        <div class="icon">\u2699\uFE0F</div>
        <div class="title">Not logged in to Claude.ai</div>
        <div class="desc">Please <a href="https://claude.ai" target="_blank">log in to claude.ai</a> first, then reopen this extension.</div>
      </div>`;
  } else {
    content.innerHTML = `
      <div class="state-msg">
        <div class="icon">\u26A0\uFE0F</div>
        <div class="title">Something went wrong</div>
        <div class="desc">${type}<br>Click refresh to try again.</div>
      </div>`;
  }
}

async function loadUsage() {
  refreshBtn.classList.add('spinning');
  content.innerHTML = `
    <div class="state-msg">
      <div class="icon">\u23F3</div>
      <div class="title">Loading...</div>
    </div>`;

  try {
    const orgId = await getOrgId();
    if (!orgId) {
      showError('NO_ORG');
      refreshBtn.classList.remove('spinning');
      return;
    }

    const data = await fetchUsage(orgId);
    renderDashboard(data);
  } catch (err) {
    showError(err.message || 'Unknown error');
  }

  refreshBtn.classList.remove('spinning');
}

loadUsage();
