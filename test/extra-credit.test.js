import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toExtraCredit,
  toLimits,
  formatUsd,
  toCreditBalance,
  hasSpendableCredit,
  spendCeiling,
  getStatus
} from '../lib/usage.js';

// Trimmed from a real response. Note spend.balance: the field exists but the
// endpoint leaves it null, and the unused buckets come back as null too.
const REAL_PAYLOAD = {
  five_hour: { utilization: 1, resets_at: '2026-08-01T23:10:00.307270+00:00' },
  seven_day: { utilization: 21, resets_at: '2026-08-08T05:00:00.307294+00:00' },
  seven_day_opus: null,
  tangelo: null,
  omelette_promotional: null,
  extra_usage: {
    is_enabled: true,
    credits_ever_enabled: true,
    currency: 'USD',
    decimal_places: 2,
    monthly_limit: 5000,
    used_credits: 64,
    spend_limit_reached: false,
    utilization: 1.28
  },
  spend: {
    enabled: true,
    balance: null,
    used: { amount_minor: 64, exponent: 2, currency: 'USD' },
    limit: { amount_minor: 5000, exponent: 2, currency: 'USD' },
    cap: { credits: { amount_minor: 5000, exponent: 2 }, money: null },
    percent: 1,
    severity: 'normal'
  },
  member_dashboard_available: false
};

test('reads the real spend shape', () => {
  const extra = toExtraCredit(REAL_PAYLOAD);
  assert.equal(extra.usedCents, 64);
  assert.equal(extra.totalCents, 5000);
  assert.equal(extra.remainingCents, 4936);
  assert.equal(formatUsd(extra.usedCents), '$0.64');
  // A whole amount drops the cents; a fractional one keeps them.
  assert.equal(formatUsd(extra.totalCents), '$50');
  assert.equal(formatUsd(extra.remainingCents), '$49.36');
});

test('the spend and extra_usage buckets are claimed so neither doubles as a limit', () => {
  const extra = toExtraCredit(REAL_PAYLOAD);
  assert.deepEqual(extra.sourceKeys.sort(), ['extra_usage', 'spend']);

  const consumed = new Set(extra.sourceKeys);
  const shown = toLimits(REAL_PAYLOAD)
    .filter((limit) => !consumed.has(limit.key))
    .map((limit) => limit.key);
  assert.deepEqual(shown, ['five_hour', 'seven_day']);
});

// Verbatim from GET /api/organizations/{org}/prepaid/credits.
const REAL_CREDITS = {
  amount: 6036,
  currency: 'USD',
  balance_credits: 60,
  auto_reload_settings: null,
  expiry_policy_months: null,
  last_paid_purchase_cents: null,
  next_expires_at: '2026-09-19T00:00:00Z',
  pending_invoice_amount_cents: null,
  promo_tranches: [
    {
      remaining_amount_minor_units: 6034,
      currency: 'USD',
      expires_at: '2026-09-19T00:00:00Z'
    }
  ],
  tranches: []
};

test('reads the balance and the promotional portion', () => {
  const credit = toCreditBalance(REAL_CREDITS);
  assert.equal(credit.balanceCents, 6036);
  assert.equal(formatUsd(credit.balanceCents), '$60.36');
  assert.equal(credit.promoCents, 6034);
  assert.equal(formatUsd(credit.promoCents), '$60.34');
  assert.equal(credit.promoExpiresAt, '2026-09-19T00:00:00Z');
});

test('sums several promo tranches and reports the soonest expiry', () => {
  const credit = toCreditBalance({
    amount: 3000,
    promo_tranches: [
      { remaining_amount_minor_units: 1000, expires_at: '2026-12-01T00:00:00Z' },
      { remaining_amount_minor_units: 500, expires_at: '2026-09-19T00:00:00Z' }
    ]
  });
  assert.equal(credit.promoCents, 1500);
  assert.equal(credit.promoExpiresAt, '2026-09-19T00:00:00Z');
});

test('a balance with no promotional credit reports none', () => {
  const credit = toCreditBalance({ amount: 2500, promo_tranches: [], tranches: [] });
  assert.equal(credit.balanceCents, 2500);
  assert.equal(credit.promoCents, null);
});

test('an empty balance is not worth a line', () => {
  // An account that has never bought credit reads $0 forever. The parser still
  // reports the zero faithfully; it just is not something to show.
  const credit = toCreditBalance({ amount: 0, promo_tranches: [] });
  assert.equal(credit.balanceCents, 0);
  assert.equal(hasSpendableCredit(credit), false);
  assert.equal(hasSpendableCredit(toCreditBalance(REAL_CREDITS)), true);
  assert.equal(hasSpendableCredit(null), false);
  assert.equal(hasSpendableCredit({ balanceCents: null }), false);
});

test('toCreditBalance tolerates junk', () => {
  assert.equal(toCreditBalance(null), null);
  assert.equal(toCreditBalance({}), null);
  assert.equal(toCreditBalance({ amount: 'nope' }), null);
});

test('a null balance is not invented from the limit', () => {
  // spend.balance is null in every response seen, and cap.credits is a ceiling
  // rather than money held, so no balance is claimed.
  assert.equal(toExtraCredit(REAL_PAYLOAD).balanceCents, null);
});

test('a populated balance is read from spend.balance', () => {
  const extra = toExtraCredit({
    spend: {
      used: { amount_minor: 64, exponent: 2 },
      limit: { amount_minor: 5000, exponent: 2 },
      balance: { amount_minor: 6036, exponent: 2 }
    }
  });
  assert.equal(extra.totalCents, 5000);
  assert.equal(extra.balanceCents, 6036);
});

test('falls back to the extra_usage bucket when spend is absent', () => {
  const extra = toExtraCredit({
    extra_usage: { is_enabled: true, decimal_places: 2, monthly_limit: 5000, used_credits: 64 }
  });
  assert.equal(extra.usedCents, 64);
  assert.equal(extra.totalCents, 5000);
});

test('decimal_places other than 2 still scales correctly', () => {
  const extra = toExtraCredit({
    extra_usage: { is_enabled: true, decimal_places: 3, monthly_limit: 50000, used_credits: 640 }
  });
  assert.equal(extra.usedCents, 64);
  assert.equal(extra.totalCents, 5000);
});

test('usage credits turned off means no card', () => {
  assert.equal(toExtraCredit({ ...REAL_PAYLOAD, spend: { ...REAL_PAYLOAD.spend, enabled: false } }), null);
  assert.equal(
    toExtraCredit({ extra_usage: { is_enabled: false, decimal_places: 2, monthly_limit: 5000, used_credits: 64 } }),
    null
  );
});

test('a reached spend limit is flagged', () => {
  assert.equal(toExtraCredit(REAL_PAYLOAD).limitReached, false);
  const reached = toExtraCredit({
    ...REAL_PAYLOAD,
    spend: { ...REAL_PAYLOAD.spend, spend_limit_reached: true }
  });
  assert.equal(reached.limitReached, true);
});

test('null buckets do not become limit cards', () => {
  // Unused buckets come back as null, including the codenamed ones, so only
  // the two live ones survive once the credit card claims its own.
  const consumed = new Set(toExtraCredit(REAL_PAYLOAD).sourceKeys);
  assert.deepEqual(
    toLimits(REAL_PAYLOAD)
      .filter((limit) => !consumed.has(limit.key))
      .map((limit) => limit.key),
    ['five_hour', 'seven_day']
  );
});

test('the credit you hold binds when it runs out before the monthly limit', () => {
  // The reported case: $48.69 spent, an $80 limit, $12.31 of credit left. The
  // account stops at $61, not $80, and is four fifths of the way there.
  const ceiling = spendCeiling({ usedCents: 4869, totalCents: 8000, balanceCents: 1231 });
  assert.equal(ceiling.boundByCredit, true);
  assert.equal(ceiling.ceilingCents, 6100);
  assert.equal(ceiling.limitCents, 8000);
  assert.equal(Math.round(ceiling.utilization), 80);
  // Against the unreachable limit it read 61%, and calm rather than close.
  assert.equal(Math.round((4869 / 8000) * 100), 61);
  assert.equal(getStatus(ceiling.utilization), 'high');
  assert.equal(getStatus(60.9), 'mid');
});

test('the monthly limit binds when the credit covers it', () => {
  // The usual way round, so the card is unchanged for most accounts.
  const ceiling = spendCeiling({ usedCents: 64, totalCents: 5000, balanceCents: 6036 });
  assert.equal(ceiling.boundByCredit, false);
  assert.equal(ceiling.ceilingCents, 5000);
  assert.equal(Math.round(ceiling.utilization), 1);
});

test('with no balance known the limit is the only ceiling there is', () => {
  const ceiling = spendCeiling(toExtraCredit(REAL_PAYLOAD));
  assert.equal(ceiling.boundByCredit, false);
  assert.equal(ceiling.ceilingCents, 5000);
  assert.equal(ceiling.utilization, toExtraCredit(REAL_PAYLOAD).utilization);
});

test('credit exactly covering the limit does not take it over', () => {
  const ceiling = spendCeiling({ usedCents: 2000, totalCents: 5000, balanceCents: 3000 });
  assert.equal(ceiling.boundByCredit, false);
  assert.equal(ceiling.ceilingCents, 5000);
});

test('spendCeiling has nothing to measure without spend', () => {
  assert.equal(spendCeiling(null), null);
  assert.equal(spendCeiling({ balanceCents: 1231 }), null);
  assert.equal(spendCeiling({ usedCents: 100, totalCents: 0 }), null);
});

test('a non-cent exponent still converts correctly', () => {
  // exponent 0 means whole dollars, exponent 3 means thousandths.
  assert.equal(toExtraCredit({ spend: { used: { amount_minor: 7, exponent: 0 }, limit: { amount_minor: 50, exponent: 0 } } }).usedCents, 700);
  assert.equal(toExtraCredit({ spend: { used: { amount_minor: 6400, exponent: 3 }, limit: { amount_minor: 50000, exponent: 3 } } }).usedCents, 640);
});

test('spend falls back to the credits cap when there is no limit', () => {
  const extra = toExtraCredit({
    spend: { used: { amount_minor: 100, exponent: 2 }, cap: { credits: { amount_minor: 2500, exponent: 2 } } }
  });
  assert.equal(extra.totalCents, 2500);
});

test('an account with no extra usage gets no card', () => {
  assert.equal(toExtraCredit({ five_hour: { utilization: 10 }, spend: {} }), null);
  assert.equal(
    toExtraCredit({ spend: { used: { amount_minor: 0, exponent: 2 }, limit: { amount_minor: 0, exponent: 2 } } }),
    null
  );
});
