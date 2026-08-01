import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toLimits,
  peakUtilization,
  getStatus,
  formatCountdown,
  formatAge,
  formatUsd,
  formatDate,
  describeError,
  normaliseRefreshSeconds,
  REFRESH_OPTIONS,
  DEFAULT_REFRESH_SECONDS
} from '../lib/usage.js';

test('formatUsd shows cents only when there are any', () => {
  assert.equal(formatUsd(5000), '$50');
  assert.equal(formatUsd(6036), '$60.36');
  assert.equal(formatUsd(64), '$0.64');
  assert.equal(formatUsd(0), '$0');
  assert.equal(formatUsd(123456), '$1,234.56');
  assert.equal(formatUsd(120000), '$1,200');
  assert.equal(formatUsd(-500), '-$5');
  assert.equal(formatUsd(null), '');
});

test('formatDate renders an expiry as a plain date', () => {
  assert.equal(formatDate(null), '');
  assert.equal(formatDate('not a date'), '');
  assert.match(formatDate('2026-09-19T00:00:00Z'), /2026/);
});

test('normaliseRefreshSeconds only accepts the offered intervals', () => {
  for (const seconds of REFRESH_OPTIONS) {
    assert.equal(normaliseRefreshSeconds(seconds), seconds);
    assert.equal(normaliseRefreshSeconds(String(seconds)), seconds);
  }
  assert.equal(normaliseRefreshSeconds(0), 0, 'off must survive normalisation');
  // Anything else falls back rather than polling at some arbitrary rate.
  assert.equal(normaliseRefreshSeconds(7), DEFAULT_REFRESH_SECONDS);
  assert.equal(normaliseRefreshSeconds('abc'), DEFAULT_REFRESH_SECONDS);
  assert.equal(normaliseRefreshSeconds(undefined), DEFAULT_REFRESH_SECONDS);
  // Anyone carrying a stored 5, 10 or 20 from the old options migrates itself.
  for (const retired of [5, 10, 20]) {
    assert.equal(normaliseRefreshSeconds(retired), DEFAULT_REFRESH_SECONDS);
  }
});

test('every refresh option maps onto a real alarm period', () => {
  // Chrome will not fire an alarm more often than every 30 seconds, so no
  // option may need clamping — otherwise the badge silently ignores the choice.
  for (const seconds of REFRESH_OPTIONS.filter(Boolean)) {
    assert.equal(Math.max(0.5, seconds / 60), seconds / 60, `${seconds}s must not clamp`);
  }
});

test('toLimits keeps known buckets in display order', () => {
  const limits = toLimits({
    seven_day_opus: { utilization: 10 },
    five_hour: { utilization: 20 },
    seven_day: { utilization: 30 }
  });
  assert.deepEqual(
    limits.map((l) => l.key),
    ['five_hour', 'seven_day', 'seven_day_opus']
  );
  assert.equal(limits[0].label, '5-Hour Session');
});

test('toLimits renders unknown buckets after known ones with a derived label', () => {
  const limits = toLimits({
    five_hour: { utilization: 1 },
    thirty_day_haiku: { utilization: 2 }
  });
  assert.deepEqual(
    limits.map((l) => l.key),
    ['five_hour', 'thirty_day_haiku']
  );
  assert.equal(limits[1].label, 'Thirty Day Haiku');
});

test('toLimits drops entries without a usable number', () => {
  const limits = toLimits({
    five_hour: { utilization: 42 },
    seven_day: { utilization: null },
    seven_day_opus: 'nope',
    seven_day_sonnet: { utilization: 'abc' }
  });
  assert.deepEqual(
    limits.map((l) => l.key),
    ['five_hour']
  );
});

test('toLimits tolerates junk payloads', () => {
  assert.deepEqual(toLimits(null), []);
  assert.deepEqual(toLimits(undefined), []);
  assert.deepEqual(toLimits('nope'), []);
  assert.deepEqual(toLimits({}), []);
});

test('toLimits only keeps string reset timestamps', () => {
  const [withReset, withoutReset] = toLimits({
    five_hour: { utilization: 1, resets_at: '2026-08-01T00:00:00Z' },
    seven_day: { utilization: 2, resets_at: 12345 }
  });
  assert.equal(withReset.resetsAt, '2026-08-01T00:00:00Z');
  assert.equal(withoutReset.resetsAt, null);
});

test('peakUtilization returns the tightest limit', () => {
  assert.equal(peakUtilization(toLimits({ five_hour: { utilization: 12 }, seven_day: { utilization: 88 } })), 88);
  assert.equal(peakUtilization([]), 0);
});

test('getStatus maps each threshold band', () => {
  assert.equal(getStatus(0), 'low');
  assert.equal(getStatus(49.9), 'low');
  assert.equal(getStatus(50), 'mid');
  assert.equal(getStatus(74.9), 'mid');
  assert.equal(getStatus(75), 'high');
  assert.equal(getStatus(94.9), 'high');
  assert.equal(getStatus(95), 'crit');
  assert.equal(getStatus(120), 'crit');
});

test('formatCountdown picks the coarsest useful unit', () => {
  const now = Date.parse('2026-08-01T00:00:00Z');
  const at = (ms) => formatCountdown(new Date(now + ms).toISOString(), now);

  assert.equal(at(3 * 86400000 + 4 * 3600000), 'Resets in 3d 4h');
  assert.equal(at(5 * 3600000 + 30 * 60000), 'Resets in 5h 30m');
  assert.equal(at(12 * 60000), 'Resets in 12m');
  assert.equal(at(30000), 'Resets in under a minute');
});

test('formatCountdown handles elapsed and missing timestamps', () => {
  const now = Date.parse('2026-08-01T00:00:00Z');
  assert.equal(formatCountdown(new Date(now - 1000).toISOString(), now), 'Resetting soon…');
  assert.equal(formatCountdown(null, now), '');
  assert.equal(formatCountdown('not a date', now), '');
});

test('formatAge describes cache freshness', () => {
  assert.equal(formatAge(0), 'just now');
  assert.equal(formatAge(45 * 1000), 'just now');
  assert.equal(formatAge(5 * 60000), '5m ago');
  assert.equal(formatAge(3 * 3600000), '3h ago');
  assert.equal(formatAge(2 * 86400000), '2d ago');
  assert.equal(formatAge(-1), '');
});

test('describeError explains known codes and falls back for others', () => {
  assert.equal(describeError('AUTH').title, 'Not logged in');
  assert.equal(describeError('TIMEOUT').title, 'Request timed out');
  assert.equal(describeError('NO_LIMITS').title, 'No limits reported');
  assert.equal(describeError('UNKNOWN', 'HTTP 500').desc, 'HTTP 500');
});
