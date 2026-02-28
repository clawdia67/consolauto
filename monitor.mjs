/**
 * prenotami-monitor — AI-powered slot monitor
 *
 * Monitors prenotami.esteri.it/Services/Booking/5810 for available passport slots
 * at Consolato Generale d'Italia a Barcellona.
 *
 * Architecture:
 * - Stagehand LOCAL (AI-driven browser) instead of raw Playwright
 * - Natural language act() calls are self-healing — no brittle CSS selectors
 * - Cookie persistence keeps sessions alive across restarts (no persistent profile needed)
 * - Auto-reinit on browser crash — no ProcessSingleton fights
 *
 * Why Stagehand over raw Playwright:
 * - Old: elementHandle.click() → timeout at midnight when site is slow/congested
 * - New: stagehand.act("click the passport booking link") → AI finds & retries naturally
 * - Old: brittle dialog interception for "esauriti" detection
 * - New: stagehand.extract() reads actual page state, language-agnostic
 */
import "dotenv/config";
import { initBrowser, closeBrowser } from "./lib/browser.mjs";
import { checkSlots } from "./lib/slots.mjs";
import { notify } from "./lib/notify.mjs";
import { CHECK_INTERVAL_MS, BOOKING_URL } from "./lib/config.mjs";

let running = true;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log("=== Prenotami Monitor started ===");
  console.log(`Checking every ${CHECK_INTERVAL_MS / 1000}s`);
  console.log(`Booking URL: ${BOOKING_URL}`);

  await notify(
    "Prenotami Monitor",
    "Monitor avviato — controllo ogni minuto slot passaporto Barcellona"
  );

  while (running) {
    try {
      await initBrowser();
      console.log("[browser] Stagehand initialized");

      // Keep running until browser error
      while (running) {
        await checkSlots();
        await sleep(CHECK_INTERVAL_MS);
      }

    } catch (err) {
      console.error("[main] browser error, reinitializing:", err.message);
      await closeBrowser();
      console.log("[main] waiting 30s before retry...");
      await sleep(30_000);
    }
  }
}

// Graceful shutdown
process.on("SIGINT",  () => { running = false; closeBrowser().then(() => process.exit(0)); });
process.on("SIGTERM", () => { running = false; closeBrowser().then(() => process.exit(0)); });

main().catch(async (err) => {
  console.error("Fatal:", err);
  await notify("💀 Prenotami Monitor CRASH", err.message.substring(0, 150));
  process.exit(1);
});
