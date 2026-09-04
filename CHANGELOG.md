# Changelog

## 3.1.4

The countdown said how long was left but never when it ends, so anyone
planning around a reset had to do the arithmetic themselves.

### Changed

- **The reset line leads with the time the reset happens.** "Resets in 2h 22m" now reads "Resets at 10:34 PM (2h 22m)": the wall-clock time first, the countdown kept in brackets for the glance. A limit a day or more out names the day it lands on — "Resets on Sun 10:34 PM (3 days)" — since the time alone would not say which one. Under a day it drops the weekday and matches the session line exactly, so the two read the same way when they mean the same thing. The clock follows the reader's locale, so a 24-hour clock stays a 24-hour clock, and the hover tooltip still carries the full date

## 3.1.3

Three things on the card were taking up space without answering anything: a
limit named after a model that has not been announced, a balance of nothing,
and a percentage measured against a ceiling the account cannot reach.

### Fixed

- **A codenamed bucket appeared as a card and never moved again.** The usage API ships buckets for models and promotions before they are announced — `tangelo`, `omelette_promotional`, `nimbus_quill` — normally as null, which was dropped, but an account enrolled in one gets a live entry sitting at zero instead. That rendered as a card named after something the reader has never heard of, reporting no usage, permanent and impossible to dismiss. An unrecognised bucket now has to carry usage to appear at all. A bucket we can name still shows at 0%, because a quiet weekly limit is a real reading about a limit you know you have
- **A credit balance of $0 was reported as though it were news.** Every account that has never bought prepaid credit holds exactly $0 and always will, so the line never changed and never said anything. With no monthly spend limit either, that empty line was the entire card: "Usage Credits — $0 — Current balance", forever
- **Spend was measured against the monthly limit even when the credit ran out first.** The limit is a ceiling you set; the balance is the money that pays for the spend underneath it, and the two are set independently. With $48.69 spent, an $80 limit and $12.31 of credit left, the card read "61% used" in a calm colour and offered a ceiling the account stops $19 short of — while it was in fact four fifths of the way to a stop, and the two figures on the card implied different amounts of headroom. The bar, the percentage and its colour now follow whichever of the two runs out first, the note names that ceiling, and a second line says the monthly limit is above the credit when it is no longer what sets the pace. Where the balance comfortably covers the limit, which is the usual way round, nothing changes

## 3.1.2

The "Connection failed" that came back on every browser restart, and cleared
only after claude.ai was opened in a tab, was never a network fault. Chrome
exempts an extension's requests from CORS only while the host permission is
actually held, and declaring it in the manifest is not the same as holding it:
with site access narrowed to "on click", every call to claude.ai is treated as
an ordinary cross-origin request from `chrome-extension://…`, preflighted, and
refused for want of an `Access-Control-Allow-Origin` header. The request never
left the browser. Opening the site in a tab is what granted the access back.

`fetch` reports all of that as `Failed to fetch` — the same string it uses for
an unplugged cable — which is why it read as a connection problem and sent
people to check the one thing that was working.

### Fixed

- **Withheld site access is identified and repairable.** A transport failure now rules out the host permission before blaming anything else, since nothing can succeed without it, and says "Site access is switched off" with a button that asks for it back
- Granting the permission refreshes immediately, by either route — the button, or Site access in `chrome://extensions`, which the popup never hears about. Granting it is the exact event that unblocks the requests, so there is nothing left to wait for and the badge no longer stays wrong until the next alarm
- **A failure during backoff with nothing cached was always reported as "Connection failed"**, whatever had actually gone wrong, so a withheld permission or an expired login spent the entire backoff window mislabelled and pointing at the wrong fix. The real failure is remembered and reported
- The footer read "Updated connection failed — showing last known", which is a timestamp prefix fused onto an error message. A failed revalidation now reads "Connection failed — showing last known data"

### Changed

- `content-type: application/json` is no longer sent on GETs. A GET has no body to describe and the header is not on the CORS safelist, so it escalated every request into a preflighted one for nothing
- The origin probe added in 3.1.1 is gone. It was meant to tell a dead connection from a refused request, but a CORS refusal blocks the probe in exactly the same way, so it answered "origin unreachable" for an origin it had never actually asked

## 3.1.1

Everything that was supposed to keep this extension from hammering claude.ai
was held in a variable inside the service worker. Chrome shuts an idle worker
down after about thirty seconds, so all of it was reset before the next alarm
ever read it. None of it had been working.

### Fixed

- **The backoff never engaged.** The failure counter and the deadline it sets lived in worker memory, which is discarded between alarms, so every tick started again from zero failures and went straight out to the network. A browser that came up before its network did was answered with a full-rate stream of failing requests until something recovered. Both now live in session storage, which outlives the worker and is cleared on browser restart
- **The five-minute credit cache never applied either**, for the same reason, so the balance was refetched on every single tick — the doubled traffic 3.1.0 set out to remove. It is now cached in local storage
- **A failed credit lookup was not remembered at all.** Accounts with no prepaid credit 404 there, and an uncached failure comes straight back on the next refresh, so the endpoint most likely to fail was the one being called most often, forever. Failures are cached too: a 404 for a day, since it means this account has no prepaid credit, and a blip for a minute
- **A Cloudflare challenge was reported as "Not logged in"**, sending people off to re-authenticate a session that was fine. Challenged requests are now identified by their `cf-mitigated` header or HTML body and say what actually clears them, which is loading claude.ai itself
- **Every dropped connection produced the same bare "Connection failed"** — the underlying reason was thrown away at the point of failure, leaving nothing to diagnose from. It is now kept on the error and logged by the worker
- With auto-refresh switched off there was no periodic alarm, so a failed refresh left the badge showing an error until the popup was next opened by hand. A failure now books its own retry

### Changed

- Only the usage request retries a dropped connection. Retrying all three doubled the traffic during exactly the outage that caused it
- `429` and `503` are recognised, and the `Retry-After` the server sends is honoured over the extension's own backoff
- A transport failure now probes the origin for a static file before it is logged. `fetch` reports DNS not being up, a connection that cannot be established, and an edge refusing one particular request all as the same bare "Failed to fetch", and telling those apart is the difference between a fault worth fixing here and one that is not

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
