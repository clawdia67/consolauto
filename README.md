# prenotami-monitor

AI-powered passport slot monitor for [prenotami.esteri.it](https://prenotami.esteri.it/Services/Booking/5810) (Consolato Barcellona).

## Why Stagehand over raw Playwright?

Old monitor used raw Playwright with brittle CSS selectors and dialog interception — which broke nightly at midnight when the site gets congested (timeout 30s exceeded).

**Stagehand approach:**
- `stagehand.act("click the passport booking link")` — natural language, self-healing when the UI changes, better timeout handling under load
- `stagehand.extract()` — reads actual page state to detect slot availability, no flaky dialog interception
- Cookie persistence across restarts — no more Chrome ProcessSingleton fights
- Auto-reinit on browser crash — clean recovery loop

## Setup

```bash
cp .env.example .env
# edit .env with your credentials
npm install
npm start
```

## Config

All config in `.env`. See `.env.example`.

## Notifications

- **Pinger** — iPhone push when slot found or error
- **Discord** — same + intelligence report (form fields, available dates)

## Files

```
monitor.mjs         — entry point, main loop
lib/config.mjs      — all config from .env
lib/browser.mjs     — Stagehand init + cookie persistence + login
lib/slots.mjs       — AI-powered slot detection + booking flow exploration
lib/notify.mjs      — Pinger + Discord notifications
```
