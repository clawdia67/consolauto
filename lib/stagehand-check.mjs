/**
 * stagehand-check.mjs — AI-powered check via Stagehand + Gemini
 * Used for 1h/day (23:30 – 00:30) when the site is slow/congested.
 * Costs ~$0.30–0.70 per night, handles timeouts Playwright can't.
 */
import { Stagehand } from "@browserbasehq/stagehand";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { z } from "zod";
import { SITE, BOOKING_URL, SCREENSHOTS_DIR, COOKIES_FILE, EMAIL, PASSWORD, DIOCAN_INTERVAL_MS } from "./config.mjs";
import { notify, sendDiscord } from "./notify.mjs";

mkdirSync(SCREENSHOTS_DIR, { recursive: true });

let stagehand = null;
let checkCount = 0;
export let lastDiocanAlert = Date.now();

// ─── Cookie persistence ───────────────────────────────────────────────────────

function loadCookies() {
  if (!existsSync(COOKIES_FILE)) return [];
  try { return JSON.parse(readFileSync(COOKIES_FILE, "utf8")); } catch { return []; }
}

function getPage() {
  return stagehand?.context?.pages()?.[0];
}

async function saveCookies() {
  if (!stagehand) return;
  try {
    const cookies = await stagehand.context.cookies();
    writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
    console.log(`[stagehand] cookies saved (${cookies.length})`);
  } catch (e) {
    console.error("[stagehand] cookie save error:", e.message);
  }
}

// ─── Init / teardown ─────────────────────────────────────────────────────────

export async function initStagehand() {
  if (stagehand) return; // already up
  console.log("[stagehand] initializing...");
  stagehand = new Stagehand({
    env: "LOCAL",
    model: "google/gemini-3-flash-preview",
    verbose: 1,
    headless: false,
  });
  await stagehand.init();

  // Restore cookies from Playwright session (shares the same file)
  const cookies = loadCookies();
  if (cookies.length > 0) {
    await stagehand.context.addCookies(cookies);
    console.log(`[stagehand] restored ${cookies.length} cookies`);
  }
  console.log("[stagehand] ready");
}

export async function closeStagehand() {
  if (!stagehand) return;
  await saveCookies();
  try { await stagehand.close(); } catch {}
  stagehand = null;
  console.log("[stagehand] closed");
}

// ─── Login ────────────────────────────────────────────────────────────────────

async function ensureLoggedIn() {
  const page = getPage();
  await page.goto(`${SITE}/UserArea`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  const { loggedIn } = await stagehand.extract(
    "is the user logged in? look for a dashboard or booking options vs a login prompt or 'EFFETTUARE IL LOGIN'",
    z.object({ loggedIn: z.boolean() })
  );

  console.log(`[stagehand] loggedIn: ${loggedIn}`);
  if (!loggedIn) {
    await page.goto(SITE, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    await stagehand.act("click the login or 'accedere' link");
    await page.waitForTimeout(3000);
    await stagehand.act("type %email% in the email or username field", { variables: { email: EMAIL } });
    try {
      await stagehand.act("click next or avanti button if visible");
      await page.waitForTimeout(1500);
    } catch {}
    await stagehand.act("type %password% in the password field", { variables: { password: PASSWORD } });
    await stagehand.act("click the login or accedi button");
    await page.waitForTimeout(4000);
    await saveCookies();
    console.log("[stagehand] login done, URL:", page.url());
  }
}

// ─── Screenshot ───────────────────────────────────────────────────────────────

async function screenshot(name) {
  const file = path.join(SCREENSHOTS_DIR, `${name}-${Date.now()}.png`);
  await getPage().screenshot({ path: file, fullPage: true });
  console.log(`[screenshot] ${file}`);
  return file;
}

// ─── Main check ───────────────────────────────────────────────────────────────

export async function checkSlots() {
  const page = getPage();

  await ensureLoggedIn();
  await page.goto(`${SITE}/Services`, { waitUntil: "networkidle", timeout: 45_000 });

  if (page.url().includes("perfdrive.com") || page.url().includes("radware")) {
    throw new Error("Bot detection triggered (Radware). Retry next cycle.");
  }

  // AI-driven click — no brittle selector, self-healing
  // Stagehand handles its own timeouts internally; we wait generously after click
  await stagehand.act("click the link for passport booking or the link containing 'Booking/5810' or passaporto");
  await page.waitForTimeout(5000); // extra wait — site slow at midnight

  // AI-driven slot detection — replaces flaky dialog interception
  const { hasSlots, reason } = await stagehand.extract(
    "determine if any appointment slots are available. " +
    "Look for: a booking form with selectable dates, or a message saying 'esauriti' (all taken). " +
    "Return hasSlots=true ONLY if a booking form or calendar with dates is visible.",
    z.object({
      hasSlots: z.boolean(),
      reason: z.string().describe("brief description of what you see"),
    })
  );

  console.log(`[stagehand check #${++checkCount}] hasSlots: ${hasSlots} | ${reason}`);

  if (!hasSlots) {
    if (Date.now() - lastDiocanAlert >= DIOCAN_INTERVAL_MS) {
      lastDiocanAlert = Date.now();
      await notify("Consolauto", "diocan nessun posto nelle scorse 3 ore");
    }
    return;
  }

  // 🎉 Slot found
  console.log("🎉 SLOT FOUND (stagehand)!", reason);
  await screenshot("slot-stagehand-landing");
  await notify("🎉 POSTO DISPONIBILE!", `Slot aperto — passaporto Barcellona! Apri subito!\n${reason}`);

  // Save full DOM snapshot for automation analysis
  const slotPage = getPage();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    const html = await slotPage.content();
    const domPath = `./snapshots/dom-${timestamp}.html`;
    const { mkdirSync, writeFileSync } = await import("fs");
    mkdirSync("./snapshots", { recursive: true });
    writeFileSync(domPath, html);
    console.log(`[snapshot] full DOM saved: ${domPath} (${(html.length / 1024).toFixed(0)}KB)`);

    // Also grab the accessibility tree for structure analysis
    const snapshot = await slotPage.accessibility.snapshot();
    writeFileSync(`./snapshots/a11y-${timestamp}.json`, JSON.stringify(snapshot, null, 2));
    console.log(`[snapshot] a11y tree saved`);
  } catch (e) {
    console.error("[snapshot] DOM dump failed:", e.message);
  }

  // Navigate the booking flow to understand the steps
  try {
    const flowState = await stagehand.extract(
      "extract everything visible on this booking page: all available dates and time slots, " +
      "all form fields (dropdowns, inputs, checkboxes) with their current values and options, " +
      "all buttons and their labels, any calendar widget state, and the current URL",
      z.object({
        currentUrl: z.string().optional(),
        availableDates: z.array(z.string()),
        timeSlots: z.array(z.string()).optional(),
        formFields: z.array(z.object({
          label: z.string(),
          type: z.string(),
          value: z.string().optional(),
          options: z.array(z.string()).optional(),
        })).optional(),
        buttons: z.array(z.string()).optional(),
        calendarState: z.string().optional(),
        notes: z.string().optional(),
      })
    );
    const { writeFileSync } = await import("fs");
    writeFileSync(`./snapshots/flow-${timestamp}.json`, JSON.stringify(flowState, null, 2));
    console.log(`[snapshot] booking flow state saved`);
    await sendDiscord(`🎉 **SLOT TROVATO (stagehand):**\n\`\`\`json\n${JSON.stringify(flowState, null, 2).substring(0, 1500)}\n\`\`\``);
  } catch (e) {
    console.error("[snapshot] flow extraction failed:", e.message);
  }

  // Take screenshots at each visible step
  try {
    await screenshot("slot-stagehand-form");
    // Try clicking into calendar/date picker if present
    await stagehand.act("if there is a calendar or date picker, click on the first available date");
    await screenshot("slot-stagehand-date-selected");
    console.log("[snapshot] navigated date picker");
  } catch (e) {
    console.log("[snapshot] no further navigation possible:", e.message);
  }
}
