// Recaps and questions: Claude (with an API key) or a local model through Ollama.
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import {
  USE_CLAUDE, ANTHROPIC_API_KEY, CLAUDE_MODEL, OLLAMA_URL, OLLAMA_MODEL, OLLAMA_CONTEXT, CAMPAIGN_NAME,
} from './config.js';
import { listSessions, readLines, readJSON, formatTranscript } from './store.js';

const anthropic = USE_CLAUDE ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
export const AI_LABEL = USE_CLAUDE ? `Claude (${CLAUDE_MODEL})` : `Local: ${OLLAMA_MODEL} (Ollama)`;

// How much text the AI may read at once. Local models have much less room than Claude.
const ASK_CHAR_BUDGET = USE_CLAUDE ? 600_000 : 30_000;
const RECAP_CHUNK_CHARS = USE_CLAUDE ? 600_000 : 24_000;

export async function askAI(system, user, maxTokens = 4000) {
  if (!USE_CLAUDE) return askOllama(system, user, maxTokens);
  const msg = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

async function askOllama(system, user, maxTokens) {
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        options: { num_ctx: OLLAMA_CONTEXT, num_predict: maxTokens, temperature: 0.4 },
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
Skip out-of-character chatter. Do not invent anything.`;

// Long sessions are too big for a local model in one go, so: notes per chunk, then one recap from the notes.
export async function writeRecap(title, date, transcriptText, prevRecap) {
  const prevPart = prevRecap ? `For context, here is the PREVIOUS session's recap:\n${prevRecap}\n\n---\n\n` : '';
  const chunks = chunkText(transcriptText, RECAP_CHUNK_CHARS);
  if (chunks.length === 1) {
    return askAI(RECAP_SYSTEM, `${prevPart}Session title: ${title} (${date})\n\nTRANSCRIPT:\n${transcriptText}`, 6000);
  }
  const notes = [];
  for (let i = 0; i < chunks.length; i++) {
    console.log(`[recap] notes for part ${i + 1}/${chunks.length}`);
    notes.push(`--- Part ${i + 1} of ${chunks.length} ---\n` +
      await askAI(CHUNK_NOTES_SYSTEM, `TRANSCRIPT PART ${i + 1}:\n${chunks[i]}`, 1200));
  }
  return askAI(RECAP_SYSTEM,
    `${prevPart}Session title: ${title} (${date})\n\nThe transcript was long, so here are notes taken from it in order ` +
    `(treat them as the transcript):\n\n${notes.join('\n\n')}`, 4000);
}

export const RECAP_SYSTEM = `You are the campaign scribe for ${CAMPAIGN_NAME}, a Shadowrun tabletop RPG game.
You get a raw speech-to-text transcript of one session. It is messy: speech recognition errors, crosstalk,
and lots of out-of-character table talk (snacks, rules lookups, jokes). Speaker labels look like
"Player (Runner name)". The GM usually narrates and voices NPCs.

Write a recap the players will enjoy reading and can rely on later. Focus on what happened in the fiction.
Use Discord markdown, and these sections (skip any that have nothing in them):

**📼 The Run So Far** — 2–4 paragraph narrative recap, a little noir flavor, but accurate.
**🕴️ The Job** — who hired the team (Mr. Johnson), the objective, the pay offered/negotiated.
**👥 NPCs & Contacts** — name: who they are, what happened with them, attitude toward the team.
**📍 Places** — locations visited or mentioned that matter.
**💰 Payouts & Loot** — nuyen, karma, gear, paydata gained or spent.
**🩸 Consequences** — injuries, heat, burned contacts, enemies made, essence loss.
**🧵 Loose Threads** — open questions, leads, promises made, things to follow up next session.
**💬 Best Lines** — up to 3 memorable quotes (only if clearly funny or dramatic).

Rules: never invent facts. If something is unclear from the transcript, say it's unclear rather than guessing.
Ignore rules arguments and off-topic chatter unless it changed something in the game.`;

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
    const lines = readLines(path.join(s.dir, 'transcript.jsonl'));
    const notes = readJSON(path.join(s.dir, 'notes.json'), []);
    const block = `\n\n=== Session ${i + 1}: ${s.title} (${s.date}) — TRANSCRIPT ===\n${formatTranscript(lines, notes)}`;
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
