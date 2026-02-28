# prenotami-monitor

Hybrid passport slot monitor for [prenotami.esteri.it](https://prenotami.esteri.it/Services/Booking/5810) (Consolato Barcellona).

## Architecture

**Time-based mode switching:**

| Window | Mode | Cost | Why |
|--------|------|------|-----|
| 00:30 – 23:30 | Playwright | free | fast, deterministic, zero API calls |
| 23:30 – 00:30 | Stagehand + Gemini | ~€0.40/night | site congested, Playwright times out |

Prenotami releases new slots at midnight — that's when `elementHandle.click: Timeout 30s exceeded` happens. Stagehand uses natural language `act()` which is self-healing and handles slow sites better. For the other 23 hours, Playwright is free and reliable.

**Cookie handoff on switch:**
- Playwright (persistent Chrome profile) → saves cookies to `cookies.json`
- Stagehand restores from `cookies.json` → no re-login needed

## Setup

```bash
cp .env.example .env
# edit .env with credentials + API keys
npm install
npx playwright install chromium  # if not already installed
npm start
```

## .env

```
PRENOTAMI_EMAIL=your@email.com
PRENOTAMI_PASSWORD=yourpassword
PINGER_USER=matlo
PINGER_URL=https://...
DISCORD_TOKEN=...
DISCORD_CHANNEL=...
GOOGLE_GENERATIVE_AI_API_KEY=...   # for Stagehand/Gemini (1h/night only)
```

## Files

```
monitor.mjs                  — main loop + time-based mode switching
lib/config.mjs               — all config from .env
lib/playwright-check.mjs     — free Playwright check (23h/day)
lib/stagehand-check.mjs      — Stagehand/Gemini check (midnight window)
lib/notify.mjs               — Pinger + Discord notifications
```

## Notifications

- **slot found** → Pinger (iPhone) + Discord con form intelligence
- **diocan alert** → ogni 3h se nessuno slot
- **mode switch** → Discord al passaggio playwright↔stagehand
- **crash** → Pinger + Discord
