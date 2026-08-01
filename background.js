// background.js — keeps the toolbar badge in sync with usage.

import {
  loadSnapshot,
  getStatus,
  formatCountdown,
  describeError,
  BADGE_LIMIT_KEY,
  normaliseRefreshSeconds,
  UsageError
} from './lib/usage.js';

const REFRESH_ALARM = 'refresh-usage';

// Chrome will not fire an alarm more often than every 30 seconds, so anything
// quicker than that only applies while the popup is open and driving it.
const MIN_ALARM_MINUTES = 0.5;

// Highest first, so one crossing only fires the most severe notice.
const NOTIFY_LEVELS = [95, 80];

const BADGE_COLORS = {
  low: '#2f8452',
  mid: '#a37b12',
  high: '#c4613f',
  crit: '#c53030',
  idle: '#6b5e52'
};

async function paintBadge(text, color, title) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  // Not available on every Chromium build.
  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  }
  await chrome.action.setTitle({ title });
}

// The badge always tracks the session window, whatever else is on the card.
async function paintUsage(limits) {
  const target = limits.find((limit) => limit.key === BADGE_LIMIT_KEY);
  if (!target) {
    await paintBadge('', BADGE_COLORS.idle, 'Claude Usage');
    return;
  }

  const pct = Math.round(target.utilization);
  await paintBadge(
    pct >= 100 ? 'MAX' : String(pct),
    BADGE_COLORS[getStatus(target.utilization)],
    `Claude Usage — ${target.label} at ${pct}%`
  );
}

async function paintProblem(code) {
  const { title } = describeError(code);
  await paintBadge(
    code === 'AUTH' || code === 'NO_ORG' ? '?' : '!',
    BADGE_COLORS.idle,
    `Claude Usage — ${title}`
  );
}

function notify(limit, level) {
  chrome.notifications.create(`usage-${limit.key}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: `${limit.label} at ${Math.round(limit.utilization)}%`,
    message: formatCountdown(limit.resetsAt) || `You have passed ${level}% of this limit.`,
    priority: level >= 95 ? 2 : 0
  });
}

// Fires once per limit per level per reset window, so a window that rolls over
// re-arms the alerts without nagging in between.
async function maybeNotify(limits) {
  const { notifyEnabled = true, notifyState = {} } = await chrome.storage.local.get([
    'notifyEnabled',
    'notifyState'
  ]);

  const nextState = {};
  for (const limit of limits) {
    const currentWindow = limit.resetsAt || '';
    const previous = notifyState[limit.key];
    const notifiedLevel = previous && previous.window === currentWindow ? previous.level : 0;
    const level = NOTIFY_LEVELS.find((threshold) => limit.utilization >= threshold) || 0;

    nextState[limit.key] = { window: currentWindow, level: Math.max(level, notifiedLevel) };
    if (notifyEnabled && level > notifiedLevel) notify(limit, level);
  }

  await chrome.storage.local.set({ notifyState: nextState });
}

async function runRefresh() {
  try {
    const { limits, extra } = await loadSnapshot();
    if (!limits.length && !extra) {
      await paintProblem('NO_LIMITS');
      return { ok: false, code: 'NO_LIMITS', detail: '' };
    }

    await paintUsage(limits);
    if (limits.length) await maybeNotify(limits);

    // Cached so the popup can paint something the moment it opens.
    const fetchedAt = Date.now();
    await chrome.storage.local.set({ usageCache: { limits, extra, fetchedAt } });
    return { ok: true, limits, extra, fetchedAt };
  } catch (err) {
    const code = err instanceof UsageError ? err.code : 'UNKNOWN';
    await paintProblem(code);
    return { ok: false, code, detail: err?.detail || err?.message || '' };
  }
}

// The alarm and an open popup can ask at the same time; only fetch once.
let pending = null;

function refresh() {
  if (!pending) {
    pending = runRefresh().finally(() => {
      pending = null;
    });
  }
  return pending;
}

async function ensureAlarm() {
  const stored = await chrome.storage.local.get('refreshSeconds');
  const seconds = normaliseRefreshSeconds(stored.refreshSeconds);

  await chrome.alarms.clear(REFRESH_ALARM);
  if (!seconds) return; // auto-refresh turned off

  chrome.alarms.create(REFRESH_ALARM, {
    periodInMinutes: Math.max(MIN_ALARM_MINUTES, seconds / 60)
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  refresh();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  refresh();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) refresh();
});

// Re-arm as soon as the interval is changed in the popup.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.refreshSeconds) ensureAlarm();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'refresh-usage') {
    refresh().then(sendResponse);
    return true; // keep the channel open for the async reply
  }
  return undefined;
});
