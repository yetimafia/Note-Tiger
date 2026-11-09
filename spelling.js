// Fixes how speech recognition spells Shadowrun words and your campaign's names
// ("wren rocky" -> "Renraku", "saeder crup" -> "Saeder-Krupp", "ghost" -> "Ghost").
//
// Three layers, applied whenever a transcript is read (so new words fix old sessions too):
//   1. "Always fix" pairs you type in Settings  (heard = meant)
//   2. sound-alike matching against known words: Shadowrun terms, runner names, contacts, places, your words
//   3. capitalization of known names
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { readJSON, writeJSON, getSettings, setTextFixer } from './store.js';

const VOCAB_FILE = path.join(DATA_DIR, 'vocab.json');
export const readVocab = () => ({ auto: true, words: [], fixes: [], ...readJSON(VOCAB_FILE, {}) });
export function saveVocab(v) {
  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const out = {
    auto: v.auto !== false,
    words: [...new Set((v.words || []).map(clean).filter(Boolean))].slice(0, 500),
    fixes: (v.fixes || []).map((f) => ({ heard: clean(f.heard), meant: clean(f.meant) })).filter((f) => f.heard && f.meant).slice(0, 500),
  };
  writeJSON(VOCAB_FILE, out);
  cache.clear();
  return out;
}

// Proper nouns from Shadowrun (5th/6th edition era). Ordinary words like "edge" or "drain" are left out on
// purpose: they'd get "fixed" in normal speech.
export const SHADOWRUN_TERMS = `Renraku, Ares, Aztechnology, Saeder-Krupp, Mitsuhama, Shiawase, Horizon, Wuxing, Evo, Spinrad, NeoNET,
Knight Errant, Lone Star, Hard Corps, Redmond Barrens, Redmond, Puyallup, Tacoma, Everett, Bellevue, Renton,
Auburn, Snohomish, Fort Lewis, Council Island, Salish-Shidhe, Tir Tairngire, Tir na nOg, Aztlan, Amazonia,
Ork Underground, Seattle, Seoulpa, Yakuza, Triad, Vory, Mafia, Ancients, Halloweeners, Draco Foundation,
Dunkelzahn, Lofwyr, Ghostwalker, Mr. Johnson, Ms. Johnson, Fichetti, Ares Predator, Ingram Smartgun,
Ruger Super Warhawk, Colt America, Remington Roomsweeper, Defiance, Yamaha Pulsar, Ares Alpha, HK-227, Uzi,
Enfield, Krime, Ranger Arms, Mossberg, Steyr, Walther, Beretta, Browning Ultra-Power, Fairlight Excalibur,
Hermes Ikon, Renraku Tsurugi, Sony CIY-720, Shiawase Cyber-5, Novatech Navi, Transys Avalon, Erika Elite,
Hyundai Shin-Hyung, Ford Americar, Eurocar Westwind, Harley-Davidson Scorpion, Dodge Scoot, GMC Bulldog,
Northrup Wasp, Ares Roadmaster, MCT Fly-Spy, Lockheed Optic-X, Steel Lynx, Roto-drone, Nissan Hound, Novacoke,
Deepweed, BTL, Stuffer Shack, Sixth World, UCAS, Bug City, Crash 2.0, Grid Overwatch Division,
Corporate Court, Zurich-Orbital, Shadowland, Jackpoint, Dodger, FastJack, Netcat, Slamm-0!, Winterhawk,
Man-of-Many-Names, Plan 9, Hatchetman, Orxploitation, Mitsuhama Zero-Zone, Telestrian, Telestrian Industries,
Wuxing Inc, Shiawase Envirotech, Proteus, Zeta-ImpChem, Universal Omnitech, Cross Applied Technologies, Yamatetsu,
Ares Macrotechnology, Saito, Aztechnology Pyramid, Space Needle, Ork Rights Committee, Humanis Policlub,
Mothers of Metahumans, Ghost Cartels, Tamanous, Laés, Kong-Wah, Red Dragon, Feathered Serpent`.split(',').map((s) => s.trim()).filter(Boolean);

// Very common English words: never "fixed" on their own, and a run of only these is never changed either
// (so "her son" doesn't turn into "Horizon").
const COMMON = new Set(`a about above across act add after again against age ago air all almost alone along already also always am
among an and another any anyone anything are area around as ask at away back bad bag ball bank bar base be bear beat because bed been
before began begin behind being believe below best better between big bit black blood blue board boat body book born both box boy break
bring brother brought build burn business but buy by call came can car care carry case cat catch cause center certain chair chance
change check child city class clear close cold come common cook cool corner cost could count country course cover cross cry cut dark
day dead deal dear death deep did die different do does dog done door down draw dream dress drink drive drop dry during each ear early
earth east easy eat edge end enough even evening ever every eye face fact fall family far fast father fear feel feet few field fight
fill final find fine fire first fish five floor fly follow food foot for force form found four free friend from front full fun game
gave get girl give glass go god gold gone good got great green ground group grow gun guy had hair half hall hand hang happen hard has
hat have he head hear heard heart heat heavy held hell hello help her here hey high him his hit hold hole home hope horse hot hour
house how huge human hundred hunt hurt i ice idea if in inside into iron is it its job join just keep key kid kill kind king knew
knock know lady land large last late laugh law lay lead learn least leave left leg less let lie life light like line list listen
little live lock long look lord lose lost lot loud love low made main make man many map mark may me mean meet men mind mine minute
miss moment money month moon more morning most mother mouth move much must my name near neck need never new news next nice night no
none north nose not note nothing now number of off office often oh oil ok okay old on once one only open or order other our out over
own page paid pain paper part party pass past pay people person pick piece place plan play please point police poor power pretty
price pull push put question quick quiet race rain ran rather reach read ready real really red rest ride right ring rise river road
rock rocky roll room round run safe said same sat save saw say sea seat second see seem seen sell send sense sent set seven shall
she ship shoot short shot should show shut sick side sign since sing sir sister sit six size sky sleep slow small smell smile snow so
soft some someone something son song soon sorry sound south space speak spot stand star start state stay step still stone stop
story street strong such sun sure table take talk team tell ten than thank that the their them then there these they thing think
this those though three through throw time tiny to today together told too took top touch toward town tree trip trouble true try
turn two under until up upon us use very voice wait walk wall want war warm was watch water way we wear week well went were west
what when where which while white who whole why wide wife will win wind window wish with without woman women wood word work world
would write wrong yard yeah year yes yet you young your yours`.split(/\s+/));

// A rough "sounds like" key: consonant skeleton after common spelling-to-sound swaps.
export function soundKey(words) {
  const parts = String(words).toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z]/g, '')
    .replace(/^kn/, 'n').replace(/^wr/, 'r').replace(/^ps/, 's').replace(/^x/, 's').replace(/^wh/, 'w'));
  let s = parts.join('');
  if (!s) return '';
  s = s.replace(/ph/g, 'f').replace(/gh/g, '').replace(/ck/g, 'k').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k')
    .replace(/q/g, 'k').replace(/x/g, 'ks').replace(/z/g, 's').replace(/dg/g, 'j').replace(/tch/g, 'ch')
    .replace(/th/g, 't').replace(/h(?![aeiou])/g, '').replace(/w(?![aeiou])/g, '');
  const first = /[aeiouy]/.test(s[0]) ? 'a' : s[0];
  const rest = s.slice(1).replace(/[aeiouyhw]/g, '');
  return (first + rest).replace(/(.)\1+/g, '$1');
}

function lev(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const letters = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const similarity = (a, b) => { const x = letters(a), y = letters(b); return 1 - lev(x, y) / Math.max(x.length, y.length, 1); };
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Builds the matcher for one server (cached; campaign names change slowly).
let campaignNames = () => [];
export function setCampaignNames(fn) { campaignNames = fn; }
const cache = new Map();
function matcher(gid) {
  const hit = cache.get(gid);
  if (hit && Date.now() - hit.at < 30_000) return hit;
  const v = readVocab();
  const runners = gid ? Object.values(getSettings(gid).characters || {}) : [];
  let fromCampaign = [];
  try { fromCampaign = gid ? campaignNames(gid) : []; } catch {}
  const terms = [...new Set([...SHADOWRUN_TERMS, ...v.words, ...runners, ...fromCampaign].map((t) => String(t).trim()).filter((t) => t.length >= 3))];
  const byKey = new Map();
  for (const t of terms) {
    const k = soundKey(t);
    if (k.length >= 4 && !byKey.has(k)) byKey.set(k, t);
  }
  // Capitalization: lowercase -> proper spelling, for names that have capitals and aren't everyday words.
  const caps = new Map();
  for (const t of terms) if (/[A-Z]/.test(t) && !COMMON.has(t.toLowerCase())) caps.set(t.toLowerCase(), t);
  const capsRe = caps.size ? new RegExp(`\\b(${[...caps.keys()].sort((a, b) => b.length - a.length).map(escRe).join('|')})\\b`, 'gi') : null;
  const fixes = v.fixes.map((f) => ({ re: new RegExp(`\\b${escRe(f.heard)}\\b`, 'gi'), meant: f.meant }));
  const m = { at: Date.now(), auto: v.auto, byKey, caps, capsRe, fixes, terms };
  cache.set(gid, m);
  return m;
}

export function fixText(text, gid = null) {
  if (!text) return text;
  const m = matcher(gid);
  let out = String(text);
  for (const f of m.fixes) out = out.replace(f.re, f.meant);
  if (m.auto && m.byKey.size) {
    const tokens = out.split(/(\s+)/);           // even = words, odd = the spaces between them
    const nWords = Math.ceil(tokens.length / 2);
    for (let wi = 0; wi < nWords; wi++) {
      for (let n = Math.min(3, nWords - wi); n >= 1; n--) {
        const raw = Array.from({ length: n }, (_, k) => tokens[2 * (wi + k)]);
        const core = raw.map((w) => w.replace(/^[^\w]+|[^\w]+$/g, ''));
        if (core.some((w) => !w || /\d/.test(w))) continue;
        const plain = core.map((w) => w.toLowerCase());
        if (plain.every((w) => COMMON.has(w))) continue;
        const key = soundKey(plain.join(' '));
        const term = m.byKey.get(key);
        if (!term || key.length < 4) continue;
        if (letters(term) === letters(plain.join(''))) continue;      // already right (case is fixed below)
        if (similarity(plain.join(''), term) < (n === 1 ? 0.6 : 0.45)) continue;
        const lead = raw[0].match(/^[^\w]*/)[0], trail = raw.at(-1).match(/[^\w]*$/)[0];
        tokens[2 * wi] = lead + term + trail;
        for (let j = 2 * wi + 1; j <= 2 * (wi + n - 1); j++) tokens[j] = '';
        wi += n - 1;
        break;
      }
    }
    out = tokens.join('');
  }
  if (m.capsRe) out = out.replace(m.capsRe, (w) => m.caps.get(w.toLowerCase()) || w);
  return out;
}

// Names for the AI prompts, so recaps spell things right too.
export function knownNames(gid, max = 150) {
  const v = readVocab();
  const runners = gid ? Object.values(getSettings(gid).characters || {}) : [];
  let fromCampaign = [];
  try { fromCampaign = gid ? campaignNames(gid) : []; } catch {}
  return [...new Set([...runners, ...v.words, ...fromCampaign, ...v.fixes.map((f) => f.meant)])].slice(0, max).join(', ');
}

// Every transcript read goes through the fixer.
setTextFixer((text, gid) => fixText(text, gid));
