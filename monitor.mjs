/**
 * consolauto — time-based Playwright/Stagehand hybrid
 *
 * 00:30 – 23:30  →  Playwright (free, deterministic, zero API cost)
 * 23:30 – 00:30  →  Stagehand + Gemini (AI-driven, handles midnight congestion)
 *
 * Why time-based?
 * prenotami releases new slots at midnight — site is slow/congested 23:30–00:30.
 * Playwright times out under load (elementHandle.click: Timeout 30s exceeded).
 * Stagehand handles it with natural language + longer retries, but costs ~$0.50/night.
 * For the other 23 hours, Playwright is free, fast, and reliable.
 *
 * Cookie handoff:
 * Playwright saves cookies → JSON → Stagehand restores them on switch.
 * Stagehand saves cookies → JSON → Playwright restores on exit (uses persistent profile anyway).
 */
import "dotenv/config";
import * as PW from "./lib/playwright-check.mjs";
import * as SH from "./lib/stagehand-check.mjs";
import { notify } from "./lib/notify.mjs";
import { CHECK_INTERVAL_MS } from "./lib/config.mjs";

// ─── Time window ─────────────────────────────────────────────────────────────

/**
 * Returns true between 23:30 and 00:30 (1 hour window around midnight).
 */
function isStagehandWindow() {
  const now = new Date();
  const totalMin = now.getHours() * 60 + now.getMinutes();
  const START = 23 * 60 + 30; // 23:30 = 1410
  const END   =  0 * 60 + 30; //  0:30 =   30
  // window crosses midnight: active if ≥ 23:30 OR < 00:30
  return totalMin >= START || totalMin < END;
}

function currentMode() {
  return isStagehandWindow() ? "stagehand" : "playwright";
}

// ─── Sleep ────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Main loop ────────────────────────────────────────────────────────────────

let running = true;
let activeMode = null; // track what's currently initialized

async function switchTo(mode) {
  if (mode === activeMode) return;

  if (activeMode === "playwright") {
    console.log("[switch] playwright → stagehand");
    await PW.saveCookies();    // export session to JSON
    await PW.closeBrowser();   // close Chrome persistent context
    await SH.initStagehand();  // Stagehand restores from JSON
    await notify("Consolauto", "🤖 switching to Stagehand (23:30–00:30 finestra mezzanotte)");
  } else if (activeMode === "stagehand") {
    console.log("[switch] stagehand → playwright");
    await SH.closeStagehand(); // saves cookies to JSON, closes Stagehand
    await PW.killStaleChrome(); // clear any lingering Chrome profile lock
    await notify("Consolauto", "⚙️ switching to Playwright (00:30–23:30)");
  } else {
    // Cold start — kill any stale Chrome left from previous runs
    await PW.killStaleChrome();
    if (mode === "stagehand") {
      await SH.initStagehand();
    }
    // Playwright initializes lazily on first getBrowser() call
  }

  activeMode = mode;
  console.log(`[mode] active: ${activeMode}`);
}

async function runOnce() {
  const mode = currentMode();
  await switchTo(mode);

  try {
    if (mode === "stagehand") {
      await SH.checkSlots();
    } else {
      await PW.checkSlots();
    }
  } catch (err) {
    // Errors already logged and notified inside each module.
    // If Playwright crashed, it already reset its browser context.
    // If Stagehand crashed, reinitialize it.
    if (mode === "stagehand" && activeMode === "stagehand") {
      console.log("[main] stagehand error — reinitializing in 30s...");
      await SH.closeStagehand();
      activeMode = null;
      await sleep(30_000);
    }
  }
}

async function main() {
  console.log("=== Consolauto started ===");
  console.log(`Check interval: ${CHECK_INTERVAL_MS / 1000}s`);
  console.log(`Mode at startup: ${currentMode()}`);

  await notify("Consolauto", "Monitor avviato — Playwright 23h/day, Stagehand a mezzanotte");

  while (running) {
    await runOnce();
    await sleep(CHECK_INTERVAL_MS);
  }
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

async function shutdown() {
  running = false;
  await PW.closeBrowser();
  await SH.closeStagehand();
  process.exit(0);
}

process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);

main().catch(async (err) => {
  console.error("Fatal:", err);
  await notify("💀 Consolauto CRASH", err.message.substring(0, 150));
  process.exit(1);
});
