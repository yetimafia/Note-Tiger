// Compares one AI (your Local model) with the council on a past session: table talk, fights, NPC voices, and the
// recap. Works on a COPY of the session, so the session itself, your contacts and the story are never touched.
//
//   compare-council.bat                 the latest session
//   compare-council.bat <session id>    a specific one (the folder name under data\<server>\sessions)
//   add "council" or "single" to run only that half (e.g. to re-run the council after changing members)
//
// Writes logs\council-compare\report.txt plus recap-single.md and recap-council.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.chdir(here);
const { DATA_DIR } = await import('./config.js');
const { recapForComparison } = await import('./ai.js');
const { councilStatus, readCouncilRecord } = await import('./council.js');
const { previousRecap } = await import('./store.js');

const args = process.argv.slice(2);
const only = args.find((a) => a === 'council' || a === 'single');
const wanted = args.find((a) => a !== 'council' && a !== 'single');

// ---------- the session ----------
const sessions = [];
for (const g of fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR) : []) {
  const s = path.join(DATA_DIR, g, 'sessions');
  if (fs.existsSync(s)) for (const d of fs.readdirSync(s)) if (fs.existsSync(path.join(s, d, 'transcript.jsonl'))) sessions.push({ gid: g, id: d, dir: path.join(s, d) });
}
sessions.sort((a, b) => a.id.localeCompare(b.id));
const src = wanted ? sessions.find((s) => s.id === wanted) : sessions.at(-1);
if (!src) { console.error(wanted ? `No session called ${wanted}.` : 'No sessions recorded yet.'); process.exit(1); }

const OUT = path.join(here, 'logs', 'council-compare');
fs.mkdirSync(OUT, { recursive: true });
const report = path.join(OUT, 'report.txt');
const say = (m = '') => { console.log(m); fs.appendFileSync(report, m + '\n'); };
fs.writeFileSync(report, '');

const st = await councilStatus({ fresh: true });
say(`Session ${src.id} (server ${src.gid})`);
say(`Council: ${st.members.length} members, ${st.ready} ready${st.usingClaude ? ' (Claude is selected: the council only runs with the local AI)' : ''}`);
for (const m of st.members) say(`  ${m.reachable && m.hasModel ? '✓' : '✗'} ${m.name}: ${m.model} at ${m.url}${m.problem ? ` (${m.problem})` : ''}`);
say(`  judge: ${st.judge.model} at ${st.judge.url}${st.judge.problem ? ` (${st.judge.problem})` : ''}`);
if (!only || only === 'council') {
  if (st.members.length < 2) { say('\nAdd at least 2 council members in Settings → Council first.'); if (only === 'council') process.exit(1); }
}
say('');

// A fresh copy per run, with the same server id in its path so known NPC names and spellings still apply.
// Only the raw session is copied (no labels.json), so hand fixes don't hide what the AIs did.
const prevRecap = previousRecap(src.dir);
function copy(name) {
  const dir = path.join(OUT, 'work', src.gid, 'sessions', `${src.id}-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['transcript.jsonl', 'meta.json', 'notes.json']) if (fs.existsSync(path.join(src.dir, f))) fs.copyFileSync(path.join(src.dir, f), path.join(dir, f));
  return dir;
}

const runs = {};
for (const mode of ['single', 'council']) {
  if (only && only !== mode) continue;
  if (mode === 'council' && st.members.length < 2) continue;
  const dir = copy(mode);
  console.log(`\n=== ${mode === 'single' ? 'one AI (your Local model)' : 'the council'}: working… (this takes as long as a normal recap)`);
  const t0 = Date.now();
  const r = await recapForComparison(dir, { council: mode === 'council', prevRecap });
  r.secs = Math.round((Date.now() - t0) / 1000);
  r.council = readCouncilRecord(dir);
  runs[mode] = r;
  fs.writeFileSync(path.join(OUT, `recap-${mode}.md`), r.text);
}

// ---------- report ----------
const lines = (runs.single || runs.council).lines;
const keyIdx = new Map(lines.map((l, i) => [`${l.t}:${l.speaker}`, i]));
const sets = (r) => ({
  tt: new Set((r.labels.offTopic || []).map((k) => keyIdx.get(k))),
  fight: new Set((r.labels.combat || []).map((k) => keyIdx.get(k))),
  voices: new Map(Object.entries(r.labels.voices || {}).map(([k, v]) => [keyIdx.get(k), v])),
});
const fmt = (s) => `${Math.floor(s / 60)}m ${s % 60}s`;
for (const [mode, r] of Object.entries(runs)) {
  const x = sets(r);
  const npc = {};
  for (const v of x.voices.values()) npc[v] = (npc[v] || 0) + 1;
  say(`########## ${mode === 'single' ? 'ONE AI' : 'COUNCIL'} ##########`);
  say(`Time: ${fmt(r.secs)}`);
  say(`Table talk: ${x.tt.size} of ${lines.length} lines (${Math.round(x.tt.size / lines.length * 100)}%), fight lines: ${x.fight.size}`);
  say(`Who the GM voices: ${Object.entries(npc).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (r.council) {
    for (const part of ['labels', 'recap']) {
      const c = r.council[part];
      if (!c) continue;
      say(`Council ${part}: ${c.used}`);
      for (const m of c.members) say(`  ${m.ok ? '✓' : '✗'} ${m.name} (${m.model})${m.secs != null ? ` ${fmt(m.secs)}` : ''}${m.error ? `: ${m.error}` : ''}`);
      if (c.judge) say(`  judge: ${c.judge.ok ? `✓ ${c.judge.model} ${fmt(c.judge.secs)}` : `✗ ${c.judge.error}`}`);
    }
  }
  say('');
}

if (runs.single && runs.council) {
  const a = sets(runs.single), b = sets(runs.council);
  const diff = (x, y) => [...x].filter((i) => !y.has(i));
  say('########## WHERE THEY DISAGREE ##########');
  say(`Table talk: ${diff(b.tt, a.tt).length} lines only the council called table talk, ${diff(a.tt, b.tt).length} only the single AI did.`);
  say(`Fights: ${diff(b.fight, a.fight).length} lines only the council called a fight, ${diff(a.fight, b.fight).length} only the single AI did.`);
  const voiceDiff = [...a.voices.keys()].filter((i) => b.voices.has(i) && a.voices.get(i) !== b.voices.get(i)).sort((x, y) => x - y);
  say(`NPC voices: ${voiceDiff.length} GM lines labeled differently.`);
  say('\nSome table-talk differences (check which is right):');
  for (const i of [...diff(b.tt, a.tt).slice(0, 8), ...diff(a.tt, b.tt).slice(0, 8)].sort((x, y) => x - y)) {
    say(`  L${i} [${b.tt.has(i) ? 'council: table talk' : 'single: table talk'}] ${lines[i].speaker}: ${String(lines[i].text).slice(0, 100)}`);
  }
  say('\nSome NPC-voice differences (single | council):');
  for (const i of voiceDiff.slice(0, 25)) say(`  L${i} [${a.voices.get(i)} | ${b.voices.get(i)}] ${String(lines[i].text).slice(0, 100)}`);
  say('');
  say('########## GAME LOG ##########');
  const { gameLogText } = await import('./squirrel.js');
  say(`--- one AI ---\n${gameLogText(runs.single.labels.sceneLog) || '(empty)'}\n`);
  say(`--- council ---\n${gameLogText(runs.council.labels.sceneLog) || '(empty)'}\n`);
}
for (const [mode, r] of Object.entries(runs)) say(`########## RECAP: ${mode === 'single' ? 'ONE AI' : 'COUNCIL'} ##########\n${r.text}\n`);
say(`Report: ${report}`);
// The working copies aren't needed any more.
fs.rmSync(path.join(OUT, 'work'), { recursive: true, force: true });
process.exit(0);
