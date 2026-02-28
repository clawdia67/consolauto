# consolauto

Automated passport appointment slot monitor for [prenotami.esteri.it](https://prenotami.esteri.it) — specifically for the **Consolato Generale d'Italia a Barcellona** (service ID 5810).

Sends iPhone push notifications (Pinger) and Discord messages the instant a slot opens.

## How it works

The site releases new passport appointment slots around midnight — that's when it's most congested and basic browser automation times out. This monitor uses a **time-based hybrid approach**:

| Window | Engine | Cost | Why |
|--------|--------|------|-----|
| 00:30 – 23:30 | Playwright | free | fast, deterministic, zero API calls |
| 23:30 – 00:30 | Stagehand + Gemini | ~€0.40/night | AI-driven, survives slow/congested site |

During the midnight window, instead of brittle CSS selectors that time out under load, it uses natural-language browser automation:

```js
// old (breaks at midnight):
const link = await page.$('a[href*="Booking/5810"]');
await link.click(); // ← Timeout 30000ms exceeded

// new (self-healing):
await stagehand.act("click the link for passport booking or Booking/5810 or passaporto");
```

Slot detection uses AI extraction instead of flaky dialog interception:

```js
const { hasSlots, reason } = await stagehand.extract(
  "determine if any appointment slots are available...",
  z.object({ hasSlots: z.boolean(), reason: z.string() })
);
// → { hasSlots: false, reason: "i posti disponibili per il servizio scelto sono esauriti" }
```

## Setup

```bash
git clone https://github.com/clawdia67/consolauto
cd consolauto
npm install
cp .env.example .env
# fill in .env
npm start
```

## Configuration (`.env`)

```env
# prenotami.esteri.it account
PRENOTAMI_EMAIL=your@email.com
PRENOTAMI_PASSWORD=yourpassword

# iPhone push notifications via Pinger
PINGER_USER=your_pinger_username
PINGER_URL=https://us-central1-your-project.cloudfunctions.net/notify

# Discord bot notifications
DISCORD_TOKEN=your_bot_token
DISCORD_CHANNEL=your_channel_id

# Gemini API key (used only 1h/night during midnight window)
GOOGLE_GENERATIVE_AI_API_KEY=your_gemini_key
```

## Notifications

- **Slot found** → Pinger (iPhone) + Discord with form intelligence (available dates, fields)
- **Diocan alert** → every 3h if no slots (so you know it's still running)
- **Mode switch** → Discord message when switching Playwright ↔ Stagehand
- **Error** → Pinger + Discord on crash or repeated failures

## Project structure

```
monitor.mjs                  — main loop, time-based mode switching
lib/
  config.mjs                 — all config loaded from .env
  playwright-check.mjs       — Playwright-based check (00:30–23:30, free)
  stagehand-check.mjs        — Stagehand/Gemini check (23:30–00:30, AI-driven)
  notify.mjs                 — Pinger + Discord notification helpers
test-stagehand.mjs           — one-shot test for the Stagehand path
```

## Running

```bash
# foreground (dev)
npm start

# background (production)
nohup node monitor.mjs >> prenotami.log 2>&1 &

# watch logs
tail -f prenotami.log

# stop
pkill -f monitor.mjs
```

## Adapting for other consulates / services

Change `BOOKING_URL` in `lib/config.mjs` to your service's booking URL. The service ID is the number in `Services/Booking/<ID>`. Everything else works as-is.

## Tech stack

- [Playwright](https://playwright.dev) — browser automation (Chromium)
- [Stagehand](https://github.com/browserbase/stagehand) — AI-powered browser automation
- [Google Gemini Flash](https://ai.google.dev) — LLM for AI actions (cheap, fast)
- [Zod](https://zod.dev) — schema validation for structured AI extraction
