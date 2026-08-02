// background.js — keeps the toolbar badge in sync with usage.

import {
  loadSnapshot,
  getStatus,
  formatCountdown,
  describeError,
  probeOrigin,
  storageGet,
  storageSet,
  BADGE_LIMIT_KEY,
  normaliseRefreshSeconds,
  UsageError
} from './lib/usage.js';

const REFRESH_ALARM = 'refresh-usage';

// Auto-refresh can be switched off entirely, and a browser that has only just
// started tends to fail its first attempt before the network is up. Without a
// retry of its own that leaves the badge stuck on an error until the popup is
// opened by hand, so a failure always books its own next attempt.
const RETRY_ALARM = 'retry-usage';

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
    const detail = err?.detail || err?.message || '';
    await paintProblem(code);

    // A transport failure says nothing about itself, so ask the origin directly
    // whether it is reachable at all before writing the failure down.
    const probe = code === 'NETWORK' ? ` — probe: ${await probeOrigin()}` : '';

    // The popup only ever shows the friendly wording, so this is the one place
    // the actual reason a request died is recoverable. Inspect it from
    // chrome://extensions -> the extension -> "service worker".
    console.warn(`[usage] refresh failed: ${code}${detail ? ` — ${detail}` : ''}${probe}`);
    return { ok: false, code, detail, retryAfterMs: err?.retryAfterMs ?? null };
  }
}

// The alarm and an open popup can ask at the same time; only fetch once.
let pending = null;

// Repeated failures back off instead of retrying at the refresh interval,
// which during an outage would be a lot of pointless requests.
//
// This state has to survive the worker, not just live in it. Chrome shuts an
// idle service worker down after about thirty seconds, so a counter held in a
// module variable was reset before the next alarm ever read it — the backoff
// existed but never once engaged, and a browser that came up before its network
// did was answered with a full-rate stream of failing requests for as long as
// it took to recover. Session storage is the right home: it outlives the worker
// and is cleared when the browser restarts, which is exactly when a fresh start
// is wanted.
const BACKOFF_BASE_MS = 5000;
const BACKOFF_MAX_MS = 120000;
const BACKOFF_KEY = 'refreshBackoff';

async function readBackoff() {
  return (await storageGet('session', BACKOFF_KEY)) || { failures: 0, until: 0 };
}

async function noteResult(ok, retryAfterMs) {
  if (ok) {
    await storageSet('session', BACKOFF_KEY, { failures: 0, until: 0 });
    await chrome.alarms.clear(RETRY_ALARM);
    return;
  }

  const { failures } = await readBackoff();
  const next = failures + 1;
  // A server that told us how long to wait outranks our own guess.
  const wait = Number.isFinite(retryAfterMs)
    ? Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_BASE_MS, retryAfterMs))
    : Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (next - 1));

  const until = Date.now() + wait;
  await storageSet('session', BACKOFF_KEY, { failures: next, until });
  await scheduleRetry(until);
}

// Chrome will not fire an alarm sooner than 30 seconds, so a short backoff just
// gets the earliest slot going.
async function scheduleRetry(until) {
  await chrome.alarms.create(RETRY_ALARM, {
    delayInMinutes: Math.max(MIN_ALARM_MINUTES, (until - Date.now()) / 60000)
  });
}

// While backing off, hand back the last good reading rather than an error, so
// the popup keeps showing numbers.
async function cachedResult() {
  const { usageCache } = await chrome.storage.local.get('usageCache');
  if (usageCache?.limits?.length || usageCache?.extra) {
    return { ok: true, ...usageCache, stale: true };
  }
  return { ok: false, code: 'NETWORK', detail: '' };
}

async function refresh({ force = false } = {}) {
  if (!force) {
    const { until } = await readBackoff();
    if (Date.now() < until) return cachedResult();
  }

  if (!pending) {
    pending = runRefresh()
      .then(async (result) => {
        await noteResult(result.ok, result.retryAfterMs);
        return result;
      })
      .finally(() => {
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
  if (alarm.name === REFRESH_ALARM || alarm.name === RETRY_ALARM) refresh();
});

// Re-arm as soon as the interval is changed in the popup.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.refreshSeconds) ensureAlarm();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'refresh-usage') {
    // A manual click should always try, backoff or not.
    refresh({ force: message.force === true }).then(sendResponse);
    return true; // keep the channel open for the async reply
  }
  return undefined;
});
