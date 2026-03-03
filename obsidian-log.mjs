#!/usr/bin/env node
/**
 * obsidian-log.mjs — daily Obsidian slot log updater
 *
 * Two modes (set via --mode):
 *
 *   --mode evening   (default, run at 23:50)
 *     Logs today's slot events (00:00–23:50 Madrid time).
 *     Server is up, so vault is reachable.
 *
 *   --mode catchup   (run at 08:15)
 *     Logs overnight events: yesterday 23:50 → today 07:59 Madrid time.
 *     This covers the 00:30–01:00 Stagehand window that runs while server is down.
 *     If no overnight events, does nothing (silent).
 *     If events found, appends a separate "🌙 overnight" row for that date.
 *
 * Manual usage:
 *   node obsidian-log.mjs --mode evening [--date YYYY-MM-DD]
 *   node obsidian-log.mjs --mode catchup
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
const EVENTS_FILE = join(__dir, "events.jsonl");
const OBSIDIAN_NOTE = "/Volumes/obsidian-vaults/matlo/Consolauto/Slot Log.md";
const VAULT_PATH = "/Volumes/obsidian-vaults";
const SMB_SHARE = "smb://100.120.163.53/obsidian-vaults";

// ─── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const mode = args.includes("--mode") ? args[args.indexOf("--mode") + 1] : "evening";
const dateArg = args.includes("--date") ? args[args.indexOf("--date") + 1] : null;

// ─── Vault mount ─────────────────────────────────────────────────────────────
function ensureVaultMounted() {
  try {
    const mounts = execSync("mount").toString();
    if (mounts.includes(VAULT_PATH)) return true;
    console.log("[obsidian-log] vault not mounted, mounting...");
    execSync(`osascript -e 'mount volume "${SMB_SHARE}"'`, { timeout: 15000 });
    for (let i = 0; i < 15; i++) {
      execSync("sleep 1");
      if (execSync("mount").toString().includes(VAULT_PATH)) {
        console.log("[obsidian-log] vault mounted");
        return true;
      }
    }
    console.error("[obsidian-log] mount timed out");
    return false;
  } catch (e) {
    console.error("[obsidian-log] mount error:", e.message);
    return false;
  }
}

// ─── Event parsing ────────────────────────────────────────────────────────────
function loadEvents() {
  if (!existsSync(EVENTS_FILE)) return [];
  return readFileSync(EVENTS_FILE, "utf8")
    .trim().split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function madridDate(isoStr) {
  return new Date(isoStr).toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
}

function madridTime(isoStr) {
  return new Date(isoStr).toLocaleTimeString("es-ES", {
    timeZone: "Europe/Madrid",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

// events for a date between two Madrid times (HH:MM)
function getEventsForDate(dateStr, fromTime = "00:00", toTime = "23:59") {
  const fromMs = new Date(`${dateStr}T${fromTime}:00+01:00`).getTime();
  const toMs   = new Date(`${dateStr}T${toTime}:59+01:00`).getTime();
  return loadEvents().filter(e => {
    if (e.type !== "slot_found") return false;
    const t = new Date(e.ts).getTime();
    return t >= fromMs && t <= toMs;
  });
}

// ─── Table row writer ─────────────────────────────────────────────────────────
function appendRow(dateLabel, slotEvents, rowNote = "") {
  if (!existsSync(OBSIDIAN_NOTE)) {
    console.error("[obsidian-log] note not found:", OBSIDIAN_NOTE);
    return false;
  }

  const slotsFound = slotEvents.length === 0
    ? "❌ No"
    : `✅ Yes (${slotEvents.length})`;
  const times = slotEvents.length === 0
    ? "—"
    : slotEvents.map(e => madridTime(e.ts)).join(", ");
  const modeStr = slotEvents.length === 0
    ? "—"
    : [...new Set(slotEvents.map(e => e.mode || "?"))].join("/");

  const row = `| ${dateLabel} | ${slotsFound} | ${times} | ${modeStr} | ${rowNote} |`;
  const content = readFileSync(OBSIDIAN_NOTE, "utf8");

  // Insert after header separator row
  const updated = content.replace(
    /(\| Date \| Slots Found \|.*\n\|[-| ]+\|\n)/,
    `$1${row}\n`
  );
  writeFileSync(OBSIDIAN_NOTE, updated === content ? content + row + "\n" : updated);
  console.log(`[obsidian-log] appended: ${dateLabel} | ${slotsFound} | ${times}`);
  return true;
}

// Check if a row for this date label already exists
function rowExists(dateLabel) {
  if (!existsSync(OBSIDIAN_NOTE)) return false;
  return readFileSync(OBSIDIAN_NOTE, "utf8").includes(`| ${dateLabel} |`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
console.log(`[obsidian-log] mode: ${mode}`);

if (mode === "evening") {
  // Log today 00:00–23:50
  const today = dateArg || new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
  console.log(`[obsidian-log] evening run for: ${today}`);

  if (rowExists(today)) {
    console.log(`[obsidian-log] row for ${today} already exists, skipping`);
    process.exit(0);
  }

  if (!ensureVaultMounted()) process.exit(1);

  const events = getEventsForDate(today, "00:00", "23:50");
  console.log(`[obsidian-log] events found: ${events.length}`);
  appendRow(today, events);

} else if (mode === "catchup") {
  // Check for overnight events: yesterday 23:50 → today 07:59
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
  const label = `${yesterdayStr} 🌙`;

  console.log(`[obsidian-log] catchup checking overnight for: ${yesterdayStr}`);

  // overnight window: yesterday 23:50 → today 07:59
  // We use a broader check: events on yesterday's date between 23:50-23:59
  // AND events on today's date between 00:00-07:59
  const todayStr = now.toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
  const overnightEvents = [
    ...getEventsForDate(yesterdayStr, "23:50", "23:59"),
    ...getEventsForDate(todayStr, "00:00", "07:59"),
  ];

  if (overnightEvents.length === 0) {
    console.log("[obsidian-log] no overnight slot events, nothing to do");
    process.exit(0);
  }

  console.log(`[obsidian-log] overnight slot events found: ${overnightEvents.length}`);

  if (rowExists(label)) {
    console.log(`[obsidian-log] overnight row already exists, skipping`);
    process.exit(0);
  }

  if (!ensureVaultMounted()) process.exit(1);

  appendRow(label, overnightEvents, "server was down, logged at 08:15");

} else {
  console.error(`[obsidian-log] unknown mode: ${mode}. Use --mode evening or --mode catchup`);
  process.exit(1);
}
