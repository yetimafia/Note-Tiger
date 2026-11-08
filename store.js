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

// Transcript lines in the order they were spoken (they're written as transcription finishes).
export function sessionLines(dir) {
  return readLines(path.join(dir, 'transcript.jsonl')).sort((a, b) => a.t - b.t);
}

export const lineKey = (l) => `${l.t}:${l.speaker}`;

// What the AI worked out after the session (saved in labels.json):
// which lines were off-topic table talk, and who the GM was voicing on each GM line.
export function readLabels(dir) {
  const l = readJSON(path.join(dir, 'labels.json'), {});
  return { offTopic: new Set(l.offTopic || []), voices: new Map(Object.entries(l.voices || {})) };
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
export function transcriptEntries(lines, notes = [], offTopic = new Set(), voices = new Map()) {
  return [
    ...lines.map((l) => ({
      t: l.t, kind: 'say', speaker: displaySpeaker(l, voices), text: l.text,
      offTopic: offTopic.has(lineKey(l)), gm: Boolean(l.gm), voice: voices.get(lineKey(l)) || null,
    })),
    ...notes.map((n) => ({ t: n.t, kind: 'note', speaker: n.speaker, text: n.text, offTopic: false })),
  ].sort((a, b) => a.t - b.t);
}

// mode: 'all' (table talk marked), 'game' (table talk left out), 'table' (only table talk)
export function formatTranscript(lines, notes = [], offTopic = new Set(), mode = 'all', voices = new Map()) {
  return transcriptEntries(lines, notes, offTopic, voices)
    .filter((e) => (mode === 'game' ? !e.offTopic : mode === 'table' ? e.offTopic : true))
    .map((e) => (e.kind === 'note'
      ? `[${clock(e.t)}] NOTE from ${e.speaker}: ${e.text}`
      : `[${clock(e.t)}] ${mode === 'all' && e.offTopic ? '(table talk) ' : ''}${e.speaker}: ${e.text}`))
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
  const { offTopic, voices } = readLabels(dir);
  const entries = transcriptEntries(lines, notes, offTopic, voices);
  const colors = speakerColors(gid, entries.filter((e) => e.kind === 'say').map((e) => e.speaker));
  for (const e of entries) e.color = colors[baseName(e.speaker)] || null;
  return {
    ...meta,
    id,
    dir,
    recap: fs.existsSync(recapFile) ? fs.readFileSync(recapFile, 'utf8') : null,
    transcript: formatTranscript(lines, notes, offTopic, 'all', voices),
    entries,
    tableTalkLines: offTopic.size,
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
    if (last && last.name === name && last.offTopic === e.offTopic && last.kind === e.kind) last.lines.push(e);
    else groups.push({ name, kind: e.kind, offTopic: e.offTopic, voice: e.voice, gm: e.gm, color: e.color, lines: [e] });
  }
  return groups;
}

export function transcriptHtml(gid, dir) {
  const meta = readJSON(path.join(dir, 'meta.json'), {});
  const { offTopic, voices } = readLabels(dir);
  const entries = transcriptEntries(sessionLines(dir), readJSON(path.join(dir, 'notes.json'), []), offTopic, voices);
  const colors = speakerColors(gid, entries.filter((e) => e.kind === 'say').map((e) => e.speaker));
  for (const e of entries) e.color = e.kind === 'note' ? '#C8CCD4' : colors[baseName(e.speaker)] || '#C8CCD4';
  const blocks = groupEntries(entries).map((g) => {
    const tag = g.offTopic ? '<span class="tag">table talk</span>' : '';
    const rows = g.lines.map((e) => `<div class="ln"><span class="tm">${clock(e.t)}</span>${escHtml(e.text)}</div>`).join('');
    return `<div class="b${g.offTopic ? ' tt' : ''}${g.kind === 'note' ? ' note' : ''}" style="border-left-color:${g.color}">` +
      `<div class="n" style="color:${g.color}">${escHtml(g.name)}${tag}</div>${rows}</div>`;
  }).join('\n');
  const people = [...new Set(entries.filter((e) => e.kind === 'say').map((e) => baseName(e.speaker)))]
    .map((n) => `<span class="p"><i style="background:${colors[n]}"></i>${escHtml(n)}</span>`).join('');
  const tt = entries.filter((e) => e.offTopic).length;
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
</style></head><body><main>
<h1>📜 ${escHtml(meta.title || 'Transcript')}</h1>
<div class="sub">${escHtml(meta.date || '')}${meta.voiceChannel ? ` · ${escHtml(meta.voiceChannel)}` : ''} · ${entries.length} lines${tt ? ` · ${tt} table talk` : ''} · Note Tiger</div>
<div class="people">${people}</div>
${tt ? '<label><input type="checkbox" checked onchange="document.body.classList.toggle(\'hide-tt\',!this.checked)"> Show table talk</label>' : ''}
${blocks}
</main></body></html>`;
}

// data/<server id>/sessions/<session id> -> server id
export const gidOf = (dir) => path.basename(path.dirname(path.dirname(dir)));

// Writes transcript.txt and transcript.html for a session folder.
export function writeTranscriptFiles(dir, gid = gidOf(dir)) {
  const { offTopic, voices } = readLabels(dir);
  const txt = path.join(dir, 'transcript.txt');
  const html = path.join(dir, 'transcript.html');
  fs.writeFileSync(txt, formatTranscript(sessionLines(dir), readJSON(path.join(dir, 'notes.json'), []), offTopic, 'all', voices));
  fs.writeFileSync(html, transcriptHtml(gid, dir));
  return { txt, html };
}
