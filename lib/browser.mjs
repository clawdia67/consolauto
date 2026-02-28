/**
 * browser.mjs — Stagehand setup + cookie persistence
 *
 * We use Stagehand LOCAL mode (no Browserbase cloud) but save/restore
 * cookies from disk so sessions survive restarts — same benefit as
 * Playwright's launchPersistentContext, but cleaner.
 */
import { Stagehand } from "@browserbasehq/stagehand";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { mkdirSync } from "fs";
import path from "path";
import { SCREENSHOTS_DIR, COOKIES_FILE, EMAIL, PASSWORD, SITE } from "./config.mjs";
import { z } from "zod";

mkdirSync(SCREENSHOTS_DIR, { recursive: true });
mkdirSync(path.dirname(COOKIES_FILE), { recursive: true });

let stagehand = null;

function loadCookies() {
  if (!existsSync(COOKIES_FILE)) return [];
  try {
    return JSON.parse(readFileSync(COOKIES_FILE, "utf8"));
  } catch {
    return [];
  }
}

async function saveCookies() {
  if (!stagehand) return;
  try {
    const cookies = await stagehand.page.context().cookies();
    writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
    console.log(`[cookies] saved ${cookies.length} cookies`);
  } catch (e) {
    console.error("[cookies] save error:", e.message);
  }
}

export async function initBrowser() {
  stagehand = new Stagehand({
    env: "LOCAL",
    model: "google/gemini-3-flash-preview",
    verbose: 1,
    headless: false,
  });

  await stagehand.init();

  // Restore saved cookies (if any)
  const savedCookies = loadCookies();
  if (savedCookies.length > 0) {
    await stagehand.page.context().addCookies(savedCookies);
    console.log(`[cookies] restored ${savedCookies.length} cookies`);
  }

  return stagehand;
}

export async function closeBrowser() {
  if (!stagehand) return;
  await saveCookies();
  try { await stagehand.close(); } catch {}
  stagehand = null;
}

export function getStagehand() {
  return stagehand;
}

// ─── Login ────────────────────────────────────────────────────────────────────

export async function ensureLoggedIn() {
  const sh = getStagehand();
  const page = sh.page;

  // Check login state
  await page.goto(`${SITE}/UserArea`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  const loginState = await sh.extract(
    "is the user logged in? look for a dashboard, booking options, or a logout button vs a login prompt or 'EFFETTUARE IL LOGIN' message",
    z.object({
      loggedIn: z.boolean(),
      hint: z.string().describe("brief description of what you see"),
    })
  );

  console.log(`[session] loggedIn: ${loginState.loggedIn} | ${loginState.hint}`);

  if (!loginState.loggedIn) {
    console.log("[login] starting login flow...");
    await page.goto(SITE, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);

    // Click the login/access link
    await sh.act("click the login or 'accedere' or 'accedi' link");
    await page.waitForTimeout(3000);

    // Fill credentials — variables are NOT sent to LLM
    await sh.act("type %email% in the email or username field", { variables: { email: EMAIL } });

    // Some flows have a "next" step before password
    try {
      await sh.act("click the next or avanti or submit button if visible");
      await page.waitForTimeout(1500);
    } catch {}

    await sh.act("type %password% in the password field", { variables: { password: PASSWORD } });
    await sh.act("click the login or accedi or submit button");
    await page.waitForTimeout(4000);

    await saveCookies();
    console.log("[login] done, URL:", page.url());
  }
}

// ─── Screenshot helper ────────────────────────────────────────────────────────

export async function screenshot(name) {
  const sh = getStagehand();
  const ts = Date.now();
  const file = path.join(SCREENSHOTS_DIR, `${name}-${ts}.png`);
  await sh.page.screenshot({ path: file, fullPage: true });
  console.log(`[screenshot] saved: ${file}`);
  return file;
}
