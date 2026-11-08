// Note Tiger — a Discord bot that silently listens to a voice channel,
// transcribes everyone who talks, writes a session recap, and answers questions
// about the campaign afterwards.
//
// Commands:
//   /session start [title]   join your voice channel and start listening
//   /session stop            stop, write the recap, post it here
//   /session status          is it recording? how much has it heard?
//   /note text               add a manual note to the current session
//   /character name          link yourself to your runner's name
//   /optout on|off           don't record me / record me again
//   /recap [number]          re-post a past session's recap (1 = latest)
//   /ask question            ask anything about past sessions
//
// Control panel: http://localhost:3080 (settings, sessions, recaps, questions)

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import {
  Client, GatewayIntentBits, SlashCommandBuilder, AttachmentBuilder, MessageFlags,
} from 'discord.js';
import {
  joinVoiceChannel, EndBehaviorType, VoiceConnectionStatus, entersState, getVoiceConnection,
} from '@discordjs/voice';
import prism from 'prism-media';
import Anthropic from '@anthropic-ai/sdk';
import { pipeline, env as hfEnv } from '@huggingface/transformers';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startWeb } from './web.js';

// ---------- log buffer (shown in the control panel) ----------
const LOG_LINES = [];
for (const level of ['log', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    orig(...args);
    const text = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    LOG_LINES.push({ t: Date.now(), level, text: text.slice(0, 2000) });
    if (LOG_LINES.length > 300) LOG_LINES.shift();
  };
}

// ---------- config ----------
const {
  DISCORD_TOKEN,
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL = 'claude-sonnet-5-5',
  OLLAMA_URL = 'http://127.0.0.1:11434',
  OLLAMA_MODEL = 'llama3.1:8b',
  OLLAMA_CONTEXT = '16384',
  WHISPER_MODEL = 'onnx-community/whisper-small.en',
  WHISPER_DTYPE = 'q8',
  CAMPAIGN_NAME = 'our Shadowrun campaign',
  DATA_DIR = './data',
  PANEL_PORT = '3080',
} = process.env;

// With a Claude key the bot uses Claude; without one it uses a local model through Ollama.
const USE_CLAUDE = Boolean(ANTHROPIC_API_KEY);
const anthropic = USE_CLAUDE ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
console.log(USE_CLAUDE ? `AI: Claude (${CLAUDE_MODEL})` : `AI: local model ${OLLAMA_MODEL} via Ollama`);
const MIN_UTTERANCE_SEC = 0.6;   // ignore coughs and clicks
const SILENCE_MS = 1200;         // pause that ends one utterance
// How much text the AI may read at once. Local models have much less room than Claude.
const ASK_CHAR_BUDGET = USE_CLAUDE ? 600_000 : 30_000;
const RECAP_CHUNK_CHARS = USE_CLAUDE ? 600_000 : 24_000;

// ---------- storage helpers ----------
const guildDir = (gid) => path.join(DATA_DIR, gid);
const sessionsDir = (gid) => path.join(guildDir(gid), 'sessions');
fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
const settingsFile = (gid) => path.join(guildDir(gid), 'settings.json');
const getSettings = (gid) => readJSON(settingsFile(gid), { characters: {}, optout: [] });
const saveSettings = (gid, s) => writeJSON(settingsFile(gid), s);

// Folder and server ids come from the control panel's URLs, so only allow safe characters.
const SAFE_ID = /^[\w.-]+$/;
function sessionDir(gid, id) {
  if (!/^\d+$/.test(gid) || !SAFE_ID.test(id) || id.includes('..')) throw new Error('Bad session id');
  const dir = path.join(sessionsDir(gid), id);
  if (!fs.existsSync(path.join(dir, 'meta.json'))) throw new Error('Session not found');
  return dir;
}

function listSessions(gid) {
  const dir = sessionsDir(gid);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((d) => fs.existsSync(path.join(dir, d, 'meta.json')))
    .sort() // folder names start with an ISO date, so this is chronological
    .map((d) => ({ dir: path.join(dir, d), ...readJSON(path.join(dir, d, 'meta.json'), {}) }));
}

// ---------- audio helpers ----------
// Discord gives 48 kHz stereo PCM. Whisper wants 16 kHz mono.
function toMono16k(pcm48kStereo) {
  const inSamples = pcm48kStereo.length / 4; // 2 ch * 2 bytes
  const outSamples = Math.floor(inSamples / 3);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    let sum = 0;
    for (let j = 0; j < 3; j++) {
      const idx = (i * 3 + j) * 4;
      sum += pcm48kStereo.readInt16LE(idx) + pcm48kStereo.readInt16LE(idx + 2);
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / 6))), i * 2);
  }
  return out;
}

// Keep downloaded models next to the app so updates don't delete them.
hfEnv.cacheDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'models');

// ---------- local speech-to-text (Whisper, runs on this computer) ----------
// The model downloads once (a few hundred MB) on first start, then works offline.
let whisperPromise = null;
let whisperState = 'idle'; // idle | loading | ready | error
let whisperError = null;
function loadWhisper() {
  if (!whisperPromise) {
    whisperState = 'loading';
    console.log(`Loading speech model ${WHISPER_MODEL} (first run downloads it, this can take a few minutes)…`);
    whisperPromise = pipeline('automatic-speech-recognition', WHISPER_MODEL, { dtype: WHISPER_DTYPE })
      .then((p) => { whisperState = 'ready'; console.log('Speech model ready.'); return p; })
      .catch((err) => { whisperPromise = null; whisperState = 'error'; whisperError = err.message; throw err; });
  }
  return whisperPromise;
}

// Whisper sometimes "hears" these in silence or noise; drop them.
const HALLUCINATIONS = /^(\s*(thank you( for watching)?|thanks( for watching)?|you|\.+|\[[^\]]*\]|\([^)]*\))[.!?]*\s*)$/i;

// One clip at a time so the game PC doesn't get bogged down.
let queue = Promise.resolve();
function transcribe(pcm16kMono) {
  const job = queue.then(async () => {
    const whisper = await loadWhisper();
    const audio = new Float32Array(pcm16kMono.length / 2);
    for (let i = 0; i < audio.length; i++) audio[i] = pcm16kMono.readInt16LE(i * 2) / 32768;
    const out = await whisper(audio, { chunk_length_s: 30, stride_length_s: 5 });
    const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text || '').trim();
    return HALLUCINATIONS.test(text) ? '' : text;
  });
  queue = job.catch(() => {});
  return job;
}

// ---------- live recording state ----------
// guildId -> { dir, meta, textChannel, lines: [], pending: Set<Promise>, active: Set<userId> }
const live = new Map();

function speakerLabel(gid, member) {
  const name = member?.displayName ?? 'Unknown';
  const runner = getSettings(gid).characters[member?.id];
  return runner ? `${name} (${runner})` : name;
}

function listenTo(guild, connection, userId) {
  const rec = live.get(guild.id);
  if (!rec || rec.active.has(userId)) return;
  const member = guild.members.cache.get(userId);
  if (member?.user.bot) return;
  if (getSettings(guild.id).optout.includes(userId)) return;

  rec.active.add(userId);
  const startedAt = Date.now();
  const opus = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
  });
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const chunks = [];

  const finish = () => {
    rec.active.delete(userId);
    const pcm = Buffer.concat(chunks);
    const seconds = pcm.length / (48000 * 4);
    if (seconds < MIN_UTTERANCE_SEC) return;

    const job = (async () => {
      try {
        const text = await transcribe(toMono16k(pcm));
        if (!text) return;
        const line = {
          t: startedAt,
          speaker: speakerLabel(guild.id, member ?? (await guild.members.fetch(userId).catch(() => null))),
          text,
        };
        rec.lines.push(line);
        fs.appendFileSync(path.join(rec.dir, 'transcript.jsonl'), JSON.stringify(line) + '\n');
      } catch (err) {
        console.error('[transcribe]', err.message);
      }
    })();
    rec.pending.add(job);
    job.finally(() => rec.pending.delete(job));
  };

  opus.on('error', (e) => console.error('[opus]', e.message));
  decoder.on('error', (e) => console.error('[decoder]', e.message));
  opus.pipe(decoder);
  decoder.on('data', (c) => chunks.push(c));
  decoder.on('end', finish);
}

// ---------- Claude ----------
async function askAI(system, user, maxTokens = 4000) {
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
        options: { num_ctx: Number(OLLAMA_CONTEXT), num_predict: maxTokens, temperature: 0.4 },
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
async function writeRecap(title, date, transcriptText, prevRecap) {
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

function formatTranscript(lines, notes = []) {
  const all = [
    ...lines.map((l) => ({ ...l, kind: 'say' })),
    ...notes.map((n) => ({ ...n, kind: 'note' })),
  ].sort((a, b) => a.t - b.t);
  return all.map((l) => {
    const time = new Date(l.t).toTimeString().slice(0, 5);
    return l.kind === 'note'
      ? `[${time}] NOTE from ${l.speaker}: ${l.text}`
      : `[${time}] ${l.speaker}: ${l.text}`;
  }).join('\n');
}

const RECAP_SYSTEM = `You are the campaign scribe for ${CAMPAIGN_NAME}, a Shadowrun tabletop RPG game.
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

const ASK_SYSTEM = `You are the campaign scribe for ${CAMPAIGN_NAME}, a Shadowrun tabletop RPG game.
You have the archive of past sessions: recaps and raw speech-to-text transcripts (which contain recognition
errors and out-of-character chatter). Answer the player's question using only this archive.
Say which session(s) your answer comes from (by date/title). If the archive doesn't contain the answer,
say so plainly — don't make things up. Keep answers short enough for a Discord message unless asked for detail.`;

function buildArchive(gid) {
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

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Discord messages max out at 2000 characters.
function splitForDiscord(text, max = 1900) {
  const parts = [];
  let cur = '';
  for (const para of text.split('\n')) {
    if ((cur + '\n' + para).length > max) {
      if (cur) parts.push(cur);
      cur = para.length > max ? para.slice(0, max) : para;
    } else cur = cur ? `${cur}\n${para}` : para;
  }
  if (cur) parts.push(cur);
  return parts;
}

async function sendLong(channel, text, files = []) {
  const parts = splitForDiscord(text);
  for (let i = 0; i < parts.length; i++) {
    await channel.send({ content: parts[i], files: i === parts.length - 1 ? files : [] });
  }
}

// ---------- session start / stop ----------
async function startSession(interaction) {
  const { guild } = interaction;
  if (live.has(guild.id)) return interaction.reply({ content: 'Already recording a session.', flags: MessageFlags.Ephemeral });

  const voice = interaction.member.voice?.channel;
  if (!voice) return interaction.reply({ content: 'Join a voice channel first, then run `/session start`.', flags: MessageFlags.Ephemeral });

  await interaction.deferReply();
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const title = interaction.options.getString('title') || `Session ${listSessions(guild.id).length + 1}`;
  const dir = path.join(sessionsDir(guild.id), `${now.toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(dir, { recursive: true });
  const meta = { title, date, startedAt: now.toISOString(), voiceChannel: voice.name };
  writeJSON(path.join(dir, 'meta.json'), meta);
  writeJSON(path.join(dir, 'notes.json'), []);

  const connection = joinVoiceChannel({
    channelId: voice.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, // must be able to hear
    selfMute: true,  // never talks
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch {
    connection.destroy();
    return interaction.editReply('Could not connect to voice. Check that I have **Connect** permission on that channel.');
  }

  await guild.members.fetch().catch(() => {});
  live.set(guild.id, { dir, meta, textChannel: interaction.channel, lines: [], pending: new Set(), active: new Set() });
  connection.receiver.speaking.on('start', (userId) => listenTo(guild, connection, userId));

  // Auto-stop if the bot gets kicked or the connection dies.
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      if (live.has(guild.id)) await stopSession(guild, interaction.channel, 'Disconnected from voice');
    }
  });

  await interaction.editReply(
    `🔴 **Recording "${title}"** in **${voice.name}**.\n` +
    'Everyone in the channel is being transcribed for the session recap. ' +
    'Don\'t want to be recorded? Use `/optout on`. Stop with `/session stop`.',
  );
}

async function stopSession(guild, channel, reason) {
  const rec = live.get(guild.id);
  if (!rec) return null;
  live.delete(guild.id);
  getVoiceConnection(guild.id)?.destroy();

  await channel.send(`⏹️ Recording stopped${reason ? ` (${reason})` : ''}. Finishing transcription and writing the recap…`);
  await Promise.allSettled([...rec.pending]);

  const lines = readLines(path.join(rec.dir, 'transcript.jsonl'));
  const notes = readJSON(path.join(rec.dir, 'notes.json'), []);
  rec.meta.endedAt = new Date().toISOString();
  rec.meta.lineCount = lines.length;
  writeJSON(path.join(rec.dir, 'meta.json'), rec.meta);

  const transcriptText = formatTranscript(lines, notes);
  fs.writeFileSync(path.join(rec.dir, 'transcript.txt'), transcriptText);

  if (lines.length === 0 && notes.length === 0) {
    await channel.send('I didn\'t catch any speech this time, so there\'s no recap.');
    return;
  }

  // Give the AI the previous recap too, so names and threads stay consistent between sessions.
  const prev = listSessions(guild.id).filter((s) => s.dir !== rec.dir).pop();
  const prevRecap = prev && fs.existsSync(path.join(prev.dir, 'recap.md'))
    ? fs.readFileSync(path.join(prev.dir, 'recap.md'), 'utf8') : null;

  let recap;
  try {
    recap = await writeRecap(rec.meta.title, rec.meta.date, transcriptText, prevRecap);
  } catch (err) {
    console.error('[recap]', err);
    await channel.send(`The recap failed (${err.message}), but the transcript was saved. Fix that and run \`/recap\`.`);
    return;
  }
  fs.writeFileSync(path.join(rec.dir, 'recap.md'), recap);

  await sendLong(channel, `# ${rec.meta.title} — ${rec.meta.date}\n${recap}`, [
    new AttachmentBuilder(path.join(rec.dir, 'transcript.txt'), { name: `transcript-${rec.meta.date}.txt` }),
  ]);
}

// ---------- slash commands ----------
const commands = [
  new SlashCommandBuilder().setName('session').setDescription('Record a game session')
    .addSubcommand((s) => s.setName('start').setDescription('Join your voice channel and start listening')
      .addStringOption((o) => o.setName('title').setDescription('e.g. "The Renraku Extraction"')))
    .addSubcommand((s) => s.setName('stop').setDescription('Stop recording and post the recap'))
    .addSubcommand((s) => s.setName('status').setDescription('Show recording status')),
  new SlashCommandBuilder().setName('note').setDescription('Add a note to the current session')
    .addStringOption((o) => o.setName('text').setDescription('The note').setRequired(true)),
  new SlashCommandBuilder().setName('character').setDescription('Link yourself to your runner\'s name')
    .addStringOption((o) => o.setName('name').setDescription('Runner name (leave empty to clear)')),
  new SlashCommandBuilder().setName('optout').setDescription('Choose whether your voice is recorded')
    .addStringOption((o) => o.setName('mode').setDescription('on = don\'t record me').setRequired(true)
      .addChoices({ name: 'on (don\'t record me)', value: 'on' }, { name: 'off (record me)', value: 'off' })),
  new SlashCommandBuilder().setName('recap').setDescription('Re-post a past session recap')
    .addIntegerOption((o) => o.setName('sessions_ago').setDescription('1 = latest (default), 2 = the one before…').setMinValue(1)),
  new SlashCommandBuilder().setName('ask').setDescription('Ask about past sessions')
    .addStringOption((o) => o.setName('question').setDescription('e.g. "What did Mr. Johnson offer us for the Ares job?"').setRequired(true)),
].map((c) => c.toJSON());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
});

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  loadWhisper().catch((e) => console.error('Speech model failed to load:', e.message));
  for (const guild of client.guilds.cache.values()) {
    await guild.commands.set(commands).catch((e) => console.error(`Command registration failed in ${guild.name}:`, e.message));
  }
  console.log('Slash commands registered.');
});
client.on('guildCreate', (guild) => guild.commands.set(commands).catch(() => {}));

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { guild, commandName } = interaction;
  const gid = guild.id;

  try {
    if (commandName === 'session') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'start') return await startSession(interaction);
      if (sub === 'stop') {
        if (!live.has(gid)) return interaction.reply({ content: 'Nothing is being recorded.', flags: MessageFlags.Ephemeral });
        await interaction.reply('Wrapping up…');
        return await stopSession(guild, interaction.channel);
      }
      if (sub === 'status') {
        const rec = live.get(gid);
        if (!rec) return interaction.reply({ content: 'Not recording.', flags: MessageFlags.Ephemeral });
        const mins = Math.round((Date.now() - new Date(rec.meta.startedAt)) / 60000);
        return interaction.reply({
          content: `🔴 Recording **${rec.meta.title}** for ${mins} min — ${rec.lines.length} lines transcribed, ${rec.pending.size} in progress.`,
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    if (commandName === 'note') {
      const rec = live.get(gid);
      if (!rec) return interaction.reply({ content: 'No session is running. Start one with `/session start`.', flags: MessageFlags.Ephemeral });
      const file = path.join(rec.dir, 'notes.json');
      const notes = readJSON(file, []);
      notes.push({ t: Date.now(), speaker: speakerLabel(gid, interaction.member), text: interaction.options.getString('text') });
      writeJSON(file, notes);
      return interaction.reply({ content: '📝 Noted.', flags: MessageFlags.Ephemeral });
    }

    if (commandName === 'character') {
      const s = getSettings(gid);
      const name = interaction.options.getString('name');
      if (name) s.characters[interaction.user.id] = name; else delete s.characters[interaction.user.id];
      saveSettings(gid, s);
      return interaction.reply({ content: name ? `You're now listed as **${name}** in transcripts.` : 'Runner name cleared.', flags: MessageFlags.Ephemeral });
    }

    if (commandName === 'optout') {
      const s = getSettings(gid);
      const on = interaction.options.getString('mode') === 'on';
      s.optout = s.optout.filter((id) => id !== interaction.user.id);
      if (on) s.optout.push(interaction.user.id);
      saveSettings(gid, s);
      return interaction.reply({ content: on ? 'Got it — I won\'t record your voice.' : 'You\'ll be included in recordings again.', flags: MessageFlags.Ephemeral });
    }

    if (commandName === 'recap') {
      const sessions = listSessions(gid);
      const n = interaction.options.getInteger('sessions_ago') ?? 1;
      const s = sessions[sessions.length - n];
      if (!s) return interaction.reply({ content: 'No session found that far back.', flags: MessageFlags.Ephemeral });
      const file = path.join(s.dir, 'recap.md');
      await interaction.deferReply();
      let recap = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      if (!recap) {
        // Recap failed or never ran — try to build it now from the saved transcript.
        const text = formatTranscript(readLines(path.join(s.dir, 'transcript.jsonl')), readJSON(path.join(s.dir, 'notes.json'), []));
        if (!text) return interaction.editReply('That session has no transcript.');
        recap = await writeRecap(s.title, s.date, text, null);
        fs.writeFileSync(file, recap);
      }
      const parts = splitForDiscord(`# ${s.title} — ${s.date}\n${recap}`);
      await interaction.editReply(parts[0]);
      for (const p of parts.slice(1)) await interaction.followUp(p);
      return;
    }

    if (commandName === 'ask') {
      const question = interaction.options.getString('question');
      await interaction.deferReply();
      const { archive, count } = buildArchive(gid);
      if (count === 0) return interaction.editReply('No sessions recorded yet.');
      const answer = await askAI(ASK_SYSTEM, `ARCHIVE:\n${archive}\n\n---\nQUESTION from ${speakerLabel(gid, interaction.member)}: ${question}`, 1500);
      const parts = splitForDiscord(`> ${question}\n${answer}`);
      await interaction.editReply(parts[0]);
      for (const p of parts.slice(1)) await interaction.followUp(p);
    }
  } catch (err) {
    console.error(`[${commandName}]`, err);
    const msg = `Something went wrong: ${err.message}`.slice(0, 1900);
    if (interaction.deferred || interaction.replied) await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    else await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

// Save the session if the bot is shut down with Ctrl+C mid-game.
process.on('SIGINT', async () => {
  for (const [gid, rec] of live) {
    const guild = client.guilds.cache.get(gid);
    if (guild) await stopSession(guild, rec.textChannel, 'bot shutting down').catch(() => {});
  }
  process.exit(0);
});

// ---------- local AI health check (cached for a few seconds) ----------
let ollamaCache = { t: 0, value: null };
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
checkOllama();
setInterval(checkOllama, 10_000).unref();

// ---------- control panel ----------
let loginError = null;
const RESTART_CODE = 75; // start-bot.bat restarts the bot when it exits with this code

startWeb({
  status() {
    return {
      online: client.isReady(),
      botName: client.user?.tag ?? null,
      hasToken: Boolean(DISCORD_TOKEN),
      loginError,
      ai: USE_CLAUDE ? `Claude (${CLAUDE_MODEL})` : `Local: ${OLLAMA_MODEL} (Ollama)`,
      usingClaude: USE_CLAUDE,
      ollama: USE_CLAUDE ? null : ollamaCache.value,
      ollamaModel: OLLAMA_MODEL,
      speech: { state: whisperState, error: whisperError, model: WHISPER_MODEL },
      canInstallLocalAI: process.platform === 'win32',
      campaign: CAMPAIGN_NAME,
      inviteUrl: client.user
        ? `https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot%20applications.commands&permissions=2150665216`
        : null,
      guilds: [...client.guilds.cache.values()].map((g) => {
        const rec = live.get(g.id);
        return {
          id: g.id,
          name: g.name,
          sessions: listSessions(g.id).length,
          recording: rec ? {
            title: rec.meta.title,
            minutes: Math.round((Date.now() - new Date(rec.meta.startedAt)) / 60000),
            lines: rec.lines.length,
            pending: rec.pending.size,
          } : null,
        };
      }),
    };
  },
  listSessions(gid) {
    if (!/^\d+$/.test(gid)) throw new Error('Bad server id');
    return listSessions(gid).reverse().map((s) => ({
      id: path.basename(s.dir),
      title: s.title,
      date: s.date,
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? null,
      lines: s.lineCount ?? null,
      hasRecap: fs.existsSync(path.join(s.dir, 'recap.md')),
      live: live.get(gid)?.dir === s.dir,
    }));
  },
  readSession(gid, id) {
    const dir = sessionDir(gid, id);
    const meta = readJSON(path.join(dir, 'meta.json'), {});
    const recapFile = path.join(dir, 'recap.md');
    return {
      ...meta,
      id,
      recap: fs.existsSync(recapFile) ? fs.readFileSync(recapFile, 'utf8') : null,
      transcript: formatTranscript(readLines(path.join(dir, 'transcript.jsonl')), readJSON(path.join(dir, 'notes.json'), [])),
    };
  },
  async regenerateRecap(gid, id) {
    const dir = sessionDir(gid, id);
    if (live.get(gid)?.dir === dir) throw new Error('That session is still recording.');
    const meta = readJSON(path.join(dir, 'meta.json'), {});
    const text = formatTranscript(readLines(path.join(dir, 'transcript.jsonl')), readJSON(path.join(dir, 'notes.json'), []));
    if (!text) throw new Error('That session has no transcript.');
    const recap = await writeRecap(meta.title, meta.date, text, null);
    fs.writeFileSync(path.join(dir, 'recap.md'), recap);
    return recap;
  },
  deleteSession(gid, id) {
    const dir = sessionDir(gid, id);
    if (live.get(gid)?.dir === dir) throw new Error('Stop the recording before deleting it.');
    fs.rmSync(dir, { recursive: true, force: true });
  },
  async ask(gid, question) {
    if (!/^\d+$/.test(gid)) throw new Error('Bad server id');
    const { archive, count } = buildArchive(gid);
    if (count === 0) return 'No sessions recorded yet.';
    return askAI(ASK_SYSTEM, `ARCHIVE:\n${archive}\n\n---\nQUESTION from the GM: ${question}`, 1500);
  },
  logs() { return LOG_LINES; },
  setupLocalAI() {
    if (process.platform !== 'win32') throw new Error('Automatic setup is Windows-only. Install Ollama from ollama.com, then run: ollama pull ' + OLLAMA_MODEL);
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'setup-local-ai.bat');
    if (!fs.existsSync(script)) throw new Error('setup-local-ai.bat is missing from the bot folder.');
    exec(`start "Note Tiger: local AI setup" cmd /c ""${script}""`, { cwd: path.dirname(script) });
    ollamaCache.t = 0;
  },
  async stop() {
    for (const [gid, rec] of live) {
      const guild = client.guilds.cache.get(gid);
      if (guild) await stopSession(guild, rec.textChannel, 'bot shutting down').catch(() => {});
    }
    process.exit(0);
  },
  async restart() {
    for (const [gid, rec] of live) {
      const guild = client.guilds.cache.get(gid);
      if (guild) await stopSession(guild, rec.textChannel, 'bot restarting').catch(() => {});
    }
    process.exit(RESTART_CODE);
  },
}, Number(PANEL_PORT));

// Open the panel in the browser on first launch (not after a restart from the panel).
if (!process.env.NT_RESTARTED && process.env.OPEN_PANEL !== 'false') {
  const url = `http://localhost:${PANEL_PORT}`;
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

process.on('unhandledRejection', (err) => console.error('[unhandled]', err));

if (!DISCORD_TOKEN) {
  console.log('No Discord token yet. Open the control panel to finish setup.');
  loadWhisper().catch((e) => console.error('Speech model failed to load:', e.message));
} else {
  client.login(DISCORD_TOKEN).catch((err) => {
    loginError = /disallowed intents/i.test(err.message)
      ? 'Discord refused the connection: turn on "Server Members Intent" (Developer Portal → Bot → Privileged Gateway Intents), then restart.'
      : /token/i.test(err.message)
        ? 'Discord rejected the token. Reset it in the Developer Portal (Bot → Reset Token) and paste the new one in Settings.'
        : `Could not log in to Discord: ${err.message}`;
    console.error(loginError);
  });
}
