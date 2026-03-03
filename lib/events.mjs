/**
 * events.mjs — structured event logger for Obsidian slot log
 * Appends JSON lines to consolauto/events.jsonl
 * Types: "slot_found" | "no_slot" | "startup" | "error"
 */
import { appendFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
const EVENTS_FILE = join(__dir, "..", "events.jsonl");

export function logEvent(type, data = {}) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), type, ...data });
  try {
    appendFileSync(EVENTS_FILE, entry + "\n");
  } catch (e) {
    console.error("[events] write error:", e.message);
  }
}
