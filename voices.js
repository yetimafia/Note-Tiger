// Who the GM is voicing, line by line: Narrator, an NPC (by name), or the GM as themselves.
//
// The first tagging pass looks at lines almost one at a time, and small local models then never commit to an
// NPC name. This pass reads the conversation in order with memory: who's in the scene, who introduced
// themselves, which names the players use, and the known NPCs. It's told the cues that give a voice away.
import { soundKey } from './spelling.js';

export const VOICE_SYSTEM = `You help label a speech-to-text transcript of a Shadowrun tabletop RPG night. The game master (GM) plays
everyone the runners meet. For each line marked [GM] with an id like L12, decide who the GM is speaking as:

NARRATOR  = describing the world or what happens: places, actions, results, what a screen or device shows
             ("You see...", "The truck pulls up", "It starts a glowy screen", "She hands you the other one"),
             even right after an NPC spoke.
NPC <name> = speaking AS a character in the world. Clues: first person inside the story ("I", "my name is Grim",
             "I keep a piece of family furniture"), talking to the runners as people in the world ("Mr. Crusher",
             "you're on the clock"), offering jobs, haggling, threats, greetings in character. If the players just spoke
             to someone by name ("What do you got for us, Mr. Graham?"), the GM's answer is that character.
             Use the NPC's name. If unnamed, a short role ("Bartender", "Guard"). Keep using the same name for the same
             character. Never use a player's or runner's name.
GM        = the GM as themselves, outside the story: rules, dice, "roll for it", Roll20/Discord/tech, scheduling,
             jokes and chat about real life.

You get WHO'S AROUND (characters already speaking in this scene) and KNOWN NPCs. A character usually keeps talking
for several lines in a row (including "Any questions?", "You're on the clock") until the GM clearly switches to
describing, to dice and rules, or to real-life chat.
Reply with JSON only, one entry per [GM] id: {"L12": "NARRATOR", "L13": "NPC Grim", "L14": "GM"}`;

const WINDOW = 30;

function parse(raw) {
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) return {};
  try { return JSON.parse(m[0]); } catch { return {}; }
}

// lines: transcript lines (sorted); isGM(line); players: names that must never be NPCs;
// known: NPC names already known (contacts); sceneAt(t): the tracker's scene for that time (or '').
// Returns Map(lineIndex -> 'Narrator' | 'GM' | npc name).
export async function findVoices(lines, askAI, { isGM = (l) => l.gm, players = new Set(), known = [], sceneAt = () => '', onProgress = () => {}, log = () => {} } = {}) {
  const out = new Map();
  const around = [];            // recent NPCs, most recent last
  const blocks = Math.ceil(lines.length / WINDOW);
  const playerKey = (n) => soundKey(n);
  const playerKeys = new Set([...players].map(playerKey).filter((k) => k.length >= 2));
  for (let b = 0; b < blocks; b++) {
    const from = b * WINDOW, to = Math.min(lines.length, from + WINDOW);
    const gmIdx = [];
    for (let i = from; i < to; i++) if (isGM(lines[i])) gmIdx.push(i);
    onProgress(b + 1, blocks);
    if (!gmIdx.length) continue;
    // A few lines of lead-in so the first GM lines have context.
    const lead = Math.max(0, from - 6);
    const text = [];
    for (let i = lead; i < to; i++) {
      const l = lines[i];
      const id = i >= from && isGM(l) ? `L${i} [GM] ` : '      ';
      text.push(`${id}${l.speaker}: ${String(l.text).slice(0, 240)}`);
    }
    const user = `SCENE: ${sceneAt(lines[from].t) || 'unknown'}\nWHO'S AROUND: ${around.slice(-4).join(', ') || 'nobody yet'}\n` +
      `KNOWN NPCs: ${known.slice(0, 40).join(', ') || 'none yet'}\nPLAYERS AND RUNNERS (never NPCs): ${[...players].slice(0, 30).join(', ')}\n\n` +
      `${text.join('\n')}\n\nLabel these ids: ${gmIdx.map((i) => `L${i}`).join(', ')}`;
    let j = {};
    try {
      j = parse(await askAI(VOICE_SYSTEM, user, 60 + gmIdx.length * 14, { json: true }));
    } catch (err) {
      log(`[voices] part ${b + 1} skipped: ${err.message}`);
      continue;
    }
    for (const i of gmIdx) {
      const v = String(j[`L${i}`] ?? j[i] ?? '').trim();
      let label = 'Narrator';
      if (/^npc\b/i.test(v)) {
        const name = v.replace(/^npc\s*[:\-]?\s*/i, '').replace(/["*()[\]]/g, '').trim().slice(0, 40);
        label = name && !playerKeys.has(playerKey(name)) ? name : 'Narrator';
      } else if (/^gm\b|out of char|ooc/i.test(v)) label = 'GM';
      else if (/^narr/i.test(v) || !v) label = 'Narrator';
      else if (!playerKeys.has(playerKey(v)) && /^[A-Z]/.test(v) && v.length <= 40) label = v;   // a bare name
      out.set(i, label);
      if (label !== 'Narrator' && label !== 'GM') { const k = around.indexOf(label); if (k >= 0) around.splice(k, 1); around.push(label); }
    }
  }
  smooth(lines, out);
  mergeSpellings(out, known);
  log(`[voices] ${[...out.values()].filter((v) => v !== 'Narrator' && v !== 'GM').length} lines as NPCs: ` +
    [...new Set([...out.values()].filter((v) => v !== 'Narrator' && v !== 'GM'))].join(', '));
  return out;
}

// One "Narrator" line between two lines of the same NPC, within a minute: almost always that NPC still talking.
function smooth(lines, out) {
  const idx = [...out.keys()].sort((a, b) => a - b);
  for (let k = 1; k < idx.length - 1; k++) {
    const a = out.get(idx[k - 1]), m = out.get(idx[k]), c = out.get(idx[k + 1]);
    if (m === 'Narrator' && a === c && a !== 'Narrator' && a !== 'GM' &&
        lines[idx[k + 1]].t - lines[idx[k - 1]].t < 90_000) out.set(idx[k], a);
  }
}

// Speech recognition spells names several ways ("Grim", "Grimm", "Graham"): sound-alike names become one,
// preferring a known NPC's spelling, then the most used one.
function mergeSpellings(out, known) {
  const counts = new Map();
  for (const v of out.values()) if (v !== 'Narrator' && v !== 'GM') counts.set(v, (counts.get(v) || 0) + 1);
  const groups = new Map();
  const keyOf = (n) => soundKey(n.replace(/^(mr|mrs|ms|miss|dr)\.?\s+/i, ''));
  for (const name of counts.keys()) {
    const k = keyOf(name);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(name);
  }
  const rename = new Map();
  for (const [k, names] of groups) {
    const knownName = known.find((n) => keyOf(n) === k);
    const best = knownName || names.sort((a, b) => counts.get(b) - counts.get(a))[0];
    for (const n of names) if (n !== best) rename.set(n, best);
  }
  for (const [i, v] of out) if (rename.has(v)) out.set(i, rename.get(v));
}
