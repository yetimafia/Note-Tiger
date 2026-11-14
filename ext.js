// The connection API: lets another program (like the Dungeon Delve game) use Note Tiger without being part of it.
// Its own small web server, off unless turned on in Settings → Connections, and every request needs the key.
//
//   Base address:  http://localhost:3081/v1   (or http://<this PC's address>:3081/v1 with "allow other PCs" on)
//   Key:           header  Authorization: Bearer <key>   (or X-Api-Key: <key>)
//
// Settings are read fresh on every request, so turning it on/off or changing the key works without a restart.
// Only the address (port, and whether other PCs may connect) needs a restart.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { APP_DIR, DATA_DIR, DISCORD_TOKEN, RECAP_CHANNEL } from './config.js';

const ENV_FILE = path.join(APP_DIR, '.env');
export function connectSettings() {
  let env = {};
  try { env = dotenv.parse(fs.readFileSync(ENV_FILE)); } catch { /* none */ }
  return {
    enabled: env.CONNECT_ENABLED === 'true' && Boolean(env.CONNECT_KEY),
    key: env.CONNECT_KEY || '',
    port: Number(env.CONNECT_PORT || 3081),
    lan: env.CONNECT_LAN === 'true',
  };
}
export const newConnectKey = () => crypto.randomBytes(24).toString('base64url');

// ---------- dungeon runs (their own folder; recorded sessions aren't touched) ----------
const runsDir = (gid) => path.join(DATA_DIR, String(gid).replace(/\D/g, ''), 'runs');
const RUN_SYSTEM = `You write the recap of a quick dungeon crawl (a pickup D&D game) from its event log, for the players to
read in Discord. Keep it short and fun: a title line, then 2–4 short paragraphs telling what happened floor by floor
(the fights that mattered, close calls, who saved whom, the loot), then "**Party:**" with each character and how they
ended up, and "**Result:**" (how deep they got, and whether they won or fell). Use only what the log says; don't
invent events. Discord markdown, no headings bigger than bold.`;

async function postToRecaps(gid, text) {
  if (!DISCORD_TOKEN) return false;
  const api = process.env.DISCORD_API || 'https://discord.com/api/v10';
  const headers = { Authorization: `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'NoteTiger (connections)' };
  const chans = await (await fetch(`${api}/guilds/${gid}/channels`, { headers })).json();
  const ch = Array.isArray(chans) && chans.find((c) => c.type === 0 && c.name === RECAP_CHANNEL);
  if (!ch) return false;
  // Discord's limit is 2,000 characters a message: split on paragraphs.
  const parts = [];
  let cur = '';
  for (const para of text.split('\n')) {
    if ((cur + '\n' + para).length > 1900) { parts.push(cur); cur = para; } else cur = cur ? `${cur}\n${para}` : para;
  }
  if (cur) parts.push(cur);
  for (const content of parts) {
    const r = await fetch(`${api}/channels/${ch.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) });
    if (!r.ok) throw new Error(`Discord ${r.status}`);
  }
  return true;
}

export function listRuns(gid) {
  const dir = runsDir(gid);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    try { const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return { id: r.id, title: r.title, outcome: r.outcome, at: r.at, status: r.status }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
export function getRun(gid, id) {
  try { return JSON.parse(fs.readFileSync(path.join(runsDir(gid), `${String(id).replace(/[^\w-]/g, '')}.json`), 'utf8')); } catch { return null; }
}

// Saves the run right away, then writes (and posts) its recap in the background.
function startRun(gid, body, askAI) {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${crypto.randomBytes(3).toString('hex')}`;
  const events = (Array.isArray(body.events) ? body.events : []).map((e) => (typeof e === 'string' ? { text: e } : { at: e.at, text: String(e.text || '') })).filter((e) => e.text);
  const run = {
    id, at: new Date().toISOString(), title: String(body.title || 'Dungeon run').slice(0, 120), outcome: String(body.outcome || '').slice(0, 200),
    party: Array.isArray(body.party) ? body.party.map(String).slice(0, 12) : [], floors: Number(body.floors) || null,
    source: String(body.source || 'connection').slice(0, 60), events, status: 'writing', recap: '', posted: false,
  };
  fs.mkdirSync(runsDir(gid), { recursive: true });
  const file = path.join(runsDir(gid), `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(run, null, 2));
  (async () => {
    try {
      // The newest events matter most if the log is long.
      let log = events.map((e) => `- ${e.text}`).join('\n');
      if (log.length > 24_000) log = `(earlier events cut)\n${log.slice(-24_000)}`;
      run.recap = (await askAI(RUN_SYSTEM, `RUN: ${run.title}\nPARTY: ${run.party.join(', ') || 'unknown'}\nOUTCOME: ${run.outcome || 'unknown'}\n\nEVENT LOG:\n${log}`, 1500)).trim();
      run.status = 'done';
      if (body.post !== false && run.recap) run.posted = await postToRecaps(gid, `🗝️ **${run.title}**\n${run.recap}`).catch((e) => { run.postError = e.message; return false; });
    } catch (err) {
      run.status = 'failed'; run.error = err.message;
    }
    fs.writeFileSync(file, JSON.stringify(run, null, 2));
    console.log(`[connections] run recap ${run.status}: ${run.title}${run.posted ? ' (posted)' : ''}`);
  })();
  return { id, status: 'writing' };
}

// ---------- the server ----------
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
async function readJson(req) {
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 2e6) throw new Error('Request too big.'); }
  return raw ? JSON.parse(raw) : {};
}
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// api: functions from the manager (characters, rules, AI). Returns the server.
export function startConnections(api) {
  const boot = connectSettings();
  const server = http.createServer(async (req, res) => {
    const cfg = connectSettings();
    if (!cfg.enabled) return send(res, 503, { error: 'Connections are off. Turn them on in Note Tiger → Settings → Connections.' });
    const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || '';
    if (!given || !same(String(given), cfg.key)) return send(res, 401, { error: 'Wrong or missing key.' });
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean); // ['v1', ...]
    const q = (k) => url.searchParams.get(k);
    if (p[0] !== 'v1') return send(res, 404, { error: 'Use /v1/…' });
    try {
      const r = p.slice(1);
      const gidOf = (b) => String(b?.server || q('server') || api.defaultServer() || '');
      // GET /v1/info, GET /v1/servers
      if (r[0] === 'info' && req.method === 'GET') return send(res, 200, api.info());
      if (r[0] === 'servers' && req.method === 'GET') return send(res, 200, { servers: api.servers() });

      // The player website: GET /v1/site, POST /v1/site/live { url, token, title } or { offline: true }
      if (r[0] === 'site' && !r[1] && req.method === 'GET') return send(res, 200, api.site());
      if (r[0] === 'site' && r[1] === 'live' && req.method === 'POST') { const b = await readJson(req); return send(res, 200, await api.publishLive(b)); }
      // Characters
      if (r[0] === 'characters') {
        if (r[1] === 'random' && req.method === 'POST') {
          const b = await readJson(req);
          const gid = gidOf(b);
          const n = Math.max(1, Math.min(8, Number(b.count) || 1));
          const out = [];
          for (let i = 0; i < n; i++) out.push(api.randomCharacter(gid, b));
          return send(res, 200, { characters: out });
        }
        if (!r[1] && req.method === 'GET') {
          const tag = q('tag');
          return send(res, 200, { characters: api.characters(gidOf()).filter((c) => !tag || c.tag === tag) });
        }
        if (!r[1] && req.method === 'POST') { const b = await readJson(req); return send(res, 200, { character: api.saveCharacter(gidOf(b), b.character || b) }); }
        const id = r[1];
        if (r[2] === 'track' && req.method === 'POST') { const b = await readJson(req); return send(res, 200, api.track(gidOf(b), id, b)); }
        if (r[2] === 'pdf' && req.method === 'GET') {
          const { pdf, fileName } = await api.pdf(gidOf(), id, q('sheet') || '');
          res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}` });
          return res.end(pdf);
        }
        if (!r[2] && req.method === 'GET') { const c = api.character(gidOf(), id); return c ? send(res, 200, { character: c }) : send(res, 404, { error: 'No such character.' }); }
        if (!r[2] && req.method === 'PUT') { const b = await readJson(req); return send(res, 200, { character: api.saveCharacter(gidOf(b), { ...(b.character || b), id }) }); }
        if (!r[2] && req.method === 'DELETE') return send(res, 200, { ok: api.deleteCharacter(gidOf(), id) });
      }

      // Rules: search the rulebooks, ask a question, SRD spells.
      if (r[0] === 'rules') {
        if (r[1] === 'search' && req.method === 'GET') return send(res, 200, { results: api.searchRules(q('q') || '', gidOf(), Number(q('limit')) || 6) });
        if (r[1] === 'ask' && req.method === 'POST') { const b = await readJson(req); return send(res, 200, await api.askRules(String(b.question || ''), gidOf(b))); }
        if (r[1] === 'spells' && req.method === 'GET') return send(res, 200, { spells: api.spells(q('edition'), q('class'), q('level')) });
      }

      // Runs: send a finished run, get its recap.
      if (r[0] === 'runs') {
        if (!r[1] && req.method === 'POST') { const b = await readJson(req); return send(res, 202, startRun(gidOf(b), b, api.askAI)); }
        if (!r[1] && req.method === 'GET') return send(res, 200, { runs: listRuns(gidOf()) });
        if (r[1] && req.method === 'GET') { const run = getRun(gidOf(), r[1]); return run ? send(res, 200, run) : send(res, 404, { error: 'No such run.' }); }
      }
      return send(res, 404, { error: 'Not found. See the README section "Connecting other programs".' });
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  });
  server.on('error', (err) => console.error(`[connections] couldn't open port ${boot.port}:`, err.message));
  server.listen(boot.port, boot.lan ? '0.0.0.0' : '127.0.0.1', () => console.log(`[connections] listening on ${boot.lan ? 'the network' : 'localhost'}:${boot.port} (${boot.enabled ? 'on' : 'off'})`));
  return server;
}
