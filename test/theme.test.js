import test from 'node:test';
import assert from 'node:assert/strict';

import { systemThemeFrom, resolveTheme, buildOverride } from '../lib/theme.js';

test('systemThemeFrom maps the media query result', () => {
  assert.equal(systemThemeFrom(true), 'dark');
  assert.equal(systemThemeFrom(false), 'light');
});

test('with no override the system theme wins', () => {
  assert.deepEqual(resolveTheme('dark', null), { theme: 'dark', override: null, following: true });
  assert.deepEqual(resolveTheme('light', undefined), { theme: 'light', override: null, following: true });
});

test('an override sticks while the system stays put', () => {
  const override = buildOverride('light', 'dark');
  const resolved = resolveTheme('dark', override);
  assert.equal(resolved.theme, 'light');
  assert.equal(resolved.following, false);
});

test('the override is dropped once the system itself changes', () => {
  const override = buildOverride('light', 'dark');
  // The machine switched to light, so the manual choice has done its job.
  const resolved = resolveTheme('light', override);
  assert.deepEqual(resolved, { theme: 'light', override: null, following: true });

  // And it stays dropped when the machine later goes back to dark.
  assert.equal(resolveTheme('dark', resolved.override).theme, 'dark');
});

test('choosing the theme the system already gives is just following it', () => {
  assert.equal(buildOverride('dark', 'dark'), null);
  assert.deepEqual(buildOverride('dark', 'light'), { theme: 'dark', system: 'light' });
});

test('a malformed override falls back to the system theme', () => {
  assert.equal(resolveTheme('dark', {}).theme, 'dark');
  assert.equal(resolveTheme('dark', { system: 'dark' }).theme, 'dark');
});
