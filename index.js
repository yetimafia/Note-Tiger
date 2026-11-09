// Note Tiger bot process: Discord, voice recording and transcription.
// It's started and stopped by the manager (server.js), which also runs the control panel.
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

import fs from 'node:fs';
import path from 'node:path';
import {
  Client, GatewayIntentBits, SlashCommandBuilder, AttachmentBuilder, MessageFlags, EmbedBuilder,
} from 'discord.js';
import {
  joinVoiceChannel, EndBehaviorType, VoiceConnectionStatus, entersState, getVoiceConnection,
} from '@discordjs/voice';
import prism from 'prism-media';
import { pipeline, env as hfEnv } from '@huggingface/transformers';
import { DISCORD_TOKEN, WHISPER_MODEL, WHISPER_DTYPE, MODELS_DIR, LOG_CHANNEL, RECAP_CHANNEL, GM_ROLES } from './config.js';
import {
  readJSON, writeJSON, sessionsDir, getSettings, saveSettings, listSessions, readLines, saveGuildName,
  sessionLines, readTableTalk, readLabels, transcriptEntries, speakerColors, baseName, writeTranscriptFiles,
  sessionStats, statsText, sessionDir,
} from './store.js';
import { askAI, recapSession, buildArchive, ASK_SYSTEM, AI_LABEL } from './ai.js';
import { publishSite, siteConfigured } from './site.js';

console.log(`Starting bot. Recap AI: ${AI_LABEL}`);
const MIN_UTTERANCE_SEC = 0.6;   // ignore coughs and clicks
const SILENCE_MS = 1200;         // pause that ends one utterance

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
hfEnv.cacheDir = MODELS_DIR;

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

// The game master / storyteller is whoever has one of the GM roles (Settings → Game master role).
function isGM(member) {
  return Boolean(member?.roles?.cache?.some((r) => GM_ROLES.includes(r.name.toLowerCase())));
}

function speakerLabel(gid, member) {
  const name = member?.displayName ?? 'Unknown';
  if (isGM(member)) return `${name} (GM)`;
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
        const who = member ?? (await guild.members.fetch(userId).catch(() => null));
        const line = { t: startedAt, d: Math.round(seconds * 10) / 10, speaker: speakerLabel(guild.id, who), text };
        if (isGM(who)) line.gm = true;
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

  const gms = voice.members.filter((m) => isGM(m)).map((m) => m.displayName);
  const gmNote = gms.length
    ? `🎲 Game master: **${gms.join(', ')}**. I'll note who they're voicing (narrator or NPC) in the transcript.\n`
    : `🎲 No game master found. Give the GM a role called **${GM_ROLES[0].replace(/\b\w/g, (c) => c.toUpperCase())}** so I can tell narration and NPCs apart.\n`;
  const beginNote = '📖 Recapping last session first? Type `/session begin` when the game starts, so the recap stays out of the new notes.\n';
  await interaction.editReply(
    `🔴 **Recording "${title}"** in **${voice.name}**.\n` + gmNote + beginNote +
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

  if (lines.length === 0 && notes.length === 0) {
    await channel.send('I didn\'t catch any speech this time, so there\'s no recap.');
    return;
  }

  // Give the AI the previous recap too, so names and threads stay consistent between sessions.
  const prev = listSessions(guild.id).filter((s) => s.dir !== rec.dir).pop();
  const prevRecap = prev && fs.existsSync(path.join(prev.dir, 'recap.md'))
    ? fs.readFileSync(path.join(prev.dir, 'recap.md'), 'utf8') : null;

  let recap = null;
  try {
    recap = await recapSession(rec.dir, { prevRecap });
  } catch (err) {
    console.error('[recap]', err);
    await channel.send(`The recap failed (${err.message}), but the transcript was saved. Fix that and run \`/recap\`.`);
  }

  await publishSession(guild, channel, rec.dir, rec.meta, recap);
}

// Posts a session's recap (+ squirrel-o-meter) to #recaps and its transcript to #logs.
// channel = where a command was used (fallback + short "done" note); null when started from Note Tiger.
// updated = true when reposting, so people can tell it's the new version.
async function publishSession(guild, channel, dir, meta, recap, { updated = false } = {}) {
  const lines = sessionLines(dir);
  const tag = updated ? '🔁 **Updated**\n' : '';
  // Publish to the player website first, so the Discord posts can link to it.
  let siteLink = '';
  if (siteConfigured()) {
    try {
      const r = await publishSite({ dirs: [dir] });
      siteLink = `\n\n🌐 *Read it color-coded on the player website:* ${r.url}`;
    } catch (err) {
      console.error('[website]', err.message);
    }
  }
  // The recap goes to #recaps and the full transcript to #logs (falling back to this channel).
  const recapChannel = findChannel(guild, RECAP_CHANNEL);
  const logChannel = findChannel(guild, LOG_CHANNEL);
  const files = writeTranscriptFiles(dir, guild.id);
  // Discord shows .html files as code, so only the plain text goes to Discord; the color-coded page
  // (transcript.html) is available from "Download transcript" in the Note Tiger window.
  const attachments = () => transcriptAttachments(files.txt, `transcript-${meta.date}`, meta.title);
  const tips = [];
  // Where things go if #recaps / #logs don't exist.
  const home = channel ?? recapChannel ?? logChannel ?? firstWritableChannel(guild);
  if (!home) throw new Error('I can\'t find a text channel I\'m allowed to post in on that server.');

  let logPosted = null;
  if (logChannel) {
    try {
      const st = sessionStats(dir);
      await sendWithFiles(logChannel,
        `${tag}📜 **Transcript: ${meta.title}** (${meta.date}) · ${lines.length} lines` +
          (st ? ` · 🎲 ${st.gamePct}% game · 🐿️ ${st.squirrelPct}% squirrels` : '') + siteLink,
        attachments());
      logPosted = logChannel;
      await postColorLog(logChannel, guild.id, dir, meta.title).catch((err) => console.error('[logs] color log:', err.message));
    } catch (err) {
      console.error(`[logs] couldn't post in #${logChannel.name}:`, err.message);
      tips.push(`I couldn't post in <#${logChannel.id}>. Check that I can send messages and attach files there.`);
    }
  } else if (LOG_CHANNEL) {
    tips.push(`Create a text channel called **#${LOG_CHANNEL}** and I'll post transcripts there.`);
  }

  let recapPosted = null;
  if (recap) {
    const pointer = logPosted ? `\n\n*Full transcript in <#${logPosted.id}>.*` : '';
    const allFiles = logPosted ? [] : attachments();
    const recapFiles = allFiles.slice(0, 1);
    const meter = statsText(sessionStats(dir));
    const text = `${tag}# ${meta.title} — ${meta.date}\n${recap}${meter ? `\n\n${meter}` : ''}${pointer}${siteLink}`;
    if (recapChannel) {
      try { await sendLong(recapChannel, text, recapFiles); recapPosted = recapChannel; }
      catch (err) {
        console.error(`[recaps] couldn't post in #${recapChannel.name}:`, err.message);
        tips.push(`I couldn't post in <#${recapChannel.id}>. Check that I can send messages and attach files there.`);
      }
    } else if (RECAP_CHANNEL) {
      tips.push(`Create a text channel called **#${RECAP_CHANNEL}** and I'll post recaps there.`);
    }
    if (!recapPosted) { await sendLong(home, text, recapFiles); recapPosted = home; }
    for (const f of allFiles.slice(1)) await recapPosted.send({ content: f.partLabel, files: [f] });
    if (!logPosted && allFiles.length) logPosted = recapPosted;
  } else if (!logPosted) {
    await sendWithFiles(home, `${tag}📜 Transcript: ${meta.title}`, attachments());
    logPosted = home;
  }

  // Short note where the command was used, so people know where to look.
  if (channel) {
    const where = [];
    if (recapPosted && recapPosted.id !== channel.id) where.push(`recap in <#${recapPosted.id}>`);
    if (logPosted && logPosted.id !== channel.id) where.push(`transcript in <#${logPosted.id}>`);
    const note = [where.length ? `✅ Done: ${where.join(', ')}.` : '', ...tips.map((t) => `*${t}*`)].filter(Boolean).join('\n');
    if (note) await channel.send(note).catch(() => {});
  }
  return { recap: recapPosted?.name ?? null, transcript: logPosted?.name ?? null, tips: tips.map((t) => t.replace(/\*\*/g, '').replace(/<#\d+>/g, 'that channel')) };
}

function firstWritableChannel(guild) {
  const me = guild.members.me;
  const ok = (c) => c?.isTextBased?.() && !c.isThread?.() && !c.isVoiceBased?.() && c.permissionsFor(me)?.has(['ViewChannel', 'SendMessages']);
  if (ok(guild.systemChannel)) return guild.systemChannel;
  return guild.channels.cache.filter(ok).sort((a, b) => a.rawPosition - b.rawPosition).first() ?? null;
}

// Re-posts a saved session with its current recap and transcript (after "Rewrite recap", for example).
async function repostSession(guild, sessionDirPath, channel = null) {
  const meta = readJSON(path.join(sessionDirPath, 'meta.json'), {});
  const recapFile = path.join(sessionDirPath, 'recap.md');
  let recap = fs.existsSync(recapFile) ? fs.readFileSync(recapFile, 'utf8') : null;
  if (!recap) recap = await recapSession(sessionDirPath);
  return publishSession(guild, channel, sessionDirPath, meta, recap, { updated: true });
}

// The conversation as color-coded blocks: one pastel color per person, grouped by who's talking.
async function postColorLog(logChannel, gid, dir, title = 'Session') {
  const entries = transcriptEntries(sessionLines(dir), readJSON(path.join(dir, 'notes.json'), []), readLabels(dir));
  if (!entries.length) return;
  const colors = speakerColors(gid, entries.filter((e) => e.kind === 'say').map((e) => e.speaker));
  const clock = (t) => new Date(t).toTimeString().slice(0, 5);
  const hex = (c) => parseInt(String(c || '#C8CCD4').slice(1), 16);

  // Group consecutive lines from the same speaker (and same voice / table-talk state).
  const groups = [];
  for (const e of entries) {
    const name = e.kind === 'note' ? `📝 Note from ${e.speaker}`
      : e.offTopic ? `${e.speaker} · table talk` : e.recap ? `${e.speaker} · recap of last session` : e.speaker;
    const line = `\`${clock(e.t)}\` ${e.offTopic || e.recap ? `*${e.text}*` : e.text}`;
    const last = groups.at(-1);
    if (last && last.name === name && last.text.length + line.length < 3800) last.text += `\n${line}`;
    else groups.push({ name, text: line, color: e.kind === 'note' ? '#C8CCD4' : colors[baseName(e.speaker)] });
  }

  // Discord allows 10 embeds and 6000 characters per message, so long sessions are posted in numbered parts.
  const messages = [];
  let cur = [], size = 0;
  for (const g of groups) {
    const len = g.name.length + g.text.length;
    if (cur.length && (cur.length === 10 || size + len > 5600)) { messages.push(cur); cur = []; size = 0; }
    cur.push(new EmbedBuilder().setAuthor({ name: g.name.slice(0, 250) }).setDescription(g.text.slice(0, 4000)).setColor(hex(g.color)));
    size += len;
  }
  if (cur.length) messages.push(cur);
  const total = messages.length;
  if (total > 40) {
    // Would flood the channel (a long session can be 250+ messages): the text parts above have everything.
    await logChannel.send(`🎨 *The color-coded version of this session is too long for Discord. Open it from **Sessions → Download transcript** in Note Tiger.*`);
    return;
  }
  console.log(`[logs] posting the color-coded transcript in ${total} part${total === 1 ? '' : 's'}`);
  for (let i = 0; i < total; i++) {
    await logChannel.send({
      content: total > 1 ? `📜 **${title}** — part ${i + 1} of ${total}` : `📜 **${title}**`,
      embeds: messages[i],
    });
  }
  if (total > 1) await logChannel.send(`✅ End of **${title}** (${total} parts).`);
}

// Sends files one per message when there are several parts (Discord limits upload size per message).
async function sendWithFiles(channel, content, files) {
  if (files.length <= 1) return channel.send({ content, files });
  await channel.send(content);
  for (const f of files) await channel.send({ content: f.partLabel, files: [f] });
}

// Discord only previews the first ~50 KB of a text file, so long transcripts are split into parts that each
// show in full: "Session 1 — part 1 of 5".
const PART_BYTES = 45_000;
function transcriptAttachments(file, baseName, title = 'Session') {
  const text = fs.readFileSync(file, 'utf8');
  if (Buffer.byteLength(text) <= PART_BYTES) return [new AttachmentBuilder(file, { name: `${baseName}.txt` })];
  const parts = [];
  let cur = '', bytes = 0;
  for (const l of text.split('\n')) {
    const b = Buffer.byteLength(l) + 1;
    if (cur && bytes + b > PART_BYTES - 200) { parts.push(cur); cur = ''; bytes = 0; }
    cur += l + '\n';
    bytes += b;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p, i) => {
    const file = new AttachmentBuilder(Buffer.from(`${title} — part ${i + 1} of ${parts.length}\n\n${p}`), {
      name: `${baseName}-part${i + 1}of${parts.length}.txt`,
    });
    file.partLabel = `📄 **${title}** — part ${i + 1} of ${parts.length}`;
    return file;
  });
}

// A text channel by name (from Settings), if the bot can see it.
function findChannel(guild, name) {
  if (!name) return null;
  return guild.channels.cache.find((c) => c.isTextBased?.() && !c.isThread?.() && !c.isVoiceBased?.() &&
    c.name.toLowerCase() === name && c.permissionsFor(guild.members.me)?.has('ViewChannel')) ?? null;
}


// ---------- slash commands ----------
const commands = [
  new SlashCommandBuilder().setName('session').setDescription('Record a game session')
    .addSubcommand((s) => s.setName('start').setDescription('Join your voice channel and start listening')
      .addStringOption((o) => o.setName('title').setDescription('e.g. "The Renraku Extraction"')))
    .addSubcommand((s) => s.setName('stop').setDescription('Stop recording and post the recap'))
    .addSubcommand((s) => s.setName('begin').setDescription('The recap of last session is done: the game starts now'))
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
  new SlashCommandBuilder().setName('repost').setDescription('Post a session\'s recap and transcript again, updated')
    .addIntegerOption((o) => o.setName('sessions_ago').setDescription('1 = latest (default), 2 = the one before…').setMinValue(1)),
  new SlashCommandBuilder().setName('ask').setDescription('Ask about past sessions')
    .addStringOption((o) => o.setName('question').setDescription('e.g. "What did Mr. Johnson offer us for the Ares job?"').setRequired(true)),
].map((c) => c.toJSON());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
});

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  for (const g of client.guilds.cache.values()) saveGuildName(g.id, g.name);
  report();
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
      if (sub === 'begin') {
        const rec = live.get(gid);
        if (!rec) return interaction.reply({ content: 'Nothing is being recorded. Start with `/session start`.', flags: MessageFlags.Ephemeral });
        rec.meta.playStartedAt = Date.now();
        writeJSON(path.join(rec.dir, 'meta.json'), rec.meta);
        return interaction.reply('▶️ **Game on!** Everything before this was the recap of last session, so it won\'t go into the new notes.');
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
        try { recap = await recapSession(s.dir); }
        catch (err) { return interaction.editReply(err.message); }
      }
      const meter = statsText(sessionStats(s.dir));
      const parts = splitForDiscord(`# ${s.title} — ${s.date}\n${recap}${meter ? `\n\n${meter}` : ''}`);
      await interaction.editReply(parts[0]);
      for (const p of parts.slice(1)) await interaction.followUp(p);
      return;
    }

    if (commandName === 'repost') {
      const sessions = listSessions(gid).filter((x) => !(live.get(gid)?.dir === x.dir));
      const n = interaction.options.getInteger('sessions_ago') ?? 1;
      const s = sessions[sessions.length - n];
      if (!s) return interaction.reply({ content: 'No finished session found that far back.', flags: MessageFlags.Ephemeral });
      await interaction.reply(`🔁 Reposting **${s.title}** (${s.date})…`);
      await repostSession(guild, s.dir, interaction.channel);
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

// ---------- talking to the manager ----------
function report() {
  if (!process.send) return;
  process.send({
    type: 'status',
    online: client.isReady(),
    botName: client.user?.tag ?? null,
    clientId: client.user?.id ?? null,
    loginError,
    speech: { state: whisperState, error: whisperError, model: WHISPER_MODEL },
    guilds: [...client.guilds.cache.values()].map((g) => {
      const rec = live.get(g.id);
      return {
        id: g.id,
        name: g.name,
        recording: rec ? {
          title: rec.meta.title,
          sessionId: path.basename(rec.dir),
          minutes: Math.round((Date.now() - new Date(rec.meta.startedAt)) / 60000),
          lines: rec.lines.length,
          pending: rec.pending.size,
        } : null,
      };
    }),
  });
}
setInterval(report, 2000);

async function shutdown(reason) {
  for (const [gid, rec] of live) {
    const guild = client.guilds.cache.get(gid);
    if (guild) await stopSession(guild, rec.textChannel, reason).catch(() => {});
  }
  client.destroy().catch?.(() => {});
  process.exit(0);
}
process.on('message', async (msg) => {
  if (msg?.type === 'stop') return shutdown('bot stopped from Note Tiger');
  if (msg?.type === 'repost') {
    try {
      const guild = client.guilds.cache.get(msg.gid);
      if (!guild) throw new Error('The bot isn\'t in that server.');
      const dir = sessionDir(msg.gid, msg.sessionId);
      if (live.get(msg.gid)?.dir === dir) throw new Error('That session is still recording.');
      const result = await repostSession(guild, dir);
      process.send({ type: 'reply', id: msg.id, ok: true, result });
    } catch (err) {
      console.error('[repost]', err.message);
      process.send({ type: 'reply', id: msg.id, ok: false, error: err.message });
    }
  }
});
process.on('SIGINT', () => shutdown('bot shutting down'));
process.on('disconnect', () => shutdown('Note Tiger closed'));
process.on('unhandledRejection', (err) => console.error('[unhandled]', err));

client.on('guildCreate', (g) => saveGuildName(g.id, g.name));
client.on('guildUpdate', (_, g) => saveGuildName(g.id, g.name));

let loginError = null;
if (!DISCORD_TOKEN) {
  loginError = 'No Discord token yet. Paste it in Settings.';
  console.log(loginError);
  report();
} else {
  client.login(DISCORD_TOKEN).catch((err) => {
    loginError = /disallowed intents/i.test(err.message)
      ? 'Discord refused the connection: turn on "Server Members Intent" (Developer Portal → Bot → Privileged Gateway Intents), then start the bot again.'
      : /token/i.test(err.message)
        ? 'Discord rejected the token. Reset it in the Developer Portal (Bot → Reset Token) and paste the new one in Settings.'
        : /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(err.message)
          ? 'Could not reach Discord. Check your internet connection, then start the bot again.'
          : `Could not log in to Discord: ${err.message}`;
    console.error(loginError);
    report();
    setTimeout(() => process.exit(2), 500);
  });
}
