/**
 * slots.mjs — AI-powered slot checking via Stagehand
 *
 * Key improvement over old Playwright approach:
 * - No brittle CSS selectors or hardcoded timeouts
 * - stagehand.act() uses natural language — adapts when the UI changes
 * - stagehand.extract() reads actual page state, not dialog interception
 * - Handles bot-detection / slow midnight traffic gracefully
 */
import { z } from "zod";
import { getStagehand, ensureLoggedIn, screenshot } from "./browser.mjs";
import { notify, sendDiscord } from "./notify.mjs";
import { SITE, BOOKING_URL, DIOCAN_INTERVAL_MS } from "./config.mjs";
import { writeFileSync } from "fs";
import path from "path";

// State
let checkCount = 0;
let errorCount = 0;
let lastDiocanAlert = Date.now();

export async function checkSlots() {
  const sh = getStagehand();
  const page = sh.page;

  try {
    await ensureLoggedIn();

    // Navigate to Services listing (avoids direct URL block)
    await page.goto(`${SITE}/Services`, { waitUntil: "networkidle", timeout: 45_000 });

    // Bot detection check
    if (page.url().includes("perfdrive.com") || page.url().includes("radware")) {
      throw new Error("Bot detection triggered (Radware). Retry next cycle.");
    }

    // Verify we landed on the Services page
    if (!page.url().includes("Services")) {
      throw new Error(`Failed to reach Services page — landed on: ${page.url()}`);
    }

    // ── AI-powered: click the passport booking link ───────────────────────
    // OLD: const bookingLink = await page.$('a[href*="Booking/5810"]');
    //      await bookingLink.click(); // ← timeout here at midnight
    //
    // NEW: natural language — no brittle selector, self-healing
    // increase timeout for midnight traffic congestion
    page.setDefaultTimeout(60_000);
    await sh.act(
      "click the link for passport booking or the link containing 'Booking/5810' or passaporto"
    );
    page.setDefaultTimeout(30_000); // reset to default

    await page.waitForTimeout(3000);

    // ── AI-powered: detect slot availability ─────────────────────────────
    // OLD: dialog interception (brittle — missed races, double-fires, etc.)
    //
    // NEW: extract page state directly — what does the page actually show?
    const slotState = await sh.extract(
      "determine if any appointment slots are available for booking. " +
      "Look for: available dates on a calendar, a booking form, or an error/dialog saying " +
      "'esauriti' (all slots taken) or 'no availability'. " +
      "Return hasSlots=true ONLY if a booking form or calendar with selectable dates is visible.",
      z.object({
        hasSlots: z.boolean().describe("true if a booking form or selectable dates are visible"),
        reason: z.string().describe("brief explanation of what you see on the page"),
        currentUrl: z.string().optional(),
      })
    );

    console.log(`[check #${++checkCount}] hasSlots: ${slotState.hasSlots} | ${slotState.reason}`);

    if (!slotState.hasSlots) {
      // No slots — maybe send diocan alert
      if (Date.now() - lastDiocanAlert >= DIOCAN_INTERVAL_MS) {
        lastDiocanAlert = Date.now();
        await notify("Prenotami", "diocan nessun posto nelle scorse 3 ore");
      }
      errorCount = 0;
      return;
    }

    // 🎉 SLOT FOUND
    console.log("🎉 SLOT FOUND!", slotState.reason);
    await screenshot("slot-01-landing");

    await notify(
      "🎉 POSTO DISPONIBILE!",
      `Slot aperto su prenotami — passaporto Barcellona! Apri subito!\n${slotState.reason}`
    );

    // ── Explore the booking flow ──────────────────────────────────────────
    await exploreBookingFlow(sh, page);

    errorCount = 0;

  } catch (err) {
    console.error("[error]", err.message);
    errorCount++;
    if (errorCount <= 3 || errorCount % 10 === 0) {
      await notify(
        "⚠️ Prenotami Monitor Error",
        `Errore #${errorCount}: ${err.message.substring(0, 100)}`
      );
    }
    // Signal to caller that browser needs reset
    throw err;
  }
}

async function exploreBookingFlow(sh, page) {
  const intelligence = [];

  try {
    // Extract full booking form state
    const formState = await sh.extract(
      "extract all visible form fields, available date slots, and time options on the booking page",
      z.object({
        availableDates: z.array(z.string()).describe("list of available dates shown"),
        formFields: z.array(z.object({
          label: z.string(),
          type: z.string(),
          required: z.boolean().optional(),
        })).describe("visible form fields"),
        pageTitle: z.string().optional(),
        instructions: z.string().optional().describe("any instructions or notes shown"),
      })
    );

    intelligence.push(`=== BOOKING FORM STATE ===\n${JSON.stringify(formState, null, 2)}`);

    // Try to click first available date
    if (formState.availableDates.length > 0) {
      await screenshot("slot-02-calendar-before");

      await sh.act("click the first available date slot on the calendar");
      await page.waitForTimeout(2000);
      await screenshot("slot-03-after-date-click");

      // Extract time slots after date selection
      const timeState = await sh.extract(
        "extract available time slots shown after selecting a date",
        z.object({
          timeSlots: z.array(z.string()).describe("available time options"),
          nextSteps: z.string().optional(),
        })
      );

      intelligence.push(`=== AFTER DATE CLICK ===\n${JSON.stringify(timeState, null, 2)}`);

      if (timeState.timeSlots.length > 0) {
        await sh.act("click the first available time slot");
        await page.waitForTimeout(2000);
        await screenshot("slot-04-after-time-click");
      }
    }

    // Final form extraction
    await screenshot("slot-05-final");
    const finalState = await sh.extract(
      "extract the current page state — any confirmation, additional required fields, or next steps",
      z.object({
        status: z.string(),
        requiredFields: z.array(z.string()).optional(),
        confirmationId: z.string().optional(),
      })
    );

    intelligence.push(`=== FINAL STATE ===\n${JSON.stringify(finalState, null, 2)}`);

  } catch (exploreErr) {
    console.error("[explore error]", exploreErr.message);
    intelligence.push(`EXPLORE ERROR: ${exploreErr.message}`);
  }

  // Save report
  const reportPath = path.join("./screenshots", `intelligence-${Date.now()}.txt`);
  writeFileSync(reportPath, intelligence.join("\n\n---\n\n"));
  console.log("[intelligence] saved:", reportPath);

  await sendDiscord(
    `🎉 **SLOT TROVATO** — intelligence:\n\`\`\`json\n${intelligence.join("\n---\n").substring(0, 1800)}\n\`\`\`\nScreenshots: ${path.resolve("./screenshots")}`
  );
}
