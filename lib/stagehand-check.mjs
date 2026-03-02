/**
 * stagehand-check.mjs — AI-powered check via Stagehand + Gemini
 * Used for 1.5h/day (23:30 – 01:00) when the site is slow/congested.
 * Costs ~$0.30–0.70 per night, handles timeouts Playwright can't.
 * On slot found: auto-fills form, accepts privacy, triggers OTP, then waits 5min for manual OTP entry.
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

  // Deep analysis pass first (for auto-booker research), then attempt booking
  const report = await analyzeBookingPage("01-landing");
  await bookSlot(report);
}

// ─── Deep page analysis (for auto-booker research) ───────────────────────────

async function analyzeBookingPage(stepLabel) {
  const page = getPage();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const reportDir = path.join(path.dirname(SCREENSHOTS_DIR), "reports");
  const { mkdirSync, writeFileSync } = await import("fs");
  mkdirSync(reportDir, { recursive: true });

  console.log(`[analyze] deep scan — step: ${stepLabel}`);

  // Full DOM dump
  let domHtml = "";
  try {
    domHtml = await page.content();
    writeFileSync(path.join(reportDir, `dom-${stepLabel}-${ts}.html`), domHtml);
    console.log(`[analyze] DOM saved (${(domHtml.length / 1024).toFixed(0)}KB)`);
  } catch (e) {
    console.error("[analyze] DOM dump failed:", e.message);
  }

  // Accessibility tree
  try {
    const a11y = await page.accessibility.snapshot({ interestingOnly: false });
    writeFileSync(path.join(reportDir, `a11y-${stepLabel}-${ts}.json`), JSON.stringify(a11y, null, 2));
    console.log("[analyze] a11y tree saved");
  } catch (e) {
    console.error("[analyze] a11y failed:", e.message);
  }

  // AI extraction: form fields with concrete selectors
  const formData = await stagehand.extract(
    "extract every interactive element on this page needed to complete the booking. " +
    "For each element provide: its visible label, its HTML id or name attribute (look at source), its type (select/input/checkbox/button), " +
    "all available options for dropdowns, current value if any. " +
    "Also note the exact URL and page title.",
    z.object({
      pageUrl: z.string(),
      pageTitle: z.string().optional(),
      fields: z.array(z.object({
        label: z.string(),
        htmlId: z.string().optional(),
        htmlName: z.string().optional(),
        cssSelector: z.string().optional(),
        type: z.enum(["select", "input", "checkbox", "button", "textarea", "other"]),
        options: z.array(z.string()).optional(),
        currentValue: z.string().optional(),
        required: z.boolean().optional(),
      })),
      buttons: z.array(z.object({
        label: z.string(),
        htmlId: z.string().optional(),
        action: z.string().optional(),
      })),
      pageNotes: z.string().optional(),
    })
  );

  // Screenshot (full page, high quality)
  const screenshotFile = await screenshot(`step-${stepLabel}`);

  const report = { timestamp: ts, step: stepLabel, url: page.url(), formData, screenshotFile, domSizeKb: (domHtml.length / 1024).toFixed(0) };
  writeFileSync(path.join(reportDir, `report-${stepLabel}-${ts}.json`), JSON.stringify(report, null, 2));
  console.log(`[analyze] report saved: report-${stepLabel}-${ts}.json`);

  // Post summary to Discord for easy review
  const summary = `📊 **Page analysis — ${stepLabel}**\nURL: \`${page.url()}\`\nFields:\n` +
    formData.fields.map(f =>
      `  • **${f.label}** (${f.type})${f.htmlId ? ` id=\`${f.htmlId}\`` : ""}${f.htmlName ? ` name=\`${f.htmlName}\`` : ""}` +
      (f.options?.length ? `\n    options: ${f.options.join(", ")}` : "") +
      (f.currentValue ? `  current: \`${f.currentValue}\`` : "")
    ).join("\n") +
    `\nButtons: ${formData.buttons.map(b => b.label).join(", ")}` +
    (formData.pageNotes ? `\nNotes: ${formData.pageNotes}` : "");

  await sendDiscord(summary.substring(0, 1900));
  return report;
}

// ─── Booking flow ─────────────────────────────────────────────────────────────

async function bookSlot(landingReport) {
  const page = getPage();
  console.log("[booking] starting booking flow...");

  try {
    // Step 1: select Tipo Prenotazione (first/only option)
    try {
      await stagehand.act(
        "in the 'Tipo Prenotazione' or 'tipo prenotazione' dropdown, select the first available option if nothing is selected yet"
      );
      await page.waitForTimeout(1000);
      await screenshot("step-02-tipo-selected");
      console.log("[booking] ✓ tipo prenotazione selected");
    } catch (e) {
      console.log("[booking] tipo prenotazione skip:", e.message);
    }

    // Step 2: accept privacy policy checkbox
    try {
      await stagehand.act("check the privacy policy checkbox (informativa sulla privacy) if not already checked");
      await page.waitForTimeout(800);
      await screenshot("step-03-privacy-checked");
      console.log("[booking] ✓ privacy accepted");
    } catch (e) {
      console.log("[booking] privacy checkbox skip:", e.message);
    }

    // Step 3: request OTP — analyze page before clicking
    await analyzeBookingPage("04-pre-otp");
    await stagehand.act("click the 'INVIA NUOVO CODICE' button to send the OTP verification code");
    await page.waitForTimeout(4000);
    await screenshot("step-05-otp-sent");
    console.log("[booking] ✓ OTP requested");

    // Step 4: analyze state after OTP send
    const postOtpReport = await analyzeBookingPage("06-post-otp");
    const { hasOtpInput, otpFieldSelector, pageState } = await stagehand.extract(
      "is there now a text input field to enter an OTP or verification code? if so, what is its id or name? describe the current page state.",
      z.object({
        hasOtpInput: z.boolean(),
        otpFieldSelector: z.string().optional().describe("css selector or id of the OTP input"),
        pageState: z.string(),
      })
    );
    console.log("[booking] OTP input detected:", hasOtpInput, otpFieldSelector);

    // Notify boss with full context
    const bookingUrl = page.url();
    await notify(
      "🔑 OTP RICHIESTO — AZIONE NECESSARIA",
      `Form compilato, privacy accettata, OTP inviato!\nControlla email/telefono per il codice e completalo tu:\n${bookingUrl}`
    );
    await sendDiscord(
      `🔑 **OTP inviato — azione richiesta!**\n` +
      `Ho compilato il form e accettato la privacy.\n` +
      `**Controlla email/SMS** per il codice OTP e completalo:\n<${bookingUrl}>\n\n` +
      `Stato pagina: ${pageState}\n` +
      (otpFieldSelector ? `Campo OTP: \`${otpFieldSelector}\`` : "")
    );

    // Step 5: keep page alive and poll for completion (5 min)
    console.log("[booking] waiting up to 5min for manual OTP entry...");
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(20_000);
      const { confirmed, stillWaiting } = await stagehand.extract(
        "has the booking been confirmed (look for confirmation number or success message)? or are we still on the OTP page?",
        z.object({ confirmed: z.boolean(), stillWaiting: z.boolean() })
      );
      if (confirmed) {
        const finalReport = await analyzeBookingPage("07-confirmed");
        await screenshot("step-07-confirmed");
        const confDetails = finalReport.formData.pageNotes || "confirmed!";
        await notify("✅ PRENOTAZIONE CONFERMATA!", `Passaporto Barcellona prenotato!\n${confDetails}`);
        await sendDiscord(`✅ **PRENOTAZIONE CONFERMATA!**\n${confDetails}`);
        console.log("✅ BOOKING CONFIRMED!");
        return;
      }
      if (!stillWaiting) break; // page changed unexpectedly
    }

    // Timeout — take final screenshot
    await screenshot("step-08-otp-timeout");
    await analyzeBookingPage("08-timeout");
    console.log("[booking] 5min timeout — boss needs to finish manually");

  } catch (err) {
    console.error("[booking] error:", err.message);
    await screenshot("step-error");
    try { await analyzeBookingPage("error"); } catch {}
    await notify("⚠️ Booking flow error", err.message.substring(0, 120));
  }
}
