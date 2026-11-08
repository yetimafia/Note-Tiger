// Recaps and questions: Claude (with an API key) or a local model through Ollama.
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import {
  USE_CLAUDE, ANTHROPIC_API_KEY, CLAUDE_MODEL, OLLAMA_URL, OLLAMA_MODEL, OLLAMA_CONTEXT, CAMPAIGN_NAME, SEPARATE_TABLE_TALK,
} from './config.js';
import {
  listSessions, readJSON, formatTranscript, sessionLines, readLabels, updateLabels, lineKey, writeTranscriptFiles,
} from './store.js';

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

// ---------- table talk ----------
const TABLE_TALK_SYSTEM = `You sort lines from a speech-to-text transcript of a Shadowrun tabletop RPG session.
Each line starts with an id like L12. Find the stretches of OFF-TOPIC TABLE TALK: conversation that has nothing to do
with the game, such as real life, work, food, other games, movies, sports, tech problems, or jokes unrelated to the game.

These are NOT table talk (they count as the game): anything said in character, the GM narrating or voicing NPCs,
players deciding what their characters do, dice rolls and results, rules questions, planning the run, and
jokes about what's happening in the game.

Answer with JSON only, in this exact shape: {"offTopic": [[first_id, last_id], ...]}
Use the numbers from the ids. A single line is [n, n]. If there is no table talk, answer {"offTopic": []}.
When unsure, treat the line as part of the game.`;

function parseRanges(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const ranges = JSON.parse(match[0]).offTopic;
    return Array.isArray(ranges) ? ranges : [];
  } catch {
    return [];
  }
}

// Tags off-topic lines and saves them to labels.json. Reuses the saved result unless the transcript changed.
export async function classifyTableTalk(dir, { force = false } = {}) {
  const lines = sessionLines(dir);
  const labelsFile = path.join(dir, 'labels.json');
  const saved = readJSON(labelsFile, null);
  if (!force && saved && saved.lineCount === lines.length) return new Set(saved.offTopic);
  if (!SEPARATE_TABLE_TALK || lines.length === 0) return new Set();

  const offTopic = new Set();
  const chunkChars = USE_CLAUDE ? 120_000 : 14_000;
  let start = 0;
  while (start < lines.length) {
    let end = start, size = 0;
    while (end < lines.length && (size < chunkChars || end === start)) { size += lines[end].text.length + 30; end++; }
    const numbered = lines.slice(start, end).map((l, i) => `L${start + i} ${l.speaker}: ${l.text}`).join('\n');
    console.log(`[table talk] checking lines ${start + 1}–${end} of ${lines.length}`);
    try {
      const answer = await askAI(TABLE_TALK_SYSTEM, numbered, 1500, { json: true });
      for (const range of parseRanges(answer)) {
        const [a, b] = (Array.isArray(range) ? range : [range, range]).map(Number);
        if (!Number.isFinite(a)) continue;
        for (let i = Math.max(a, start); i <= Math.min(Number.isFinite(b) ? b : a, end - 1); i++) offTopic.add(lineKey(lines[i]));
      }
    } catch (err) {
      console.error('[table talk] skipped a part:', err.message);
    }
    start = end;
  }
  updateLabels(dir, { lineCount: lines.length, offTopic: [...offTopic] });
  console.log(`[table talk] ${offTopic.size} of ${lines.length} lines are table talk`);
  return offTopic;
}

// ---------- who the GM is voicing ----------
const VOICES_SYSTEM = `You help label a speech-to-text transcript of a Shadowrun tabletop RPG session.
Each line starts with an id like L12. Lines marked [GM] are spoken by the game master (storyteller).
For every [GM] line, decide who the GM is speaking as, using the surrounding lines for context:
- "Narrator": describing scenes, places, what happens, results of actions.
- An NPC's name, when the GM speaks as a character (dialogue, often in first person). Use the name from context
  (e.g. "Mr. Johnson"). If the NPC has no name, use a short description like "Bouncer" or "Security guard".
  Keep using the same name for the same character.
- "GM": talking as themselves, out of character (rules, dice, asking players what they do, breaks).

Answer with JSON only: {"voices": [{"from": first_id, "to": last_id, "as": "Name"}, ...]}
Group consecutive [GM] lines with the same voice into one range. Only include [GM] lines.`;

// Labels each GM line as Narrator / an NPC / GM, and saves the result to labels.json.
export async function attributeVoices(dir, offTopic = new Set(), { force = false } = {}) {
  const lines = sessionLines(dir);
  const saved = readJSON(path.join(dir, 'labels.json'), {});
  if (!force && saved.voices && saved.voiceLineCount === lines.length) return new Map(Object.entries(saved.voices));
  const gmIdx = lines.map((l, i) => (l.gm && !offTopic.has(lineKey(l)) ? i : -1)).filter((i) => i >= 0);
  if (gmIdx.length === 0) { updateLabels(dir, { voiceLineCount: lines.length, voices: {} }); return new Map(); }

  const voices = new Map();
  const known = new Set();
  const chunkChars = USE_CLAUDE ? 120_000 : 12_000;
  let start = 0;
  while (start < lines.length) {
    let end = start, size = 0;
    while (end < lines.length && (size < chunkChars || end === start)) { size += lines[end].text.length + 30; end++; }
    if (gmIdx.some((i) => i >= start && i < end)) {
      const ctx = lines.slice(start, end).map((l, k) => {
        const i = start + k;
        if (offTopic.has(lineKey(l))) return null; // table talk isn't useful context
        return `L${i} ${l.gm ? '[GM] ' : ''}${l.speaker}: ${l.text}`;
      }).filter(Boolean).join('\n');
      const knownPart = known.size ? `Characters the GM has voiced so far: ${[...known].join(', ')}\n\n` : '';
      console.log(`[voices] labeling GM lines ${start + 1}–${end} of ${lines.length}`);
      try {
        const answer = await askAI(VOICES_SYSTEM, knownPart + ctx, 2000, { json: true });
        const m = answer.match(/\{[\s\S]*\}/);
        const ranges = m ? JSON.parse(m[0]).voices : [];
        for (const r of Array.isArray(ranges) ? ranges : []) {
          const who = String(r?.as ?? '').trim().slice(0, 40);
          const a = Number(r?.from), b = Number.isFinite(Number(r?.to)) ? Number(r.to) : a;
          if (!who || !Number.isFinite(a)) continue;
          for (let i = Math.max(a, start); i <= Math.min(b, end - 1); i++) {
            if (lines[i]?.gm) voices.set(lineKey(lines[i]), /^(gm|game ?master)$/i.test(who) ? 'GM' : /^narrat/i.test(who) ? 'Narrator' : who);
          }
          if (!/^(gm|game ?master|narrat)/i.test(who)) known.add(who);
        }
      } catch (err) {
        console.error('[voices] skipped a part:', err.message);
      }
    }
    start = end;
  }
  updateLabels(dir, { voiceLineCount: lines.length, voices: Object.fromEntries(voices) });
  console.log(`[voices] labeled ${voices.size} of ${gmIdx.length} GM lines${known.size ? ` (NPCs: ${[...known].join(', ')})` : ''}`);
  return voices;
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
async function writeRecap(title, date, gameText, tableText, prevRecap) {
  const prevPart = prevRecap ? `For context, here is the PREVIOUS session's recap:\n${prevRecap}\n\n---\n\n` : '';
  const head = `${prevPart}Session title: ${title} (${date})\n\n`;
  const tablePart = tableText ? `\n\n---\n${TABLE_TALK_NOTE}\n${tableTalkCandidates(tableText, USE_CLAUDE ? 60_000 : 6_000)}` : '';
  const chunks = chunkText(gameText || '(no in-game talk was transcribed)', RECAP_CHUNK_CHARS);
  if (chunks.length === 1) {
    return askAI(RECAP_SYSTEM, `${head}GAME TRANSCRIPT:\n${gameText}${tablePart}`, 6000);
  }
  const notes = [];
  for (let i = 0; i < chunks.length; i++) {
    console.log(`[recap] notes for part ${i + 1}/${chunks.length}`);
    notes.push(`--- Part ${i + 1} of ${chunks.length} ---\n` +
      await askAI(CHUNK_NOTES_SYSTEM, `TRANSCRIPT PART ${i + 1}:\n${chunks[i]}`, 1200));
  }
  return askAI(RECAP_SYSTEM,
    `${head}The game transcript was long, so here are notes taken from it in order ` +
    `(treat them as the game transcript):\n\n${notes.join('\n\n')}${tablePart}`, 4000);
}

// Tags table talk, writes transcript.txt and recap.md for a session folder, and returns the recap.
export async function recapSession(dir, { prevRecap = null, reclassify = false } = {}) {
  const meta = readJSON(path.join(dir, 'meta.json'), {});
  const lines = sessionLines(dir);
  const notes = readJSON(path.join(dir, 'notes.json'), []);
  if (lines.length === 0 && notes.length === 0) throw new Error('That session has no transcript.');
  const offTopic = await classifyTableTalk(dir, { force: reclassify });
  const voices = await attributeVoices(dir, offTopic, { force: reclassify });
  writeTranscriptFiles(dir);
  const recap = await writeRecap(
    meta.title, meta.date,
    formatTranscript(lines, notes, offTopic, 'game', voices),
    offTopic.size ? formatTranscript(lines, [], offTopic, 'table', voices) : '',
    prevRecap,
  );
  fs.writeFileSync(path.join(dir, 'recap.md'), recap);
  return recap;
}

export const RECAP_SYSTEM = `You are the campaign scribe for ${CAMPAIGN_NAME}, a Shadowrun tabletop RPG game.
You get a raw speech-to-text transcript of one session (the GAME TRANSCRIPT). It is messy: speech recognition
errors and crosstalk. Speaker labels look like "Player (Runner name)". The game master's lines are labeled
"Name (GM as Narrator)", "Name (GM as <NPC name>)" when voicing a character, or "Name (GM)" when out of character.
These labels were added by an AI and may occasionally be wrong; use context.
Off-topic table talk has been separated out; if present it comes after, under TABLE TALK.

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
    const { offTopic, voices } = readLabels(s.dir);
    const transcript = formatTranscript(sessionLines(s.dir), readJSON(path.join(s.dir, 'notes.json'), []), offTopic, 'game', voices);
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
