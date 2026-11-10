// Finds table talk ("squirrels"): stretches where the group isn't playing.
//
// Small local models are bad at labeling single lines (they call almost everything "game"), but decent at
// judging a short stretch of conversation. So: overlapping windows of lines, one question each
// ("how much of this is off-topic?"), and each line takes the majority vote of the windows that cover it.

export const SQUIRREL_SYSTEM = `You read a stretch of a messy speech-to-text transcript from a Shadowrun tabletop RPG night over voice
chat, and estimate how much of it is OFF-TOPIC (the group "squirreling").

ON-TOPIC = anything about the game or this campaign: the story, talking in character, plans, combat, dice rolls,
rules questions, character sheets and builds, gear, Shadowrun lore and history, characters introducing themselves or
their backstory, the GM describing things, jokes about the scene, the job, Roll20 handouts about the job.
OFF-TOPIC = not about the game: real life, work, food, family, other games, shows, movies, YouTube, music,
jokes that have nothing to do with the game, mic / Discord / computer problems, breaks, waiting for someone.

Ignore filler like "yeah", "mm-hmm", "okay". Reply with JSON only:
{"offTopicPercent": a number from 0 to 100, "about": "a few words on what they talk about"}`;

const WINDOW = 30;   // lines per question
const STEP = 15;     // windows overlap by half

function windowText(lines, from, to, isGM) {
  return lines.slice(from, to).map((l) => `${isGM(l) ? '[GM] ' : ''}${l.speaker}: ${String(l.text).slice(0, 220)}`).join('\n');
}

// Returns a Set of line indexes that are table talk. askAI(system, user, maxTokens, {json}) -> string.
export async function findTableTalk(lines, askAI, { isGM = () => false, onProgress = () => {}, log = () => {} } = {}) {
  const n = lines.length;
  if (n < 8) return new Set();
  const starts = [];
  for (let s = 0; s < n; s += STEP) {
    starts.push(Math.min(s, Math.max(0, n - WINDOW)));
    if (s + WINDOW >= n) break;
  }
  const votes = new Array(n).fill(0);
  const counts = new Array(n).fill(0);
  const verdicts = [];
  for (let w = 0; w < starts.length; w++) {
    const from = starts[w], to = Math.min(n, from + WINDOW);
    const user = windowText(lines, from, to, isGM);
    let playing = true, why = '', pct = 0;
    try {
      const raw = await askAI(SQUIRREL_SYSTEM, user, 80, { json: true });
      const m = String(raw).match(/\{[\s\S]*\}/);
      const j = m ? JSON.parse(m[0]) : {};
      pct = Math.max(0, Math.min(100, Number(j.offTopicPercent ?? j.offtopicpercent ?? j.percent) || 0));
      playing = pct < 50;
      why = `${pct}% ${String(j.about || j.why || '').slice(0, 80)}`;
    } catch (err) {
      log(`[squirrels] window ${w + 1} skipped: ${err.message}`);
      continue;   // no vote: the lines keep whatever the other windows say
    }
    verdicts.push({ from, to, playing, why });
    for (let i = from; i < to; i++) { counts[i]++; if (!playing) votes[i]++; }
    onProgress(w + 1, starts.length);
  }
  const out = new Set();
  for (let i = 0; i < n; i++) if (counts[i] && votes[i] / counts[i] > 0.5) out.add(i);
  // Edges: a line covered by one "not playing" window and one "playing" window is a tie; it goes with its
  // neighbors on the side that agrees.
  for (let i = 0; i < n; i++) {
    if (!counts[i] || out.has(i) || votes[i] / counts[i] !== 0.5) continue;
    if (out.has(i - 1) && (i + 1 >= n || votes[i + 1] / (counts[i + 1] || 1) >= 0.5)) out.add(i);
  }
  log(`[squirrels] ${verdicts.filter((v) => !v.playing).length} of ${verdicts.length} stretches not playing`);
  return Object.assign(out, { verdicts });
}
