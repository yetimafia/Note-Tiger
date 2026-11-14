// Reads the session a stretch at a time, keeping a running memory of the game:
//   - how much of each stretch is table talk ("squirrels")
//   - where the runners are and whether a real fight is going on
//   - what actually happened in the story (confirmed by the GM, not players joking)
//
// Small local models are bad at labeling single lines (they call almost everything "game") and at telling a joke
// from an event without context. Judging overlapping ~30-line stretches in order, with "where things stand" carried
// from one stretch to the next, fixes both. Each line takes the majority vote of the stretches that cover it.

export const SQUIRREL_SYSTEM = `You read a stretch of a messy speech-to-text transcript from a Shadowrun tabletop RPG night over voice
chat, and estimate how much of it is OFF-TOPIC (the group "squirreling").

ON-TOPIC = anything about the game or this campaign: the story, talking in character, plans, combat, dice rolls,
rules questions, character sheets and builds, gear, Shadowrun lore and history, characters introducing themselves or
their backstory, the GM describing things, jokes about the scene, the job, Roll20 handouts about the job.
OFF-TOPIC = not about the game: real life, work, food, family, other games, shows, movies, YouTube, music,
jokes that have nothing to do with the game, mic / Discord / computer problems, breaks, waiting for someone.

Ignore filler like "yeah", "mm-hmm", "okay". Reply with JSON only:
{"offTopicPercent": a number from 0 to 100, "about": "a few words on what they talk about"}`;

export const TRACKER_SYSTEM = `You follow the STORY of a Shadowrun tabletop RPG night, one stretch of a messy speech-to-text
transcript at a time. Lines marked [GM] are the game master. You get WHERE THINGS STAND from before; update it.

Players joke and talk big all the time ("I'd shoot him", "we're all gonna die", "he died lol", "I stab him").
Something only HAPPENED in the story if the GM narrates it or confirms it (describes the result, asks for the roll
and resolves it). Jokes, threats, plans, hypotheticals, rules talk, character-sheet talk and stories about other
games are NOT events. If nothing new happened in the story, "happened" is empty.
A fight (combat) only happens when the GM runs one: initiative is rolled, attacks are rolled and resolved.
The GM jokes too: a death or attack with no dice rolled during character setup or chatting is a joke.

Reply with JSON only:
{"scene": "where the runners are and what they're doing, one short sentence",
 "combat": true or false,
 "happened": "the new thing that really happened in the story in this stretch, one short sentence, or empty"}`;

const WINDOW = 30;   // lines per question
const STEP = 15;     // stretches overlap by half

function windowText(lines, from, to, isGM) {
  return lines.slice(from, to).map((l) => `${isGM(l) ? '[GM] ' : ''}${l.speaker}: ${String(l.text).slice(0, 220)}`).join('\n');
}
const yes = (v) => v === true || /^(true|yes|y)$/i.test(String(v).trim());
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Returns a Set of table-talk line indexes, with .verdicts (one per 30-line block: from, to, playing, scene,
// combat, happened) and .combat (a Set of line indexes during a real fight).
// askAI(system, user, maxTokens, {json}) -> string.
export async function findTableTalk(lines, askAI, { isGM = () => false, onProgress = () => {}, log = () => {} } = {}) {
  const n = lines.length;
  const empty = Object.assign(new Set(), { verdicts: [], combat: new Set() });
  if (n < 8) return empty;
  // Pass 1: table talk, on half-overlapping stretches.
  const starts = [];
  for (let s = 0; s < n; s += STEP) {
    starts.push(Math.min(s, Math.max(0, n - WINDOW)));
    if (s + WINDOW >= n) break;
  }
  const blocks = Math.ceil(n / WINDOW);
  const totalSteps = starts.length + blocks;
  const votes = new Array(n).fill(0), counts = new Array(n).fill(0);
  let offStretches = 0;
  for (let w = 0; w < starts.length; w++) {
    const from = starts[w], to = Math.min(n, from + WINDOW);
    try {
      const raw = await askAI(SQUIRREL_SYSTEM, windowText(lines, from, to, isGM), 80, { json: true });
      const m = String(raw).match(/\{[\s\S]*\}/);
      const j = m ? JSON.parse(m[0]) : {};
      const pct = Math.max(0, Math.min(100, Number(j.offTopicPercent ?? j.offtopicpercent ?? j.percent) || 0));
      if (pct >= 50) offStretches++;
      for (let i = from; i < to; i++) { counts[i]++; if (pct >= 50) votes[i]++; }
    } catch (err) {
      log(`[game tracker] stretch ${w + 1} skipped: ${err.message}`);
    }
    onProgress(w + 1, totalSteps);
  }
  const out = new Set();
  for (let i = 0; i < n; i++) if (counts[i] && votes[i] / counts[i] > 0.5) out.add(i);
  // Ties at the edge of a stretch go with the neighbor on the side that agrees.
  for (let i = 0; i < n; i++) {
    if (!counts[i] || out.has(i) || votes[i] / counts[i] !== 0.5) continue;
    if (out.has(i - 1) && (i + 1 >= n || votes[i + 1] / (counts[i + 1] || 1) >= 0.5)) out.add(i);
  }

  // Pass 2: follow the story in order (scene, fights, GM-confirmed events), skipping table talk.
  const verdicts = [];
  const combatLines = new Set();
  let scene = '', combat = false;
  const events = [];
  for (let k = 0; k < blocks; k++) {
    const from = k * WINDOW, to = Math.min(n, from + WINDOW);
    const game = [];
    for (let i = from; i < to; i++) if (!out.has(i)) game.push(i);
    const v = { from, to, playing: game.length >= (to - from) / 2, scene, combat, happened: '' };
    if (game.length >= 6) {
      const text = game.map((i) => `${isGM(lines[i]) ? '[GM] ' : ''}${lines[i].speaker}: ${String(lines[i].text).slice(0, 220)}`).join('\n');
      const before = `WHERE THINGS STAND: ${scene || 'the session is just starting'}\nIN A FIGHT RIGHT NOW: ${combat ? 'yes' : 'no'}\n` +
        `RECENT EVENTS: ${events.slice(-4).join(' / ') || 'none yet'}`;
      try {
        const raw = await askAI(TRACKER_SYSTEM, `${before}\n\nTHIS STRETCH:\n${text}`, 160, { json: true });
        const m = String(raw).match(/\{[\s\S]*\}/);
        const j = m ? JSON.parse(m[0]) : {};
        v.scene = clean(j.scene, 200) || scene;
        v.combat = yes(j.combat);
        // In Shadowrun every real fight starts with initiative. No initiative, no fight (the GM jokes too).
        if (v.combat && !combat && !/\binitiative\b/i.test(text)) v.combat = false;
        let h = clean(j.happened, 240);
        if (/^(none|nothing|n\/a|empty|no new|nothing new)/i.test(h)) h = '';
        // Outside a fight, deaths and gunshots are jokes (players, and GMs, do this a lot).
        if (!v.combat && !combat) {
          h = withoutViolence(h);
          v.scene = withoutViolence(v.scene) || scene;
        }
        if (h && !similar(h, events.at(-1))) { v.happened = h; events.push(h); }
      } catch (err) {
        log(`[game tracker] story stretch ${k + 1} skipped: ${err.message}`);
      }
    }
    scene = v.scene; combat = v.combat;
    if (v.combat) for (const i of game) combatLines.add(i);
    verdicts.push(v);
    onProgress(starts.length + k + 1, totalSteps);
  }
  log(`[game tracker] ${out.size} of ${n} lines table talk (${offStretches} of ${starts.length} stretches), ` +
    `${verdicts.filter((v) => v.combat).length} stretches in combat, ${events.length} events`);
  return Object.assign(out, { verdicts, combat: combatLines });
}

// Drops the parts of a sentence that say someone died, was shot, killed or stabbed.
const VIOLENCE = /\b(died|dies|dying|dead|killed|kills|shot|stabbed|murdered|drive-?by)\b/i;
export function withoutViolence(text) {
  if (!text || !VIOLENCE.test(text)) return text;
  return text.split(/(?<=[.;])\s+|,\s*(?:and\s+|after\s+|with\s+|while\s+)?/).filter((part) => !VIOLENCE.test(part))
    .join(', ').replace(/,\s*$/, '').trim();
}

// Same event said twice in a row ("the GM clarified..." / "The GM clarified...")?
function similar(a, b) {
  if (!a || !b) return false;
  const w = (t) => new Set(String(t).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((x) => x.length > 3));
  const A = w(a), B = w(b);
  if (!A.size || !B.size) return false;
  let same = 0;
  for (const x of A) if (B.has(x)) same++;
  return same / Math.min(A.size, B.size) >= 0.6;
}

// The game log for the recap writer: where the team went, fights, and GM-confirmed events, in order.
export function gameLogText(sceneLog = []) {
  if (!sceneLog.length) return '';
  const out = [];
  let lastScene = '', inFight = false, fights = 0;
  for (const v of sceneLog) {
    if (v.combat && !inFight) { fights++; out.push(`⚔️ A fight starts (${v.scene || 'scene unclear'})`); }
    if (!v.combat && inFight) out.push('⚔️ The fight ends');
    inFight = v.combat;
    if (v.scene && v.scene !== lastScene && v.playing) { out.push(`📍 ${v.scene}`); lastScene = v.scene; }
    if (v.happened) out.push(`• ${v.happened}`);
  }
  if (inFight) out.push('⚔️ (still fighting when the session ended)');
  const head = fights ? `There were ${fights} fight(s) this session.` : 'There was NO combat this session. Treat any talk of shooting, stabbing, dying or killing as jokes unless an event below says it happened.';
  return `${head}\n${out.join('\n')}`;
}
