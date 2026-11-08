// Note Tiger manager: runs the control panel and starts/stops the bot (index.js) as a separate process.
// If the bot crashes, the panel stays up, shows why, and can start it again.
import fs from 'node:fs';
import path from 'node:path';
import { fork, exec } from 'node:child_process';
import {
  APP_DIR, DISCORD_TOKEN, PANEL_PORT, AUTO_START, USE_CLAUDE, OLLAMA_MODEL, CAMPAIGN_NAME, WHISPER_MODEL,
} from './config.js';
import { listSessions, readSession, sessionDir, knownGuilds, transcriptHtml } from './store.js';
import { recapSession, askArchive, ollamaStatus, refreshOllama, AI_LABEL } from './ai.js';
import { startWeb } from './web.js';

const RESTART_CODE = 75; // the launcher restarts the manager when it exits with this code

// ---------- log buffer (manager + bot output, shown in the panel) ----------
const LOG_LINES = [];
function addLog(level, text, source = 'app') {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    LOG_LINES.push({ t: Date.now(), level, source, text: line.slice(0, 2000) });
    if (LOG_LINES.length > 400) LOG_LINES.shift();
  }
}
for (const level of ['log', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    orig(...args);
    addLog(level, args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
}

// ---------- bot process ----------
let bot = null;                 // ChildProcess while running
let botState = 'stopped';       // stopped | starting | running | stopping | crashed
let botStatus = null;           // last status message from the bot
let crash = null;               // { code, hint, at }
let startedAt = null;

function startBot() {
  if (bot) return;
  if (!DISCORD_TOKEN) throw new Error('Paste your Discord bot token in Settings first.');
  crash = null;
  botStatus = null;
  botState = 'starting';
  startedAt = Date.now();
  console.log('Starting the bot…');
  bot = fork(path.join(APP_DIR, 'index.js'), [], { cwd: APP_DIR, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  bot.stdout.on('data', (d) => { process.stdout.write(d); addLog('log', d.toString(), 'bot'); });
  bot.stderr.on('data', (d) => { process.stderr.write(d); addLog('error', d.toString(), 'bot'); });
  bot.on('message', (msg) => {
    if (msg?.type !== 'status') return;
    botStatus = msg;
    if (botState === 'starting' && msg.online) botState = 'running';
  });
  bot.on('exit', (code, signal) => {
    const wasStopping = botState === 'stopping';
    bot = null;
    if (wasStopping || code === 0) {
      botState = 'stopped';
      console.log('The bot stopped.');
    } else {
      botState = 'crashed';
      const lastBotLines = LOG_LINES.filter((l) => l.source === 'bot').slice(-5).map((l) => l.text).join('\n');
      let hint = botStatus?.loginError || null;
      if (!hint && /Loading speech model/.test(lastBotLines) && !/Speech model ready/.test(lastBotLines)) {
        hint = 'The bot crashed while loading the speech-to-text model. Try a smaller Whisper model in Settings, or reinstall Note Tiger.';
      }
      crash = { code: code ?? signal, hint, at: Date.now() };
      console.error(`The bot stopped unexpectedly (exit code ${code ?? signal}).`);
    }
    botStatus = botStatus ? { ...botStatus, online: false, guilds: botStatus.guilds?.map((g) => ({ ...g, recording: null })) } : null;
  });
}

function stopBot(timeoutMs = 60_000) {
  return new Promise((resolve) => {
    if (!bot) return resolve();
    botState = 'stopping';
    console.log('Stopping the bot (finishing any recording first)…');
    const proc = bot;
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    proc.once('exit', () => { clearTimeout(timer); resolve(); });
    try { proc.send({ type: 'stop' }); } catch { proc.kill(); }
  });
}

// ---------- panel ----------
const safeGid = (gid) => { if (!/^\d+$/.test(gid)) throw new Error('Bad server id'); return gid; };
const liveSessionId = (gid) => botStatus?.guilds?.find((g) => g.id === gid)?.recording?.sessionId;

function guildList() {
  const map = new Map(knownGuilds().map((g) => [g.id, { ...g, recording: null }]));
  for (const g of botStatus?.guilds ?? []) map.set(g.id, { id: g.id, name: g.name, recording: bot ? g.recording : null });
  return [...map.values()].map((g) => ({ ...g, sessions: listSessions(g.id).length }));
}

startWeb({
  status() {
    const clientId = botStatus?.clientId;
    return {
      botState,
      online: Boolean(bot && botStatus?.online),
      botName: botStatus?.botName ?? null,
      hasToken: Boolean(DISCORD_TOKEN),
      loginError: botStatus?.loginError ?? null,
      crash,
      uptimeMin: bot && startedAt ? Math.round((Date.now() - startedAt) / 60000) : 0,
      ai: AI_LABEL,
      usingClaude: USE_CLAUDE,
      ollama: USE_CLAUDE ? null : ollamaStatus(),
      ollamaModel: OLLAMA_MODEL,
      speech: bot && botStatus?.speech ? botStatus.speech : { state: 'idle', model: WHISPER_MODEL },
      canInstallLocalAI: process.platform === 'win32',
      campaign: CAMPAIGN_NAME,
      inviteUrl: clientId
        ? `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=2150665216`
        : null,
      guilds: guildList(),
    };
  },
  startBot,
  async stopBot() { await stopBot(); },
  listSessions(gid) {
    const live = liveSessionId(safeGid(gid));
    return listSessions(gid).reverse().map((s) => ({
      id: path.basename(s.dir),
      title: s.title,
      date: s.date,
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? null,
      lines: s.lineCount ?? null,
      hasRecap: fs.existsSync(path.join(s.dir, 'recap.md')),
      live: path.basename(s.dir) === live,
    }));
  },
  readSession(gid, id) {
    const { dir, ...s } = readSession(gid, id);
    return s;
  },
  async regenerateRecap(gid, id) {
    const dir = sessionDir(gid, id);
    if (liveSessionId(gid) === id) throw new Error('That session is still recording.');
    // Rewriting also re-checks which parts were table talk.
    return recapSession(dir, { reclassify: true });
  },
  deleteSession(gid, id) {
    const dir = sessionDir(gid, id);
    if (liveSessionId(gid) === id) throw new Error('Stop the recording before deleting it.');
    fs.rmSync(dir, { recursive: true, force: true });
  },
  transcriptHtml(gid, id) { return transcriptHtml(gid, sessionDir(gid, id)); },
  ask(gid, question) { return askArchive(safeGid(gid), question); },
  logs() { return LOG_LINES; },
  setupLocalAI() {
    if (process.platform !== 'win32') throw new Error(`Install Ollama from ollama.com, then run: ollama pull ${OLLAMA_MODEL}`);
    const script = path.join(APP_DIR, 'setup-local-ai.bat');
    if (!fs.existsSync(script)) throw new Error('setup-local-ai.bat is missing from the app folder.');
    exec(`start "Note Tiger: local AI setup" cmd /c ""${script}""`, { cwd: APP_DIR });
    setTimeout(refreshOllama, 15_000);
  },
  // Settings changed: restart everything so the new settings load.
  async restart() {
    await stopBot();
    process.exit(RESTART_CODE);
  },
  // Quit Note Tiger completely (tray "Quit", or the installer closing the app).
  async quit() {
    await stopBot();
    process.exit(0);
  },
}, PANEL_PORT);

console.log(`Note Tiger manager running. Panel: http://localhost:${PANEL_PORT}`);

// Started from source (start-bot.bat / start.sh) rather than the Note Tiger app: open the panel in the browser.
if (!process.env.NT_LAUNCHER && !process.env.NT_RESTARTED && process.env.OPEN_PANEL !== 'false') {
  const url = `http://localhost:${PANEL_PORT}`;
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

if (DISCORD_TOKEN && AUTO_START) {
  try { startBot(); } catch (e) { console.error(e.message); }
} else if (!DISCORD_TOKEN) {
  console.log('No Discord token yet. Open Settings in Note Tiger to finish setup.');
}

process.on('unhandledRejection', (err) => console.error('[unhandled]', err));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await stopBot(); process.exit(0); });
