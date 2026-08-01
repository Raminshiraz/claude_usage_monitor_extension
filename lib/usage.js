// Shared usage helpers. Imported by the popup and the background worker, so
// nothing here may touch the DOM.

const ORIGIN = 'https://claude.ai';
const API_BASE = `${ORIGIN}/api`;
const REQUEST_TIMEOUT_MS = 10000;

// Known limit buckets, in the order we want to show them. Anything the API
// starts returning that is not listed here still gets rendered, just after
// these and with a label derived from the key.
export const LIMIT_LABELS = {
  five_hour: '5-Hour Session',
  seven_day: 'Weekly Usage',
  seven_day_opus: 'Weekly Opus',
  seven_day_sonnet: 'Weekly Sonnet',
  seven_day_cowork: 'Weekly Cowork',
  seven_day_oauth_apps: 'OAuth Apps'
};

const KNOWN_KEYS = Object.keys(LIMIT_LABELS);

// The bucket the toolbar badge always tracks.
export const BADGE_LIMIT_KEY = 'five_hour';

// Auto-refresh choices, in seconds. 0 is off.
export const REFRESH_OPTIONS = [5, 10, 20, 60, 0];
export const DEFAULT_REFRESH_SECONDS = 10;

export function normaliseRefreshSeconds(value) {
  const seconds = Number(value);
  return REFRESH_OPTIONS.includes(seconds) ? seconds : DEFAULT_REFRESH_SECONDS;
}

// Error codes the UI knows how to explain. Anything else surfaces as UNKNOWN.
export class UsageError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.name = 'UsageError';
    this.code = code;
    this.detail = detail || '';
  }
}

function labelFor(key) {
  if (LIMIT_LABELS[key]) return LIMIT_LABELS[key];
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

async function apiGet(path) {
  let resp;
  try {
    resp = await fetch(`${API_BASE}${path}`, {
      method: 'GET',
      credentials: 'include',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        'anthropic-client-platform': 'web_claude_ai'
      }
    });
  } catch (err) {
    // A hung request used to leave the popup spinning forever.
    throw new UsageError(err?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK');
  }

  if (resp.status === 401 || resp.status === 403) throw new UsageError('AUTH');
  if (!resp.ok) throw new UsageError('HTTP', `HTTP ${resp.status}`);

  try {
    return await resp.json();
  } catch {
    throw new UsageError('BAD_RESPONSE');
  }
}

// The cookie is the most accurate source for people in several orgs, but it is
// not always set yet on a fresh session, so fall back to asking the API.
export async function getOrgId() {
  let cookie = null;
  try {
    cookie = await chrome.cookies.get({ url: 'https://claude.ai', name: 'lastActiveOrg' });
  } catch {
    cookie = null;
  }
  if (cookie?.value) return cookie.value;

  const orgs = await apiGet('/organizations');
  const uuid = Array.isArray(orgs) ? orgs[0]?.uuid : null;
  if (!uuid) throw new UsageError('NO_ORG');
  return uuid;
}

export function fetchUsage(orgId) {
  return apiGet(`/organizations/${encodeURIComponent(orgId)}/usage`);
}

// The credit balance is not on the usage endpoint — spend.balance there is
// always null. It lives here, in plain cents:
//
//   amount                                   total balance
//   promo_tranches[].remaining_amount_minor_units   promotional portion
//   promo_tranches[].expires_at                     when that portion lapses
export function fetchCredits(orgId) {
  return apiGet(`/organizations/${encodeURIComponent(orgId)}/prepaid/credits`);
}

function readCents(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

export function toCreditBalance(data) {
  if (!data || typeof data !== 'object') return null;

  const balanceCents = readCents(data.amount);
  if (balanceCents == null) return null;

  let promoCents = 0;
  let promoExpiresAt = null;
  for (const tranche of Array.isArray(data.promo_tranches) ? data.promo_tranches : []) {
    const amount = readCents(tranche?.remaining_amount_minor_units);
    if (amount == null) continue;
    promoCents += amount;
    // Soonest expiry is the one worth warning about.
    const expires = typeof tranche?.expires_at === 'string' ? tranche.expires_at : null;
    if (expires && (promoExpiresAt == null || expires < promoExpiresAt)) promoExpiresAt = expires;
  }

  return {
    balanceCents,
    promoCents: promoCents > 0 ? promoCents : null,
    promoExpiresAt:
      promoExpiresAt ?? (typeof data.next_expires_at === 'string' ? data.next_expires_at : null)
  };
}

// Turns the raw payload into an ordered list, dropping entries without a
// usable number so a partial response still renders what it can.
export function toLimits(data) {
  if (!data || typeof data !== 'object') return [];

  const keys = Object.keys(data);
  const ordered = [
    ...KNOWN_KEYS.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !KNOWN_KEYS.includes(k)).sort()
  ];

  const limits = [];
  for (const key of ordered) {
    const entry = data[key];
    if (!entry || typeof entry !== 'object') continue;
    // Deliberately not Number(): that turns a null utilization into 0, which
    // reads as "no usage" when we actually know nothing.
    const raw = entry.utilization;
    const utilization = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isFinite(utilization)) continue;
    limits.push({
      key,
      label: labelFor(key),
      utilization,
      resetsAt: typeof entry.resets_at === 'string' ? entry.resets_at : null
    });
  }
  return limits;
}

// --- Extra usage credit -----------------------------------------------------
//
// Extra usage is a prepaid dollar balance that only some accounts have. It
// comes back on the usage endpoint under `spend`:
//
//   spend.used   = { amount_minor: 64,   exponent: 2 }   ->  $0.64
//   spend.limit  = { amount_minor: 5000, exponent: 2 }   -> $50.00
//   spend.cap.credits = { ... }                          -> fallback for limit
//
// Accounts without extra usage have no usable `spend`, and get no card. The
// looser search further down stays as a fallback for layouts we have not seen.

// Money arrives as amount_minor / 10^exponent, so exponent 2 means cents.
function minorToCents(money) {
  if (!money || typeof money !== 'object') return null;
  const minor = Number(money.amount_minor);
  if (!Number.isFinite(minor)) return null;
  const exponent = Number(money.exponent);
  return Math.round(minor * 10 ** (2 - (Number.isFinite(exponent) ? exponent : 2)));
}

// The real schema, as returned by the endpoint:
//
//   spend.used        spent so far
//   spend.limit       the monthly spend limit you set
//   spend.cap.credits the ceiling credits impose (falls back for limit)
//   spend.balance     the credit you hold — present in the schema but null in
//                     every response seen so far, so it is read when populated
//                     and simply not shown when it is not
//
// extra_usage carries the same figures as plain numbers scaled by
// decimal_places, and is used when spend is missing.
function scaledToCents(value, decimalPlaces) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  const places = Number(decimalPlaces);
  return Math.round(amount * 10 ** (2 - (Number.isFinite(places) ? places : 2)));
}

function readSpend(data) {
  const spend = data.spend;
  const bucket = data.extra_usage;

  // Turned off, or never turned on.
  if (spend?.enabled === false || bucket?.is_enabled === false) return null;

  const sourceKeys = [];
  if (spend) sourceKeys.push('spend');
  if (bucket) sourceKeys.push('extra_usage');

  const usedCents =
    minorToCents(spend?.used) ?? scaledToCents(bucket?.used_credits, bucket?.decimal_places);
  const totalCents =
    minorToCents(spend?.limit) ??
    minorToCents(spend?.cap?.credits) ??
    scaledToCents(bucket?.monthly_limit, bucket?.decimal_places);

  if (usedCents == null || totalCents == null || totalCents <= 0) return null;

  const balanceCents = minorToCents(spend?.balance);

  return {
    usedCents,
    totalCents,
    remainingCents: totalCents - usedCents,
    balanceCents,
    limitReached: spend?.spend_limit_reached === true || bucket?.spend_limit_reached === true,
    // Derived from the amounts rather than spend.percent so the bar and the
    // dollars can never disagree.
    utilization: (usedCents / totalCents) * 100,
    sourceKeys
  };
}


export function toExtraCredit(data) {
  if (!data || typeof data !== 'object') return null;
  return readSpend(data);
}

// Formatted explicitly rather than via currency localisation, which renders
// "US$20.80" outside en-US. Whole amounts drop the cents: $50, not $50.00.
export function formatUsd(cents) {
  if (cents == null || !Number.isFinite(cents)) return '';
  const dollars = cents / 100;
  const amount = Math.abs(dollars).toLocaleString('en-US', {
    minimumFractionDigits: Math.abs(cents) % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2
  });
  return `${dollars < 0 ? '-' : ''}$${amount}`;
}

export async function loadSnapshot() {
  const orgId = await getOrgId();

  // The balance is a second request. It must never take the rest down: plenty
  // of accounts have no prepaid credit and this 404s for them.
  const [raw, credit] = await Promise.all([
    fetchUsage(orgId),
    fetchCredits(orgId).then(toCreditBalance, () => null)
  ]);

  let extra = toExtraCredit(raw);
  if (credit) {
    // A balance with no spend limit configured is still worth showing on its
    // own; buildExtraCard renders it without a bar.
    extra = extra
      ? { ...extra, ...credit }
      : { usedCents: null, totalCents: null, remainingCents: null, utilization: null, sourceKeys: [], ...credit };
  }
  // Whatever the credit card is built from must not also appear as a plain
  // limit card, or "Extra Usage" shows up twice.
  const consumed = new Set(extra?.sourceKeys || []);
  const limits = toLimits(raw).filter((limit) => !consumed.has(limit.key));
  return { limits, extra, raw };
}

export function peakUtilization(limits) {
  return limits.reduce((max, limit) => Math.max(max, limit.utilization), 0);
}

export function getStatus(utilization) {
  if (utilization >= 95) return 'crit';
  if (utilization >= 75) return 'high';
  if (utilization >= 50) return 'mid';
  return 'low';
}

export function formatCountdown(resetIso, now = Date.now()) {
  if (!resetIso) return '';
  const reset = new Date(resetIso).getTime();
  if (!Number.isFinite(reset)) return '';

  let diff = reset - now;
  if (diff <= 0) return 'Resetting soon…';

  const days = Math.floor(diff / 86400000);
  diff %= 86400000;
  const hrs = Math.floor(diff / 3600000);
  diff %= 3600000;
  const mins = Math.floor(diff / 60000);

  if (days > 0) return `Resets in ${days}d ${hrs}h`;
  if (hrs > 0) return `Resets in ${hrs}h ${mins}m`;
  if (mins > 0) return `Resets in ${mins}m`;
  return 'Resets in under a minute';
}

export function formatDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatResetTime(resetIso) {
  if (!resetIso) return '';
  const reset = new Date(resetIso);
  if (Number.isNaN(reset.getTime())) return '';
  return reset.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

export function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function describeError(code, detail) {
  switch (code) {
    case 'AUTH':
    case 'NO_ORG':
      return {
        icon: '🔒',
        title: 'Not logged in',
        desc: 'Log in to claude.ai in this browser, then refresh.',
        link: true
      };
    case 'TIMEOUT':
      return { icon: '⏱️', title: 'Request timed out', desc: 'claude.ai took too long to respond. Try again.' };
    case 'NETWORK':
      return { icon: '📡', title: 'Connection failed', desc: 'Could not reach claude.ai. Check your connection.' };
    case 'BAD_RESPONSE':
      return { icon: '⚠️', title: 'Unexpected response', desc: 'claude.ai returned data we could not read.' };
    case 'NO_LIMITS':
      return { icon: '📭', title: 'No limits reported', desc: 'Your account returned no usage buckets. The API may have changed.' };
    default:
      return { icon: '⚠️', title: 'Something went wrong', desc: detail || 'Click refresh to try again.' };
  }
}
