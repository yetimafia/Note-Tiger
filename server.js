// Note Tiger manager: runs the control panel and starts/stops the bot (index.js) as a separate process.
// If the bot crashes, the panel stays up, shows why, and can start it again.
import fs from 'node:fs';
import path from 'node:path';
import { fork, exec } from 'node:child_process';
import {
  APP_DIR, DISCORD_TOKEN, PANEL_PORT, AUTO_START, USE_CLAUDE, OLLAMA_MODEL, CAMPAIGN_NAME, WHISPER_MODEL,
} from './config.js';
import { listSessions, readSession, sessionDir, knownGuilds, transcriptHtml, fixLines, writeTranscriptFiles } from './store.js';
import { buildCampaign, addEdit, latestStory, allQuotes } from './campaign.js';
import { backupNow, restoreBackup, backupStatus, backupConfigured, startBackupSchedule } from './backup.js';
import { readVocab, saveVocab, fixText } from './spelling.js';
import { updateStatus, checkForUpdate, installUpdate, startUpdateChecks, CURRENT_VERSION } from './updater.js';
import { gmPrep } from './campaign.js';
import { sendAlert, testAlert } from './alerts.js';
import { campaignBook } from './book.js';
import { recapSession, askArchive, ollamaStatus, refreshOllama, AI_LABEL, getProgress, askAI } from './ai.js';
import { councilStatus, checkMember, parseMembers, machineOf } from './council.js';
import {
  listCharacters, getCharacter, saveCharacter, deleteCharacter, importSheet, fillSheet, listTemplates, addTemplate, removeTemplate,
  mapTemplate, readTemplateMap, saveTemplateMap, characterHistory, KEY_GUIDE, ALL_KEYS, normalize, trackChange, CONDITIONS,
} from './sheets.js';

// Matching a blank sheet's boxes runs in the background (it can take a few minutes on the local AI).
const sheetMatching = new Map(); // name → { done, total, error }
// A made-up character to test-fill a sheet with.
const SAMPLE_CHARACTER = {
  name: 'Test Character', player: 'Note Tiger', classes: [{ name: 'Wizard', subclass: 'Evocation', level: 5 }], species: 'Elf', background: 'Sage',
  alignment: 'Neutral Good', xp: 6500, abilities: { str: 8, dex: 14, con: 13, int: 18, wis: 12, cha: 10 },
  saves: { int: { prof: true }, wis: { prof: true } }, skills: { arcana: { prof: true }, history: { prof: true }, investigation: { prof: true }, perception: { prof: true } },
  ac: 12, speed: '30 ft', hp: { max: 27, current: 27 }, hitDice: '5d6', attacks: [{ name: 'Quarterstaff', bonus: '+1', damage: '1d6-1 bludgeoning' }, { name: 'Fire Bolt', bonus: '+7', damage: '2d10 fire' }],
  spellcasting: { class: 'Wizard', ability: 'int', slots: { 1: { max: 4 }, 2: { max: 3 }, 3: { max: 2 } },
    spells: [{ name: 'Fire Bolt', level: 0 }, { name: 'Mage Hand', level: 0 }, { name: 'Magic Missile', level: 1, prepared: true }, { name: 'Shield', level: 1, prepared: true }, { name: 'Misty Step', level: 2, prepared: true }, { name: 'Fireball', level: 3, prepared: true }] },
  inventory: [{ name: 'Spellbook' }, { name: 'Component pouch' }, { name: 'Potion of Healing', qty: 2 }], money: { gp: 120, sp: 15 },
  features: [{ name: 'Arcane Recovery', text: 'Regain spell slots on a short rest.' }, { name: 'Sculpt Spells' }], languages: 'Common, Elvish, Draconic',
  personality: { traits: 'Always has a book open.', ideals: 'Knowledge.', bonds: 'My old master\'s library.', flaws: 'Overconfident.' },
};

// Council status for the dashboard (checked every 30 s; the Settings page asks for a fresh check).
let councilCache = null;
const refreshCouncil = () => councilStatus({ fresh: true }).then((c) => { councilCache = c; return c; }).catch(() => councilCache);
refreshCouncil();
setInterval(refreshCouncil, 30_000).unref();
import { startWeb } from './web.js';
import { publishSite, siteStatus, siteConfigured } from './site.js';
import { LIB_DIR, listBooks, syncLibrary, libraryProgress, addBook, removeBook, askBooks, renderPage, serverSetups, setServerSetup, bookCover, librarySystems, setBookSystem, renameSystem, setSystemCover } from './library.js';

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
    if (msg?.type === 'reply') {
      const p = pending.get(msg.id);
      if (p) { clearTimeout(p.timer); pending.delete(msg.id); msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error)); }
      return;
    }
    if (msg?.type !== 'status') return;
    // A session just ended: back up once its recap has had time to finish.
    const wasRec = (botStatus?.guilds || []).some((g) => g.recording);
    if (wasRec && !(msg.guilds || []).some((g) => g.recording) && backupConfigured()) {
      setTimeout(() => backupNow('after a session').catch(() => {}), 20 * 60_000);
    }
    botStatus = msg;
    if (botState === 'starting' && msg.online) botState = 'running';
  });
  bot.on('exit', (code, signal) => {
    for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error('The bot stopped.')); pending.delete(id); }
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
      const wasRecording = (botStatus?.guilds || []).some((g) => g.recording);
      const tail = LOG_LINES.filter((l) => l.source === 'bot').slice(-8).map((l) => l.text).join('\n').slice(-900);
      sendAlert('crash', `${wasRecording ? '⚠️ **The bot crashed during a recording.** What was said before the crash is saved; anything after isn\'t being recorded.' : '⚠️ **The bot crashed.**'}` +
        `\n${hint ? `${hint}\n` : ''}Open Note Tiger to start it again.${tail ? `\n\`\`\`\n${tail.replace(/`/g, "'")}\n\`\`\`` : ''}`);
    }
    botStatus = botStatus ? { ...botStatus, online: false, guilds: botStatus.guilds?.map((g) => ({ ...g, recording: null })) } : null;
  });
}

// Ask the running bot to do something and wait for its answer.
const pending = new Map();
let nextId = 1;
function askBot(msg, timeoutMs = 10 * 60_000) {
  if (!bot || !botStatus?.online) return Promise.reject(new Error('Start the bot first: it has to be online in Discord to post.'));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('The bot took too long to answer.')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    bot.send({ ...msg, id });
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
  councilStatus() { return refreshCouncil(); },
  // ---------- characters (D&D sheets) ----------
  characters(gid) { return { characters: listCharacters(gid), conditions: CONDITIONS, history: characterHistory(gid), sheets: listTemplates().filter((t) => t.mapped).map((t) => t.name) }; },
  saveCharacter(gid, body) { return saveCharacter(gid, body, { by: 'Note Tiger app', change: body.change || 'edited in the app' }); },
  deleteCharacter(gid, id) { return deleteCharacter(gid, id, { by: 'Note Tiger app' }); },
  // Party tracker: one change (damage, heal, slot, rest…) to one character.
  trackCharacter(gid, id, body) {
    const c = getCharacter(gid, id);
    if (!c) throw new Error('No such character.');
    const { character, said } = trackChange(c, body.op, body);
    const saved = saveCharacter(gid, { ...character, id }, { by: 'Party tracker', change: said || body.op });
    return { character: saved, said, conditions: CONDITIONS };
  },
  async importCharacter(gid, buf, fileName) {
    const { character, how } = await importSheet(buf, askAI, { log: (m) => console.log(m) });
    const existing = listCharacters(gid).find((c) => c.name.toLowerCase() === character.name.toLowerCase());
    const saved = saveCharacter(gid, { ...character, id: existing?.id, playerId: existing?.playerId || '' },
      { by: 'Note Tiger app', change: `imported from ${fileName} (${how})` });
    return { character: saved, how, replaced: Boolean(existing) };
  },
  async characterPdf(gid, id, sheet) {
    const c = getCharacter(gid, id);
    if (!c) throw new Error('No such character.');
    const mapped = listTemplates().filter((t) => t.mapped);
    const t = mapped.find((x) => x.name === sheet) || mapped[0];
    if (!t) throw new Error('Add a blank sheet first (Library → Character sheets).');
    return { pdf: await fillSheet(t.name, c), fileName: `${c.name} - ${t.name}.pdf` };
  },
  // ---------- blank sheets ----------
  sheetTemplates() {
    return { sheets: listTemplates().map((t) => ({ ...t, matching: sheetMatching.get(t.name) || null })), keyGuide: KEY_GUIDE, keys: ALL_KEYS };
  },
  async addSheetTemplate(name, buf) {
    const t = await addTemplate(name, buf);
    this.matchSheetTemplate(t.name);   // start matching its boxes right away
    return t;
  },
  removeSheetTemplate(name) { removeTemplate(name); return { ok: true }; },
  matchSheetTemplate(name) {
    if (sheetMatching.get(name)?.running) return { ok: true, already: true };
    const st = { running: true, done: 0, total: 0, error: null };
    sheetMatching.set(name, st);
    mapTemplate(name, askAI, { onProgress: (d, t) => { st.done = d; st.total = t; } })
      .then(() => { st.running = false; })
      .catch((err) => { st.running = false; st.error = err.message; console.error('[sheets] matching failed:', err.message); });
    return { ok: true };
  },
  sheetTemplateMap(name) { return readTemplateMap(name) || { boxes: [] }; },
  saveSheetTemplateMap(name, body) {
    const map = readTemplateMap(name);
    if (!map) throw new Error('Match the boxes first.');
    const keys = body.keys || {};
    for (const b of map.boxes) if (b.name in keys) b.key = keys[b.name] || null;
    map.by = 'edited'; map.at = new Date().toISOString();
    saveTemplateMap(name, map);
    return { ok: true };
  },
  sampleSheet(name) { return fillSheet(name, normalize(SAMPLE_CHARACTER)); },
  // Checks members typed in Settings before they're saved.
  async councilCheck(list) {
    const members = parseMembers(JSON.stringify(list || []));
    return Promise.all(members.map(async (m) => ({ ...m, machine: machineOf(m.url), ...(await checkMember(m)) })));
  },
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
      council: councilCache && councilCache.on ? { members: councilCache.members.length, ready: councilCache.ready, labels: councilCache.labels, recap: councilCache.recap } : null,
      speech: bot && botStatus?.speech ? botStatus.speech : { state: 'idle', model: WHISPER_MODEL },
      canInstallLocalAI: process.platform === 'win32',
      campaign: CAMPAIGN_NAME,
      inviteUrl: clientId
        ? `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=2150665216`
        : null,
      guilds: guildList(),
      site: siteStatus(),
      backup: backupStatus(),
      update: updateStatus(),
      version: CURRENT_VERSION,
      progress: this.progress(),
    };
  },
  // Recaps being written right now (in this window, or by the bot after a session).
  progress() { return { ...(bot ? botStatus?.progress : null), ...getProgress() }; },
  async publishSite({ all = false, gid = null, id = null } = {}) {
    if (all) return publishSite({ all: true });
    return publishSite({ dirs: [sessionDir(safeGid(gid), id)] });
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
  async regenerateRecap(gid, id, { reclassify = true } = {}) {
    const dir = sessionDir(gid, id);
    if (liveSessionId(gid) === id) throw new Error('That session is still recording.');
    // A normal rewrite also re-checks which parts were table talk; after hand fixes it can skip that (much faster).
    const recap = await recapSession(dir, { reclassify });
    if (siteConfigured()) publishSite({ dirs: [dir] }).catch((e) => console.error('[website]', e.message));
    return recap;
  },
  // Hand fixes from the transcript view: table talk / game, and who the GM was voicing.
  fixLines(gid, id, { keys, offTopic, voice }) {
    const dir = sessionDir(safeGid(gid), id);
    if (!Array.isArray(keys) || !keys.length || keys.length > 5000) throw new Error('Select some lines first.');
    fixLines(dir, keys.map(String), {
      offTopic: offTopic === null || typeof offTopic === 'boolean' ? offTopic : undefined,
      voice: voice === null || typeof voice === 'string' ? voice : undefined,
    });
    writeTranscriptFiles(dir, safeGid(gid));
    return { ok: true };
  },
  deleteSession(gid, id) {
    const dir = sessionDir(gid, id);
    if (liveSessionId(gid) === id) throw new Error('Stop the recording before deleting it.');
    fs.rmSync(dir, { recursive: true, force: true });
  },
  async repostSession(gid, id) {
    sessionDir(safeGid(gid), id); // validates
    if (liveSessionId(gid) === id) throw new Error('That session is still recording.');
    return askBot({ type: 'repost', gid, sessionId: id });
  },
  campaign(gid) {
    const c = buildCampaign(safeGid(gid));
    return { ...c, story: latestStory(gid), quotes: allQuotes(gid) };
  },
  backupNow() { return backupNow('manual'); },
  async testAlert() {
    const ok = await testAlert();
    if (!ok) throw new Error('Couldn\'t send the test message. Check that the Discord token is set and that you share a server with the bot. See the activity log for details.');
    return { ok: true };
  },
  checkUpdate() { return checkForUpdate(); },
  installUpdate() {
    if ((botStatus?.guilds || []).some((g) => g.recording)) throw new Error('A session is recording. Update after you stop it.');
    return installUpdate(async () => { await stopBot(); });
  },
  campaignBook(gid) { return campaignBook(safeGid(gid)); },
  async gmPrep(gid) { return { note: await gmPrep(safeGid(gid), askAI) }; },
  async restoreBackup() {
    if ((botStatus?.guilds || []).some((g) => g.recording)) throw new Error('Stop the recording before restoring.');
    return restoreBackup();
  },
  vocab() { return readVocab(); },
  saveVocab(v) { return saveVocab(v); },
  testSpelling(text) { return fixText(String(text).slice(0, 2000), knownGuilds()[0]?.id || null); },
  campaignEdit(gid, edit) {
    const allowed = {
      'thread-add': ['text'], 'thread-close': ['id', 'how'], 'thread-reopen': ['id'], 'thread-delete': ['id'],
      'thread-edit': ['id', 'text'], 'npc-add': ['name', 'who', 'attitude'], 'npc-edit': ['key', 'who', 'attitude'], 'npc-delete': ['key'],
      'place-add': ['name', 'what'], 'place-edit': ['key', 'what'], 'place-delete': ['key'],
      'job-edit': ['key', 'status', 'payReceived', 'outcome'], 'job-delete': ['key'],
    }[edit?.type];
    if (!allowed) throw new Error('Unknown change.');
    const clean = { type: edit.type, by: 'Note Tiger' };
    for (const f of allowed) if (edit[f] !== undefined) clean[f] = String(edit[f]).replace(/\s+/g, ' ').trim().slice(0, 300);
    if ((clean.type === 'thread-add' || clean.type === 'thread-edit') && !clean.text) throw new Error('Type the loose end first.');
    if ((clean.type === 'npc-add' || clean.type === 'place-add') && !clean.name) throw new Error('Type a name first.');
    addEdit(safeGid(gid), clean);
    refreshSiteSoon();
    return this.campaign(gid);
  },
  library() { return { books: listBooks(), systems: librarySystems(), progress: libraryProgress(), folder: LIB_DIR }; },
  librarySystem({ action, file, name, to }) {
    if (action === 'move') setBookSystem(String(file), name);
    else if (action === 'rename') renameSystem(String(name), to);
    else if (action === 'cover') setSystemCover(String(name), String(file));
    else throw new Error('Unknown change.');
    return { systems: librarySystems() };
  },
  addBook(name, buffer) { return addBook(name, buffer); },
  removeBook(key) { removeBook(key); },
  askBooks(question, gid) { return askBooks(question, { gid }); },
  bookCover(key) { return bookCover(key); },
  serverBooks() { return { guilds: guildList().map(({ id, name }) => ({ id, name })), setups: serverSetups() }; },
  setServerBooks(gid, body) { return setServerSetup(gid, body); },
  renderPage(key, page) { return renderPage(key, page); },
  reindexLibrary() { syncLibrary().catch((e) => console.error('[library]', e.message)); },
  openLibraryFolder() {
    const cmd = process.platform === 'win32' ? `explorer "${LIB_DIR}"` : process.platform === 'darwin' ? `open "${LIB_DIR}"` : `xdg-open "${LIB_DIR}"`;
    exec(cmd, () => {});
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

// Hand edits to contacts/loose ends: refresh the player website a little later (edits often come in bursts).
let siteTimer = null;
function refreshSiteSoon() {
  if (!siteConfigured()) return;
  clearTimeout(siteTimer);
  siteTimer = setTimeout(() => publishSite({ dirs: [] }).catch((e) => console.error('[website]', e.message)), 15_000);
}

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

startBackupSchedule();
startUpdateChecks();

// Rulebooks: index anything new now, and whenever PDFs are added to or removed from the library folder.
syncLibrary().catch((e) => console.error('[library]', e.message));
let libTimer = null;
try {
  fs.watch(LIB_DIR, () => { clearTimeout(libTimer); libTimer = setTimeout(() => syncLibrary().catch(() => {}), 3000); });
} catch { /* watching isn't critical */ }

process.on('unhandledRejection', (err) => console.error('[unhandled]', err));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await stopBot(); process.exit(0); });
