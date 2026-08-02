import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyResponse,
  retryAfterMs,
  creditsCacheIsFresh,
  describeError,
  hasHostAccess,
  storageGet,
  storageSet
} from '../lib/usage.js';

// Enough of a Response for the classifier, which only reads status and headers.
function response(status, headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: new Headers(headers) };
}

test('a good response is not an error', () => {
  assert.equal(classifyResponse(response(200)), null);
});

test('401 and a JSON 403 are a real auth failure', () => {
  assert.equal(classifyResponse(response(401)).code, 'AUTH');
  assert.equal(classifyResponse(response(403, { 'content-type': 'application/json' })).code, 'AUTH');
});

test('a Cloudflare challenge is not reported as being logged out', () => {
  // Telling someone to log in again does nothing for a challenged request, and
  // the session it blames is usually perfectly good.
  assert.equal(classifyResponse(response(403, { 'cf-mitigated': 'challenge' })).code, 'BLOCKED');
  assert.equal(classifyResponse(response(403, { 'content-type': 'text/html' })).code, 'BLOCKED');
  assert.equal(
    classifyResponse(response(503, { 'cf-mitigated': 'challenge' })).code,
    'RATE_LIMIT',
    'a status that says "slow down" wins, so we wait rather than nag'
  );
});

test('429 and 503 carry the delay the server asked for', () => {
  const limited = classifyResponse(response(429, { 'retry-after': '90' }));
  assert.equal(limited.code, 'RATE_LIMIT');
  assert.equal(limited.retryAfterMs, 90000);
  assert.equal(classifyResponse(response(503)).code, 'RATE_LIMIT');
});

test('other failures keep their status for the caller to read', () => {
  const missing = classifyResponse(response(404));
  assert.equal(missing.code, 'HTTP');
  assert.equal(missing.status, 404);
  assert.equal(missing.detail, 'HTTP 404');
  assert.equal(classifyResponse(response(500)).code, 'HTTP');
});

test('retryAfterMs reads both header forms', () => {
  const now = Date.parse('2026-08-01T00:00:00Z');
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '30' }), now), 30000);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '0' }), now), 0);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': 'Sat, 01 Aug 2026 00:02:00 GMT' }), now), 120000);
  // A date already in the past means go now, not go negative.
  assert.equal(retryAfterMs(new Headers({ 'retry-after': 'Sat, 01 Aug 2026 00:00:00 GMT' }), now + 5000), 0);
  assert.equal(retryAfterMs(new Headers(), now), null);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': 'soonish' }), now), null);
  assert.equal(retryAfterMs(undefined, now), null);
});

test('a failed credits lookup is cached, so it does not repeat every tick', () => {
  const now = Date.parse('2026-08-01T00:00:00Z');
  const minutes = (n) => now + n * 60000;

  // Never fetched: go and fetch it.
  assert.equal(creditsCacheIsFresh(undefined, now), false);
  assert.equal(creditsCacheIsFresh({ at: 0, ok: true, value: null }, now), false);

  // A good reading is reused for five minutes.
  const ok = { at: now, ok: true, value: { balanceCents: 100 } };
  assert.equal(creditsCacheIsFresh(ok, minutes(4)), true);
  assert.equal(creditsCacheIsFresh(ok, minutes(6)), false);

  // A blip is retried a minute later rather than on the very next refresh.
  const blip = { at: now, ok: false, missing: false, value: null };
  assert.equal(creditsCacheIsFresh(blip, now + 30000), true);
  assert.equal(creditsCacheIsFresh(blip, minutes(2)), false);

  // A 404 means this account has no prepaid credit at all. Asking again every
  // thirty seconds forever is what doubled the request rate.
  const none = { at: now, ok: false, missing: true, value: null };
  assert.equal(creditsCacheIsFresh(none, minutes(60)), true);
  assert.equal(creditsCacheIsFresh(none, now + 25 * 3600000), false);
});

test('the new codes have wording of their own', () => {
  assert.equal(describeError('BLOCKED').title, 'Request was challenged');
  assert.equal(describeError('BLOCKED').link, true);
  assert.equal(describeError('RATE_LIMIT').title, 'Asked to slow down');
  // Distinct from the auth wording, which is the whole point of splitting them.
  assert.notEqual(describeError('BLOCKED').title, describeError('AUTH').title);
});

test('withheld site access is its own fault, with its own fix', () => {
  const denied = describeError('NO_ACCESS');

  // The failure this was written for: Chrome refusing the request at the CORS
  // check reads as "Failed to fetch", so it was reported as a dead connection
  // and sent people to check a network that was working. Never alike again.
  assert.notEqual(denied.title, describeError('NETWORK').title);
  assert.match(denied.desc, /chrome:\/\/extensions/);

  // The popup renders its permission button off this flag; losing it turns the
  // one repairable failure back into a dead end.
  assert.equal(denied.grant, true);
  assert.ok(!describeError('NETWORK').grant);
});

test('host access is assumed where the permissions API is absent', async () => {
  // The tests, and any other non-extension context: report access rather than
  // invent a permission failure that cannot be true there.
  assert.equal(await hasHostAccess(), true);
});

test('storage helpers are inert where chrome is not', async () => {
  // Both are called from code the popup, the worker and the tests all run.
  assert.equal(await storageGet('local', 'anything'), undefined);
  await storageSet('local', 'anything', 1);
});
