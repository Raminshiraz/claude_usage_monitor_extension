# Changelog

## 3.1.0

### Changed

- Auto-refresh is 30s, 60s or off, defaulting to 30s. The shorter intervals were removed: Chrome will not fire a background alarm more often than every 30 seconds, so they refreshed the open popup while leaving the badge no fresher, at several times the request volume. Both remaining options map exactly onto a real alarm period, so the popup and the badge now refresh at the same rate. A stored 5, 10 or 20 migrates itself to 30
- The credit balance is fetched at most every five minutes and reused in between. Requesting it on every tick alongside usage doubled the traffic for a figure that barely moves, which is what turned a short interval into connection failures

### Added

- A dropped connection retries once, so a single blip does not replace good numbers with an error
- Repeated failures back off from 5 seconds up to 2 minutes, handing back the last good reading rather than an error, so the popup keeps showing numbers while it recovers. The refresh button ignores the backoff
- The validator resolves named imports, catching a missing export at build time instead of as a worker that silently fails to start

## 3.0.0

A rewrite of everything above the icons. Versions 1.1 through 2.0 were cut while
reverse-engineering an undocumented API and bumped far more often than the
changes warranted; they are folded in here.

### Added

- **Toolbar badge** showing 5-hour session usage, colour-coded by threshold, so usage is visible without opening anything
- **Auto-refresh** every 10 seconds by default, selectable as 5s, 20s, 60s or off from the popup footer
- **Usage credits** — spend against your monthly limit, plus the credit balance and the promotional portion with its expiry date
- **Alerts** at 80% and 95%, once per limit per reset window, with a bell toggle
- **Follows the system theme.** A manual toggle sticks until the OS itself switches, then goes back to following it. An OS switch while the popup is open is picked up live
- Cached readings, so the popup opens with numbers instead of a spinner and revalidates behind them
- Live countdowns with the exact reset time on hover
- Screen reader labels on the usage bars and controls
- Unit tests, a manifest validator, a packaging script and a CI workflow — all dependency-free

### Changed

- Fetching moved into a background service worker, so the badge and the popup can never disagree
- Every limit the API returns is rendered, not six hardcoded ones
- Requests time out after 10 seconds instead of hanging
- The org ID falls back to the organizations API when the `lastActiveOrg` cookie is missing
- Money is formatted explicitly: `$50` rather than `$50.00`, but `$60.36` keeps its cents

### Fixed

- Threshold colours did nothing — all four levels resolved to the same colour
- A null utilization rendered as 0%, so an unknown limit read as unused
- The light theme flashed dark on every open, and a script error could leave the popup permanently blank
- Overlapping refreshes raced; an empty response showed a blank panel
- The spend limit was labelled as a balance. They are different numbers, and the balance is usually larger

## 1.0.0

- Initial release
