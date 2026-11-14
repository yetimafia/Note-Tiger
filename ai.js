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
  previousRecap, gidOf,
} from './store.js';
import { updateCampaign, updateStory, rulesSection, updateVoiceCards, buildCampaign } from './campaign.js';
import { knownNames } from './spelling.js';
import { listCharacters, classLine } from './sheets.js';
import { findTableTalk, gameLogText, withoutViolence } from './squirrel.js';
import { findVoices } from './voices.js';
import { councilConfig, runCouncil, voteTableTalk, voteVoices, judgeDrafts, saveCouncilRecord, setCouncilOverride } from './council.js';

// ---------- progress (shown as a progress bar in Note Tiger) ----------
// Key: "<server id>/<session id>". Stages: tagging 0–70%, opening recap 70–75%, notes and recap 75–99%, contacts 99–100%.
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
Lines labeled "(GM as <name>)" are the game master voicing that NPC. Skip out-of-character chatter. Do not invent anything.
Players joke and talk big a lot ("I shoot him", "he's dead", "we all die"): only note a fight, injury or death if the GM
narrates it or the GAME LOG says it happened.`;

// ---------- tagging: table talk, fights, events, and who the GM is voicing ----------
// One AI's labels for the whole night: 1) the game tracker reads a stretch at a time with a running memory of the game
// (table talk, real fights, what actually happened); 2) the voice pass works out who the GM is voicing, in order,
// with the scene and the NPCs met so far. ask = askAI, or one council member.
async function labelLines(lines, ask, { players, known, onFrac = () => {}, log = () => {} }) {
  const empty = Object.assign(new Set(), { verdicts: [], combat: new Set() });
  let tt = empty;
  try {
    tt = await findTableTalk(lines, ask, { isGM: (l) => l.gm, log, onProgress: (i, n) => onFrac(0.78 * i / n) });
  } catch (err) {
    console.error('[game tracker] skipped:', err.message);
  }
  let voices = new Map();
  if (lines.some((l) => l.gm)) {
    const sceneLog = tt.verdicts.map((v) => ({ t0: lines[v.from].t, t1: lines[v.to - 1].t, scene: v.scene }));
    const sceneAt = (t) => (sceneLog.find((v) => v.t0 <= t && t <= v.t1) || {}).scene || '';
    try {
      voices = await findVoices(lines, ask, { isGM: (l) => l.gm, players, known, sceneAt, log, onProgress: (i, n) => onFrac(0.78 + 0.22 * i / n) });
    } catch (err) {
      console.error('[voices] skipped:', err.message);
    }
  }
  onFrac(1);
  return { tt, voices };
}

export async function tagLines(dir, { force = false } = {}) {
  const lines = sessionLines(dir);
  const saved = readJSON(path.join(dir, 'labels.json'), {});
  if (!force && saved.tagVersion === 4 && saved.lineCount === lines.length) {
    return { offTopic: new Set(saved.offTopic || []), voices: new Map(Object.entries(saved.voices || {})) };
  }
  if (lines.length === 0 || (!SEPARATE_TABLE_TALK && !lines.some((l) => l.gm))) {
    updateLabels(dir, { tagVersion: 4, lineCount: lines.length, offTopic: [], voices: {}, voiceLineCount: lines.length });
    return { offTopic: new Set(), voices: new Map() };
  }
  // Names that can't be NPCs: the people at the table and their runners.
  const playerNames = [...new Set(lines.flatMap((l) => {
    const m = l.speaker.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
    return m ? [m[1], m[2].replace(/^GM( as .*)?$/, '')] : [l.speaker];
  }).map((s) => s.trim()).filter((s) => s && s.length > 1))];

  const started = Date.now();
  const offTopic = new Set();
  const voices = new Map();
  let known = [];
  try { if (lines.some((l) => l.gm)) known = buildCampaign(gidOf(dir), { upTo: dir }).contacts.map((c) => c.name); } catch { /* no campaign yet */ }
  const opts = { players: new Set(playerNames), known, log: (m) => console.log(m) };
  let found = null;
  // Council: every member labels the whole night; each line takes the majority vote.
  const council = councilConfig();
  if (council.labels) {
    try {
      const { results, record, lead } = await runCouncil('line labeling',
        (m, ask, onFrac) => labelLines(lines, ask, { ...opts, onFrac }),
        { onProgress: (f, label) => setProgress(dir, 0, 70, f, `Council: following the game and the NPC voices (${label})`) });
      if (results.length) {
        found = {
          tt: voteTableTalk(results.map((r) => r.value.tt), lines.length, lead, withoutViolence),
          voices: voteVoices(results.map((r) => r.value.voices), lead, known),
        };
      }
      saveCouncilRecord(dir, 'labels', {
        members: record, lead: results[lead] ? results[lead].member.name : null,
        used: results.length > 1 ? `majority vote of ${results.length}` : results.length ? 'one member only' : 'fallback: this PC alone',
      });
      if (!results.length) console.log('[council] nobody answered: labeling with this PC alone');
    } catch (err) {
      console.error('[council] labeling failed, using this PC alone:', err.message);
    }
  }
  // The usual way: this PC's model alone.
  if (!found) {
    found = await labelLines(lines, askAI, {
      ...opts, onFrac: (f) => setProgress(dir, 0, 70, f, f < 0.78 ? 'Following the game (table talk, fights, events)' : 'Working out who the GM is voicing'),
    });
  }
  const sceneLog = found.tt.verdicts.map((v) => ({ ...v, t0: lines[v.from].t, t1: lines[v.to - 1].t }));
  const combat = [...found.tt.combat].map((i) => lineKey(lines[i]));
  if (SEPARATE_TABLE_TALK) for (const i of found.tt) offTopic.add(lineKey(lines[i]));
  for (const [i, v] of found.voices) voices.set(lineKey(lines[i]), v);
  updateLabels(dir, {
    sceneLog, combat,
    tagVersion: 4, lineCount: lines.length, voiceLineCount: lines.length,
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
// ask = askAI, or one council member; onStep replaces the progress bar updates (the council reports its own).
async function writeRecap(title, date, gameText, tableText, prevRecap, dir = null, { ask = askAI, onStep = null } = {}) {
  const step = onStep || ((frac, label) => dir && setProgress(dir, 75, 99, frac, label));
  const askAI = ask;
  const prevPart = prevRecap ? `For context, here is the PREVIOUS session's recap:\n${prevRecap}\n\n---\n\n` : '';
  const names = dir ? knownNames(gidOf(dir)) : '';
  const namesPart = names ? `Correct spellings of names in this campaign (the transcript may mangle them): ${names}\n\n` : '';
  // Imported character sheets (D&D): who plays whom, so the recap gets names, classes and roles right.
  let party = [];
  try { party = dir ? listCharacters(gidOf(dir)) : []; } catch { /* no sheets */ }
  const partyPart = party.length ? `THE PARTY (from their character sheets): ${party.map((c) => `${c.name}${c.player ? ` (played by ${c.player})` : ''}: ` +
    `${[c.species, classLine({ classes: c.classes || [] })].filter(Boolean).join(' ')}`).join('; ')}\n\n` : '';
  const log = dir ? gameLogText(readJSON(path.join(dir, 'labels.json'), {}).sceneLog) : '';
  const logPart = log ? `GAME LOG (built while following the whole session; trust it for whether fights, injuries and deaths ` +
    `really happened, since players joke about those a lot):\n${log}\n\n---\n\n` : '';
  const head = `${prevPart}${namesPart}${partyPart}${logPart}Session title: ${title} (${date})\n\n`;
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
      await askAI(CHUNK_NOTES_SYSTEM, `${log ? `GAME LOG FOR THE WHOLE SESSION (for context):\n${log.slice(0, 3000)}\n\n` : ''}TRANSCRIPT PART ${i + 1}:\n${chunks[i]}`, 1200));
  }
  step(chunks.length / (chunks.length + 1), 'Writing the recap from the notes');
  return askAI(RECAP_SYSTEM,
    `${head}The game transcript was long, so here are notes taken from it in order ` +
    `(treat them as the game transcript):\n\n${notes.join('\n\n')}${tablePart}`, 4000);
}

// Council recap: every member writes a draft (in parallel across machines), then the judge merges them, keeping what
// at least two drafts agree on and leaning on the GM's narration and the game log. Returns null if nobody could write
// one, so the caller falls back to this PC alone.
async function councilRecap(meta, gameText, tableText, prevRecap, dir) {
  const rec = { members: [], used: '' };
  try {
    const { results, record, lead } = await runCouncil('recap drafts',
      (m, ask, onFrac) => writeRecap(meta.title, meta.date, gameText, tableText, prevRecap, dir, { ask, onStep: (f) => onFrac(f) }),
      { onProgress: (f, label) => setProgress(dir, 75, 95, f, `Council: writing recap drafts (${label})`) });
    rec.members = record;
    const drafts = results.filter((r) => String(r.value || '').trim().length > 150).map((r) => ({ name: r.member.name, model: r.member.model, text: r.value }));
    if (!drafts.length) { rec.used = 'fallback: this PC alone'; console.log('[council] no drafts: writing the recap with this PC alone'); return null; }
    if (drafts.length === 1) { rec.used = `one draft only (${drafts[0].name})`; return drafts[0].text; }
    setProgress(dir, 95, 99, 0, `Council: the judge is merging ${drafts.length} drafts`);
    try {
      const log = gameLogText(readJSON(path.join(dir, 'labels.json'), {}).sceneLog);
      const j = await judgeDrafts(drafts, { gameLog: log, gameText, title: `${meta.title} (${meta.date})` });
      rec.judge = { ...j.judge, ok: true, secs: j.secs };
      rec.used = `judge merged ${drafts.length} drafts`;
      return j.text;
    } catch (err) {
      // No judge: the judge model's own draft if it wrote one, else the first.
      const pick = results[lead] && drafts.find((d) => d.name === results[lead].member.name) || drafts[0];
      rec.judge = { ok: false, error: String(err.message).slice(0, 200) };
      rec.used = `judge failed; used ${pick.name}'s draft`;
      console.error(`[council] judge failed (${err.message}); using ${pick.name}'s draft`);
      return pick.text;
    }
  } catch (err) {
    rec.used = 'fallback: this PC alone';
    rec.error = String(err.message).slice(0, 200);
    console.error('[council] recap failed, using this PC alone:', err.message);
    return null;
  } finally {
    try { saveCouncilRecord(dir, 'recap', rec); } catch { /* never lose the recap over the record */ }
  }
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
  await tagLines(dir, { force: reclassify });
  const { offTopic, voices } = readLabels(dir);   // includes fixes made by hand
  const recap = await detectOpeningRecap(dir, { prevRecap, force: reclassify });
  const labels = { offTopic, voices, recap };
  writeTranscriptFiles(dir);
  const gameText = formatTranscript(lines, notes, labels, 'game');
  const tableText = offTopic.size ? formatTranscript(lines, [], labels, 'table') : '';
  let text = councilConfig().recap ? await councilRecap(meta, gameText, tableText, prevRecap, dir) : null;
  if (!text) text = await writeRecap(meta.title, meta.date, gameText, tableText, prevRecap, dir);
  // Contacts and loose ends come from the recap; a failure here never loses the recap itself.
  try {
    setProgress(dir, 99, 100, 0, 'Updating contacts and loose ends');
    await updateCampaign(dir, text, askAI);
  } catch (err) {
    console.error('[campaign] skipped:', err.message);
  }
  try {
    setProgress(dir, 99, 100, 0.3, 'Updating the GM\'s NPC voice cards');
    await updateVoiceCards(dir, askAI);
  } catch (err) {
    console.error('[voice cards] skipped:', err.message);
  }
  try {
    setProgress(dir, 99, 100, 0.6, 'Updating the story so far');
    await updateStory(dir, text, askAI);
  } catch (err) {
    console.error('[story] skipped:', err.message);
  }
  // Rules looked up with /game ask during the session.
  const rules = rulesSection(dir);
  const full = rules ? `${text.trim()}\n\n${rules}` : text;
  fs.writeFileSync(path.join(dir, 'recap.md'), full);
  return full;
}

// For compare-council.mjs: labels and recap for a COPY of a session folder, with or without the council.
// Doesn't touch contacts, the story, voice cards or anything else outside that folder.
export async function recapForComparison(dir, { council, prevRecap = null }) {
  setCouncilOverride(council ? { labels: true, recap: true } : { labels: false, recap: false });
  try {
    const meta = readJSON(path.join(dir, 'meta.json'), {});
    const lines = sessionLines(dir);
    const notes = readJSON(path.join(dir, 'notes.json'), []);
    await tagLines(dir, { force: true });
    const { offTopic, voices } = readLabels(dir);
    const recap = await detectOpeningRecap(dir, { prevRecap, force: true });
    const labels = { offTopic, voices, recap };
    const gameText = formatTranscript(lines, notes, labels, 'game');
    const tableText = offTopic.size ? formatTranscript(lines, [], labels, 'table') : '';
    let text = council ? await councilRecap(meta, gameText, tableText, prevRecap, dir) : null;
    if (!text) text = await writeRecap(meta.title, meta.date, gameText, tableText, prevRecap, dir);
    return { text, labels: readJSON(path.join(dir, 'labels.json'), {}), lines };
  } finally {
    setCouncilOverride(null);
  }
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
Players joke about shooting, stabbing and dying all the time. Only report a fight, injury or death if the GAME LOG or the
GM's narration confirms it; if the GAME LOG says there was no combat, there were no fights, injuries from fights or deaths.
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
