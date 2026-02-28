# CLAUDE.md — Agent Guide for prenotami-monitor

This file tells you (the AI agent) what this project does, how it's structured, and what to watch out for when making changes.

## What this is

A Node.js monitor that checks `prenotami.esteri.it/Services/Booking/5810` every minute for available passport appointment slots at the Italian Consulate in Barcelona. It sends iPhone push (Pinger) and Discord notifications when a slot appears.

## Key design decision: time-based hybrid

**Do not make the whole thing Stagehand or the whole thing Playwright.** The split exists for cost reasons:

- Playwright is free — use it 23h/day
- Stagehand calls Gemini on every check — at 60s intervals that's ~1440 LLM calls/day, ~$0.50–1/day just to see "esauriti"
- The midnight window (23:30–00:30) is the only time Playwright actually fails (site congestion → timeout)

If you're tempted to simplify by making everything Stagehand: don't. The split is intentional.

## Architecture

```
monitor.mjs
  ├── isStagehandWindow() → checks local time (23:30–00:30 = Stagehand)
  ├── switchTo("playwright"|"stagehand") → handles init/teardown + cookie handoff
  └── runOnce() → calls the right checkSlots() based on current mode

lib/playwright-check.mjs   (00:30–23:30)
  ├── getBrowser()          → launchPersistentContext on Chrome profile
  ├── closeBrowser()
  ├── killStaleChrome()     → clears ProcessSingleton lock (CRITICAL — call on startup + mode switch)
  ├── saveCookies()         → exports cookies to cookies.json for Stagehand handoff
  └── checkSlots()          → the actual check: login → Services → click → detect dialog

lib/stagehand-check.mjs    (23:30–00:30)
  ├── initStagehand()       → Stagehand LOCAL mode + restore cookies from JSON
  ├── closeStagehand()      → saves cookies to JSON + closes browser
  └── checkSlots()          → AI-driven: act() to click, extract() to detect slots

lib/notify.mjs             → sendPinger(), sendDiscord(), notify()
lib/config.mjs             → all constants from .env
```

## Critical: Chrome ProcessSingleton

The Playwright path uses `launchPersistentContext` on `/Users/bill/.openclaw/browser-profiles/esteri`. Chrome locks this with a `SingletonLock` file. If a previous run crashed without cleanup, the next run fails with:

```
Failed to create a ProcessSingleton for your profile directory
```

**Fix:** always call `killStaleChrome()` before launching Playwright. It's called:
- At cold start (before first check)
- When switching stagehand → playwright

If you see this error, run: `pkill -f "user-data-dir=...esteri"` and delete the lock file.

## Cookie handoff between modes

Playwright uses a persistent Chrome profile (cookies survive naturally on disk).
Stagehand uses a fresh browser, so it needs cookies injected manually.

Flow at 23:30 (Playwright → Stagehand):
1. `PW.saveCookies()` → writes `cookies.json`
2. `PW.closeBrowser()`
3. `SH.initStagehand()` → `stagehand.context.addCookies(cookies.json)`

Flow at 00:30 (Stagehand → Playwright):
1. `SH.closeStagehand()` → saves `cookies.json`, closes browser
2. `PW.killStaleChrome()`
3. Playwright uses persistent profile (already has session on disk)

## Stagehand v3 API gotchas

In Stagehand v3:
- **`stagehand.page` is undefined** — use `stagehand.context.pages()[0]` instead
- **`act()` and `extract()` are on the stagehand instance**, not on the page
- **`stagehand.context.cookies()`** for saving, **`stagehand.context.addCookies()`** for restoring
- **`page.setDefaultTimeout()` is NOT available** on the Stagehand-wrapped page — set navigation timeouts via `page.goto()` options instead
- Always `env: "LOCAL"` — we don't use Browserbase cloud

## What "esauriti" looks like

The site shows an alert dialog OR an inline message:
> "i posti disponibili per il servizio scelto sono esauriti"

Playwright intercepts it as a dialog event. Stagehand detects it via `extract()` reading the accessibility tree. Both work; they're just different mechanisms.

A slot opening means the click on "PRENOTA" navigates to a booking form instead of showing the esauriti message.

## Notifications

All go through `lib/notify.mjs`:
- `notify(title, body)` → Pinger + Discord in parallel
- `sendPinger(title, body, url?)` → iOS push via Cloud Function
- `sendDiscord(message)` → Discord bot API

Discord token and Pinger URL are in `.env`. Don't hardcode them.

## Testing the Stagehand path

```bash
node test-stagehand.mjs
```

This runs one full Stagehand check cycle without touching the running monitor. Good for verifying login flow and AI detection after changes.

## Logs

```bash
tail -f prenotami.log
```

Format: `[mode] active: playwright|stagehand` on switch, then per-check:
```
[session] URL: https://prenotami.esteri.it/UserArea | loggedIn: true
[check #42] No slots — esauriti
```

## Making changes

**Changing the service (different consulate/service ID):**
Edit `BOOKING_URL` in `lib/config.mjs`. The AI instructions in `stagehand-check.mjs` reference "Booking/5810" — update those strings too.

**Changing the midnight window:**
Edit `isStagehandWindow()` in `monitor.mjs`. Currently 23:30–00:30 (local time).

**Adding a notification channel:**
Add a sender function in `lib/notify.mjs` and call it inside `notify()`.

**Increasing check frequency:**
Change `CHECK_INTERVAL_MS` in `lib/config.mjs`. Don't go below 30s — the site will rate-limit you.
