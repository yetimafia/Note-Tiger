// Reading and writing sessions on disk (data/<server id>/sessions/<session id>/).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const guildDir = (gid) => path.join(DATA_DIR, gid);
export const sessionsDir = (gid) => path.join(guildDir(gid), 'sessions');
fs.mkdirSync(DATA_DIR, { recursive: true });

export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
export function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
const settingsFile = (gid) => path.join(guildDir(gid), 'settings.json');
export const getSettings = (gid) => readJSON(settingsFile(gid), { characters: {}, optout: [] });
export const saveSettings = (gid, s) => writeJSON(settingsFile(gid), s);

// ---------- speaker colors (pastels, same color for a person every session) ----------
export const PASTELS = [
  '#FFB3BA', '#BAE1FF', '#BAFFC9', '#FFDFBA', '#D7BAFF', '#FFFFBA',
  '#FFC8E8', '#B5EAD7', '#C9F0FF', '#E2F0CB', '#F3C4FB', '#FFD8B1',
];
// "Seth (GM as Mr. Johnson)" -> "Seth"
export const baseName = (speaker) => String(speaker).replace(/\s*\([^)]*\)\s*$/, '').trim();

export function speakerColors(gid, names) {
  const s = getSettings(gid);
  s.colors ||= {};
  let changed = false;
  for (const raw of names) {
    const name = baseName(raw);
    if (!name || name in s.colors) continue;
    const used = new Set(Object.values(s.colors));
    const free = PASTELS.findIndex((c) => !used.has(c));
    s.colors[name] = PASTELS[free >= 0 ? free : Object.keys(s.colors).length % PASTELS.length];
    changed = true;
  }
  if (changed) saveSettings(gid, s);
  return s.colors;
}

// Folder and server ids come from the control panel's URLs, so only allow safe characters.
const SAFE_ID = /^[\w.-]+$/;
export function sessionDir(gid, id) {
  if (!/^\d+$/.test(gid) || !SAFE_ID.test(id) || id.includes('..')) throw new Error('Bad session id');
  const dir = path.join(sessionsDir(gid), id);
  if (!fs.existsSync(path.join(dir, 'meta.json'))) throw new Error('Session not found');
  return dir;
}

export function listSessions(gid) {
  const dir = sessionsDir(gid);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((d) => fs.existsSync(path.join(dir, d, 'meta.json')))
    .sort() // folder names start with an ISO date, so this is chronological
    .map((d) => ({ dir: path.join(dir, d), ...readJSON(path.join(dir, d, 'meta.json'), {}) }));
}


export function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Spelling fixes (spelling.js registers itself here, so every reader gets fixed text).
let textFixer = null;
export function setTextFixer(fn) { textFixer = fn; }

// Transcript lines in the order they were spoken (they're written as transcription finishes).
export function sessionLines(dir, { raw = false } = {}) {
  const lines = readLines(path.join(dir, 'transcript.jsonl')).sort((a, b) => a.t - b.t);
  if (raw || !textFixer) return lines;
  const gid = path.basename(path.dirname(path.dirname(dir)));
  for (const l of lines) { try { l.text = textFixer(l.text, gid); } catch {} }
  return lines;
}

export const lineKey = (l) => `${l.t}:${l.speaker}`;

// What the AI worked out after the session (saved in labels.json):
// which lines were off-topic table talk, and who the GM was voicing on each GM line.
export function readLabels(dir) {
  const l = readJSON(path.join(dir, 'labels.json'), {});
  return {
    offTopic: new Set(l.offTopic || []),              // off-topic table talk
    voices: new Map(Object.entries(l.voices || {})),  // who the GM is voicing
    recap: new Set(l.recapLines || []),               // the group retelling last session at the start
  };
}
export const readTableTalk = (dir) => readLabels(dir).offTopic;
export const readVoices = (dir) => readLabels(dir).voices;

export function updateLabels(dir, changes) {
  const file = path.join(dir, 'labels.json');
  writeJSON(file, { ...readJSON(file, {}), ...changes });
}

// "Seth (GM)" + voice "Mr. Johnson" -> "Seth (GM as Mr. Johnson)"
export function displaySpeaker(line, voices = new Map()) {
  const voice = voices.get(lineKey(line));
  if (!voice || voice === 'GM') return line.speaker;
  return `${line.speaker.replace(/\s*\(GM\)$/, '')} (GM as ${voice})`;
}

const clock = (t) => new Date(t).toTimeString().slice(0, 5);

// Spoken lines + /note entries, in time order, each marked if it's table talk.
export function transcriptEntries(lines, notes = [], labels = {}) {
  const { offTopic = new Set(), voices = new Map(), recap = new Set() } = labels;
  return [
    ...lines.map((l) => ({
      t: l.t, kind: 'say', speaker: displaySpeaker(l, voices), text: l.text,
      offTopic: offTopic.has(lineKey(l)), recap: recap.has(lineKey(l)) && !offTopic.has(lineKey(l)),
      gm: Boolean(l.gm), voice: voices.get(lineKey(l)) || null,
    })),
    ...notes.map((n) => ({ t: n.t, kind: 'note', speaker: n.speaker, text: n.text, offTopic: false, recap: false })),
  ].sort((a, b) => a.t - b.t);
}

// mode: 'all' (everything, with tags), 'game' (no table talk, no opening recap), 'table' (only table talk)
export function formatTranscript(lines, notes = [], labels = {}, mode = 'all') {
  return transcriptEntries(lines, notes, labels)
    .filter((e) => (mode === 'game' ? !e.offTopic && !e.recap : mode === 'table' ? e.offTopic : true))
    .map((e) => {
      if (e.kind === 'note') return `[${clock(e.t)}] NOTE from ${e.speaker}: ${e.text}`;
      const tag = mode !== 'all' ? '' : e.offTopic ? '(table talk) ' : e.recap ? '(recap of last session) ' : '';
      return `[${clock(e.t)}] ${tag}${e.speaker}: ${e.text}`;
    })
    .join('\n');
}

// Server names are remembered so sessions can be browsed while the bot is offline.
export function saveGuildName(gid, name) {
  writeJSON(path.join(guildDir(gid), 'guild.json'), { name });
}

export function knownGuilds() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR)
    .filter((d) => /^\d+$/.test(d))
    .map((id) => ({ id, name: readJSON(path.join(guildDir(id), 'guild.json'), {}).name || `Server ${id}` }));
}

export function readSession(gid, id) {
  const dir = sessionDir(gid, id);
  const meta = readJSON(path.join(dir, 'meta.json'), {});
  const recapFile = path.join(dir, 'recap.md');
  const lines = sessionLines(dir);
  const notes = readJSON(path.join(dir, 'notes.json'), []);
  const labels = readLabels(dir);
  const entries = transcriptEntries(lines, notes, labels);
  const colors = speakerColors(gid, entries.filter((e) => e.kind === 'say').map((e) => e.speaker));
  for (const e of entries) e.color = colors[baseName(e.speaker)] || null;
  return {
    ...meta,
    id,
    dir,
    recap: fs.existsSync(recapFile) ? fs.readFileSync(recapFile, 'utf8') : null,
    transcript: formatTranscript(lines, notes, labels),
    entries,
    tableTalkLines: labels.offTopic.size,
    recapLines: entries.filter((e) => e.recap).length,
    playStartedAt: meta.playStartedAt ?? null,
    stats: sessionStats(dir),
    colors,
  };
}

// ---------- color-coded transcript page (transcript.html) ----------
const escHtml = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Consecutive lines from the same speaker become one block.
export function groupEntries(entries) {
  const groups = [];
  for (const e of entries) {
    const name = e.kind === 'note' ? `📝 Note from ${e.speaker}` : e.speaker;
    const last = groups.at(-1);
    if (last && last.name === name && last.offTopic === e.offTopic && last.recap === e.recap && last.kind === e.kind) last.lines.push(e);
    else groups.push({ name, kind: e.kind, offTopic: e.offTopic, recap: e.recap, voice: e.voice, gm: e.gm, color: e.color, lines: [e] });
  }
  return groups;
}

export function transcriptHtml(gid, dir) {
  const meta = readJSON(path.join(dir, 'meta.json'), {});
  const entries = transcriptEntries(sessionLines(dir), readJSON(path.join(dir, 'notes.json'), []), readLabels(dir));
  const colors = speakerColors(gid, entries.filter((e) => e.kind === 'say').map((e) => e.speaker));
  for (const e of entries) e.color = e.kind === 'note' ? '#C8CCD4' : colors[baseName(e.speaker)] || '#C8CCD4';
  const blocks = groupEntries(entries).map((g) => {
    const tag = g.offTopic ? '<span class="tag">table talk</span>' : g.recap ? '<span class="tag">recap of last session</span>' : '';
    const rows = g.lines.map((e) => `<div class="ln"><span class="tm">${clock(e.t)}</span>${escHtml(e.text)}</div>`).join('');
    return `<div class="b${g.offTopic || g.recap ? ' tt' : ''}${g.kind === 'note' ? ' note' : ''}" style="border-left-color:${g.color}">` +
      `<div class="n" style="color:${g.color}">${escHtml(g.name)}${tag}</div>${rows}</div>`;
  }).join('\n');
  const people = [...new Set(entries.filter((e) => e.kind === 'say').map((e) => baseName(e.speaker)))]
    .map((n) => `<span class="p"><i style="background:${colors[n]}"></i>${escHtml(n)}</span>`).join('');
  const tt = entries.filter((e) => e.offTopic).length;
  const st = sessionStats(dir);
  const statBar = st ? `<div class="bar">${[['#7bd88f', st.gamePct, '🎲 Game'], ['#f5a524', st.squirrelPct, '🐿️ Squirrels'], ['#9be7ef', st.recapPct, '📖 Recap'], ['#5c6370', st.quietPct, '☕ Quiet']]
    .filter(([, p]) => p > 0).map(([c, p, l]) => `<span style="width:${p}%;background:${c}" title="${l} ${p}%"></span>`).join('')}</div>
<div class="legend">🎲 Game <b>${formatDuration(st.gameMs)}</b> (${st.gamePct}%) · 🐿️ Squirrels <b>${formatDuration(st.squirrelMs)}</b> (${st.squirrelPct}%)${st.recapMs ? ` · 📖 Recap ${formatDuration(st.recapMs)}` : ''}${st.quietMs >= 60000 ? ` · ☕ Quiet ${formatDuration(st.quietMs)}` : ''}${st.topSquirrels[0] ? ` · Biggest squirrel: <b>${escHtml(st.topSquirrels[0].name)}</b>` : ''}</div>` : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(meta.title || 'Transcript')} (${escHtml(meta.date || '')})</title><style>
body{margin:0;background:#313338;color:#dbdee1;font:15px/1.45 "gg sans","Segoe UI",system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:28px 20px 60px}
h1{color:#f2f3f5;font-size:22px;margin:0 0 4px}.sub{color:#949ba4;margin-bottom:14px}
.people{display:flex;flex-wrap:wrap;gap:8px 14px;margin-bottom:12px;color:#b5bac1;font-size:13px}
.p i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:0}
label{color:#b5bac1;font-size:13px;cursor:pointer;display:inline-block;margin-bottom:14px}
.b{background:#2b2d31;border-left:4px solid;border-radius:4px;padding:8px 14px 10px 12px;margin:4px 0}
.n{font-weight:600;font-size:14px;margin-bottom:3px}
.ln{padding:1px 0}.tm{font:12px ui-monospace,Consolas,monospace;background:#1e1f22;color:#b5bac1;border-radius:3px;padding:1px 4px;margin-right:8px}
.b.tt{opacity:.62}.b.tt .ln{font-style:italic}.b.note{background:#26282c}
.tag{font-size:11px;font-weight:500;color:#b5bac1;background:#1e1f22;border-radius:99px;padding:1px 7px;margin-left:8px}
body.hide-tt .b.tt{display:none}
.bar{display:flex;height:12px;border-radius:99px;overflow:hidden;background:#1e1f22;margin:4px 0 6px}.bar span{display:block;height:100%}
.legend{color:#b5bac1;font-size:13px;margin-bottom:12px}
</style></head><body><main>
<h1>📜 ${escHtml(meta.title || 'Transcript')}</h1>
<div class="sub">${escHtml(meta.date || '')}${meta.voiceChannel ? ` · ${escHtml(meta.voiceChannel)}` : ''} · ${entries.length} lines${tt ? ` · ${tt} table talk` : ''} · Note Tiger</div>
${statBar}
<div class="people">${people}</div>
${tt ? '<label><input type="checkbox" checked onchange="document.body.classList.toggle(\'hide-tt\',!this.checked)"> Show table talk</label>' : ''}
${blocks}
</main></body></html>`;
}

// ---------- squirrel-o-meter: how much of the session was the game ----------
// Each stretch of time from one line to the next counts toward what that line was (game, table talk,
// or the opening recap). Silences over 2 minutes count as quiet/breaks.
export function sessionStats(dir) {
  const lines = sessionLines(dir);
  if (lines.length < 2) return null;
  const meta = readJSON(path.join(dir, 'meta.json'), {});
  const { offTopic, recap } = readLabels(dir);
  const labelsRaw = readJSON(path.join(dir, 'labels.json'), {});
  const combatSet = new Set(labelsRaw.combat || []);
  const tracked = Array.isArray(labelsRaw.sceneLog) && labelsRaw.sceneLog.length > 0;
  let combatMs = 0;
  // Recording start/end count as quiet time, but only if they're close to the first/last line.
  const near = (v, ref) => (Number.isFinite(v) && Math.abs(v - ref) < 30 * 60_000 ? v : ref);
  const start = Math.min(lines[0].t, near(Date.parse(meta.startedAt), lines[0].t));
  const end = Math.max(lines.at(-1).t + 5000, near(Date.parse(meta.endedAt), lines.at(-1).t + 5000));
  const ms = { game: 0, squirrel: 0, recap: 0, quiet: lines[0].t - start };
  const squirrels = {};
  const spot = {};
  let gmTalk = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const gap = (lines[i + 1]?.t ?? end) - l.t;
    const kind = offTopic.has(lineKey(l)) ? 'squirrel' : recap.has(lineKey(l)) ? 'recap' : 'game';
    const counted = Math.min(gap, 120_000);
    ms[kind] += counted;
    ms.quiet += gap - counted;
    if (kind === 'game' && combatSet.has(lineKey(l))) combatMs += counted;
    if (kind === 'squirrel') squirrels[baseName(l.speaker)] = (squirrels[baseName(l.speaker)] || 0) + counted;
    // Spotlight: how long each player talked during the game (their own speaking time, not the gaps).
    if (kind === 'game') {
      const talk = Math.min(Number.isFinite(l.d) ? l.d * 1000 : counted, counted || 1000, 60_000);
      if (l.gm) gmTalk += talk;
      else {
        const who = baseName(l.speaker);
        const p = spot[who] || (spot[who] = { name: who, runner: String(l.speaker).match(/\(([^)]+)\)\s*$/)?.[1] || null, ms: 0, lines: 0 });
        p.ms += talk; p.lines++;
      }
    }
  }
  const playerTalk = Object.values(spot).reduce((a, p) => a + p.ms, 0) || 1;
  const spotlight = Object.values(spot).sort((a, b) => b.ms - a.ms)
    .map((p) => ({ ...p, ms: Math.round(p.ms), pct: Math.round((p.ms / playerTalk) * 100) }));
  const total = Object.values(ms).reduce((a, b) => a + b, 0) || 1;
  const pct = (v) => Math.round((v / total) * 100);
  const top = Object.entries(squirrels).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, t]) => ({ name, ms: t }));
  return {
    totalMs: total,
    gameMs: ms.game, squirrelMs: ms.squirrel, recapMs: ms.recap, quietMs: ms.quiet,
    gamePct: pct(ms.game), squirrelPct: pct(ms.squirrel), recapPct: pct(ms.recap), quietPct: pct(ms.quiet),
    topSquirrels: top,
    spotlight, gmTalkMs: Math.round(gmTalk), playerTalkMs: Math.round(playerTalk),
    combatMs: tracked ? combatMs : null,
  };
}

export function formatDuration(ms) {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

// For Discord: a few short lines.
export function statsText(stats) {
  if (!stats) return '';
  const row = (emoji, label, v, p) => (v >= 60_000 ? `${emoji} ${label}: **${formatDuration(v)}** (${p}%)` : null);
  const rows = [
    row('🎲', 'Playing the game', stats.gameMs, stats.gamePct),
    row('🐿️', 'Squirrels (off-topic)', stats.squirrelMs, stats.squirrelPct),
    row('📖', 'Recapping last session', stats.recapMs, stats.recapPct),
    row('☕', 'Quiet / breaks', stats.quietMs, stats.quietPct),
  ].filter(Boolean);
  const top = stats.topSquirrels[0] && stats.topSquirrels[0].ms >= 60_000
    ? `\nBiggest squirrel: **${stats.topSquirrels[0].name}** (${formatDuration(stats.topSquirrels[0].ms)})` : '';
  const fight = stats.combatMs == null ? '' : stats.combatMs > 60_000 ? `\n⚔️ In combat: **${formatDuration(stats.combatMs)}**` : '\n⚔️ No combat this session';
  const sp = (stats.spotlight || []).filter((p) => p.pct >= 1);
  const spot = sp.length >= 2
    ? `\n**🔦 Spotlight** (who talked in the game): ${sp.map((p) => `${p.runner || p.name} ${p.pct}%`).join(' · ')}` : '';
  return `**🐿️ Squirrel-o-meter** · ${formatDuration(stats.totalMs)} session\n${rows.join('\n')}${top}${fight}${spot}`;
}

// The recap of the session before this one (for context), if there is one.
export function previousRecap(dir) {
  const gid = path.basename(path.dirname(path.dirname(dir)));
  const sessions = listSessions(gid);
  const i = sessions.findIndex((s) => path.resolve(s.dir) === path.resolve(dir));
  for (let j = (i < 0 ? sessions.length : i) - 1; j >= 0; j--) {
    const f = path.join(sessions[j].dir, 'recap.md');
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  }
  return null;
}

// data/<server id>/sessions/<session id> -> server id
export const gidOf = (dir) => path.basename(path.dirname(path.dirname(dir)));

// Writes transcript.txt and transcript.html for a session folder.
export function writeTranscriptFiles(dir, gid = gidOf(dir)) {
  const txt = path.join(dir, 'transcript.txt');
  const html = path.join(dir, 'transcript.html');
  fs.writeFileSync(txt, formatTranscript(sessionLines(dir), readJSON(path.join(dir, 'notes.json'), []), readLabels(dir)));
  fs.writeFileSync(html, transcriptHtml(gid, dir));
  return { txt, html };
}
