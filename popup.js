// popup.js — Claude Usage Monitor

import {
  getStatus,
  formatCountdown,
  formatResetTime,
  formatAge,
  formatUsd,
  formatDate,
  describeError,
  CLAUDE_ORIGIN_PATTERN,
  REFRESH_OPTIONS,
  normaliseRefreshSeconds,
  UsageError
} from './lib/usage.js';
import { systemThemeFrom, resolveTheme, buildOverride } from './lib/theme.js';

const COUNTDOWN_TICK_MS = 30000;

const content = document.getElementById('content');
const refreshBtn = document.getElementById('refreshBtn');
const footerText = document.getElementById('footerText');
const intervalSelect = document.getElementById('intervalSelect');
const themeBtn = document.getElementById('themeBtn');
const sunIcon = document.getElementById('sunIcon');
const moonIcon = document.getElementById('moonIcon');
const notifyBtn = document.getElementById('notifyBtn');
const bellOnIcon = document.getElementById('bellOnIcon');
const bellOffIcon = document.getElementById('bellOffIcon');

const CLOCK_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

// --- Theme: follow the OS unless overridden since the OS last changed --------

const systemQuery = window.matchMedia('(prefers-color-scheme: dark)');

function currentSystemTheme() {
  return systemThemeFrom(systemQuery.matches);
}

function applyTheme(theme, following) {
  document.documentElement.setAttribute('data-theme', theme);
  const isLight = theme === 'light';
  sunIcon.style.display = isLight ? 'none' : 'block';
  moonIcon.style.display = isLight ? 'block' : 'none';
  themeBtn.title = following ? `Theme: system (${theme})` : `Theme: ${theme}`;
}

function syncTheme(override) {
  const resolved = resolveTheme(currentSystemTheme(), override);
  applyTheme(resolved.theme, resolved.following);
  return resolved;
}

function reveal() {
  document.documentElement.classList.add('ready');
}

try {
  chrome.storage.local.get(['themeOverride'], (result) => {
    try {
      const resolved = syncTheme(result?.themeOverride || null);
      // The OS moved since we last ran, so the override has served its purpose.
      if (result?.themeOverride && !resolved.override) {
        chrome.storage.local.remove('themeOverride');
      }
    } finally {
      reveal();
    }
  });
} catch {
  syncTheme(null);
  reveal();
}

themeBtn.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  const override = buildOverride(next, currentSystemTheme());

  if (override) chrome.storage.local.set({ themeOverride: override });
  else chrome.storage.local.remove('themeOverride');

  applyTheme(next, !override);
});

systemQuery.addEventListener('change', () => {
  chrome.storage.local.remove('themeOverride');
  syncTheme(null);
});

// --- Alerts -----------------------------------------------------------------

function setNotify(enabled) {
  chrome.storage.local.set({ notifyEnabled: enabled });
  notifyBtn.setAttribute('aria-pressed', String(enabled));
  notifyBtn.title = enabled ? 'Alerts on' : 'Alerts off';
  bellOnIcon.style.display = enabled ? 'block' : 'none';
  bellOffIcon.style.display = enabled ? 'none' : 'block';
}

chrome.storage.local.get('notifyEnabled', (result) => {
  setNotify(result.notifyEnabled !== false);
});

notifyBtn.addEventListener('click', () => {
  setNotify(notifyBtn.getAttribute('aria-pressed') !== 'true');
});

// --- Auto-refresh -----------------------------------------------------------

let autoTimer = null;

function applyInterval(seconds) {
  clearInterval(autoTimer);
  autoTimer = null;
  intervalSelect.value = String(seconds);
  if (seconds) autoTimer = setInterval(() => loadUsage({ keepVisible: true }), seconds * 1000);
}

intervalSelect.addEventListener('change', () => {
  const seconds = normaliseRefreshSeconds(intervalSelect.value);
  chrome.storage.local.set({ refreshSeconds: seconds });
  applyInterval(seconds);
});

// --- Rendering --------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Countdown labels would otherwise go stale while the popup sits open.
let countdownTargets = [];
let countdownTimer = null;

function replaceContent(node) {
  countdownTargets = [];
  clearInterval(countdownTimer);
  countdownTimer = null;
  content.replaceChildren(node);
}

function tickCountdowns() {
  const now = Date.now();
  for (const { resetsAt, node } of countdownTargets) {
    node.textContent = formatCountdown(resetsAt, now);
  }
}

function buildTrack(utilization, label, { thin = false } = {}) {
  const track = el('div', thin ? 'progress-track thin' : 'progress-track');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  track.setAttribute('aria-valuenow', String(Math.round(utilization)));
  track.setAttribute('aria-label', label);

  const fill = el('div', 'progress-fill');
  // Overage can report past 100; the bar should stop at full.
  fill.style.width = `${Math.max(0, Math.min(100, utilization))}%`;
  track.append(fill);
  return track;
}

function buildCard(limit, countdownSinks) {
  const status = getStatus(limit.utilization);
  const pct = Math.round(limit.utilization);

  const card = el('div', `card status-${status}`);

  const header = el('div', 'card-header');
  header.append(el('span', 'card-label', limit.label), el('span', 'card-value', `${pct}% used`));
  card.append(header, buildTrack(limit.utilization, `${limit.label} usage`));

  const countdown = formatCountdown(limit.resetsAt);
  if (countdown) {
    const info = el('div', 'reset-info');
    const icon = el('span', 'reset-icon');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = CLOCK_SVG;
    const text = el('span', null, countdown);
    info.append(icon, text);

    const exact = formatResetTime(limit.resetsAt);
    if (exact) info.title = `Resets at ${exact}`;

    card.append(info);
    countdownSinks.push({ resetsAt: limit.resetsAt, node: text });
  }

  return card;
}

function promoNote(extra) {
  const expires = formatDate(extra.promoExpiresAt);
  return `${formatUsd(extra.promoCents)} promotional${expires ? `, expires ${expires}` : ''}`;
}

// The money you actually hold, which is a different figure from the headroom
// under the monthly limit above it.
function buildBalance(extra) {
  const sub = el('div', 'card-sub');
  const row = el('div', 'card-sub-row');
  row.append(
    el('span', 'card-sub-label', 'Balance'),
    el('span', 'card-sub-value strong', formatUsd(extra.balanceCents))
  );
  sub.append(row);
  if (extra.promoCents != null) sub.append(el('div', 'card-note', promoNote(extra)));
  return sub;
}

function buildExtraCard(extra) {
  const hasBar = extra.utilization != null;
  const status = hasBar ? getStatus(extra.utilization) : 'low';
  const card = el('div', `card card-extra status-${status}`);

  const header = el('div', 'card-header');
  header.append(
    el('span', 'card-label', 'Usage Credits'),
    el(
      'span',
      'card-value',
      hasBar ? `${Math.round(extra.utilization)}% used` : formatUsd(extra.balanceCents)
    )
  );
  card.append(header);

  if (!hasBar) {
    card.append(el('div', 'card-note', 'Current balance'));
    if (extra.promoCents != null) card.append(el('div', 'card-note', promoNote(extra)));
    return card;
  }

  card.append(buildTrack(extra.utilization, 'Spend against your monthly limit'));

  // The remainder here is headroom under the monthly limit — deliberately not
  // called a balance, which is a different and usually larger number.
  const parts = [
    `${formatUsd(extra.usedCents)} spent of ${formatUsd(extra.totalCents)} monthly limit`
  ];
  if (extra.remainingCents != null) parts.push(`${formatUsd(extra.remainingCents)} left`);
  card.append(el('div', 'card-note', parts.join(' • ')));

  if (extra.limitReached) card.append(el('div', 'card-warn', 'Monthly spend limit reached'));
  if (extra.balanceCents != null) card.append(buildBalance(extra));

  return card;
}

function renderUsage(limits, extra) {
  if (!limits.length && !extra) {
    showState(describeError('NO_LIMITS'));
    return;
  }

  const sinks = [];
  const cards = el('div', 'cards');
  for (const limit of limits) cards.append(buildCard(limit, sinks));
  if (extra) cards.append(buildExtraCard(extra));

  replaceContent(cards);

  countdownTargets = sinks;
  if (sinks.length) countdownTimer = setInterval(tickCountdowns, COUNTDOWN_TICK_MS);
}

// Withheld site access is the one failure the popup can repair by itself, and
// asking for a permission needs a user gesture — so it has to be a button
// here, rather than anything the worker could do on its own.
function grantButton() {
  const button = el('button', 'state-action', 'Grant access to claude.ai');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (await chrome.permissions.request({ origins: [CLAUDE_ORIGIN_PATTERN] })) {
        await loadUsage({ force: true });
        return;
      }
    } catch {
      // Chrome will not always prompt from here. The written instructions in
      // the message cover that case.
    }
    button.disabled = false;
  });
  return button;
}

function showState({ icon, title, desc, link, grant }) {
  const wrap = el('div', 'state-msg');
  const glyph = el('div', 'icon', icon);
  glyph.setAttribute('aria-hidden', 'true');
  wrap.append(glyph, el('div', 'title', title));

  if (desc) {
    const description = el('div', 'desc', desc);
    if (link) {
      const anchor = el('a', null, 'Open claude.ai');
      anchor.href = 'https://claude.ai';
      anchor.target = '_blank';
      anchor.rel = 'noreferrer';
      description.append(document.createElement('br'), anchor);
    }
    wrap.append(description);
  }

  if (grant) wrap.append(grantButton());

  replaceContent(wrap);
}

// --- Loading ----------------------------------------------------------------

// The worker owns fetching so the badge and the popup never disagree.
async function requestUsage(force) {
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: 'refresh-usage', force });
  } catch {
    throw new UsageError('UNKNOWN', 'Background worker did not respond.');
  }
  if (!resp) throw new UsageError('UNKNOWN', 'Background worker did not respond.');
  if (!resp.ok) throw new UsageError(resp.code, resp.detail);
  return {
    limits: resp.limits || [],
    extra: resp.extra || null,
    fetchedAt: resp.fetchedAt,
    stale: resp.stale === true
  };
}

function setFreshness(text) {
  footerText.textContent = text ? `Updated ${text}` : 'Data from claude.ai • Local only';
  // Clears any explanation a previous failure left on the footer.
  footerText.title = '';
}

// Rapid clicks used to fire overlapping requests whose results raced.
let inFlight = false;

// `keepVisible` revalidates behind already-rendered cards instead of throwing
// the popup back to a spinner — which is what auto-refresh always wants.
async function loadUsage({ keepVisible = false, force = false } = {}) {
  if (inFlight) return;
  inFlight = true;
  refreshBtn.classList.add('spinning');
  refreshBtn.disabled = true;
  if (!keepVisible) showState({ icon: '⏳', title: 'Loading…' });

  try {
    const { limits, extra, fetchedAt, stale } = await requestUsage(force);
    renderUsage(limits, extra);
    // A stale result means the worker is backing off after failures.
    setFreshness(stale ? `${formatAge(Date.now() - fetchedAt)} — retrying` : 'just now');
  } catch (err) {
    const code = err instanceof UsageError ? err.code : 'UNKNOWN';
    const explained = describeError(code, err?.detail || err?.message);

    // Stale numbers beat an error page, so keep them and say they are stale.
    // The text is set directly: the "Updated" prefix belongs in front of a
    // timestamp, and in front of an error it read as gibberish, as in
    // "Updated connection failed — showing last known".
    //
    // Withheld access is the exception. It is repairable from the full message
    // and nowhere else, since a footer line has no room for a button, so stale
    // numbers are not worth hiding the one available fix behind.
    if (code !== 'NO_ACCESS' && keepVisible && content.querySelector('.cards')) {
      footerText.textContent = `${explained.title} — showing last known data`;
      footerText.title = explained.desc || '';
    } else {
      showState(explained);
    }
  } finally {
    inFlight = false;
    refreshBtn.classList.remove('spinning');
    refreshBtn.disabled = false;
  }
}

refreshBtn.addEventListener('click', () => {
  loadUsage({ keepVisible: Boolean(content.querySelector('.cards')), force: true });
});

async function init() {
  for (const seconds of REFRESH_OPTIONS) {
    const option = el('option', null, seconds ? `${seconds}s` : 'Off');
    option.value = String(seconds);
    intervalSelect.append(option);
  }

  const { usageCache, refreshSeconds } = await chrome.storage.local.get([
    'usageCache',
    'refreshSeconds'
  ]);

  applyInterval(normaliseRefreshSeconds(refreshSeconds));

  if (usageCache?.limits?.length || usageCache?.extra) {
    renderUsage(usageCache.limits || [], usageCache.extra || null);
    setFreshness(formatAge(Date.now() - usageCache.fetchedAt));
    await loadUsage({ keepVisible: true });
    return;
  }

  await loadUsage();
}

init();
