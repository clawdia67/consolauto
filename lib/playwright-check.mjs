/**
 * playwright-check.mjs — free, deterministic Playwright check
 * Used 23h/day (00:30 – 23:30). No LLM calls, no API cost.
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { SITE, BOOKING_URL, SCREENSHOTS_DIR, COOKIES_FILE, EMAIL, PASSWORD, DIOCAN_INTERVAL_MS } from "./config.mjs";
import { notify, sendDiscord } from "./notify.mjs";
import { logEvent } from "./events.mjs";

mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// ─── State (shared with caller) ───────────────────────────────────────────────

let browserContext = null;
let checkCount = 0;
let errorCount = 0;
let consecutiveLoginFails = 0;
let loginBackoffUntil = 0;
export let lastDiocanAlert = Date.now();

// ─── Browser ──────────────────────────────────────────────────────────────────

export async function getBrowser() {
  if (browserContext) {
    try {
      await browserContext.pages();
      return browserContext;
    } catch {
      browserContext = null;
    }
  }
  browserContext = await chromium.launchPersistentContext(
    "/Users/bill/.openclaw/browser-profiles/esteri",
    {
      headless: false,
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      args: ["--no-sandbox"],
      viewport: { width: 1280, height: 800 },
    }
  );
  return browserContext;
}

export async function closeBrowser() {
  try { await browserContext?.close(); } catch {}
  browserContext = null;
}

export async function killStaleChrome() {
  const PROFILE_DIR = "/Users/bill/.openclaw/browser-profiles/esteri";
  try {
    const { exec: execCb2 } = await import("child_process");
    const { promisify } = await import("util");
    const ex = promisify(execCb2);
    await ex(`pkill -f "user-data-dir=${PROFILE_DIR}" 2>/dev/null || true`);
    await new Promise(r => setTimeout(r, 1500));
    console.log("[playwright] stale Chrome cleared");
  } catch {
    console.log("[playwright] no stale Chrome to clear");
  }
}

// Export cookies to JSON so Stagehand can pick them up when switching modes
export async function saveCookies() {
  if (!browserContext) return;
  try {
    const cookies = await browserContext.cookies();
    writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
    console.log(`[playwright] cookies saved (${cookies.length}) → ${COOKIES_FILE}`);
  } catch (e) {
    console.error("[playwright] cookie save error:", e.message);
  }
}

// ─── Login ────────────────────────────────────────────────────────────────────

async function login(page) {
  // Exponential backoff after consecutive login failures
  if (Date.now() < loginBackoffUntil) {
    const waitSec = Math.round((loginBackoffUntil - Date.now()) / 1000);
    console.log(`[login] backoff active — skipping for ${waitSec}s more`);
    throw new Error(`Login backoff active (${waitSec}s remaining)`);
  }

  console.log("[login] session expired, logging in...");
  await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(1500);

  // Check for Radware bot detection
  const bodyText = await page.evaluate(() => document.body?.innerText || "");
  if (bodyText.includes("temporarily restricted") || bodyText.includes("perfdrive") || bodyText.includes("CAPTCHA verification")) {
    consecutiveLoginFails++;
    const backoffMs = Math.min(60_000 * Math.pow(2, consecutiveLoginFails), 30 * 60_000); // max 30min
    loginBackoffUntil = Date.now() + backoffMs;
    console.log(`[login] Radware bot detection! Backoff ${backoffMs / 1000}s (fail #${consecutiveLoginFails})`);
    throw new Error(`Radware bot detection — backing off ${backoffMs / 1000}s`);
  }

  await page.click('a[href*="oauth2/authorize"], a:has-text("accedere")');
  // Wait for navigation away from prenotami to SSO
  await page.waitForFunction(() => !location.href.includes("prenotami.esteri.it") || location.href.includes("iam.esteri.it"), { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(3000);
  console.log("[login] after click, URL:", page.url());

  // Check for IAM forbidden / rate-limit block
  const iamUrl = page.url();
  if (iamUrl.includes("#/forbidden") || iamUrl.includes("/forbidden")) {
    consecutiveLoginFails++;
    const backoffMs = Math.min(15 * 60_000 * consecutiveLoginFails, 60 * 60_000); // 15min, 30min, max 60min
    loginBackoffUntil = Date.now() + backoffMs;
    console.error(`[login] IAM forbidden — IP rate-limited. Backoff ${backoffMs / 60_000}min (fail #${consecutiveLoginFails})`);
    throw new Error(`IAM forbidden (rate-limited) — backing off ${backoffMs / 60_000}min`);
  }

  // Try to find the email/username input — iam.esteri.it may use various input types
  const inputSel = 'input[type="email"], input[type="text"], input[name="username"], input[name="email"], input[id*="email" i], input[id*="user" i]';
  try {
    await page.waitForSelector(inputSel, { timeout: 25_000 });
  } catch {
    const diagUrl = page.url();
    const diagBody = (await page.evaluate(() => document.body?.innerText || "")).substring(0, 300);
    console.error("[login] input not found. URL:", diagUrl, "| Body:", diagBody);
    throw new Error(`Login input not found at ${diagUrl}`);
  }
  await page.fill('input[type="email"], input[type="text"], input[name="username"], input[name="email"], input[id*="email" i], input[id*="user" i]', EMAIL);
  const nextBtn = await page.$('button[type="submit"]');
  if (nextBtn) { await nextBtn.click(); await page.waitForTimeout(1500); }
  const pw = await page.$('input[type="password"]');
  if (pw) {
    await pw.fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(4000);
  }

  // Verify login actually worked
  const afterUrl = page.url();
  if (afterUrl.includes("signin") || afterUrl.includes("iam.esteri.it")) {
    consecutiveLoginFails++;
    const backoffMs = Math.min(60_000 * Math.pow(2, consecutiveLoginFails), 30 * 60_000);
    loginBackoffUntil = Date.now() + backoffMs;
    console.log(`[login] FAILED — still on signin page. Backoff ${backoffMs / 1000}s (fail #${consecutiveLoginFails})`);
    throw new Error(`Login failed — backing off ${backoffMs / 1000}s`);
  }

  // Success — reset backoff
  consecutiveLoginFails = 0;
  loginBackoffUntil = 0;
  console.log("[login] done, URL:", afterUrl);
}

async function ensureLoggedIn(page) {
  await page.goto(`${SITE}/UserArea`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(2000);
  const afterUrl = page.url();
  const bodyText = await page.evaluate(() => document.body.innerText);
  const isLoggedIn = afterUrl.includes("UserArea")
    && !bodyText.includes("EFFETTUARE IL LOGIN")
    && !bodyText.includes("Accedi\n");
  console.log(`[session] URL: ${afterUrl} | loggedIn: ${isLoggedIn}`);
  if (!isLoggedIn) await login(page);
}

// ─── Screenshot ───────────────────────────────────────────────────────────────

async function screenshot(page, name) {
  const ts = Date.now();
  const file = path.join(SCREENSHOTS_DIR, `${name}-${ts}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`[screenshot] ${file}`);
  return file;
}

// ─── Main check ───────────────────────────────────────────────────────────────

export async function checkSlots() {
  const context = await getBrowser();
  let page;

  try {
    const pages = context.pages();
    page = pages.length > 0 ? pages[0] : await context.newPage();
    for (const p of (pages.slice(1))) { try { await p.close(); } catch {} }

    await ensureLoggedIn(page);
    await page.goto(`${SITE}/Services`, { waitUntil: "networkidle", timeout: 45_000 });

    if (page.url().includes("perfdrive.com") || page.url().includes("radware") || page.url().includes("validate.perfdrive")) {
      consecutiveLoginFails++;
      const backoffMs = Math.min(60_000 * Math.pow(2, consecutiveLoginFails), 30 * 60_000);
      loginBackoffUntil = Date.now() + backoffMs;
      throw new Error(`Bot detection (Radware) — backing off ${backoffMs / 1000}s`);
    }
    if (!page.url().includes("Services")) {
      throw new Error("Failed to reach Services page: " + page.url());
    }

    try {
      await page.waitForSelector('a[href*="Booking/"]', { timeout: 25000 });
    } catch {
      const bodySnip = (await page.evaluate(() => document.body.innerText)).substring(0, 300);
      throw new Error(`Services table not rendered after 25s. Body: ${bodySnip}`);
    }

    const bookingLink = await page.$('a[href*="Booking/5810"]');
    if (!bookingLink) {
      throw new Error("Booking/5810 link not found");
    }

    let dialogMessage = null;
    page.once("dialog", async (dialog) => {
      dialogMessage = dialog.message();
      console.log("[dialog]", dialogMessage);
      await dialog.accept();
    });

    await bookingLink.click();
    await page.waitForTimeout(3000);

    // "esauriti" dialog
    if (dialogMessage?.toLowerCase().includes("esaurit")) {
      console.log(`[check #${++checkCount}] No slots — esauriti`);
      if (Date.now() - lastDiocanAlert >= DIOCAN_INTERVAL_MS) {
        lastDiocanAlert = Date.now();
        await notify("Consolauto", "diocan nessun posto nelle scorse 3 ore");
      }
      errorCount = 0;
      return;
    }

    // Check where we landed after clicking the booking link
    const currentUrl = page.url();

    // Session expired mid-check → redirected to Home (URL-encoded path in ReturnUrl)
    if (currentUrl.includes("/Home") || currentUrl.includes("iam.esteri.it") || currentUrl.includes("signin")) {
      console.log(`[check #${++checkCount}] No slots — session expired mid-click (redirect: ${currentUrl})`);
      errorCount = 0;
      return;
    }

    // Still on Services → no slot (no navigation happened)
    if (currentUrl.includes("/Services") && !currentUrl.includes("/Booking/")) {
      const bodyText = await page.evaluate(() => document.body.innerText);
      const reason = bodyText.includes("esaurit") ? "esauriti" : "no navigation";
      console.log(`[check #${++checkCount}] No slots — ${reason}`);
      if (Date.now() - lastDiocanAlert >= DIOCAN_INTERVAL_MS) {
        lastDiocanAlert = Date.now();
        await notify("Consolauto", "diocan nessun posto nelle scorse 3 ore");
      }
      errorCount = 0;
      return;
    }

    // 🎉 Slot found — only if we actually landed on a booking/calendar page
    if (!currentUrl.includes("/Booking/")) {
      // Unexpected URL — log and skip (defensive catch-all)
      console.log(`[check #${++checkCount}] No slots — unexpected URL: ${currentUrl}`);
      errorCount = 0;
      return;
    }

    console.log("🎉 SLOT FOUND! URL:", page.url());
    logEvent("slot_found", { url: page.url(), mode: "playwright" });
    await screenshot(page, "slot-01-landing");
    await notify("🎉 POSTO DISPONIBILE!", "Slot aperto su prenotami — passaporto Barcellona! Apri subito!");

    errorCount = 0;

  } catch (err) {
    console.error("[playwright error]", err.message);
    try { await browserContext?.close(); } catch {}
    browserContext = null;
    const isBackoff = err.message.includes("backoff") || err.message.includes("rate-limited") || err.message.includes("forbidden");
    if (!isBackoff) errorCount++;
    if (!isBackoff && (errorCount === 3 || (errorCount > 3 && errorCount % 10 === 0))) {
      await notify("⚠️ Consolauto Playwright Error", `Errore #${errorCount} consecutivi: ${err.message.substring(0, 100)}`);
    }
    throw err; // let caller handle
  } finally {
    try {
      if (page && !page.isClosed()) await page.goto("about:blank", { waitUntil: "domcontentloaded" });
    } catch {}
  }
}
