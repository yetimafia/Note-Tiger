// Alerts: a Discord DM to whoever runs Note Tiger when something goes wrong (the bot crashed, it can't hear
// anyone during a session, a recap failed). Sent through Discord's web API with the bot's token, so the manager
// can send one even when the bot itself is down.
import path from 'node:path';
import { DATA_DIR, DISCORD_TOKEN, ALERTS_ENABLED, ALERT_USER_ID } from './config.js';
import { readJSON, writeJSON } from './store.js';

const STATE = path.join(DATA_DIR, 'alerts.json');      // shared by the manager and the bot: no repeats
const QUIET_MS = 30 * 60_000;                           // the same kind of alert at most every 30 minutes
const API = process.env.DISCORD_API || 'https://discord.com/api/v10';

async function discord(method, route, body) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { Authorization: `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'NoteTiger (alerts)' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Discord ${res.status}: ${data.message || res.statusText}`);
  return data;
}

let ownerId = null;
async function who() {
  if (ALERT_USER_ID) return ALERT_USER_ID;
  if (ownerId) return ownerId;
  const app = await discord('GET', '/oauth2/applications/@me');
  ownerId = app.team?.owner_user_id || app.owner?.id || null;   // the bot's owner in the Developer Portal
  return ownerId;
}

// kind: a short id for rate limiting ('crash', 'silent:<server>', 'recap'). text: the message.
export async function sendAlert(kind, text) {
  if (!ALERTS_ENABLED || !DISCORD_TOKEN) return false;
  const st = readJSON(STATE, {});
  if (st[kind] && Date.now() - st[kind] < QUIET_MS) return false;
  writeJSON(STATE, { ...st, [kind]: Date.now() });
  try {
    const user = await who();
    if (!user) throw new Error('could not work out who owns the bot');
    const dm = await discord('POST', '/users/@me/channels', { recipient_id: user });
    await discord('POST', `/channels/${dm.id}/messages`, { content: `🐯 **Note Tiger alert**\n${text}`.slice(0, 1990) });
    console.log(`[alert] sent: ${kind}`);
    return true;
  } catch (err) {
    console.error(`[alert] couldn't send (${kind}): ${err.message}`);
    return false;
  }
}

export function testAlert() {
  const st = readJSON(STATE, {});
  delete st.test;
  writeJSON(STATE, st);
  return sendAlert('test', '✅ This is a test. If you can read this, Note Tiger can reach you when something goes wrong.');
}
