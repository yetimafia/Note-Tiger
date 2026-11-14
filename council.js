// Council mode: several local AIs (Ollama on this PC and/or other PCs on the home network) each do the same job,
// then their answers are combined: line labels by majority vote, recap drafts merged by a "judge".
//
//  - With 0 or 1 members (or with a Claude key) nothing here runs; Note Tiger works exactly as before.
//  - Members on different machines run at the same time. Members that share a machine take turns, so Ollama isn't
//    swapping models back and forth (lets you test a council on one PC).
//  - A member that's offline, asleep, missing its model, or times out is skipped or dropped; the rest carry on.
//    If nobody answers, the caller falls back to the normal single-model path. A session is never lost to the council.
//
// Settings (.env, edited in the control panel → Settings → Council). Read fresh each time, so the panel's status
// is always current without a restart:
//   COUNCIL_MEMBERS   JSON list: [{"name":"Main PC","url":"http://127.0.0.1:11434","model":"gemma3:12b"}, ...]
//   COUNCIL_LABELS    true/false: table talk + NPC voices by vote (default true when there's a council)
//   COUNCIL_RECAP     true/false: drafts + judge (default true when there's a council)
//   COUNCIL_JUDGE_URL / COUNCIL_JUDGE_MODEL   blank = this PC's Ollama and model
//   COUNCIL_TIMEOUT   minutes one request may take before that member is dropped (default 10)
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { APP_DIR } from './config.js';
import { soundKey } from './spelling.js';

const ENV_FILE = path.join(APP_DIR, '.env');

// ---------- settings ----------
const cleanUrl = (u) => {
  let s = String(u || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  if (!/:\d+$/.test(s.replace(/^https?:\/\//i, ''))) s += ':11434';
  return s;
};

export function parseMembers(raw) {
  let list = [];
  try { list = JSON.parse(raw || '[]'); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.map((m, i) => ({
    name: String(m?.name || '').trim().slice(0, 40) || `Member ${i + 1}`,
    url: cleanUrl(m?.url),
    model: String(m?.model || '').trim(),
  })).filter((m) => m.url && m.model).slice(0, 8);
}

// Lets the comparison script run the same session with and without the council, whatever the settings say.
let override = null;
export function setCouncilOverride(o) { override = o; }

export function councilConfig() {
  let env = {};
  try { env = dotenv.parse(fs.readFileSync(ENV_FILE)); } catch { env = { ...process.env }; }
  const mainUrl = cleanUrl(env.OLLAMA_URL || 'http://127.0.0.1:11434');
  const mainModel = env.OLLAMA_MODEL || 'llama3.1:8b';
  const members = parseMembers(env.COUNCIL_MEMBERS);
  const usingClaude = Boolean(env.ANTHROPIC_API_KEY);
  const on = !usingClaude && members.length >= 2;
  return {
    members, usingClaude, on,
    labels: on && (override ? override.labels : env.COUNCIL_LABELS !== 'false'),
    recap: on && (override ? override.recap : env.COUNCIL_RECAP !== 'false'),
    judge: { name: 'Judge', url: cleanUrl(env.COUNCIL_JUDGE_URL) || mainUrl, model: (env.COUNCIL_JUDGE_MODEL || '').trim() || mainModel },
    timeoutMs: Math.max(0.05, Math.min(120, Number(env.COUNCIL_TIMEOUT) || 10)) * 60_000,   // the panel allows 1–120; tests go lower
    ctx: Number(env.OLLAMA_CONTEXT || 16384),
    main: { url: mainUrl, model: mainModel },
  };
}

// 127.0.0.1, localhost and [::1] are the same machine.
export function machineOf(url) {
  try {
    const u = new URL(url);
    const host = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname) ? 'this-pc' : u.hostname.toLowerCase();
    return `${host}:${u.port || 11434}`;
  } catch { return url; }
}
const sameModel = (a, b) => a === b || a === `${b}:latest` || `${a}:latest` === b;
export const sameMember = (a, b) => a && b && machineOf(a.url) === machineOf(b.url) && sameModel(a.model, b.model);

// ---------- reachability (the same /api/tags check as the main status light) ----------
export async function checkMember(m, timeoutMs = 3000) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${m.url}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { models = [] } = await res.json();
    const names = models.map((x) => x.name || x.model).filter(Boolean);
    const hasModel = names.some((n) => sameModel(n, m.model));
    return { reachable: true, hasModel, models: names, ms: Date.now() - t0, problem: hasModel ? '' : `doesn't have ${m.model}` };
  } catch (err) {
    const why = err.name === 'TimeoutError' ? 'no answer (asleep or off?)' : /ECONNREFUSED|fetch failed/i.test(String(err.cause?.code || err.message))
      ? 'not reachable (Ollama not running, or not open to the network?)' : err.message;
    return { reachable: false, hasModel: false, models: [], ms: Date.now() - t0, problem: why };
  }
}

let statusCache = { t: 0, value: null };
export async function councilStatus({ fresh = false } = {}) {
  if (!fresh && statusCache.value && Date.now() - statusCache.t < 5000) return statusCache.value;
  const cfg = councilConfig();
  const [members, judge] = await Promise.all([
    Promise.all(cfg.members.map(async (m) => ({ ...m, machine: machineOf(m.url), ...(await checkMember(m)) }))),
    checkMember(cfg.judge),
  ]);
  const ready = members.filter((m) => m.reachable && m.hasModel).length;
  const value = {
    on: cfg.on, usingClaude: cfg.usingClaude, labels: cfg.labels, recap: cfg.recap, timeoutMin: cfg.timeoutMs / 60_000,
    members, ready, judge: { ...cfg.judge, ...judge },
    machines: new Set(members.map((m) => m.machine)).size,
  };
  statusCache = { t: Date.now(), value };
  return value;
}

// ---------- asking one member ----------
// Fails fast once the member is clearly gone (a request timed out, or 3 failures in a row), so a dead machine
// doesn't cost minutes per question.
function memberAsk(m, cfg, stats) {
  return async (system, user, maxTokens = 4000, { json = false } = {}) => {
    if (stats.dead) throw new Error(`${m.name} dropped out earlier`);
    stats.calls++;
    try {
      const res = await fetch(`${m.url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(cfg.timeoutMs),
        body: JSON.stringify({
          model: m.model, stream: false, keep_alive: '15m',
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          ...(json ? { format: 'json' } : {}),
          options: { num_ctx: cfg.ctx, num_predict: maxTokens, temperature: json ? 0 : 0.4 },
        }),
      });
      if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const data = await res.json();
      stats.inRow = 0;
      return (data.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    } catch (err) {
      stats.fails++; stats.inRow++;
      if (err.name === 'TimeoutError') { stats.dead = true; stats.error = `timed out after ${cfg.timeoutMs / 60_000} min`; }
      else if (stats.inRow >= 3) { stats.dead = true; stats.error = err.message; }
      throw err;
    }
  };
}
export function askMember(m, cfg = councilConfig()) { return memberAsk(m, cfg, { calls: 0, fails: 0, inRow: 0 }); }

// One job at a time per machine (members sharing a PC take turns); different machines run in parallel.
const machineQueue = new Map();
function onMachine(url, fn) {
  const key = machineOf(url);
  const prev = machineQueue.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  machineQueue.set(key, run.catch(() => {}));
  return run;
}

/**
 * Runs job(member, ask, onProgress) on every ready member. Returns
 *   { results: [{ member, value }], record: [...who took part...], lead }
 * A member whose job throws, or whose questions mostly failed, is left out of results (but kept in the record).
 * onProgress(frac, label) reports the average progress of the members still working.
 */
export async function runCouncil(jobName, job, { onProgress = () => {}, log = console.log } = {}) {
  const cfg = councilConfig();
  const record = [];
  const checks = await Promise.all(cfg.members.map((m) => checkMember(m, 4000)));
  const ready = [];
  cfg.members.forEach((m, i) => {
    if (checks[i].reachable && checks[i].hasModel) ready.push(m);
    else record.push({ name: m.name, url: m.url, model: m.model, ok: false, skipped: true, error: checks[i].problem });
  });
  const skipped = record.map((r) => `${r.name} (${r.error})`);
  log(`[council] ${jobName}: ${ready.length} of ${cfg.members.length} members ready` +
    `${ready.length ? `: ${ready.map((m) => `${m.name}=${m.model}`).join(', ')}` : ''}${skipped.length ? `; skipped ${skipped.join(', ')}` : ''}`);

  const frac = new Map(ready.map((m) => [m, 0]));
  const report = () => {
    const vals = [...frac.values()];
    onProgress(vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 1,
      `${[...frac.values()].filter((f) => f < 1).length} of ${ready.length} AIs working`);
  };
  const results = [];
  await Promise.all(ready.map((m) => onMachine(m.url, async () => {
    const stats = { calls: 0, fails: 0, inRow: 0 };
    const t0 = Date.now();
    const entry = { name: m.name, url: m.url, model: m.model, ok: false };
    try {
      const value = await job(m, memberAsk(m, cfg, stats), (f) => { frac.set(m, Math.max(0, Math.min(1, f))); report(); });
      // Most of its questions failed: its answer is mostly guesses, leave it out.
      if (stats.dead || (stats.calls >= 4 && stats.fails / stats.calls > 0.25)) {
        throw new Error(stats.error || `${stats.fails} of ${stats.calls} questions failed`);
      }
      entry.ok = true;
      results.push({ member: m, value });
    } catch (err) {
      entry.error = String(err.message || err).slice(0, 200);
    } finally {
      entry.secs = Math.round((Date.now() - t0) / 1000);
      entry.questions = stats.calls;
      if (stats.fails) entry.failedQuestions = stats.fails;
      frac.set(m, 1); report();
      record.push(entry);
      log(`[council] ${jobName}: ${m.name} (${m.model}) ${entry.ok ? 'done' : `dropped: ${entry.error}`} in ${entry.secs}s`);
    }
  })));
  // Keep the settings order in results and record.
  const order = (x) => cfg.members.findIndex((m) => m.name === x.name && m.url === x.url && m.model === x.model);
  results.sort((a, b) => order(a.member) - order(b.member));
  record.sort((a, b) => order(a) - order(b));
  // The "lead" breaks ties and supplies anything that can't be voted on: the judge's model if it took part.
  const lead = Math.max(0, results.findIndex((r) => sameMember(r.member, cfg.judge)));
  return { results, record, lead, cfg };
}

// ---------- voting: table talk, combat, game log ----------
// tts: findTableTalk() results (a Set of table-talk line indexes with .verdicts and .combat), one per member.
export function voteTableTalk(tts, n, lead = 0, withoutViolence = (s) => s) {
  if (tts.length === 1) return tts[0];
  const k = tts.length;
  const wins = (has) => (i) => {
    const yes = tts.filter((t) => has(t, i)).length;
    return yes * 2 > k || (yes * 2 === k && has(tts[lead], i));
  };
  const isTT = wins((t, i) => t.has(i));
  const isFight = wins((t, i) => t.combat.has(i));
  const out = new Set(), combat = new Set();
  for (let i = 0; i < n; i++) { if (isTT(i)) out.add(i); }
  for (let i = 0; i < n; i++) { if (!out.has(i) && isFight(i)) combat.add(i); }
  // The game log (scenes, events) is the lead's; a fight it describes only stands if the vote agrees.
  let prevScene = '';
  const verdicts = (tts[lead].verdicts || []).map((v0) => {
    const v = { ...v0 };
    const game = [];
    for (let i = v.from; i < v.to; i++) if (!out.has(i)) game.push(i);
    v.playing = game.length >= (v.to - v.from) / 2;
    const fighting = game.length > 0 && game.filter((i) => combat.has(i)).length * 2 >= game.length;
    if (v.combat && !fighting) {
      v.combat = false;
      v.happened = withoutViolence(v.happened || '');
      v.scene = withoutViolence(v.scene || '') || prevScene;
    } else if (!v.combat && fighting) v.combat = true;
    prevScene = v.scene;
    return v;
  });
  return Object.assign(out, { verdicts, combat });
}

// ---------- voting: who the GM is voicing ----------
// maps: findVoices() results (Map line index → "Narrator" | "GM" | NPC name), one per member.
export function voteVoices(maps, lead = 0, known = []) {
  if (maps.length === 1) return maps[0];
  // Different spellings of one name are one vote ("Grim" / "Grimm"); the known NPC's spelling, then the most used one, wins.
  const keyOf = (n) => (n === 'Narrator' || n === 'GM' ? n : soundKey(n.replace(/^(mr|mrs|ms|miss|dr)\.?\s+/i, '')) || n.toLowerCase());
  const uses = new Map();   // the lead's spelling wins a tie
  maps.forEach((m, j) => { for (const v of m.values()) uses.set(v, (uses.get(v) || 0) + (j === lead ? 1.001 : 1)); });
  const spelling = new Map();
  for (const name of uses.keys()) {
    const k = keyOf(name);
    const knownName = known.find((x) => keyOf(x) === k);
    const cur = spelling.get(k);
    if (knownName) spelling.set(k, knownName);
    else if (!cur || (!known.includes(cur) && uses.get(name) > uses.get(cur))) spelling.set(k, name);
  }
  const out = new Map();
  const idx = new Set(maps.flatMap((m) => [...m.keys()]));
  for (const i of idx) {
    const tally = new Map();
    for (const m of maps) if (m.has(i)) { const k = keyOf(m.get(i)); tally.set(k, (tally.get(k) || 0) + 1); }
    const best = Math.max(...tally.values());
    const top = [...tally.keys()].filter((k) => tally.get(k) === best);
    const leadKey = maps[lead]?.has(i) ? keyOf(maps[lead].get(i)) : null;
    const pick = top.length === 1 ? top[0] : (top.includes(leadKey) ? leadKey : top[0]);
    out.set(i, spelling.get(pick) || pick);
  }
  return out;
}

// ---------- the judge: one recap from several drafts ----------
export const JUDGE_SYSTEM = `You are the editor of a tabletop RPG campaign's session recaps. Several AI note-takers each wrote a DRAFT
recap of the same session from a messy speech-to-text transcript. Each draft has mistakes, and different drafts have
different mistakes. Write ONE final recap.

Rules:
- Keep an event, NPC, place, job detail, payout, consequence or loose thread ONLY if at least two drafts include it
  (in any wording), or the GM NARRATION below clearly states it.
- When drafts disagree on a detail (a name, an amount, who did what, whether something happened), use the version
  the GM NARRATION or the GAME LOG supports. If neither settles it, leave the detail out or say it's unclear.
- Fights, injuries and deaths: only if the GAME LOG or the GM NARRATION confirms them. Players joke about these a lot.
- Never add anything that is in no draft and not in the GM NARRATION. Don't mention the drafts or that you merged them.
- Best Lines: only quotes that appear in a draft, copied exactly; prefer ones more than one draft picked. At most 3.
- Use the SAME sections and Discord markdown as the drafts (📼 The Run So Far, 🕴️ The Job, 👥 NPCs & Contacts,
  📍 Places, 💰 Payouts & Loot, 🩸 Consequences, 🧵 Loose Threads, 💬 Best Lines), skipping empty ones.
- Write the narrative fresh, a little noir flavor, but accurate. Reply with the recap only.`;

// GM lines from the formatted game transcript ("[time] Name (GM as Narrator): text"), evenly thinned to fit.
export function gmNarration(gameText, budget) {
  const gm = String(gameText || '').split('\n').filter((l) => /\(GM( as [^)]*)?\):/.test(l));
  let text = gm.join('\n');
  if (text.length <= budget) return text;
  const keep = Math.max(1, Math.floor(gm.length * budget / text.length));
  const stepN = gm.length / keep;
  const out = [];
  for (let j = 0; j < keep; j++) out.push(gm[Math.floor(j * stepN)]);
  text = out.join('\n');
  return text.length > budget ? text.slice(0, budget) : text;
}

export async function judgeDrafts(drafts, { gameLog = '', gameText = '', title = '', log = console.log } = {}) {
  const cfg = councilConfig();
  const letters = 'ABCDEFGH';
  const body = drafts.map((d, i) => `===== DRAFT ${letters[i]} =====\n${d.text.trim()}`).join('\n\n');
  // Room left in the judge's context (about 3 characters per token), after the drafts, the log and the answer.
  const room = Math.floor(cfg.ctx * 3) - body.length - gameLog.length - 4500 * 3 - 3000;
  const gm = gmNarration(gameText, Math.max(0, Math.min(room, 40_000)));
  const user = `Session: ${title}\n\n${gameLog ? `GAME LOG (built while following the whole session):\n${gameLog}\n\n` : ''}` +
    `${gm ? `GM NARRATION (what the game master actually said, ${gm.length < gameText.length ? 'a sample' : 'all of it'}):\n${gm}\n\n` : ''}` +
    `${body}\n\n===== END OF DRAFTS =====\nNow write the final recap.`;
  const t0 = Date.now();
  const ask = askMember(cfg.judge, cfg);
  const check = await checkMember(cfg.judge, 4000);
  if (!check.reachable || !check.hasModel) throw new Error(`judge ${cfg.judge.model} at ${cfg.judge.url}: ${check.problem}`);
  const text = await onMachine(cfg.judge.url, () => ask(JUDGE_SYSTEM, user, 4500));
  log(`[council] judge ${cfg.judge.model} merged ${drafts.length} drafts in ${Math.round((Date.now() - t0) / 1000)}s`);
  if (!text || text.length < 200) throw new Error('the judge gave an empty answer');
  return { text, secs: Math.round((Date.now() - t0) / 1000), judge: { url: cfg.judge.url, model: cfg.judge.model }, gmSample: gm.length };
}

// ---------- council.json (one per session; written only when the council runs) ----------
export function saveCouncilRecord(dir, part, data) {
  const file = path.join(dir, 'council.json');
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first time */ }
  cur[part] = { ...data, at: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(cur, null, 2));
}
export function readCouncilRecord(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'council.json'), 'utf8')); } catch { return null; }
}
