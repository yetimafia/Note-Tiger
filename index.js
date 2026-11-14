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
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  AttachmentBuilder,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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
import { askAI, recapSession, buildArchive, ASK_SYSTEM, AI_LABEL, getProgress } from './ai.js';
import { publishSite, siteConfigured, siteUrl } from './site.js';
import { askBooks, booksFor, serverSetup, renderPage, pageInfo } from './library.js';
import { buildCampaign, addEdit, campaignSummary, logRulesCall, npcKey, latestStory, allQuotes, gmPrep } from './campaign.js';
import { knownNames } from './spelling.js';
import { campaignBook } from './book.js';
import {
  importSheet, saveCharacter, findCharacter, listCharacters, deleteCharacter, sheetSummary, sheetForAI, fillSheet, listTemplates,
  ASK_SYSTEM as SHEET_ASK_SYSTEM,
} from './sheets.js';
import { startBuilder, handleBuilder } from './builder.js';
import { sendAlert } from './alerts.js';
import { SITE_PASSWORD, SITE_SHARE_PASSWORD, LIB_PAGE_IMAGES, USE_CLAUDE, GM_CHANNEL, PREP_ENABLED, GAME_DAY, GAME_TIME, PREP_HOURS } from './config.js';

const CATCHUP_SYSTEM = `You help a Shadowrun tabletop RPG player catch up on what they missed. You get the last few minutes of a
messy speech-to-text transcript of the live session. In 3–8 short bullet points (Discord markdown), say what happened in the
game: where the team is, what they're doing, decisions made, anything urgent. Mention out-of-game chatter only if it matters
(a break, a rules call). Plain and quick to read. Never invent anything; if it's unclear, say so.`;

// "🌐 Read it on the website: <link> · 🔑 Password: ||secret||" (the password is a Discord spoiler).
function websiteLine(url = siteUrl(), withPassword = SITE_SHARE_PASSWORD) {
  if (!url) return '';
  const pw = withPassword && SITE_PASSWORD ? ` · 🔑 Password: ||${SITE_PASSWORD.replace(/\|/g, '')}||` : '';
  return `\n\n🌐 **Read it color-coded on the player website:** ${url}${pw}`;
}

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
        rec.lastLineAt = Date.now();
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
// Loose ends changed by hand: update the player website a little later (changes often come in bursts).
let siteTimer = null;
function refreshSiteSoon() {
  if (!siteConfigured()) return;
  clearTimeout(siteTimer);
  siteTimer = setTimeout(() => publishSite({ dirs: [] }).catch((e) => console.error('[website]', e.message)), 15_000);
}

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
    sendAlert('recap', `📝 **The recap for "${rec.meta.title}" failed:** ${err.message}\nThe transcript is saved. Once that's fixed, open Note Tiger → Sessions → **Write recap**.`);
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
  let siteLink = '', siteUrlOk = null;
  if (siteConfigured()) {
    try {
      const r = await publishSite({ dirs: [dir] });
      siteUrlOk = r.url;
      siteLink = `\n🌐 Color-coded on the player website: ${r.url}`;
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
    const tracker = campaignSummary(dir);
    const text = `${tag}# ${meta.title} — ${meta.date}\n${recap}${meter ? `\n\n${meter}` : ''}${tracker ? `\n\n${tracker}` : ''}${pointer}${siteUrlOk ? websiteLine(siteUrlOk) : ''}`;
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

  // GM digest in the GM channel: NPC voice cards that changed, open loose ends, the run in progress.
  if (!updated && recap) {
    const gmChan = findChannel(guild, GM_CHANNEL);
    if (gmChan) {
      try {
        const cards = readJSON(path.join(dir, 'voices.json'), {});
        const c = buildCampaign(guild.id);
        const run = c.jobs.find((j) => j.status === 'in progress' || j.status === 'offered');
        const bits = [`🎲 **GM notes: ${meta.title}**`];
        const names = Object.keys(cards);
        if (names.length) bits.push(`🎭 **NPC voice cards updated:**\n${names.map((n) => `• **${n}**${cards[n].personality ? `: ${cards[n].personality}` : ''}`).join('\n')}\n*Full card: \`/campaign npc name:<npc>\`*`);
        if (run) bits.push(`🗂️ **Run in progress:** ${run.name}${run.johnson ? ` (for ${run.johnson})` : ''}${run.complications ? `\n⚠️ ${run.complications}` : ''}`);
        if (c.open.length) bits.push(`🧵 **${c.open.length} open loose end${c.open.length === 1 ? '' : 's'}**, newest: ${c.open.slice(-3).map((t) => t.text).join(' · ')}`);
        bits.push('*Prep note for next time: `/campaign prep`*');
        await sendLong(gmChan, bits.join('\n\n'));
      } catch (err) {
        console.error('[gm digest]', err.message);
      }
    }
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
// Used in the GM channel: GM-only answers can be visible there (it's private to the GM).
const inGmChannel = (interaction) => Boolean(GM_CHANNEL && interaction.channel?.name?.toLowerCase() === GM_CHANNEL);
const gmOnly = (interaction) => (inGmChannel(interaction) ? {} : { flags: MessageFlags.Ephemeral });

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
    .addSubcommand((s) => s.setName('status').setDescription('Show recording status'))
    .addSubcommand((s) => s.setName('catchup').setDescription('What happened in the last few minutes? (only you see it)')
      .addIntegerOption((o) => o.setName('minutes').setDescription('How far back (default 15)').setMinValue(5).setMaxValue(90))
      .addBooleanOption((o) => o.setName('public').setDescription('Post it for everyone instead of just you'))),
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
  new SlashCommandBuilder().setName('game').setDescription('Look things up in your rulebooks')
    .addSubcommand((s) => s.setName('ask').setDescription('Ask the rulebooks: get the book, page and a quick description')
      .addStringOption((o) => o.setName('question').setDescription('e.g. "How does Edge work?" or "Ares Predator"').setRequired(true)))
    .addSubcommand((s) => s.setName('books').setDescription('List the rulebooks I can search')),
  new SlashCommandBuilder().setName('campaign').setDescription('Contacts and loose ends from your sessions')
    .addSubcommand((s) => s.setName('contacts').setDescription('Everyone the team has met (or details on one person)')
      .addStringOption((o) => o.setName('name').setDescription('Show one contact, e.g. "Mr. Johnson"')))
    .addSubcommand((s) => s.setName('places').setDescription('Places the team has been (or details on one)')
      .addStringOption((o) => o.setName('name').setDescription('Show one place, e.g. "The Big Rhino"')))
    .addSubcommand((s) => s.setName('story').setDescription('The story of the campaign so far'))
    .addSubcommand((s) => s.setName('runs').setDescription('Every job the team has taken: who hired you, pay, how it went'))
    .addSubcommand((s) => s.setName('book').setDescription('The whole campaign as a PDF book: story, runners, runs, every recap'))
    .addSubcommand((s) => s.setName('runner').setDescription('A runner\'s profile: what they\'ve done, big moments, gear')
      .addStringOption((o) => o.setName('name').setDescription('Runner name (leave empty for everyone)')))
    .addSubcommand((s) => s.setName('prep').setDescription('GM prep note for the next session (only you see it)'))
    .addSubcommand((s) => s.setName('npc').setDescription('GM only: how you\'ve played an NPC (personality, voice, lines)')
      .addStringOption((o) => o.setName('name').setDescription('NPC name, e.g. Grim').setRequired(true)))
    .addSubcommand((s) => s.setName('quote').setDescription('A random Best Line from past sessions')
      .addStringOption((o) => o.setName('search').setDescription('Only quotes containing this (word or name)')))
    .addSubcommand((s) => s.setName('threads').setDescription('Open loose ends: leads, debts, promises, threats'))
    .addSubcommand((s) => s.setName('close').setDescription('Mark a loose end as dealt with')
      .addIntegerOption((o) => o.setName('number').setDescription('Its number in /campaign threads').setRequired(true).setMinValue(1))
      .addStringOption((o) => o.setName('how').setDescription('How it was settled (optional)')))
    .addSubcommand((s) => s.setName('add').setDescription('Add a loose end by hand')
      .addStringOption((o) => o.setName('text').setDescription('e.g. "We still owe Sticks 5,000¥"').setRequired(true))),
  new SlashCommandBuilder().setName('ask').setDescription('Ask about past sessions')
    .addStringOption((o) => o.setName('question').setDescription('e.g. "What did Mr. Johnson offer us for the Ares job?"').setRequired(true)),
  new SlashCommandBuilder().setName('sheet').setDescription('D&D character sheets')
    .addSubcommand((c) => c.setName('import').setDescription('Read your character sheet (PDF) into Note Tiger')
      .addAttachmentOption((o) => o.setName('file').setDescription('Your sheet as a PDF (D&D Beyond export, official sheet, …)').setRequired(true))
      .addUserOption((o) => o.setName('player').setDescription('GM only: import it for another player')))
    .addSubcommand((c) => c.setName('show').setDescription('Show a character')
      .addUserOption((o) => o.setName('player').setDescription('Whose (default: yours)'))
      .addStringOption((o) => o.setName('name').setDescription('Or the character\'s name').setAutocomplete(true)))
    .addSubcommand((c) => c.setName('pdf').setDescription('Get a character as a filled-in sheet')
      .addStringOption((o) => o.setName('sheet').setDescription('Which blank sheet to fill').setAutocomplete(true))
      .addUserOption((o) => o.setName('player').setDescription('Whose (default: yours)'))
      .addStringOption((o) => o.setName('name').setDescription('Or the character\'s name').setAutocomplete(true)))
    .addSubcommand((c) => c.setName('ask').setDescription('Ask about your character ("what\'s my stealth bonus?")')
      .addStringOption((o) => o.setName('question').setDescription('Your question').setRequired(true))
      .addUserOption((o) => o.setName('player').setDescription('Whose character (default: yours)')))
    .addSubcommand((c) => c.setName('build').setDescription('Make a new character step by step (only you see it)')
      .addIntegerOption((o) => o.setName('level').setDescription('Starting level (default 1)').setMinValue(1).setMaxValue(20))
      .addStringOption((o) => o.setName('rules').setDescription('Which Player\'s Handbook').addChoices({ name: '2014', value: '2014' }, { name: '2024', value: '2024' })))
    .addSubcommand((c) => c.setName('list').setDescription('Everyone\'s characters on this server'))
    .addSubcommand((c) => c.setName('remove').setDescription('Remove your character from Note Tiger')),
  new SlashCommandBuilder().setName('help').setDescription('List all my commands and what they do')
    .addBooleanOption((o) => o.setName('public').setDescription('Post it for everyone instead of just you')),
].map((c) => c.toJSON());

// /help text, built from the command list itself so it never goes out of date.
const HELP_GROUPS = [
  ['🎙️ Recording', ['session', 'note', 'character', 'optout']],
  ['📼 Recaps', ['recap', 'repost', 'ask']],
  ['📚 Rulebooks', ['game']],
  ['🧙 Character sheets', ['sheet']],
  ['🕵️ Campaign', ['campaign']],
  ['❓ Help', ['help']],
];
function helpText() {
  const byName = new Map(commands.map((c) => [c.name, c]));
  const line = (name, d) => `\`/${name}\` – ${d}`;
  const out = ['🐯 **Note Tiger commands**'];
  const used = new Set();
  const groups = [...HELP_GROUPS, ['More', commands.map((c) => c.name)]];
  for (const [title, names] of groups) {
    const rows = [];
    for (const n of names) {
      const c = byName.get(n);
      if (!c || used.has(n)) continue;
      used.add(n);
      const subs = (c.options || []).filter((o) => o.type === 1); // 1 = subcommand
      if (subs.length) for (const sc of subs) rows.push(line(`${c.name} ${sc.name}`, sc.description));
      else rows.push(line(c.name, c.description));
    }
    if (rows.length) out.push(`\n**${title}**`, ...rows);
  }
  out.push('\n*Rulebooks and settings are in the Note Tiger app on the host PC.*');
  return out.join('\n');
}

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

// A rulebook page as a picture, with buttons to turn to the page before or after
// (an answer can land on a page where the rule starts or ends mid-way).
async function pagePicture(book, pdfPage) {
  const info = pageInfo(book, pdfPage) || { title: 'Rulebook', pages: pdfPage, pageLabel: `PDF page ${pdfPage}` };
  const png = await renderPage(book, pdfPage);
  const name = `${info.title} ${info.pageLabel}`.replace(/[^\w .-]+/g, '').replace(/\s+/g, '_').slice(0, 80);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pg|${book}|${pdfPage - 1}`).setLabel('◀ Previous page').setStyle(ButtonStyle.Secondary).setDisabled(pdfPage <= 1),
    new ButtonBuilder().setCustomId(`pg|${book}|${pdfPage}|now`).setLabel(`${info.title.slice(0, 50)} · ${info.pageLabel}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`pg|${book}|${pdfPage + 1}`).setLabel('Next page ▶').setStyle(ButtonStyle.Secondary).setDisabled(pdfPage >= info.pages),
  );
  return { files: [new AttachmentBuilder(png, { name: `${name}.png` })], components: [row] };
}

client.on('interactionCreate', async (interaction) => {
  // Page-turn buttons under a rulebook picture: swap the picture for the page before or after.
  // The character builder's buttons, menus and forms.
  if ((interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) && interaction.customId.startsWith('sb|')) {
    try {
      return await handleBuilder(interaction, {
        onSave: async (ch) => {
          const gid = interaction.guildId;
          const existing = findCharacter(gid, { userId: interaction.user.id });
          const saved = saveCharacter(gid, { ...ch, id: existing?.id, playerId: interaction.user.id }, { by: interaction.user.username, change: 'made with /sheet build' });
          const st = getSettings(gid);
          st.characters[interaction.user.id] = saved.name;
          saveSettings(gid, st);
          console.log(`[sheets] ${interaction.user.username} built ${saved.name} (${ch.classes[0]?.name} ${ch.classes[0]?.level})`);
          return saved;
        },
      });
    } catch (err) {
      console.error('[builder]', err);
      const msg = { content: `Something went wrong in the builder: ${err.message}`, flags: MessageFlags.Ephemeral };
      return (interaction.replied || interaction.deferred ? interaction.followUp(msg) : interaction.reply(msg)).catch(() => {});
    }
  }
  if (interaction.isButton() && interaction.customId.startsWith('pg|')) {
    const [, book, page] = interaction.customId.split('|');
    try {
      await interaction.deferUpdate();
      const { files, components } = await pagePicture(book, Number(page));
      await interaction.editReply({ files, attachments: [], components });
    } catch (err) {
      console.error('[library] page turn:', err.message);
      await interaction.followUp({
        content: `Couldn't turn the page: ${err.message} (If the rulebooks changed since, ask again with \`/game ask\`.)`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
    return;
  }
  // Suggestions while typing: blank sheets and character names for /sheet.
  if (interaction.isAutocomplete() && interaction.commandName === 'sheet') {
    const focused = interaction.options.getFocused(true);
    const q = String(focused.value || '').toLowerCase();
    const names = focused.name === 'sheet' ? listTemplates().filter((t) => t.mapped).map((t) => t.name)
      : listCharacters(interaction.guildId).map((c) => c.name);
    return interaction.respond(names.filter((n) => n.toLowerCase().includes(q)).slice(0, 25).map((n) => ({ name: n.slice(0, 100), value: n.slice(0, 100) }))).catch(() => {});
  }
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
      if (sub === 'catchup') {
        const rec = live.get(gid);
        if (!rec) return interaction.reply({ content: 'Nothing is being recorded right now.', flags: MessageFlags.Ephemeral });
        const minutes = interaction.options.getInteger('minutes') ?? 15;
        const pub = interaction.options.getBoolean('public') ?? false;
        await interaction.deferReply(pub ? {} : { flags: MessageFlags.Ephemeral });
        const since = Date.now() - minutes * 60_000;
        const lines = sessionLines(rec.dir).filter((l) => l.t >= since);
        if (lines.length < 3) return interaction.editReply(`Not much was said in the last ${minutes} minutes.`);
        let text = lines.map((l) => `${l.speaker}: ${l.text}`).join('\n');
        const budget = USE_CLAUDE ? 80_000 : 12_000;
        if (text.length > budget) text = text.slice(-budget);   // keep the most recent part
        const names = knownNames(gid);
        const summary = await askAI(CATCHUP_SYSTEM,
          `${names ? `Correct spellings of names: ${names}\n\n` : ''}LAST ${minutes} MINUTES OF THE SESSION "${rec.meta.title}":\n${text}`, 700);
        const parts = splitForDiscord(`⏪ **The last ${minutes} minutes**\n${summary}`);
        await interaction.editReply(parts[0]);
        for (const p of parts.slice(1)) await interaction.followUp(pub ? p : { content: p, flags: MessageFlags.Ephemeral });
        return;
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

    if (commandName === 'sheet') {
      const sub = interaction.options.getSubcommand();
      const target = interaction.options.getUser('player');
      const nameOpt = interaction.options.getString('name');
      const isMe = !target || target.id === interaction.user.id;
      const who = () => findCharacter(gid, nameOpt ? { name: nameOpt } : { userId: (target || interaction.user).id });
      const none = () => interaction.editReply(nameOpt ? `I don't have a character called **${nameOpt}**. Try \`/sheet list\`.`
        : isMe ? 'You don\'t have a character yet. Attach your sheet with `/sheet import`.' : `${target.displayName || target.username} doesn't have a character yet.`);

      if (sub === 'import') {
        const anyGmRole = guild.roles.cache.some((r) => GM_ROLES.includes(r.name.toLowerCase()));
        if (!isMe && anyGmRole && !isGM(interaction.member)) return interaction.reply({ content: 'Only the GM can import a sheet for someone else.', flags: MessageFlags.Ephemeral });
        const file = interaction.options.getAttachment('file');
        if (!/\.pdf$/i.test(file.name || '') && file.contentType !== 'application/pdf') return interaction.reply({ content: 'Attach the sheet as a **PDF** (on D&D Beyond: your character → Export to PDF).', flags: MessageFlags.Ephemeral });
        if (file.size > 25 * 1024 * 1024) return interaction.reply({ content: 'That PDF is over 25 MB.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await interaction.editReply('📄 Reading your sheet… (with the local AI this can take a minute or two)');
        const res = await fetch(file.url);
        if (!res.ok) throw new Error(`couldn't download the attachment (${res.status})`);
        const buf = Buffer.from(await res.arrayBuffer());
        const { character, how } = await importSheet(buf, askAI, { log: (m) => console.log(m) });
        const player = target || interaction.user;
        const member = await guild.members.fetch(player.id).catch(() => null);
        const existing = findCharacter(gid, { userId: player.id });
        const saved = saveCharacter(gid, {
          ...character, id: existing?.id, playerId: player.id, player: character.player || member?.displayName || player.username,
        }, { by: interaction.user.username, change: `imported from ${file.name} (${how})` });
        // Transcripts show the character's name next to the player's, like /character.
        const st = getSettings(gid);
        if (!st.characters[player.id]) { st.characters[player.id] = saved.name; saveSettings(gid, st); }
        console.log(`[sheets] ${interaction.user.username} imported ${saved.name} for ${player.username} via ${how}`);
        return interaction.editReply(`✅ Imported **${saved.name}** from ${how}${existing ? ' (replaced the old one)' : ''}.\n` +
          `Check it with \`/sheet show\`. Something wrong? Fix it in the Note Tiger app → Campaign → Characters.\n\n${sheetSummary(saved, { short: true })}`);
      }

      if (sub === 'build') {
        const existing = findCharacter(gid, { userId: interaction.user.id });
        const member = interaction.member;
        return startBuilder(interaction, {
          level: interaction.options.getInteger('level') || 1, edition: interaction.options.getString('rules'),
          playerName: member?.displayName || interaction.user.username, replaces: existing?.name || null,
        });
      }

      if (sub === 'list') {
        const all = listCharacters(gid);
        if (!all.length) return interaction.reply({ content: 'No characters yet. Players can add theirs with `/sheet import`.', flags: MessageFlags.Ephemeral });
        return interaction.reply(splitForDiscord(`🧙 **Characters (${all.length})**\n${all.map((c) => `• ${sheetSummary(c, { short: true }).split('\n').slice(0, 2).join(': ')}`).join('\n')}`)[0]);
      }

      if (sub === 'remove') {
        const c = findCharacter(gid, { userId: interaction.user.id });
        if (!c) return interaction.reply({ content: 'You don\'t have a character here.', flags: MessageFlags.Ephemeral });
        deleteCharacter(gid, c.id, { by: interaction.user.username });
        return interaction.reply({ content: `Removed **${c.name}**. (Import a sheet again any time.)`, flags: MessageFlags.Ephemeral });
      }

      await interaction.deferReply();
      const c = who();
      if (!c) return none();

      if (sub === 'show') return interaction.editReply(splitForDiscord(sheetSummary(c))[0]);

      if (sub === 'pdf') {
        const templates = listTemplates().filter((t) => t.mapped);
        if (!templates.length) return interaction.editReply('No blank sheets are set up yet. Add one in the Note Tiger app → Library → Character sheets.');
        const want = interaction.options.getString('sheet');
        const t = want ? templates.find((x) => x.name.toLowerCase() === want.toLowerCase()) || templates.find((x) => x.name.toLowerCase().includes(want.toLowerCase())) : templates[0];
        if (!t) return interaction.editReply(`No sheet called **${want}**. I have: ${templates.map((x) => x.name).join(', ')}.`);
        const pdf = await fillSheet(t.name, c);
        const fileName = `${c.name.replace(/[^\w -]+/g, '').trim() || 'character'} - ${t.name}.pdf`;
        return interaction.editReply({ content: `📄 **${c.name}** on the **${t.name}** sheet${templates.length > 1 ? ` (others: ${templates.filter((x) => x !== t).map((x) => x.name).join(', ')})` : ''}`, files: [new AttachmentBuilder(pdf, { name: fileName })] });
      }

      if (sub === 'ask') {
        const question = interaction.options.getString('question');
        const answer = await askAI(SHEET_ASK_SYSTEM, `CHARACTER SHEET:\n${sheetForAI(c)}\n\nQUESTION: ${question}`, 500);
        return interaction.editReply(splitForDiscord(`🧙 **${c.name}**: ${question}\n${answer}`)[0]);
      }
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
      const tracker = campaignSummary(s.dir);
      const parts = splitForDiscord(`# ${s.title} — ${s.date}\n${recap}${meter ? `\n\n${meter}` : ''}${tracker ? `\n\n${tracker}` : ''}${siteConfigured() ? websiteLine() : ''}`);
      await interaction.editReply(parts[0]);
      for (const p of parts.slice(1)) await interaction.followUp(p);
      return;
    }

    if (commandName === 'game') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'books') {
        const books = booksFor(gid);
        const setup = serverSetup(gid);
        if (!books.length) {
          return interaction.reply({ content: setup.books
            ? '📚 No rulebooks are turned on for this server. Pick them in Note Tiger → **Library** → **Books per server**.'
            : '📚 No rulebooks yet. Add PDFs in Note Tiger → **Library**.', flags: MessageFlags.Ephemeral });
        }
        const list = books.map((b) => `• **${b.title}**${b.indexed ? ` · ${b.pages} pages` : ' · *still reading…*'}${b.ocrPending ? ' · 📷 scanned, still being read' : b.noText ? ' · ⚠️ no readable text' : ''}`).join('\n');
        const head = `📚 **Rulebooks I can search here${setup.game ? ` (${setup.game})` : ''}: ${books.length}**`;
        return interaction.reply(splitForDiscord(`${head}\n${list}`)[0]);
      }
      const question = interaction.options.getString('question');
      await interaction.deferReply();
      const { answer, cited } = await askBooks(question, { gid });
      // Asked during a session: it goes into that session's recap under Rules Calls.
      const rec = live.get(gid);
      if (rec && cited !== undefined) {
        try { logRulesCall(rec.dir, { by: speakerLabel(gid, interaction.member), question, answer, cited: cited ? { title: cited.title, page: cited.pageLabel } : null }); }
        catch (err) { console.error('[rules calls]', err.message); }
      }
      // A picture of the main page it cites, so everyone can read the actual rules and tables.
      let files = [], components = [];
      if (cited && LIB_PAGE_IMAGES) {
        try {
          ({ files, components } = await pagePicture(cited.book, cited.page));
        } catch (err) {
          console.error('[library] page picture:', err.message);
        }
      }
      const parts = splitForDiscord(`> 📖 ${question}\n${answer}`);
      const last = parts.length - 1;
      await interaction.editReply({ content: parts[0], files: last === 0 ? files : [], components: last === 0 ? components : [] });
      for (let i = 1; i < parts.length; i++) {
        await interaction.followUp({ content: parts[i], files: i === last ? files : [], components: i === last ? components : [] });
      }
      return;
    }

    if (commandName === 'campaign') {
      const sub = interaction.options.getSubcommand();
      const reply = async (text, opts = {}) => {
        const parts = splitForDiscord(text);
        await interaction.reply({ content: parts[0], ...opts });
        for (const p of parts.slice(1)) await interaction.followUp({ content: p, ...opts });
      };
      const c = buildCampaign(gid);
      if (sub === 'contacts') {
        const name = interaction.options.getString('name');
        if (name) {
          const k = npcKey(name);
          const hit = k && (c.contacts.find((x) => x.key === k) || c.contacts.find((x) => x.key.includes(k) || k.includes(x.key)));
          if (!hit) return interaction.reply({ content: `I don't have anyone called **${name}**. Try \`/campaign contacts\` for the full list.`, flags: MessageFlags.Ephemeral });
          const hist = hit.history.map((h) => `• *${h.title} (${h.date}):* ${h.text}`).join('\n');
          return reply(`🕵️ **${hit.name}**${hit.who ? ` — ${hit.who}` : ''}\n` +
            `${hit.attitude ? `Attitude: **${hit.attitude}**\n` : ''}First met: ${hit.first?.title ?? '?'} (${hit.first?.date ?? '?'})` +
            `${hist ? `\n\n${hist}` : ''}`);
        }
        if (!c.contacts.length) return interaction.reply({ content: 'No contacts yet. They\'re picked up from each session\'s recap.', flags: MessageFlags.Ephemeral });
        const list = c.contacts.map((x) => `• **${x.name}**${x.who ? ` — ${x.who}` : ''}${x.attitude ? ` · *${x.attitude}*` : ''}`).join('\n');
        return reply(`🕵️ **Contacts & NPCs (${c.contacts.length})**\n${list}\n*Details: \`/campaign contacts name:<name>\`*`);
      }
      if (sub === 'places') {
        const name = interaction.options.getString('name');
        if (name) {
          const k = npcKey(name);
          const hit = k && (c.places.find((x) => x.key === k) || c.places.find((x) => x.key.includes(k) || k.includes(x.key)));
          if (!hit) return interaction.reply({ content: `I don't know a place called **${name}**. Try \`/campaign places\` for the full list.`, flags: MessageFlags.Ephemeral });
          const hist = hit.history.map((h) => `• *${h.title} (${h.date}):* ${h.text}`).join('\n');
          return reply(`📍 **${hit.name}**${hit.what ? ` — ${hit.what}` : ''}\nFirst visited: ${hit.first?.title ?? '?'} (${hit.first?.date ?? '?'})${hist ? `\n\n${hist}` : ''}`);
        }
        if (!c.places.length) return interaction.reply({ content: 'No places yet. They\'re picked up from each session\'s recap.', flags: MessageFlags.Ephemeral });
        const list = c.places.map((x) => `• **${x.name}**${x.what ? ` — ${x.what}` : ''}`).join('\n');
        return reply(`📍 **Places (${c.places.length})**\n${list}\n*Details: \`/campaign places name:<place>\`*`);
      }
      if (sub === 'runner') {
        const name = interaction.options.getString('name');
        if (!c.runners.length) return interaction.reply({ content: 'No runner profiles yet. They\'re built from each session\'s recap.', flags: MessageFlags.Ephemeral });
        if (!name) {
          const list = c.runners.map((r) => `• **${r.name}**${r.player ? ` (${r.player})` : ''} · ${r.sessions.length} session${r.sessions.length === 1 ? '' : 's'}${r.status ? ` · *${r.status}*` : ''}`).join('\n');
          return reply(`🏃 **Runners (${c.runners.length})**\n${list}\n*Profile: \`/campaign runner name:<runner>\`*`);
        }
        const k = npcKey(name);
        const r = k && (c.runners.find((x) => x.key === k) || c.runners.find((x) => x.key.includes(k) || k.includes(x.key)));
        if (!r) return interaction.reply({ content: `No runner called **${name}**. Try \`/campaign runner\` for the list.`, flags: MessageFlags.Ephemeral });
        const moments = r.sessions.filter((x) => x.moment).slice(-5).map((x) => `• *${x.title}:* ${x.moment}`).join('\n');
        const did = r.sessions.slice(-6).map((x) => `• *${x.title} (${x.date}):* ${x.did}${x.talkPct != null ? ` · 🔦 ${x.talkPct}%` : ''}`).join('\n');
        return reply(`🏃 **${r.name}**${r.player ? ` · played by ${r.player}` : ''}\n` +
          `${r.sessions.length} session${r.sessions.length === 1 ? '' : 's'} since *${r.first?.title}*${r.status ? `\nRight now: **${r.status}**` : ''}` +
          `${r.gear.length ? `\n🧰 ${r.gear.slice(-12).join(', ')}` : ''}${moments ? `\n\n⭐ **Big moments**\n${moments}` : ''}\n\n📼 **Recent sessions**\n${did}`);
      }
      if (sub === 'npc') {
        const anyGmRole = guild.roles.cache.some((r) => GM_ROLES.includes(r.name.toLowerCase()));
        if (anyGmRole && !isGM(interaction.member) && !inGmChannel(interaction)) return interaction.reply({ content: `NPC voice cards are for the game master (try it in #${GM_CHANNEL}).`, flags: MessageFlags.Ephemeral });
        const k = npcKey(interaction.options.getString('name'));
        const n = k && (c.contacts.find((x) => x.key === k) || c.contacts.find((x) => x.key.includes(k) || k.includes(x.key)));
        if (!n) return interaction.reply({ content: 'I don\'t know that NPC. `/campaign contacts` lists everyone.', flags: MessageFlags.Ephemeral });
        const card = n.card;
        const text = `🎭 **${n.name}**${n.who ? ` — ${n.who}` : ''}${n.attitude ? `\nAttitude to the team: **${n.attitude}**` : ''}\n` +
          (card ? `${card.personality ? `\n**Personality:** ${card.personality}` : ''}${card.speech ? `\n**How they talk:** ${card.speech}` : ''}` +
            `${card.wants ? `\n**Wants:** ${card.wants}` : ''}${card.knows ? `\n**Knows about the team:** ${card.knows}` : ''}` +
            `${card.lines?.length ? `\n**Lines:**\n${card.lines.map((l) => `> ${l}`).join('\n')}` : ''}`
            : '\n*No voice card yet: it\'s built from lines the GM speaks as this NPC (they need to be tagged as "GM as …" in the transcript).*') +
          `${n.history.length ? `\n\n**History:**\n${n.history.slice(-5).map((h) => `• *${h.title}:* ${h.text}`).join('\n')}` : ''}`;
        const parts = splitForDiscord(text);
        await interaction.reply({ content: parts[0], ...gmOnly(interaction) });
        for (const p of parts.slice(1)) await interaction.followUp({ content: p, ...gmOnly(interaction) });
        return;
      }
      if (sub === 'prep') {
        const member = interaction.member;
        const anyGmRole = guild.roles.cache.some((r) => GM_ROLES.includes(r.name.toLowerCase()));
        if (anyGmRole && !isGM(member) && !inGmChannel(interaction)) return interaction.reply({ content: 'The prep note is for the game master (it may suggest plot hooks). Ask in #' + GM_CHANNEL + '.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply(gmOnly(interaction));
        const note = await gmPrep(gid, askAI);
        if (!note) return interaction.editReply('Nothing to prep from yet: record a session first.');
        const parts = splitForDiscord(note);
        await interaction.editReply(parts[0]);
        for (const p of parts.slice(1)) await interaction.followUp({ content: p, ...gmOnly(interaction) });
        return;
      }
      if (sub === 'book') {
        await interaction.deferReply();
        const pdf = await campaignBook(gid);
        const name = `${CAMPAIGN_NAME.replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '_') || 'Campaign'}_book.pdf`;
        return interaction.editReply({ content: `📕 **${CAMPAIGN_NAME}: campaign book** (${Math.max(1, Math.round(pdf.length / 1024))} KB)`, files: [new AttachmentBuilder(pdf, { name })] });
      }
      if (sub === 'runs') {
        if (!c.jobs.length) return interaction.reply({ content: 'No runs yet. Jobs are picked up from each session\'s recap.', flags: MessageFlags.Ephemeral });
        const icon = { done: '✅', failed: '❌', 'in progress': '🏃', offered: '📨', 'turned down': '🚫' };
        const list = c.jobs.map((j) => `${icon[j.status] || '•'} **${j.name}**${j.status ? ` · *${j.status}*` : ''}\n` +
          `${j.johnson ? `  Hired by ${j.johnson}. ` : '  '}${j.task || ''}` +
          `${j.payOffered || j.payReceived ? `\n  💰 ${j.payOffered ? `offered ${j.payOffered}` : ''}${j.payOffered && j.payReceived ? ', ' : ''}${j.payReceived ? `got ${j.payReceived}` : ''}` : ''}` +
          `${j.complications ? `\n  ⚠️ ${j.complications}` : ''}${j.outcome ? `\n  🏁 ${j.outcome}` : ''}`).join('\n\n');
        return reply(`🗂️ **Run history (${c.jobs.length})**\n\n${list}`);
      }
      if (sub === 'story') {
        const st = latestStory(gid);
        if (!st) return interaction.reply({ content: 'No story yet. It\'s written along with each session\'s recap.', flags: MessageFlags.Ephemeral });
        return reply(`📖 **The story so far** *(through ${st.title}, ${st.date})*\n\n${st.text}`);
      }
      if (sub === 'quote') {
        const q = (interaction.options.getString('search') || '').toLowerCase();
        const all = allQuotes(gid).filter((x) => !q || `${x.quote} ${x.by}`.toLowerCase().includes(q));
        if (!all.length) return interaction.reply({ content: q ? 'No quotes match that.' : 'No quotes yet. They come from the Best Lines in each recap.', flags: MessageFlags.Ephemeral });
        const x = all[Math.floor(Math.random() * all.length)];
        return interaction.reply(`💬 *“${x.quote}”*\n— **${x.by}**${x.tableTalk ? ' (table talk)' : ''} · ${x.title}, ${x.date}`);
      }
      if (sub === 'threads') {
        if (!c.open.length && !c.closed.length) return interaction.reply({ content: 'No loose ends yet. They\'re picked up from each session\'s recap, or add one with `/campaign add`.', flags: MessageFlags.Ephemeral });
        const open = c.open.map((t) => `**${t.n}.** ${t.text} *(${t.opened?.title ?? 'added by hand'})*`).join('\n') || '*Nothing open. Clean slate, chummer.*';
        const done = c.closed.slice(0, 5).map((t) => `~~${t.text}~~${t.how ? ` — ${t.how}` : ''}`).join('\n');
        return reply(`🧵 **Loose ends (${c.open.length} open)**\n${open}${done ? `\n\n✅ **Recently tied up**\n${done}` : ''}\n*Done with one? \`/campaign close number:<n>\`*`);
      }
      if (sub === 'close') {
        const n = interaction.options.getInteger('number');
        const t = c.open.find((x) => x.n === n);
        if (!t) return interaction.reply({ content: `There's no open loose end number ${n}. Check \`/campaign threads\`.`, flags: MessageFlags.Ephemeral });
        const how = interaction.options.getString('how') || '';
        addEdit(gid, { type: 'thread-close', id: t.id, how, by: speakerLabel(gid, interaction.member) });
        refreshSiteSoon();
        return interaction.reply(`✅ Tied up: ~~${t.text}~~${how ? ` — ${how}` : ''}`);
      }
      if (sub === 'add') {
        const text = interaction.options.getString('text').trim().slice(0, 250);
        addEdit(gid, { type: 'thread-add', text, by: speakerLabel(gid, interaction.member) });
        refreshSiteSoon();
        return interaction.reply(`🧵 Added loose end: ${text}`);
      }
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

    if (commandName === 'help') {
      const pub = interaction.options.getBoolean('public');
      const parts = splitForDiscord(helpText());
      const opts = pub ? {} : { flags: MessageFlags.Ephemeral };
      await interaction.reply({ content: parts[0], ...opts });
      for (const p of parts.slice(1)) await interaction.followUp({ content: p, ...opts });
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

// ---------- alert if a recording goes quiet ----------
// People are in the voice channel but nothing has been transcribed for 15 minutes: something's wrong
// (the bot was disconnected, everyone's muted to it, the speech model stopped).
setInterval(() => {
  for (const [gid, rec] of live) {
    const since = rec.lastLineAt || Date.parse(rec.meta.startedAt) || Date.now();
    if (rec.silentAlerted || Date.now() - since < 15 * 60_000) continue;
    const guild = client.guilds.cache.get(gid);
    const vc = guild?.members.me?.voice?.channel;
    const people = vc ? vc.members.filter((m) => !m.user.bot).size : 0;
    if (!vc || people >= 2) rec.silentAlerted = true;   // once per session (breaks happen)
    if (!vc) {
      sendAlert(`silent:${gid}`, `🔇 **Note Tiger isn't in the voice channel any more** in ${guild?.name || 'your server'}, but the session "${rec.meta.title}" is still recording. Use \`/session stop\` and \`/session start\` to get it back.`);
    } else if (people >= 2) {
      sendAlert(`silent:${gid}`, `🔇 **Nothing has been transcribed for ${Math.round((Date.now() - since) / 60000)} minutes** in "${rec.meta.title}", though ${people} people are in ${vc.name}.` +
        `\nIf you're on a break, ignore this. Otherwise check that the bot isn't muted for anyone, or restart it with \`/session stop\` and \`/session start\`.`);
    }
  }
}, 60_000);

// ---------- GM prep note before game night ----------
// Every few minutes: if game night is within PREP_HOURS and the note wasn't sent for it yet, DM the GM(s).
function nextGameNight(now = new Date()) {
  if (GAME_DAY === null || !Number.isInteger(GAME_DAY) || GAME_DAY < 0 || GAME_DAY > 6) return null;
  const [h, m] = GAME_TIME.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  d.setDate(d.getDate() + ((GAME_DAY - d.getDay() + 7) % 7));
  if (d <= now) d.setDate(d.getDate() + 7);
  return d;
}
async function prepCheck() {
  if (!PREP_ENABLED || !client.isReady()) return;
  const game = nextGameNight();
  if (!game || game - Date.now() > PREP_HOURS * 3600_000) return;
  const stamp = game.toISOString();
  for (const guild of client.guilds.cache.values()) {
    const file = path.join(sessionsDir(guild.id), '..', 'prep-state.json');
    const st = readJSON(file, {});
    if (st.sentFor === stamp || live.has(guild.id) || !listSessions(guild.id).length) continue;
    writeJSON(file, { ...st, sentFor: stamp, sentAt: new Date().toISOString() });   // mark first: never send twice
    try {
      const when = game.toLocaleString([], { weekday: 'long', hour: 'numeric', minute: '2-digit' });
      // The GM channel if there is one; otherwise a DM to everyone with a GM role.
      const gmChan = findChannel(guild, GM_CHANNEL);
      if (gmChan) {
        const note = await gmPrep(guild.id, askAI);
        if (!note) continue;
        for (const p of splitForDiscord(`${note}\n\n*Game night: ${when}. Get this any time with \`/campaign prep\`.*`)) await gmChan.send(p);
        console.log(`[prep] posted in #${gmChan.name}`);
        continue;
      }
      const members = await guild.members.fetch();
      const gms = [...members.values()].filter((m) => !m.user.bot && isGM(m));
      if (!gms.length) { console.log(`[prep] no #${GM_CHANNEL} channel and no one with a GM role in ${guild.name}, so no prep note was sent`); continue; }
      const note = await gmPrep(guild.id, askAI);
      if (!note) continue;
      for (const gm of gms) {
        try {
          const parts = splitForDiscord(`${note}\n\n*Game night: ${when} · from ${guild.name}. Get this any time with \`/campaign prep\`.*`);
          for (const p of parts) await gm.send(p);
          console.log(`[prep] sent to ${gm.displayName}`);
        } catch (err) {
          console.error(`[prep] couldn't message ${gm.displayName} (their DMs may be closed):`, err.message);
        }
      }
    } catch (err) {
      console.error('[prep]', err.message);
    }
  }
}
setInterval(() => prepCheck().catch((e) => console.error('[prep]', e.message)), 5 * 60_000);
client.once('clientReady', () => setTimeout(() => prepCheck().catch(() => {}), 60_000));

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
    progress: getProgress(),
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
