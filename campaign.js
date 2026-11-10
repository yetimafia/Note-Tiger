// Campaign tracker: a roster of contacts/NPCs and a list of loose ends, built up from every session's recap.
//
// Each session folder keeps what the AI found in it (campaign.json). Hand edits made in Discord or in
// Note Tiger are kept in data/<server>/campaign-edits.json. The current state is always rebuilt by replaying
// sessions and edits in time order, so rewriting a recap never adds anything twice.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CAMPAIGN_NAME, USE_CLAUDE } from './config.js';
import { listSessions, readJSON, writeJSON, guildDir, gidOf, getSettings, sessionLines, baseName, sessionStats, speakerColors, readLabels, lineKey } from './store.js';
import { setCampaignNames, knownNames } from './spelling.js';

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
  const places = new Map();    // key -> place
  const runners = new Map();   // key -> runner profile
  const jobs = new Map();      // key -> job
  const removedJobs = new Set();
  const removedPlaces = new Set();
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
      for (const [name, card] of Object.entries(readJSON(path.join(ev.s.dir, 'voices.json'), {}))) {
        const key = npcKey(name);
        if (!key || removedNpcs.has(key)) continue;
        const c = npcs.get(key) || { key, name, who: '', attitude: '', first: at, history: [] };
        const lines = [...(c.card?.lines || []), ...(card.lines || [])];
        c.card = { ...(c.card || {}), ...Object.fromEntries(Object.entries(card).filter(([, v]) => v)), lines: [...new Set(lines)].slice(-6), at };
        c.last = c.last || at;
        npcs.set(key, c);
      }
      for (const p of ev.found.places || []) {
        const key = npcKey(p.name);
        if (!key || removedPlaces.has(key)) continue;
        const c = places.get(key) || { key, name: p.name, what: '', first: at, history: [] };
        if (nameScore(p.name) > nameScore(c.name)) c.name = p.name;
        if (p.what) c.what = p.what;
        c.last = at;
        if (p.happened) c.history.push({ ...at, text: p.happened });
        places.set(key, c);
      }
      for (const r of ev.found.runners || []) {
        const key = npcKey(r.name);
        const c = runners.get(key) || { key, name: r.name, first: at, sessions: [], gear: [], status: '' };
        c.last = at;
        c.sessions.push({ ...at, did: r.did, moment: r.moment, talkPct: r.talkPct });
        for (const g of r.gear || []) if (!c.gear.some((x) => npcKey(x) === npcKey(g))) c.gear.push(g);
        c.status = r.status || '';
        runners.set(key, c);
      }
      for (const j of ev.found.jobs || []) {
        const key = npcKey(j.name);
        if (!key || removedJobs.has(key)) continue;
        const c = jobs.get(key) || { key, name: j.name, first: at, sessions: [] };
        for (const f of ['johnson', 'task', 'payOffered', 'payReceived', 'status', 'outcome', 'complications']) if (j[f]) c[f] = j[f];
        if (!c.sessions.some((x) => x.id === at.id)) c.sessions.push(at);
        c.last = at;
        jobs.set(key, c);
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
      } else if (e.type === 'job-delete') { jobs.delete(e.key); removedJobs.add(e.key); }
      else if (e.type === 'job-edit' && jobs.has(e.key)) {
        const c = jobs.get(e.key);
        for (const f of ['status', 'payReceived', 'outcome']) if (typeof e[f] === 'string') c[f] = e[f];
      } else if (e.type === 'place-delete') { places.delete(e.key); removedPlaces.add(e.key); }
      else if (e.type === 'place-edit' && places.has(e.key)) { if (typeof e.what === 'string') places.get(e.key).what = e.what; }
      else if (e.type === 'place-add') {
        const key = npcKey(e.name);
        removedPlaces.delete(key);
        if (!places.has(key)) places.set(key, { key, name: e.name, what: e.what || '', first: at, last: at, history: [] });
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
  // Runner profiles: who plays them and their color come from the transcripts and settings.
  const roster = runners.size ? runnerRoster(gid) : new Map();
  const colors = runners.size ? speakerColors(gid, []) : {};
  const runnerList = [...runners.values()].map((r) => {
    const player = roster.get(r.name) || null;
    return { ...r, player, color: (player && colors[player]) || null, gear: r.gear.slice(-30) };
  }).sort((a, b) => b.sessions.length - a.sessions.length || a.name.localeCompare(b.name));
  return { contacts, places: [...places.values()].sort((a, b) => a.name.localeCompare(b.name)), runners: runnerList,
    jobs: [...jobs.values()].reverse(), open, closed };
}

// Contact and place names feed the spelling fixer.
setCampaignNames((gid) => { const c = buildCampaign(gid); return [...c.contacts, ...c.places].map((x) => x.name); });

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
 "places":[{"name":"...","what":"...","happened":"..."}],
 "runners":[{"name":"...","did":"...","moment":"...","gear":["..."],"status":"..."}],
 "jobs":[{"name":"...","johnson":"...","task":"...","payOffered":"...","payReceived":"...","status":"...","outcome":"...","complications":"..."}],
 "newLooseEnds":["..."],
 "resolved":[{"id":"T3","how":"..."}]}

npcs: every NAMED non-player character who appears in this session (people, spirits, AIs, named gangs or corps the
team dealt with directly). Not the player characters. If someone is already known, use the known name exactly.
  who: a few words, who/what they are ("fixer in Redmond", "Mr. Johnson for Ares"). Empty if nothing new.
  attitude: how they feel about the team now, a few words ("friendly", "owes us", "wants us dead"). Empty if unknown.
  happened: one short sentence on what happened with them THIS session.
places: every NAMED location that mattered this session (bars, safehouses, corp facilities, neighborhoods, clubs).
  If it's already known, use the known name exactly.
  what: a few words on what kind of place it is ("ork-run bar in Redmond"). Empty if nothing new.
  happened: one short sentence on what happened there THIS session.
runners: one entry per PLAYER CHARACTER (from the RUNNERS list only) who did something this session.
  did: one or two sentences on what they did this session.
  moment: their standout moment (a clutch roll, a great line, a disaster), or empty.
  gear: new gear, cyberware, spells, vehicles or drones they got or used notably (short names), or [].
  status: injuries, debts, heat or conditions they're left with, or empty.
jobs: every job (run) the team was offered, took, or worked on THIS session. If it continues a KNOWN JOB, use that
  name exactly.
  name: a short name for the job ("Renraku crate run"). johnson: who hired them (Mr. Johnson, fixer). task: what the
  job is. payOffered / payReceived: amounts as said ("3,000¥ each"), or empty. status: one of offered, in progress,
  done, failed, turned down. outcome: how it ended, or empty if not over. complications: surprises or what went
  wrong, or empty.
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

// Runner (player character) name -> player name, from /character and the speaker labels.
const rosterCache = new Map();
export function runnerRoster(gid) {
  const hit = rosterCache.get(gid);
  if (hit && Date.now() - hit.at < 60_000) return hit.roster;
  const dirs = listSessions(gid).map((x) => x.dir);
  const roster = new Map();
  for (const dir of dirs) {
    for (const l of sessionLines(dir, { raw: true })) {
      const runner = String(l.speaker).match(/\(([^)]+)\)\s*$/)?.[1];
      if (runner && !/^GM\b/.test(runner) && !l.gm) roster.set(runner, baseName(l.speaker));
    }
  }
  for (const r of Object.values(getSettings(gid).characters || {})) if (r && !roster.has(r)) roster.set(r, null);
  rosterCache.set(gid, { at: Date.now(), roster });
  return roster;
}

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
  const knownJobs = before.jobs.map((j) => `- ${j.name} (${j.status || '?'})`).join('\n') || '(none yet)';
  const knownPlaces = before.places.map((c) => `- ${c.name}${c.what ? `: ${c.what}` : ''}`).join('\n') || '(none yet)';
  const ids = new Map(before.open.map((t) => [`T${t.n}`, t.id]));
  const open = before.open.map((t) => `[T${t.n}] ${t.text}`).join('\n') || '(none)';
  const budget = USE_CLAUDE ? 60_000 : 9_000;
  const roster = runnerRoster(gid);
  const runnersList = [...roster].map(([r, p]) => `- ${r}${p ? ` (played by ${p})` : ''}`).join('\n') || '(unknown)';
  const user = `RUNNERS (the player characters):\n${runnersList}\n\nKNOWN CONTACTS:\n${known.slice(0, budget / 4)}\n\nKNOWN PLACES:\n${knownPlaces.slice(0, budget / 5)}\n\nKNOWN JOBS:\n${knownJobs.slice(0, budget / 8)}\n\nOPEN LOOSE ENDS:\n${open.slice(0, budget / 3)}\n\n` +
    `THIS SESSION'S RECAP:\n${String(recap).slice(0, budget)}`;
  const raw = await askAI(CAMPAIGN_SYSTEM, user, 3500, { json: true });
  const data = parseJSON(raw);
  if (!data) throw new Error('the AI did not answer in the expected format');

  const players = playerKeys(gid, dir);
  const sid = path.basename(dir);
  const found = {
    updatedAt: new Date().toISOString(),
    npcs: (Array.isArray(data.npcs) ? data.npcs : [])
      .map((n) => ({ name: clean(n?.name, 60), who: clean(n?.who, 120), attitude: clean(n?.attitude, 60), happened: clean(n?.happened, 300) }))
      .filter((n) => n.name && !players.has(npcKey(n.name))),
    places: (Array.isArray(data.places) ? data.places : [])
      .map((p) => ({ name: clean(p?.name, 60), what: clean(p?.what, 120), happened: clean(p?.happened, 300) }))
      .filter((p) => p.name && !players.has(npcKey(p.name))),
    runners: (() => {
      const byKey = new Map([...roster.keys()].map((r) => [npcKey(r), r]));
      const spot = new Map((sessionStats(dir)?.spotlight || []).filter((x) => x.runner).map((x) => [npcKey(x.runner), x.pct]));
      const out = [];
      for (const r of Array.isArray(data.runners) ? data.runners : []) {
        const name = byKey.get(npcKey(r?.name)) || [...byKey].find(([k]) => k && npcKey(r?.name).includes(k))?.[1];
        if (!name || out.some((x) => x.name === name)) continue;
        out.push({
          name, did: clean(r?.did, 400), moment: clean(r?.moment, 250), status: clean(r?.status, 200),
          gear: (Array.isArray(r?.gear) ? r.gear : []).map((g) => clean(g, 60)).filter(Boolean).slice(0, 10),
          talkPct: spot.get(npcKey(name)) ?? null,
        });
      }
      return out;
    })(),
    jobs: (Array.isArray(data.jobs) ? data.jobs : []).map((j) => ({
      name: clean(j?.name, 80), johnson: clean(j?.johnson, 80), task: clean(j?.task, 300),
      payOffered: clean(j?.payOffered, 80), payReceived: clean(j?.payReceived, 80),
      status: /fail/i.test(j?.status) ? 'failed' : /done|complete|finish|success/i.test(j?.status) ? 'done' : /turn|declin|refus/i.test(j?.status) ? 'turned down' : /progress|accept|took|ongoing|active/i.test(j?.status) ? 'in progress' : /offer/i.test(j?.status) ? 'offered' : '',
      outcome: clean(j?.outcome, 300), complications: clean(j?.complications, 300),
    })).filter((j) => j.name && (j.task || j.johnson)).slice(0, 6),
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
  // Drop new loose ends that are just repeats of ones already open.
  const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
  const openTexts = before.open.map((t) => norm(t.text));
  const words = (t) => new Set(norm(t).split(' ').filter((w) => w.length > 2));
  const overlap = (a, b) => { const A = words(a), B = words(b); if (!A.size || !B.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.min(A.size, B.size); };
  found.threads = found.threads.filter((t) => !openTexts.some((o) => o === norm(t.text) || overlap(o, t.text) >= 0.8))
    .map((t, i) => ({ ...t, id: `${sid}#${i + 1}` }));
  const seenP = new Set();
  found.places = found.places.filter((n) => { const k = npcKey(n.name); if (seenP.has(k)) return false; seenP.add(k); return true; });
  writeJSON(sessionFile(dir), found);
  console.log(`[campaign] ${found.npcs.length} contacts, ${found.places.length} places, ${found.threads.length} new loose ends, ${found.resolved.length} tied up`);
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
  const beforeP = new Set(buildCampaign(gid, { upTo: dir }).places.map((c) => c.key));
  const freshP = (found.places || []).filter((n) => !beforeP.has(npcKey(n.name))).map((n) => n.name);
  if (fresh.length) bits.push(`🕵️ New contacts: ${fresh.slice(0, 8).join(', ')}${fresh.length > 8 ? ` +${fresh.length - 8} more` : ''}`);
  if (freshP.length) bits.push(`📍 New places: ${freshP.slice(0, 6).join(', ')}${freshP.length > 6 ? ` +${freshP.length - 6} more` : ''}`);
  const loose = [];
  if (found.threads.length) loose.push(`${found.threads.length} new`);
  if (found.resolved.length) loose.push(`${found.resolved.length} tied up`);
  bits.push(`🧵 Loose ends: ${now.open.length} open${loose.length ? ` (${loose.join(', ')} this session)` : ''}`);
  return `${bits.join('\n')}\n*More: \`/campaign contacts\`, \`/campaign places\`, \`/campaign threads\`, \`/campaign story\`*`;
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

// ---------- the story so far ----------
// Each session keeps the campaign story as it stood after that session (story.md), built from the previous
// one plus this session's recap.
const STORY_SYSTEM = `You keep the running story of ${CAMPAIGN_NAME}, a Shadowrun tabletop RPG campaign.
You get THE STORY SO FAR (may be empty) and the recap of the newest session. Rewrite the story so far so it
includes the new session. Keep it a readable narrative for someone who missed sessions: who the runners are,
the big events in order, who they've crossed, and where things stand now. Aim for 300–700 words in short
paragraphs, a little noir flavor but accurate. Compress older events more than recent ones. Never invent facts.
Use plain paragraphs (no headings), and end with one short paragraph starting "Where things stand:".`;

export function latestStory(gid, { before = null } = {}) {
  const sessions = listSessions(gid);
  let out = null;
  for (const s of sessions) {
    if (before && path.resolve(s.dir) === path.resolve(before)) break;
    const f = path.join(s.dir, 'story.md');
    if (fs.existsSync(f)) out = { text: fs.readFileSync(f, 'utf8'), title: s.title, date: s.date };
  }
  return out;
}

export async function updateStory(dir, recap, askAI) {
  const gid = gidOf(dir);
  const prev = latestStory(gid, { before: dir });
  const meta = readJSON(path.join(dir, 'meta.json'), {});
  const names = knownNames(gid);
  const user = `${names ? `Correct spellings of names: ${names}\n\n` : ''}THE STORY SO FAR:\n${prev?.text || '(nothing yet: this is the first session)'}\n\n---\n` +
    `NEWEST SESSION: ${meta.title} (${meta.date})\n${String(recap).slice(0, USE_CLAUDE ? 60_000 : 9_000)}`;
  const text = (await askAI(STORY_SYSTEM, user, 1800)).trim();
  if (text.length < 80) throw new Error('the story came back empty');
  fs.writeFileSync(path.join(dir, 'story.md'), text);
  console.log('[story] updated');
  return text;
}

// ---------- quotes (the Best Lines from every recap) ----------
export function quotesFromRecap(recap) {
  const out = [];
  let inBest = false;
  for (const raw of String(recap || '').split('\n')) {
    const line = raw.trim();
    if (/best lines/i.test(line) && (/^\*\*|^#/.test(line))) { inBest = true; continue; }
    if (!inBest) continue;
    if (/^(#|\*\*[^*]+\*\*\s*$)/.test(line)) break;     // next section
    if (!line) continue;
    const body = line.replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, '');
    const m = body.match(/^[*_]*["“](.+?)["”][*_]*\s*[—–-]+\s*(.+)$/);
    if (!m) continue;
    const tableTalk = /\(table talk\)/i.test(m[2]);
    out.push({ quote: m[1].trim(), by: m[2].replace(/\(table talk\)/i, '').replace(/[*_]/g, '').trim(), tableTalk });
  }
  return out;
}

export function allQuotes(gid) {
  return listSessions(gid).flatMap((s) => {
    const f = path.join(s.dir, 'recap.md');
    if (!fs.existsSync(f)) return [];
    return quotesFromRecap(fs.readFileSync(f, 'utf8')).map((q) => ({ ...q, title: s.title, date: s.date }));
  });
}

// ---------- GM prep note ----------
const PREP_SYSTEM = `You help the game master of ${CAMPAIGN_NAME}, a Shadowrun tabletop RPG campaign, get ready for the next
session. From the campaign notes you get, write a short prep note in Discord markdown with these sections (skip empty ones):
**⏮️ Where we left off** — 2–4 sentences.
**🧵 Threads to pull** — the open loose ends most worth bringing back, one line each, with why.
**🕵️ Who might show up** — contacts likely to return and how they feel about the team.
**🧠 Things the players may have forgotten** — promises, debts, injuries, gear.
**💡 Ideas** — 2–3 short hook ideas, clearly marked as suggestions.
Keep it under 350 words. Use only the notes; never present an idea as something that happened.`;

export async function gmPrep(gid, askAI) {
  const c = buildCampaign(gid);
  const story = latestStory(gid);
  const sessions = listSessions(gid);
  const last = [...sessions].reverse().find((s) => fs.existsSync(path.join(s.dir, 'recap.md')));
  const lastRecap = last ? fs.readFileSync(path.join(last.dir, 'recap.md'), 'utf8') : '';
  const recent = new Set(sessions.slice(-3).map((s) => path.basename(s.dir)));
  const contacts = c.contacts.filter((x) => recent.has(x.last?.id)).concat(c.contacts.filter((x) => !recent.has(x.last?.id))).slice(0, 25);
  const notes = [
    story ? `STORY SO FAR:\n${story.text}` : '',
    last ? `LAST SESSION (${last.title}, ${last.date}) RECAP:\n${lastRecap.slice(0, USE_CLAUDE ? 30_000 : 5_000)}` : '',
    c.open.length ? `OPEN LOOSE ENDS:\n${c.open.map((t) => `- ${t.text} (since ${t.opened?.title || '?'})`).join('\n')}` : '',
    contacts.length ? `CONTACTS:\n${contacts.map((x) => `- ${x.name}${x.who ? `: ${x.who}` : ''}${x.attitude ? ` [${x.attitude}]` : ''} (last seen ${x.last?.title || '?'})` +
      `${x.card?.personality ? `; plays as: ${x.card.personality}` : ''}${x.card?.wants ? `; wants: ${x.card.wants}` : ''}`).join('\n')}` : '',
    c.runners.length ? `RUNNERS:\n${c.runners.map((r) => `- ${r.name}${r.player ? ` (${r.player})` : ''}${r.status ? `: ${r.status}` : ''}${r.gear.length ? `; gear: ${r.gear.slice(-6).join(', ')}` : ''}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  if (!notes) return null;
  const head = `🎲 **GM prep for ${CAMPAIGN_NAME}**${last ? ` · after *${last.title}* (${last.date})` : ''}`;
  try {
    const text = (await askAI(PREP_SYSTEM, notes.slice(0, USE_CLAUDE ? 120_000 : 14_000), 1200)).trim();
    if (text.length > 60) return `${head}\n\n${text}`;
  } catch (err) {
    console.error('[prep] AI failed, sending the plain notes:', err.message);
  }
  // Without the AI: the raw lists still help.
  const parts = [head];
  if (story) parts.push(`**⏮️ Where we left off**\n${story.text.split(/\n\s*\n/).pop()}`);
  if (c.open.length) parts.push(`**🧵 Open loose ends**\n${c.open.map((t) => `${t.n}. ${t.text}`).join('\n')}`);
  if (contacts.length) parts.push(`**🕵️ Recent contacts**\n${contacts.slice(0, 10).map((x) => `• ${x.name}${x.attitude ? ` — ${x.attitude}` : ''}`).join('\n')}`);
  return parts.join('\n\n');
}

// ---------- NPC voice cards (for the GM) ----------
// How the GM has played each NPC: personality, how they talk, what they want, what they know about the team,
// and a few memorable lines. Built from the lines the GM spoke as that NPC. Never published to the player website.
const VOICE_SYSTEM = `You help the game master of ${CAMPAIGN_NAME}, a Shadowrun tabletop RPG, play a recurring NPC consistently.
You get the NPC's existing card (may be empty) and the lines the GM spoke AS this NPC in the latest session
(messy speech-to-text). Update the card. Keep what's still true, add what's new, never invent.
Reply with JSON only:
{"personality": "a few words to one sentence",
 "speech": "how they talk: tone, verbal tics, accent or slang, if any",
 "wants": "what they seem to want, or empty",
 "knows": "what they know about the runners, or empty",
 "lines": ["up to 3 short memorable lines they said, cleaned up a little"]}`;

export async function updateVoiceCards(dir, askAI) {
  const gid = gidOf(dir);
  const { voices } = readLabels(dir);
  const byNpc = new Map();
  for (const l of sessionLines(dir)) {
    const v = voices.get(lineKey(l));
    if (!v || v === 'GM' || v === 'Narrator' || !l.gm) continue;
    if (!byNpc.has(v)) byNpc.set(v, []);
    byNpc.get(v).push(String(l.text));
  }
  const before = buildCampaign(gid, { upTo: dir });
  const cards = {};
  for (const [npc, said] of byNpc) {
    if (said.length < 3) continue;   // a line or two isn't enough to learn anything
    const known = before.contacts.find((c) => c.key === npcKey(npc));
    const prev = known?.card ? JSON.stringify(known.card) : '(new NPC, no card yet)';
    let text = said.join('\n');
    if (text.length > (USE_CLAUDE ? 20_000 : 4_000)) text = text.slice(0, USE_CLAUDE ? 20_000 : 4_000);
    try {
      const raw = await askAI(VOICE_SYSTEM, `NPC: ${npc}${known?.who ? ` (${known.who})` : ''}\nEXISTING CARD: ${prev}\n\nLINES THE GM SPOKE AS ${npc}:\n${text}`, 500, { json: true });
      const j = parseJSON(raw);
      if (!j) continue;
      cards[npc] = {
        personality: clean(j.personality, 200), speech: clean(j.speech, 200), wants: clean(j.wants, 200), knows: clean(j.knows, 250),
        lines: (Array.isArray(j.lines) ? j.lines : []).map((x) => clean(x, 160)).filter(Boolean).slice(0, 3),
        heard: said.length,
      };
    } catch (err) {
      console.error(`[voice cards] ${npc}: ${err.message}`);
    }
  }
  writeJSON(path.join(dir, 'voices.json'), cards);
  console.log(`[voice cards] ${Object.keys(cards).length} NPC card(s) updated`);
  return cards;
}
