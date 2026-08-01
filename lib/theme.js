// Theme resolution.
//
// The system setting wins by default. A manual toggle sticks, but only until
// the system setting itself moves — at that point the override is dropped and
// we go back to following the system.

export function systemThemeFrom(prefersDark) {
  return prefersDark ? 'dark' : 'light';
}

export function resolveTheme(systemTheme, override) {
  if (override && override.theme && override.system === systemTheme) {
    return { theme: override.theme, override, following: false };
  }
  return { theme: systemTheme, override: null, following: true };
}

// Picking the theme the system already gives us is just following it again,
// so there is nothing to remember.
export function buildOverride(theme, systemTheme) {
  if (theme === systemTheme) return null;
  return { theme, system: systemTheme };
}
