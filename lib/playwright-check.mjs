/**
 * playwright-check.mjs — free, deterministic Playwright check
 * Used 23h/day (00:30 – 23:30). No LLM calls, no API cost.
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { SITE, BOOKING_URL, SCREENSHOTS_DIR, COOKIES_FILE, EMAIL, PASSWORD, DIOCAN_INTERVAL_MS } from "./config.mjs";
import { notify, sendDiscord } from "./notify.mjs";

mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// ─── State (shared with caller) ───────────────────────────────────────────────

let browserContext = null;
let checkCount = 0;
let errorCount = 0;
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
  console.log("[login] session expired, logging in...");
  await page.goto(SITE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.click('a[href*="oauth2/authorize"], a:has-text("accedere")');
  await page.waitForTimeout(3000);
  await page.waitForSelector('input[type="text"], input[type="email"]', { timeout: 8000 });
  await page.fill('input[type="text"], input[type="email"]', EMAIL);
  const nextBtn = await page.$('button[type="submit"]');
  if (nextBtn) { await nextBtn.click(); await page.waitForTimeout(1500); }
  const pw = await page.$('input[type="password"]');
  if (pw) {
    await pw.fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(4000);
  }
  console.log("[login] done, URL:", page.url());
}

async function ensureLoggedIn(page) {
  await page.goto(`${SITE}/UserArea`, { waitUntil: "domcontentloaded" });
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
    await page.goto(`${SITE}/Services`, { waitUntil: "networkidle" });

    if (page.url().includes("perfdrive.com") || page.url().includes("radware")) {
      throw new Error("Bot detection triggered (Radware). Retry next cycle.");
    }
    if (!page.url().includes("Services")) {
      throw new Error("Failed to reach Services page: " + page.url());
    }

    try {
      await page.waitForSelector('a[href*="Booking/"]', { timeout: 10000 });
    } catch {
      const bodySnip = (await page.evaluate(() => document.body.innerText)).substring(0, 300);
      throw new Error(`Services table not rendered after 10s. Body: ${bodySnip}`);
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
        await notify("Prenotami", "diocan nessun posto nelle scorse 3 ore");
      }
      errorCount = 0;
      return;
    }

    // Still on Services → no slot
    const currentUrl = page.url();
    if (currentUrl.includes("/Services") && !currentUrl.includes("/Services/Booking")) {
      const bodyText = await page.evaluate(() => document.body.innerText);
      const reason = bodyText.includes("esaurit") ? "esauriti" : "no navigation";
      console.log(`[check #${++checkCount}] No slots — ${reason}`);
      if (Date.now() - lastDiocanAlert >= DIOCAN_INTERVAL_MS) {
        lastDiocanAlert = Date.now();
        await notify("Prenotami", "diocan nessun posto nelle scorse 3 ore");
      }
      errorCount = 0;
      return;
    }

    // 🎉 Slot found
    console.log("🎉 SLOT FOUND! URL:", page.url());
    await screenshot(page, "slot-01-landing");
    await notify("🎉 POSTO DISPONIBILE!", "Slot aperto su prenotami — passaporto Barcellona! Apri subito!");

    errorCount = 0;

  } catch (err) {
    console.error("[playwright error]", err.message);
    errorCount++;
    try { await browserContext?.close(); } catch {}
    browserContext = null;
    if (errorCount <= 3 || errorCount % 10 === 0) {
      await notify("⚠️ Prenotami Playwright Error", `Errore #${errorCount}: ${err.message.substring(0, 100)}`);
    }
    throw err; // let caller handle
  } finally {
    try {
      if (page && !page.isClosed()) await page.goto("about:blank", { waitUntil: "domcontentloaded" });
    } catch {}
  }
}
