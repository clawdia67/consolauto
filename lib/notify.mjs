/**
 * notify.mjs — Pinger + Discord notifications
 */
import { exec as execCb } from "child_process";
import { promisify } from "util";
import { PINGER_USER, PINGER_URL, DISCORD_TOKEN, DISCORD_CHANNEL, BOOKING_URL } from "./config.mjs";

const exec = promisify(execCb);

export async function sendPinger(title, message, url = null) {
  const payload = { title, message, to: PINGER_USER };
  if (url) payload.url = url;
  try {
    const { stdout } = await exec(
      `curl -s -X POST "${PINGER_URL}" -H 'Content-Type: application/json' -d '${JSON.stringify(payload).replace(/'/g, "'\\''")}'`
    );
    console.log(`[pinger] ${stdout.trim()}`);
  } catch (e) {
    console.error("[pinger] error:", e.message);
  }
}

export async function sendDiscord(message) {
  if (!DISCORD_TOKEN || !DISCORD_CHANNEL) return;
  const payload = JSON.stringify({ content: message });
  try {
    const { stdout } = await exec(
      `curl -s -X POST "https://discord.com/api/v10/channels/${DISCORD_CHANNEL}/messages" \
        -H "Authorization: Bot ${DISCORD_TOKEN}" \
        -H "Content-Type: application/json" \
        -d '${payload.replace(/'/g, "'\\''")}'`
    );
    console.log(`[discord] ${stdout.trim().substring(0, 120)}`);
  } catch (e) {
    console.error("[discord] error:", e.message);
  }
}

export async function notify(title, body, url = BOOKING_URL) {
  console.log(`[notify] ${title}: ${body}`);
  await Promise.all([
    sendPinger(title, body, url),
    sendDiscord(url ? `${body}\n${url}` : body),
  ]);
}
