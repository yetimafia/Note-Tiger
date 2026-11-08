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

// Which lines the AI tagged as off-topic table talk (saved in labels.json).
export function readTableTalk(dir) {
  return new Set(readJSON(path.join(dir, 'labels.json'), {}).offTopic || []);
}

const clock = (t) => new Date(t).toTimeString().slice(0, 5);

// Spoken lines + /note entries, in time order, each marked if it's table talk.
export function transcriptEntries(lines, notes = [], offTopic = new Set()) {
  return [
    ...lines.map((l) => ({ t: l.t, kind: 'say', speaker: l.speaker, text: l.text, offTopic: offTopic.has(lineKey(l)) })),
    ...notes.map((n) => ({ t: n.t, kind: 'note', speaker: n.speaker, text: n.text, offTopic: false })),
  ].sort((a, b) => a.t - b.t);
}

// mode: 'all' (table talk marked), 'game' (table talk left out), 'table' (only table talk)
export function formatTranscript(lines, notes = [], offTopic = new Set(), mode = 'all') {
  return transcriptEntries(lines, notes, offTopic)
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
  const offTopic = readTableTalk(dir);
  return {
    ...meta,
    id,
    dir,
    recap: fs.existsSync(recapFile) ? fs.readFileSync(recapFile, 'utf8') : null,
    transcript: formatTranscript(lines, notes, offTopic),
    entries: transcriptEntries(lines, notes, offTopic),
    tableTalkLines: offTopic.size,
  };
}
