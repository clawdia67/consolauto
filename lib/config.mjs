/**
 * config.mjs — central config, read from .env
 */
import "dotenv/config";

export const SITE = "https://prenotami.esteri.it";
export const BOOKING_URL = `${SITE}/Services/Booking/5810`;
export const CHECK_INTERVAL_MS = 60_000;          // 1 minute
export const DIOCAN_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours

// Credentials — set in .env
export const EMAIL    = process.env.PRENOTAMI_EMAIL    || "";
export const PASSWORD = process.env.PRENOTAMI_PASSWORD || "";

// Pinger
export const PINGER_USER = process.env.PINGER_USER || "matlo";
export const PINGER_URL  = process.env.PINGER_URL  || "https://us-central1-clawdia-pinger.cloudfunctions.net/notify";

// Discord
export const DISCORD_TOKEN   = process.env.DISCORD_TOKEN   || "";
export const DISCORD_CHANNEL = process.env.DISCORD_CHANNEL || "";

// Dirs
export const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || "./screenshots";
export const COOKIES_FILE    = process.env.COOKIES_FILE    || "./cookies.json";
