// Campaign tracker: a roster of contacts/NPCs and a list of loose ends, built up from every session's recap.
//
// Each session folder keeps what the AI found in it (campaign.json). Hand edits made in Discord or in
// Note Tiger are kept in data/<server>/campaign-edits.json. The current state is always rebuilt by replaying
// sessions and edits in time order, so rewriting a recap never adds anything twice.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CAMPAIGN_NAME, USE_CLAUDE } from './config.js';
import { listSessions, readJSON, writeJSON, guildDir, gidOf, getSettings, sessionLines, baseName } from './store.js';

const editsFile = (gid) => path.join(guildDir(gid), 'campaign-edits.json');
export const readEdits = (gid) => readJSON(editsFile(gid), []);
const sessionFile = (dir) => path.join(dir, 'campaign.json');

// "Mr. Johnson", "mr johnson" and "Mr Johnson" are the same person.
export const npcKey = (name) => String(name || '').toLowerCase().replace(/^(the|mr|mrs|ms|miss|dr)\.?\s+/, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

const nameScore = (n) => (String(n).match(/[A-Z]/g) || []).length * 100 + String(n).length;

const sessionTime = (s) => {
  const meta = readJSON(path.join(s.dir, 'meta.json'), {});
  return new Date(meta.startedAt || meta.date || 0).getTime() || 0;
};

// Replays everything. upTo: a session folder; stops just before that session (what was known going into it).
export function buildCampaign(gid, { upTo = null } = {}) {
  const sessions = listSessions(gid);
  const events = [];
  for (const s of sessions) {
    if (upTo && path.resolve(s.dir) === path.resolve(upTo)) break;
    const found = readJSON(sessionFile(s.dir), null);
    if (found) events.push({ t: sessionTime(s), kind: 'session', s, found });
  }
  const cutoff = upTo ? sessionTime({ dir: upTo }) : Infinity;
  for (const e of readEdits(gid)) if (e.t < cutoff) events.push({ t: e.t, kind: 'edit', e });
  events.sort((a, b) => a.t - b.t);

  const npcs = new Map();      // key -> contact
  const threads = new Map();   // id -> thread
  const removedNpcs = new Set();
  const removedThreads = new Set();
  const where = (s) => ({ id: path.basename(s.dir), title: s.title, date: s.date });

  for (const ev of events) {
    if (ev.kind === 'session') {
      const at = where(ev.s);
      for (const n of ev.found.npcs || []) {
        const key = npcKey(n.name);
        if (!key || removedNpcs.has(key)) continue;
        const c = npcs.get(key) || { key, name: n.name, who: '', attitude: '', first: at, history: [] };
        if (nameScore(n.name) > nameScore(c.name)) c.name = n.name;   // "Mr. Johnson" beats "mr johnson"
        if (n.who) c.who = n.who;
        if (n.attitude) c.attitude = n.attitude;
        c.last = at;
        if (n.happened) c.history.push({ ...at, text: n.happened });
        npcs.set(key, c);
      }
      for (const th of ev.found.threads || []) {
        if (removedThreads.has(th.id)) continue;
        threads.set(th.id, { id: th.id, text: th.text, opened: at, status: 'open' });
      }
      for (const r of ev.found.resolved || []) {
        const th = threads.get(r.id);
        if (th && th.status === 'open') Object.assign(th, { status: 'closed', closed: at, how: r.how || '' });
      }
    } else {
      const e = ev.e;
      const at = { id: null, title: /add$/.test(e.type) ? 'added by hand' : 'by hand', date: new Date(e.t).toISOString().slice(0, 10) };
      if (e.type === 'thread-add') threads.set(e.id, { id: e.id, text: e.text, opened: { ...at, by: e.by }, status: 'open' });
      else if (e.type === 'thread-close' && threads.has(e.id)) Object.assign(threads.get(e.id), { status: 'closed', closed: { ...at, by: e.by }, how: e.how || '' });
      else if (e.type === 'thread-reopen' && threads.has(e.id)) { const th = threads.get(e.id); th.status = 'open'; delete th.closed; delete th.how; }
      else if (e.type === 'thread-delete') { threads.delete(e.id); removedThreads.add(e.id); }
      else if (e.type === 'thread-edit' && threads.has(e.id)) threads.get(e.id).text = e.text;
      else if (e.type === 'npc-delete') { npcs.delete(e.key); removedNpcs.add(e.key); }
      else if (e.type === 'npc-edit' && npcs.has(e.key)) {
        const c = npcs.get(e.key);
        for (const f of ['who', 'attitude']) if (typeof e[f] === 'string') c[f] = e[f];
      } else if (e.type === 'npc-add') {
        const key = npcKey(e.name);
        removedNpcs.delete(key);
        if (!npcs.has(key)) npcs.set(key, { key, name: e.name, who: e.who || '', attitude: e.attitude || '', first: at, last: at, history: [] });
      }
    }
  }
  const contacts = [...npcs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const all = [...threads.values()];
  const open = all.filter((t) => t.status === 'open');
  const closed = all.filter((t) => t.status === 'closed').reverse();
  open.forEach((t, i) => { t.n = i + 1; });   // the numbers people use in /campaign close
  return { contacts, open, closed };
}

export function addEdit(gid, edit) {
  const edits = readEdits(gid);
  const e = { t: Date.now(), ...edit };
  if (e.type === 'thread-add') e.id = `h-${crypto.randomBytes(4).toString('hex')}`;
  edits.push(e);
  writeJSON(editsFile(gid), edits);
  return e;
}

// ---------- finding contacts and loose ends in a recap ----------
const CAMPAIGN_SYSTEM = `You keep the campaign notebook for ${CAMPAIGN_NAME}, a Shadowrun tabletop RPG game.
You get the recap of ONE session, the contacts/NPCs the team already knows, and the loose ends that are still open.
Reply with JSON only, exactly this shape:
{"npcs":[{"name":"...","who":"...","attitude":"...","happened":"..."}],
 "newLooseEnds":["..."],
 "resolved":[{"id":"T3","how":"..."}]}

npcs: every NAMED non-player character who appears in this session (people, spirits, AIs, named gangs or corps the
team dealt with directly). Not the player characters. If someone is already known, use the known name exactly.
  who: a few words, who/what they are ("fixer in Redmond", "Mr. Johnson for Ares"). Empty if nothing new.
  attitude: how they feel about the team now, a few words ("friendly", "owes us", "wants us dead"). Empty if unknown.
  happened: one short sentence on what happened with them THIS session.
newLooseEnds: new open questions, leads, debts, promises and threats from THIS session that the team may follow up
  on. One short sentence each. Don't repeat ones already in the open list.
resolved: open loose ends (by their id) that this session clearly settled, with a few words on how.
Never invent anything that isn't in the recap. Empty lists are fine.`;

function parseJSON(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Player names and runner names, so the players themselves never end up in the contact list.
function playerKeys(gid, dir) {
  const names = new Set(Object.values(getSettings(gid).characters || {}));
  for (const l of sessionLines(dir)) {
    names.add(baseName(l.speaker));
    const runner = String(l.speaker).match(/\(([^)]+)\)\s*$/)?.[1];
    if (runner && !/^GM\b/.test(runner)) names.add(runner);
  }
  return new Set([...names].map(npcKey).filter(Boolean));
}

// Reads a session's recap and saves what it found in campaign.json. askAI is passed in to avoid a circular import.
export async function updateCampaign(dir, recap, askAI) {
  const gid = gidOf(dir);
  const before = buildCampaign(gid, { upTo: dir });
  const known = before.contacts.map((c) => `- ${c.name}${c.who ? `: ${c.who}` : ''}`).join('\n') || '(none yet)';
  const ids = new Map(before.open.map((t) => [`T${t.n}`, t.id]));
  const open = before.open.map((t) => `[T${t.n}] ${t.text}`).join('\n') || '(none)';
  const budget = USE_CLAUDE ? 60_000 : 9_000;
  const user = `KNOWN CONTACTS:\n${known.slice(0, budget / 3)}\n\nOPEN LOOSE ENDS:\n${open.slice(0, budget / 3)}\n\n` +
    `THIS SESSION'S RECAP:\n${String(recap).slice(0, budget)}`;
  const raw = await askAI(CAMPAIGN_SYSTEM, user, 2500, { json: true });
  const data = parseJSON(raw);
  if (!data) throw new Error('the AI did not answer in the expected format');

  const players = playerKeys(gid, dir);
  const sid = path.basename(dir);
  const found = {
    updatedAt: new Date().toISOString(),
    npcs: (Array.isArray(data.npcs) ? data.npcs : [])
      .map((n) => ({ name: clean(n?.name, 60), who: clean(n?.who, 120), attitude: clean(n?.attitude, 60), happened: clean(n?.happened, 300) }))
      .filter((n) => n.name && !players.has(npcKey(n.name))),
    threads: (Array.isArray(data.newLooseEnds) ? data.newLooseEnds : [])
      .map((t) => clean(typeof t === 'string' ? t : t?.text, 250)).filter(Boolean).slice(0, 15)
      .map((text, i) => ({ id: `${sid}#${i + 1}`, text })),
    resolved: (Array.isArray(data.resolved) ? data.resolved : [])
      .map((r) => ({ id: ids.get(String(r?.id ?? '').trim().toUpperCase().replace(/^(\d+)$/, 'T$1')), how: clean(r?.how, 200) }))
      .filter((r) => r.id),
  };
  // Same person listed twice by the AI: keep one.
  const seen = new Set();
  found.npcs = found.npcs.filter((n) => { const k = npcKey(n.name); if (seen.has(k)) return false; seen.add(k); return true; });
  writeJSON(sessionFile(dir), found);
  console.log(`[campaign] ${found.npcs.length} contacts, ${found.threads.length} new loose ends, ${found.resolved.length} tied up`);
  return found;
}

// One line for the recap post: what changed this session.
export function campaignSummary(dir) {
  const found = readJSON(sessionFile(dir), null);
  if (!found) return '';
  const gid = gidOf(dir);
  const before = new Set(buildCampaign(gid, { upTo: dir }).contacts.map((c) => c.key));
  const fresh = found.npcs.filter((n) => !before.has(npcKey(n.name))).map((n) => n.name);
  const now = buildCampaign(gid);
  const bits = [];
  if (fresh.length) bits.push(`🕵️ New contacts: ${fresh.slice(0, 8).join(', ')}${fresh.length > 8 ? ` +${fresh.length - 8} more` : ''}`);
  const loose = [];
  if (found.threads.length) loose.push(`${found.threads.length} new`);
  if (found.resolved.length) loose.push(`${found.resolved.length} tied up`);
  bits.push(`🧵 Loose ends: ${now.open.length} open${loose.length ? ` (${loose.join(', ')} this session)` : ''}`);
  return `${bits.join('\n')}\n*See them with \`/campaign contacts\` and \`/campaign threads\`.*`;
}

// ---------- rules calls made during a session ----------
const rulesFile = (dir) => path.join(dir, 'rules.jsonl');
export function logRulesCall(dir, entry) {
  fs.appendFileSync(rulesFile(dir), JSON.stringify({ t: Date.now(), ...entry }) + '\n');
}
export function readRulesCalls(dir) {
  if (!fs.existsSync(rulesFile(dir))) return [];
  return fs.readFileSync(rulesFile(dir), 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// The answer's first block ("**Topic** — *Book*, p. 45" + 1–3 sentences), shortened to a line or two.
export function shortRule(answer) {
  const lines = String(answer).split('\n').map((l) => l.trim()).filter(Boolean);
  const stop = lines.findIndex((l) => /^also see/i.test(l));
  const body = (stop >= 0 ? lines.slice(0, stop) : lines);
  const head = body[0] || '';
  const rest = body.slice(1).join(' ');
  const sentence = rest.match(/^.{20,260}?[.!?](\s|$)/)?.[0]?.trim() || rest.slice(0, 260);
  return { head, sentence };
}

export function rulesSection(dir) {
  const calls = readRulesCalls(dir);
  if (!calls.length) return '';
  const items = calls.map((c) => {
    const { head, sentence } = shortRule(c.answer);
    return `• *“${clean(c.question, 150)}”* (${c.by || 'someone'})\n  ${head}${sentence ? ` — ${sentence}` : ''}`;
  });
  return `**📖 Rules Calls**\n${items.join('\n')}`;
}
