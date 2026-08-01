# Claude Usage Monitor — Browser Extension

A minimal browser extension that shows your Claude.ai usage limits at a glance — session window, weekly caps per model — all using your existing browser session.

![Claude Usage Monitor](screenshot.png)

## Features

- **Toolbar badge** — Your 5-hour session usage is always visible, colour-coded, without opening anything
- **Auto-refresh** — Every 10 seconds by default; selectable as 5s, 20s, 60s or off
- **5-Hour Session** — Rolling window utilization with a live countdown to reset
- **Weekly Usage** — Weekly limits broken down by model (Opus, Sonnet, Cowork, OAuth Apps)
- **Extra usage** — If you have prepaid credit, shows the percent spent and the dollar amounts. Hidden entirely if you have none
- **Alerts** — An optional notification the first time a limit passes 80% and 95%
- **Opens instantly** — The last reading is cached, so the popup shows numbers immediately and refreshes behind them
- **Follows your system theme** — Dark when your computer is dark, light when it is light, with a manual override
- **Zero config** — Automatically detects your organization from your claude.ai session
- **Privacy-first** — No external servers, no telemetry, all data stays in your browser

## Installation

Chromium-based browsers only (Chrome, Edge, Brave, Arc). Firefox is not supported.

1. Download or clone this repository — if you downloaded a ZIP file, extract it first before continuing
2. Open `chrome://extensions/` (or `edge://extensions/`)
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the extracted folder

## Usage

1. Make sure you are logged into [claude.ai](https://claude.ai) in the same browser
2. The badge on the toolbar icon always shows your **5-hour session** usage
3. Click the icon for the full breakdown — hover a countdown to see the exact reset time
4. Use the bell button to turn threshold alerts on or off
5. Use the **Auto** selector in the footer to choose how often it refreshes

### Auto-refresh

Every 10 seconds by default, selectable as 5s, 10s, 20s, 60s or Off from the popup footer.

Intervals under 30 seconds apply **while the popup is open**. Chrome will not fire a background alarm more often than every 30 seconds, so the badge updates at 30s at the fastest no matter which interval you pick. Setting Off stops both.

> The extension reads the `lastActiveOrg` cookie from claude.ai to identify your account, falling back to the organizations API if the cookie is not set. No credentials are stored or transmitted anywhere.

### Badge colours

| Colour | Usage |
|---|---|
| Green | under 50% |
| Amber | 50–74% |
| Orange | 75–94% |
| Red | 95% and above |

`?` means you are signed out; `!` means the last refresh failed.

### Theme

The popup opens in whatever mode your computer is set to. Clicking the sun/moon button overrides that, and the override sticks — until your computer itself switches modes, at which point it is dropped and the popup follows the system again. Picking the mode the system is already using simply resumes following it.

### Extra usage

Usage credits cover you once your plan allowance runs out. The card shows spend against the monthly spend limit you set:

```
USAGE CREDITS                          1% used
[▏────────────────────────────────────────]
$0.64 spent of $50.00 monthly limit • $49.36 left
──────────────────────────────────────────────
BALANCE                                 $60.36
$60.34 promotional, expires Sep 19, 2026
```

The two figures are deliberately separate: `$49.36 left` is headroom under your monthly spend limit, while `$60.36` is the money you actually hold. They are different numbers and the balance is usually larger.

"Monthly spend limit reached" is flagged when you hit the cap. If usage credits are switched off, or the account has none, no card is shown at all.

## Permissions

| Permission | Why |
|---|---|
| `cookies` | Read the `lastActiveOrg` cookie to detect your organization |
| `storage` | Save your theme and alert preferences, and cache the last reading |
| `alarms` | Refresh usage in the background to keep the badge current |
| `notifications` | Alert you when a limit passes 80% or 95% |
| `host_permissions` (`claude.ai`) | Fetch usage data from the claude.ai API |

## Privacy

- All data stays local in your browser
- No external servers, no tracking, no telemetry
- Uses your existing claude.ai session cookies — nothing is stored or transmitted beyond your machine

## API notes

These endpoints are internal and undocumented. They may change without warning.

### Where the numbers come from

The figures come from two endpoints. Spend is on the usage endpoint under `spend`; the balance is not there at all (`spend.balance` is always `null`) and comes from `/api/organizations/{org}/prepaid/credits`:

```json
{
  "amount": 6036,
  "currency": "USD",
  "next_expires_at": "2026-09-19T00:00:00Z",
  "promo_tranches": [
    { "remaining_amount_minor_units": 6034, "expires_at": "2026-09-19T00:00:00Z" }
  ]
}
```

`amount` is the balance in cents. Promotional credit is the sum of the promo tranches, reported with the soonest expiry. That request is allowed to fail — accounts with no prepaid credit get a 404, and the rest of the popup carries on.

The spend figures come back on the usage endpoint under `spend`:

```json
{
  "spend": {
    "used":  { "amount_minor": 64,   "exponent": 2, "currency": "USD" },
    "limit": { "amount_minor": 5000, "exponent": 2, "currency": "USD" },
    "cap":   { "credits": { "amount_minor": 5000, "exponent": 2 } }
  }
}
```

Amounts are `amount_minor / 10^exponent`, so an exponent of 2 means cents. `spend.limit` is used for the total, falling back to `spend.cap.credits`.

`extra_usage` carries the same figures as plain numbers scaled by `decimal_places`, and is read when `spend` is absent. If no card appears, the account has no usage credit, or has them switched off.

Both shapes are pinned by fixtures in `test/extra-credit.test.js` taken verbatim from real responses, so a schema change fails a test rather than putting a wrong number on screen.

## Development

No dependencies. Node 20 or newer.

```bash
node --test                 # run the unit tests
node scripts/validate.mjs   # check the manifest, assets and scripts
node scripts/package.mjs    # build dist/claude-usage-monitor-<version>.zip
```

Layout:

| Path | Role |
|---|---|
| `manifest.json` | Extension manifest (MV3) |
| `background.js` | Service worker — polling, badge, notifications |
| `popup.html` / `popup.js` | The popup UI |
| `lib/usage.js` | Shared fetching and formatting, used by both |
| `lib/theme.js` | System-theme resolution and override rules |
| `test/` | Unit tests for the pure helpers |

## License

MIT — see [LICENSE](LICENSE) for details.

## Disclaimer

- This is an **unofficial**, community-built tool and is **not affiliated with or endorsed by Anthropic**.
- It relies on an internal claude.ai API endpoint that may change or break without notice.
- Use at your own risk and in accordance with [Anthropic's Terms of Service](https://www.anthropic.com/terms).
