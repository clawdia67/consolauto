#!/usr/bin/env node
/**
 * obsidian-log.mjs — daily Obsidian slot log updater
 *
 * Reads events.jsonl for yesterday's slot_found events and appends
 * a row to /Volumes/obsidian-vaults/matlo/Consolauto/Slot Log.md
 *
 * Run via cron at 00:05 each day (logs the previous day's results).
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
const EVENTS_FILE = join(__dir, "events.jsonl");
const OBSIDIAN_NOTE = "/Volumes/obsidian-vaults/matlo/Consolauto/Slot Log.md";
const VAULT_PATH = "/Volumes/obsidian-vaults";

// ─── Ensure vault is mounted ──────────────────────────────────────────────────
function ensureVaultMounted() {
  try {
    const mounts = execSync("mount").toString();
    if (!mounts.includes(VAULT_PATH)) {
      console.log("[obsidian-log] vault not mounted, mounting...");
      execSync(`osascript -e 'mount volume "smb://100.120.163.53/obsidian-vaults"'`, { timeout: 15000 });
      // Wait for mount
      for (let i = 0; i < 15; i++) {
        execSync("sleep 1");
        const m = execSync("mount").toString();
        if (m.includes(VAULT_PATH)) {
          console.log("[obsidian-log] vault mounted");
          return true;
        }
      }
      console.error("[obsidian-log] mount timed out");
      return false;
    }
    return true;
  } catch (e) {
    console.error("[obsidian-log] mount error:", e.message);
    return false;
  }
}

// ─── Parse events for a given date (YYYY-MM-DD, Madrid time) ─────────────────
function getEventsForDate(dateStr) {
  if (!existsSync(EVENTS_FILE)) return [];
  const lines = readFileSync(EVENTS_FILE, "utf8").trim().split("\n").filter(Boolean);
  return lines.map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(e => {
    if (!e || e.type !== "slot_found") return false;
    // Convert UTC ts to Madrid time for date comparison
    const madridDate = new Date(e.ts).toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
    return madridDate === dateStr;
  });
}

// ─── Format Madrid time from ISO string ──────────────────────────────────────
function toMadridTime(isoStr) {
  return new Date(isoStr).toLocaleTimeString("es-ES", {
    timeZone: "Europe/Madrid",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

// ─── Append row to Obsidian table ─────────────────────────────────────────────
function appendTableRow(dateStr, slotEvents) {
  if (!existsSync(OBSIDIAN_NOTE)) {
    console.error("[obsidian-log] note not found:", OBSIDIAN_NOTE);
    return;
  }

  const content = readFileSync(OBSIDIAN_NOTE, "utf8");

  let slotsFound, times, mode, notes;
  if (slotEvents.length === 0) {
    slotsFound = "❌ No";
    times = "—";
    mode = "—";
    notes = "";
  } else {
    slotsFound = `✅ Yes (${slotEvents.length})`;
    times = slotEvents.map(e => toMadridTime(e.ts)).join(", ");
    mode = [...new Set(slotEvents.map(e => e.mode || "?"))].join("/");
    notes = "";
  }

  const row = `| ${dateStr} | ${slotsFound} | ${times} | ${mode} | ${notes} |`;

  // Insert before the closing empty line (after the header row)
  const updated = content.replace(
    /(\| Date \| Slots Found \|.*\n\|[-| ]+\|\n)/,
    `$1${row}\n`
  );

  if (updated === content) {
    // Fallback: just append at end
    writeFileSync(OBSIDIAN_NOTE, content + row + "\n");
  } else {
    writeFileSync(OBSIDIAN_NOTE, updated);
  }

  console.log(`[obsidian-log] row added for ${dateStr}: ${slotsFound} — ${times}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const dateStr = process.argv[2] || (() => {
  // Default: yesterday in Madrid time
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
})();

console.log(`[obsidian-log] processing date: ${dateStr}`);

const mounted = ensureVaultMounted();
if (!mounted) process.exit(1);

const events = getEventsForDate(dateStr);
console.log(`[obsidian-log] slot_found events for ${dateStr}: ${events.length}`);

appendTableRow(dateStr, events);
