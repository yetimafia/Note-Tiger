// Recaps and questions: Claude (with an API key) or a local model through Ollama.
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import {
  USE_CLAUDE, ANTHROPIC_API_KEY, CLAUDE_MODEL, OLLAMA_URL, OLLAMA_MODEL, OLLAMA_CONTEXT, CAMPAIGN_NAME, SEPARATE_TABLE_TALK,
  SKIP_OPENING_RECAP,
} from './config.js';
import {
  listSessions, readJSON, formatTranscript, sessionLines, readLabels, updateLabels, lineKey, writeTranscriptFiles,
  previousRecap,
} from './store.js';

// ---------- progress (shown as a progress bar in Note Tiger) ----------
// Key: "<server id>/<session id>". Stages: tagging 0–70%, opening recap 70–75%, notes 75–95%, recap 95–100%.
const progress = new Map();
const progKey = (dir) => `${path.basename(path.dirname(path.dirname(dir)))}/${path.basename(dir)}`;
function setProgress(dir, from, to, frac, label) {
  const pct = Math.round(from + (to - from) * Math.max(0, Math.min(1, frac)));
  const prev = progress.get(progKey(dir));
  progress.set(progKey(dir), { pct, label, startedAt: prev?.startedAt ?? Date.now() });
}
export function getProgress() { return Object.fromEntries(progress); }

const anthropic = USE_CLAUDE ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
export const AI_LABEL = USE_CLAUDE ? `Claude (${CLAUDE_MODEL})` : `Local: ${OLLAMA_MODEL} (Ollama)`;

// How much text the AI may read at once. Local models have much less room than Claude.
const ASK_CHAR_BUDGET = USE_CLAUDE ? 600_000 : 30_000;
const RECAP_CHUNK_CHARS = USE_CLAUDE ? 600_000 : 24_000;

export async function askAI(system, user, maxTokens = 4000, { json = false } = {}) {
  if (!USE_CLAUDE) return askOllama(system, user, maxTokens, json);
  const msg = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

async function askOllama(system, user, maxTokens, json = false) {
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        ...(json ? { format: 'json' } : {}),
        options: { num_ctx: OLLAMA_CONTEXT, num_predict: maxTokens, temperature: json ? 0 : 0.4 },
      }),
    });
  } catch {
    throw new Error('Could not reach Ollama. Is the Ollama app running?');
  }
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 404) throw new Error(`Ollama doesn't have ${OLLAMA_MODEL}. Run: ollama pull ${OLLAMA_MODEL}`);
    throw new Error(`Ollama error ${res.status}: ${body}`);
  }
  const data = await res.json();
  // Some models "think out loud" in <think> tags; keep only the answer.
  return (data.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function chunkText(text, size) {
  const chunks = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length > size && cur) { chunks.push(cur); cur = ''; }
    cur += line + '\n';
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

const CHUNK_NOTES_SYSTEM = `You take notes for a Shadowrun tabletop RPG game from a messy speech-to-text transcript.
List, as short bullet points, only what happened in the game: events, decisions, NPCs met (with names), places,
the job and payment, nuyen/karma/loot, injuries and consequences, open leads, and any very memorable quotes.
Lines labeled "(GM as <name>)" are the game master voicing that NPC. Skip out-of-character chatter. Do not invent anything.`;

// ---------- line tagging: game vs table talk, and who the GM is voicing ----------
// One pass over the transcript in small chunks. Each line gets a label; small local models are far more
// accurate labeling single lines than picking ranges out of long stretches.
const TAG_SYSTEM = `You label lines from a speech-to-text transcript of a Shadowrun tabletop RPG session played over voice chat.
Each line starts with an id like L12. Lines marked [GM] are spoken by the game master (storyteller).

Give every line ONE label:
  G   = part of the game. This includes: talking in character, saying what characters do, plans, questions to
        NPCs, dice rolls, rules, reacting to what happens in the game, jokes about the game. MOST lines are G.
  T   = table talk: clearly NOT about the game. Real life, work, food, pets, other games or shows,
        mic or computer problems, breaks, chatting before the game starts.
For lines marked [GM] use one of these instead:
  N          = the GM narrating or describing (scenes, places, what happens, results of actions)
  NPC <name> = the GM speaking AS a character. Use the character's name from context, or a short
               description like "Bouncer" or "Clerk" if unnamed. Keep the same name for the same character.
               Never use a player's name.
  GM         = the GM talking as themselves (rules, "roll for it", asking what players do)
  T          = GM table talk

Short noises ("mm-hmm", "yeah", "okay", "oh god") get the same label as the conversation around them.
If unsure: G for players, N for the GM.
Answer with exactly one line per id and nothing else, in this format:
L12 G
L13 NPC Wendy
L14 N
L15 T`;

// "L13 NPC Wendy" -> { 13: { tag: 'NPC', name: 'Wendy' } }
export function parseTags(text) {
  const tags = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const m = raw.trim().replace(/^[-*•\s]+/, '').match(/^L?(\d+)\s*[:.)-]?\s*(NPC|GM|G|T|N)\b[\s:,-]*(.*)$/i);
    if (!m) continue;
    const tag = m[2].toUpperCase();
    tags[Number(m[1])] = { tag, name: tag === 'NPC' ? m[3].replace(/["*()[\]]/g, '').trim().slice(0, 40) : null };
  }
  return tags;
}

const words = (t) => String(t).trim().split(/\s+/).filter(Boolean).length;

// Turns raw per-line tags into labels, smoothing out noise:
// - table talk needs most of the nearby real lines to agree (one stray tag can't flip a scene)
// - short filler lines ("mm-hmm") follow the lines around them
// - NPC names that are really players' names (or "GM") are treated as the GM speaking
export function applyTags(lines, raw, playerNames = []) {
  const n = lines.length;
  const players = new Set(playerNames.map((p) => p.toLowerCase()));
  const isT = lines.map((_, i) => raw[i]?.tag === 'T');
  const solid = lines.map((l) => words(l.text) >= 4);
  const offTopic = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    // up to 3 solid lines on each side, plus this one
    const win = [];
    for (let j = i - 1; j >= 0 && win.filter((k) => k < i).length < 3; j--) if (solid[j]) win.push(j);
    for (let j = i + 1; j < n && win.filter((k) => k > i).length < 3; j++) if (solid[j]) win.push(j);
    const votes = win.filter((k) => isT[k]).length + (isT[i] ? 1 : 0);
    const total = win.length + 1;
    offTopic[i] = solid[i] ? isT[i] && votes * 2 > total : votes * 2 > total;
  }
  const voices = new Map();
  for (let i = 0; i < n; i++) {
    if (!lines[i].gm || offTopic[i]) continue;
    const r = raw[i];
    let v = r?.tag === 'NPC' ? r.name : r?.tag === 'GM' ? 'GM' : r?.tag === 'N' ? 'Narrator' : null;
    if (v && v !== 'GM' && v !== 'Narrator') {
      const lower = v.toLowerCase();
      if (!v || /\bgm\b|game ?master|narrat/i.test(v) || players.has(lower) || [...players].some((p) => p && lower.includes(p))) {
        v = /narrat/i.test(v) ? 'Narrator' : 'GM';
      }
    }
    if (v) voices.set(lineKey(lines[i]), v);
  }
  return { offTopic: new Set(lines.filter((_, i) => offTopic[i]).map(lineKey)), voices };
}

export async function tagLines(dir, { force = false } = {}) {
  const lines = sessionLines(dir);
  const saved = readJSON(path.join(dir, 'labels.json'), {});
  if (!force && saved.tagVersion === 2 && saved.lineCount === lines.length) {
    return { offTopic: new Set(saved.offTopic || []), voices: new Map(Object.entries(saved.voices || {})) };
  }
  if (lines.length === 0 || (!SEPARATE_TABLE_TALK && !lines.some((l) => l.gm))) {
    updateLabels(dir, { tagVersion: 2, lineCount: lines.length, offTopic: [], voices: {}, voiceLineCount: lines.length });
    return { offTopic: new Set(), voices: new Map() };
  }
  // Names that can't be NPCs: the people at the table and their runners.
  const playerNames = [...new Set(lines.flatMap((l) => {
    const m = l.speaker.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
    return m ? [m[1], m[2].replace(/^GM( as .*)?$/, '')] : [l.speaker];
  }).map((s) => s.trim()).filter((s) => s && s.length > 1))];

  const raw = {};
  const known = new Set();
  const size = USE_CLAUDE ? 200 : 40;
  const started = Date.now();
  for (let start = 0; start < lines.length; start += size) {
    const end = Math.min(start + size, lines.length);
    const context = lines.slice(Math.max(0, start - 6), start)
      .map((l) => `(earlier) ${l.gm ? '[GM] ' : ''}${l.speaker}: ${l.text}`).join('\n');
    const body = lines.slice(start, end).map((l, k) => `L${start + k} ${l.gm ? '[GM] ' : ''}${l.speaker}: ${l.text}`).join('\n');
    const knownPart = known.size ? `Characters the GM has voiced so far: ${[...known].slice(-15).join(', ')}\n\n` : '';
    if (start % (size * 10) === 0) console.log(`[tagging] lines ${start + 1}–${Math.min(start + size * 10, lines.length)} of ${lines.length}`);
    setProgress(dir, 0, 70, start / lines.length, `Sorting game vs. table talk and GM voices: line ${start + 1} of ${lines.length}`);
    try {
      const answer = await askAI(TAG_SYSTEM, `${knownPart}${context ? `${context}\n\n` : ''}LABEL THESE LINES:\n${body}`, size * 12);
      const tags = parseTags(answer);
      for (const [id, t] of Object.entries(tags)) {
        const i = Number(id);
        if (i < start || i >= end) continue;
        raw[i] = t;
        if (t.tag === 'NPC' && t.name && lines[i].gm) known.add(t.name);
      }
    } catch (err) {
      console.error('[tagging] skipped a part:', err.message);
    }
  }
  if (!SEPARATE_TABLE_TALK) for (const k of Object.keys(raw)) if (raw[k].tag === 'T') raw[k] = { tag: lines[k].gm ? 'N' : 'G' };
  const { offTopic, voices } = applyTags(lines, raw, playerNames);
  updateLabels(dir, {
    tagVersion: 2, lineCount: lines.length, voiceLineCount: lines.length,
    offTopic: [...offTopic], voices: Object.fromEntries(voices),
  });
  const npcs = [...new Set([...voices.values()].filter((v) => v !== 'GM' && v !== 'Narrator'))];
  console.log(`[tagging] done in ${Math.round((Date.now() - started) / 1000)}s: ${offTopic.size} of ${lines.length} lines table talk, ` +
    `${voices.size} GM lines labeled${npcs.length ? ` (NPCs: ${npcs.slice(0, 12).join(', ')})` : ''}`);
  return { offTopic, voices };
}

// ---------- the opening "previously on..." recap ----------
const OPENING_RECAP_SYSTEM = `You look at the START of a speech-to-text transcript of a Shadowrun tabletop RPG session.
Groups often begin by recapping the PREVIOUS session: people retell what happened last time ("last time we...",
"so we got the job from...", "remember when..."). Then the new session's play begins (the GM sets a new scene,
players act, dice get rolled).

Each line starts with an id like L12. Find where the opening recap of the previous session ENDS.
Answer with JSON only: {"recapEndsAt": id_of_the_last_recap_line} or {"recapEndsAt": null} if the session
doesn't start with a recap of the previous one. Small talk before the recap counts as part of it.
Only the opening counts: never mark lines after new play has clearly started.`;

// Finds the opening recap; saves its lines in labels.json (recapLines).
// If the GM used /session begin, everything before that moment is the recap, no guessing needed.
export async function detectOpeningRecap(dir, { prevRecap = null, force = false } = {}) {
  const lines = sessionLines(dir);
  const meta = readJSON(path.join(dir, 'meta.json'), {});
  const saved = readJSON(path.join(dir, 'labels.json'), {});
  if (meta.playStartedAt) {
    const recap = lines.filter((l) => l.t < meta.playStartedAt).map(lineKey);
    updateLabels(dir, { recapLines: recap, recapLineCount: lines.length, recapSource: 'marker' });
    return new Set(recap);
  }
  if (!force && saved.recapLines && saved.recapLineCount === lines.length) return new Set(saved.recapLines);
  if (!SKIP_OPENING_RECAP || lines.length < 5) { updateLabels(dir, { recapLines: [], recapLineCount: lines.length }); return new Set(); }

  // Only the first ~40 minutes (and at most 300 lines) can be the opening recap.
  const cutoff = lines[0].t + 40 * 60_000;
  let n = 0, size = 0;
  const limit = USE_CLAUDE ? 60_000 : 12_000;
  while (n < lines.length && n < 300 && lines[n].t <= cutoff && size < limit) { size += lines[n].text.length + 30; n++; }
  const numbered = lines.slice(0, n).map((l, i) => `L${i} ${l.speaker}: ${l.text}`).join('\n');
  const context = prevRecap ? `What happened LAST session (for comparison):\n${prevRecap.slice(0, USE_CLAUDE ? 8000 : 2500)}\n\n---\n\n` : '';
  let end = -1;
  try {
    console.log(`[opening recap] checking the first ${n} lines`);
    setProgress(dir, 70, 75, 0, 'Looking for the recap of last session at the start');
    const answer = await askAI(OPENING_RECAP_SYSTEM, `${context}START OF THIS SESSION:\n${numbered}`, 300, { json: true });
    const m = answer.match(/\{[\s\S]*\}/);
    const v = m ? JSON.parse(m[0]).recapEndsAt : null;
    if (v !== null && v !== undefined && Number.isFinite(Number(v))) end = Math.min(Number(v), n - 1);
  } catch (err) {
    console.error('[opening recap] skipped:', err.message);
  }
  const recap = end >= 0 ? lines.slice(0, end + 1).map(lineKey) : [];
  updateLabels(dir, { recapLines: recap, recapLineCount: lines.length, recapSource: 'ai' });
  console.log(`[opening recap] ${recap.length ? `first ${recap.length} lines are a recap of last session` : 'none found'}`);
  return new Set(recap);
}

// ---------- recaps ----------
// Table talk lines worth considering for Best Lines (short and punchy), within a size budget.
function tableTalkCandidates(tableText, budget) {
  const picks = tableText.split('\n').filter((l) => {
    const said = l.replace(/^\[[^\]]*\]\s*[^:]+:\s*/, '');
    return said.length >= 15 && said.length <= 220;
  });
  let out = '';
  for (const l of picks) { if (out.length + l.length > budget) break; out += l + '\n'; }
  return out.trim();
}

const TABLE_TALK_NOTE = `TABLE TALK (off-topic chatter, not part of the game). Do NOT use it for anything in the recap except
the Best Lines section. Mark any quote you take from it with "(table talk)".`;

// Long sessions are too big for a local model in one go, so: notes per chunk, then one recap from the notes.
async function writeRecap(title, date, gameText, tableText, prevRecap, dir = null) {
  const step = (frac, label) => dir && setProgress(dir, 75, 99, frac, label);
  const prevPart = prevRecap ? `For context, here is the PREVIOUS session's recap:\n${prevRecap}\n\n---\n\n` : '';
  const head = `${prevPart}Session title: ${title} (${date})\n\n`;
  const tablePart = tableText ? `\n\n---\n${TABLE_TALK_NOTE}\n${tableTalkCandidates(tableText, USE_CLAUDE ? 60_000 : 6_000)}` : '';
  const chunks = chunkText(gameText || '(no in-game talk was transcribed)', RECAP_CHUNK_CHARS);
  if (chunks.length === 1) {
    step(0.2, 'Writing the recap');
    return askAI(RECAP_SYSTEM, `${head}GAME TRANSCRIPT:\n${gameText}${tablePart}`, 6000);
  }
  const notes = [];
  for (let i = 0; i < chunks.length; i++) {
    console.log(`[recap] notes for part ${i + 1}/${chunks.length}`);
    step(i / (chunks.length + 1), `Taking notes: part ${i + 1} of ${chunks.length}`);
    notes.push(`--- Part ${i + 1} of ${chunks.length} ---\n` +
      await askAI(CHUNK_NOTES_SYSTEM, `TRANSCRIPT PART ${i + 1}:\n${chunks[i]}`, 1200));
  }
  step(chunks.length / (chunks.length + 1), 'Writing the recap from the notes');
  return askAI(RECAP_SYSTEM,
    `${head}The game transcript was long, so here are notes taken from it in order ` +
    `(treat them as the game transcript):\n\n${notes.join('\n\n')}${tablePart}`, 4000);
}

// Tags table talk, writes transcript.txt and recap.md for a session folder, and returns the recap.
export async function recapSession(dir, opts = {}) {
  setProgress(dir, 0, 1, 0, 'Starting…');
  try {
    return await recapSessionInner(dir, opts);
  } finally {
    progress.delete(progKey(dir));
  }
}

async function recapSessionInner(dir, { prevRecap = previousRecap(dir), reclassify = false } = {}) {
  const meta = readJSON(path.join(dir, 'meta.json'), {});
  const lines = sessionLines(dir);
  const notes = readJSON(path.join(dir, 'notes.json'), []);
  if (lines.length === 0 && notes.length === 0) throw new Error('That session has no transcript.');
  const { offTopic, voices } = await tagLines(dir, { force: reclassify });
  const recap = await detectOpeningRecap(dir, { prevRecap, force: reclassify });
  const labels = { offTopic, voices, recap };
  writeTranscriptFiles(dir);
  const text = await writeRecap(
    meta.title, meta.date,
    formatTranscript(lines, notes, labels, 'game'),
    offTopic.size ? formatTranscript(lines, [], labels, 'table') : '',
    prevRecap,
    dir,
  );
  fs.writeFileSync(path.join(dir, 'recap.md'), text);
  return text;
}

export const RECAP_SYSTEM = `You are the campaign scribe for ${CAMPAIGN_NAME}, a Shadowrun tabletop RPG game.
You get a raw speech-to-text transcript of one session (the GAME TRANSCRIPT). It is messy: speech recognition
errors and crosstalk. Speaker labels look like "Player (Runner name)". The game master's lines are labeled
"Name (GM as Narrator)", "Name (GM as <NPC name>)" when voicing a character, or "Name (GM)" when out of character.
These labels were added by an AI and may occasionally be wrong; use context.
Off-topic table talk has been separated out; if present it comes after, under TABLE TALK.
The group's retelling of the previous session at the start has already been removed: only include events from
THIS session. Don't repeat what the previous session's recap already covered, except briefly for context.

Write a recap the players will enjoy reading and can rely on later. Focus on what happened in the fiction,
using only the game transcript. Use Discord markdown, and these sections (skip any that have nothing in them):

**📼 The Run So Far** — 2–4 paragraph narrative recap, a little noir flavor, but accurate.
**🕴️ The Job** — who hired the team (Mr. Johnson), the objective, the pay offered/negotiated.
**👥 NPCs & Contacts** — name: who they are, what happened with them, attitude toward the team.
**📍 Places** — locations visited or mentioned that matter.
**💰 Payouts & Loot** — nuyen, karma, gear, paydata gained or spent.
**🩸 Consequences** — injuries, heat, burned contacts, enemies made, essence loss.
**🧵 Loose Threads** — open questions, leads, promises made, things to follow up next session.
**💬 Best Lines** — up to 3 of the funniest or most dramatic quotes of the night, as "quote" — Speaker.
They can come from the game OR the table talk; mark table-talk quotes with (table talk).

Rules: never invent facts. If something is unclear from the transcript, say it's unclear rather than guessing.
Never mention anything from the table talk outside Best Lines. Ignore rules arguments unless they changed something in the game.`;

export const ASK_SYSTEM = `You are the campaign scribe for ${CAMPAIGN_NAME}, a Shadowrun tabletop RPG game.
You have the archive of past sessions: recaps and raw speech-to-text transcripts (which contain recognition
errors and out-of-character chatter). Answer the player's question using only this archive.
Say which session(s) your answer comes from (by date/title). If the archive doesn't contain the answer,
say so plainly — don't make things up. Keep answers short enough for a Discord message unless asked for detail.`;

export function buildArchive(gid) {
  const sessions = listSessions(gid);
  // Recaps for every session (they are short), then full transcripts newest-first until the budget runs out.
  let out = sessions.map((s, i) => {
    const recap = fs.existsSync(path.join(s.dir, 'recap.md'))
      ? fs.readFileSync(path.join(s.dir, 'recap.md'), 'utf8') : '(no recap)';
    return `=== Session ${i + 1}: ${s.title} (${s.date}) — RECAP ===\n${recap}`;
  }).join('\n\n');

  for (let i = sessions.length - 1; i >= 0; i--) {
    const s = sessions[i];
    // Table talk is left out so questions are answered from what happened in the game.
    const transcript = formatTranscript(sessionLines(s.dir), readJSON(path.join(s.dir, 'notes.json'), []), readLabels(s.dir), 'game');
    const block = `\n\n=== Session ${i + 1}: ${s.title} (${s.date}) — TRANSCRIPT ===\n${transcript}`;
    if (out.length + block.length > ASK_CHAR_BUDGET) break;
    out += block;
  }
  return { archive: out, count: sessions.length };
}

// ---------- local AI health check (cached for a few seconds) ----------
export let ollamaCache = { t: 0, value: null };
async function checkOllama() {
  if (USE_CLAUDE) return null;
  if (Date.now() - ollamaCache.t < 5000) return ollamaCache.value;
  let value;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
    const { models = [] } = await res.json();
    const has = models.some((m) => m.name === OLLAMA_MODEL || m.name === `${OLLAMA_MODEL}:latest` || m.model === OLLAMA_MODEL);
    value = has ? 'ready' : 'missing-model';
  } catch {
    value = 'not-running';
  }
  ollamaCache = { t: Date.now(), value };
  return value;
}


export const ollamaStatus = () => ollamaCache.value;
checkOllama();
setInterval(checkOllama, 10_000).unref();

// Ask a question about the archive of one server.
export async function askArchive(gid, question, asker = 'the GM') {
  const { archive, count } = buildArchive(gid);
  if (count === 0) return 'No sessions recorded yet.';
  return askAI(ASK_SYSTEM, `ARCHIVE:\n${archive}\n\n---\nQUESTION from ${asker}: ${question}`, 1500);
}

export function refreshOllama() { ollamaCache.t = 0; return checkOllama(); }
