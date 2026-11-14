// D&D 5e character sheets: import a player's sheet (fillable PDF, or plain text as a fallback), keep the character
// as JSON, answer questions from it, and fill it into any blank fillable sheet (2014, 2024, or the group's own).
//
// Storage (new, per server; sessions are not touched):
//   data/<server>/characters/<id>.json     one character (id = the player's Discord id, or a name slug)
//   data/<server>/characters/history.jsonl every change: when, who, what
//   library/sheets/<name>.pdf              blank sheets ("templates")
//   library/sheets/<name>.map.json         which box gets what (worked out once by the AI, fixable in the app)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PDFDocument, PDFCheckBox, PDFTextField, PDFDropdown, PDFRadioGroup } from 'pdf-lib';
import { DATA_DIR } from './config.js';
import { LIB_DIR } from './library.js';

const require = createRequire(import.meta.url);
export const SHEETS_DIR = path.join(LIB_DIR, 'sheets');
fs.mkdirSync(SHEETS_DIR, { recursive: true });

// ---------- the character ----------
export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
export const ABILITY_NAMES = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };
export const SKILLS = {
  acrobatics: 'dex', animal_handling: 'wis', arcana: 'int', athletics: 'str', deception: 'cha', history: 'int',
  insight: 'wis', intimidation: 'cha', investigation: 'int', medicine: 'wis', nature: 'int', perception: 'wis',
  performance: 'cha', persuasion: 'cha', religion: 'int', sleight_of_hand: 'dex', stealth: 'dex', survival: 'wis',
};
export const skillLabel = (k) => k.split('_').map((w) => (w === 'of' ? w : w[0].toUpperCase() + w.slice(1))).join(' ');

const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v ?? '').replace(/[−–]/g, '-').match(/[-+]?\d+/);
  return m ? Number(m[0]) : null;
};
const str = (v) => (v == null ? '' : String(v).trim());
export const mod = (score) => Math.floor(((num(score) ?? 10) - 10) / 2);
export const signed = (n) => (n == null ? '' : n >= 0 ? `+${n}` : `${n}`);
export const profBonusFor = (level) => 2 + Math.floor((Math.max(1, level || 1) - 1) / 4);

export function blankCharacter() {
  return {
    name: '', player: '', playerId: '', edition: '', classes: [], species: '', background: '', alignment: '', xp: null,
    abilities: Object.fromEntries(ABILITIES.map((a) => [a, null])),
    saves: Object.fromEntries(ABILITIES.map((a) => [a, { prof: false }])),
    skills: Object.fromEntries(Object.keys(SKILLS).map((s) => [s, { prof: false, expertise: false }])),
    profBonus: null, ac: null, initiative: null, speed: '', inspiration: false,
    hp: { max: null, current: null, temp: null }, hitDice: '',
    attacks: [], spellcasting: { ability: '', class: '', slots: {}, spells: [] },
    inventory: [], money: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
    features: [], proficiencies: '', languages: '',
    personality: { traits: '', ideals: '', bonds: '', flaws: '' },
    appearance: '', backstory: '', notes: '',
  };
}

// Fills gaps and types (whatever the import or the AI gave us) so the rest of the code can trust the shape.
export function normalize(c) {
  const b = blankCharacter();
  const out = { ...b, ...(c || {}) };
  out.name = str(out.name).slice(0, 80);
  out.classes = (Array.isArray(out.classes) ? out.classes : []).map((k) => ({
    name: str(k?.name), subclass: str(k?.subclass), level: Math.max(1, Math.min(20, num(k?.level) || 1)),
  })).filter((k) => k.name);
  out.abilities = Object.fromEntries(ABILITIES.map((a) => [a, num(out.abilities?.[a]?.score ?? out.abilities?.[a])]));
  out.saves = Object.fromEntries(ABILITIES.map((a) => [a, { prof: Boolean(out.saves?.[a]?.prof ?? out.saves?.[a] === true) }]));
  out.skills = Object.fromEntries(Object.keys(SKILLS).map((s) => [s, {
    prof: Boolean(out.skills?.[s]?.prof || out.skills?.[s]?.expertise), expertise: Boolean(out.skills?.[s]?.expertise),
  }]));
  for (const k of ['profBonus', 'ac', 'initiative', 'xp']) out[k] = num(out[k]);
  out.hp = { max: num(out.hp?.max), current: num(out.hp?.current), temp: num(out.hp?.temp) };
  out.money = Object.fromEntries(['cp', 'sp', 'ep', 'gp', 'pp'].map((k) => [k, num(out.money?.[k]) || 0]));
  out.attacks = (Array.isArray(out.attacks) ? out.attacks : []).map((a) => ({ name: str(a?.name), bonus: str(a?.bonus), damage: str(a?.damage) })).filter((a) => a.name);
  out.inventory = (Array.isArray(out.inventory) ? out.inventory : []).map((i) => (typeof i === 'string' ? { name: i.trim(), qty: 1 } : {
    name: str(i?.name), qty: num(i?.qty) || 1, notes: str(i?.notes),
  })).filter((i) => i.name);
  out.features = (Array.isArray(out.features) ? out.features : []).map((f) => (typeof f === 'string' ? { name: f.trim(), text: '' } : {
    name: str(f?.name), text: str(f?.text),
  })).filter((f) => f.name);
  const sc = out.spellcasting || {};
  out.spellcasting = {
    ability: (ABILITIES.find((a) => str(sc.ability).toLowerCase().startsWith(a)) || ''),
    class: str(sc.class),
    slots: Object.fromEntries(Object.entries(sc.slots || {}).map(([l, v]) => [String(num(l)), { max: num(v?.max ?? v) || 0, used: num(v?.used) || 0 }])
      .filter(([l, v]) => Number(l) >= 1 && Number(l) <= 9 && v.max > 0)),
    spells: (Array.isArray(sc.spells) ? sc.spells : []).map((s) => (typeof s === 'string' ? { name: s.trim(), level: 0, prepared: false } : {
      name: str(s?.name), level: Math.max(0, Math.min(9, num(s?.level) || 0)), prepared: Boolean(s?.prepared),
    })).filter((s) => s.name),
  };
  out.personality = Object.fromEntries(['traits', 'ideals', 'bonds', 'flaws'].map((k) => [k, str(out.personality?.[k])]));
  for (const k of ['player', 'playerId', 'edition', 'species', 'background', 'alignment', 'speed', 'hitDice', 'proficiencies', 'languages', 'appearance', 'backstory', 'notes']) out[k] = str(out[k]);
  out.inspiration = Boolean(out.inspiration);
  return out;
}

export const totalLevel = (c) => c.classes.reduce((n, k) => n + k.level, 0) || 1;
export const classLine = (c) => c.classes.map((k) => `${k.name}${k.subclass ? ` (${k.subclass})` : ''} ${k.level}`).join(' / ');

// The numbers a sheet shows, worked out from the character (an imported number wins when it has one).
export function derived(c) {
  const pb = c.profBonus ?? profBonusFor(totalLevel(c));
  const m = Object.fromEntries(ABILITIES.map((a) => [a, mod(c.abilities[a])]));
  const save = Object.fromEntries(ABILITIES.map((a) => [a, m[a] + (c.saves[a].prof ? pb : 0)]));
  const skill = Object.fromEntries(Object.entries(SKILLS).map(([s, a]) => [s, m[a] + (c.skills[s].expertise ? 2 * pb : c.skills[s].prof ? pb : 0)]));
  const sa = c.spellcasting.ability;
  return {
    pb, mod: m, save, skill,
    initiative: c.initiative ?? m.dex,
    passivePerception: 10 + skill.perception,
    spellDC: sa ? 8 + pb + m[sa] : null,
    spellAttack: sa ? pb + m[sa] : null,
  };
}

// ---------- the boxes a sheet can have ----------
// Every value a sheet box can show, by key. Templates map their own box names to these keys.
export function fillValues(c) {
  const d = derived(c);
  const v = {
    name: c.name, player: c.player, class_level: classLine(c), level: String(totalLevel(c)),
    classes: c.classes.map((k) => k.name).join(' / '), subclass: c.classes.map((k) => k.subclass).filter(Boolean).join(' / '),
    species: c.species, background: c.background, alignment: c.alignment, xp: c.xp == null ? '' : String(c.xp),
    prof_bonus: signed(d.pb), inspiration: c.inspiration, ac: c.ac == null ? '' : String(c.ac), initiative: signed(d.initiative),
    speed: c.speed, hp_max: str(c.hp.max), hp_current: str(c.hp.current), hp_temp: str(c.hp.temp), hit_dice: c.hitDice,
    passive_perception: String(d.passivePerception),
    cp: String(c.money.cp || ''), sp: String(c.money.sp || ''), ep: String(c.money.ep || ''), gp: String(c.money.gp || ''), pp: String(c.money.pp || ''),
    equipment: c.inventory.map((i) => `${i.qty > 1 ? `${i.qty}× ` : ''}${i.name}${i.notes ? ` (${i.notes})` : ''}`).join('\n'),
    features: c.features.map((f) => (f.text ? `${f.name}: ${f.text}` : f.name)).join('\n'),
    proficiencies: [c.proficiencies, c.languages && `Languages: ${c.languages}`].filter(Boolean).join('\n'),
    languages: c.languages,
    traits: c.personality.traits, ideals: c.personality.ideals, bonds: c.personality.bonds, flaws: c.personality.flaws,
    appearance: c.appearance, backstory: c.backstory, notes: c.notes,
    attacks_text: c.attacks.map((a) => `${a.name} ${a.bonus} ${a.damage}`.trim()).join('\n'),
    spell_class: c.spellcasting.class || (c.spellcasting.ability ? c.classes[0]?.name || '' : ''),
    spell_ability: c.spellcasting.ability ? ABILITY_NAMES[c.spellcasting.ability] : '',
    spell_dc: d.spellDC == null ? '' : String(d.spellDC), spell_attack: d.spellAttack == null ? '' : signed(d.spellAttack),
    spells_text: c.spellcasting.spells.map((s) => `${s.level ? `L${s.level}` : 'Cantrip'}: ${s.name}${s.prepared ? ' (prepared)' : ''}`).join('\n'),
  };
  for (const a of ABILITIES) {
    v[a] = str(c.abilities[a]);
    v[`${a}_mod`] = c.abilities[a] == null ? '' : signed(d.mod[a]);
    v[`save_${a}`] = c.abilities[a] == null ? '' : signed(d.save[a]);
    v[`save_${a}_prof`] = c.saves[a].prof;
  }
  for (const s of Object.keys(SKILLS)) {
    v[`skill_${s}`] = c.abilities[SKILLS[s]] == null ? '' : signed(d.skill[s]);
    v[`skill_${s}_prof`] = c.skills[s].prof;
  }
  c.attacks.slice(0, 6).forEach((a, i) => { v[`attack${i + 1}_name`] = a.name; v[`attack${i + 1}_bonus`] = a.bonus; v[`attack${i + 1}_damage`] = a.damage; });
  for (let l = 1; l <= 9; l++) {
    const s = c.spellcasting.slots[l];
    v[`slots_${l}`] = s ? String(s.max) : '';
    v[`slots_used_${l}`] = s && s.used ? String(s.used) : '';
  }
  for (let l = 0; l <= 9; l++) {
    c.spellcasting.spells.filter((s) => s.level === l).slice(0, 13).forEach((s, i) => {
      v[`spell_${l}_${i + 1}`] = s.name;
      v[`spell_${l}_${i + 1}_prepared`] = s.prepared;
    });
  }
  return v;
}

// What each key means, for the AI that matches a blank sheet's boxes to keys.
export const KEY_GUIDE = `name: character name | player: player name | class_level: class and level together ("Wizard 5") | classes | subclass | level
species: race/species | background | alignment | xp: experience points
str, dex, con, int, wis, cha: ability SCORES | str_mod … cha_mod: ability MODIFIERS
save_str … save_cha: saving throw bonus | save_str_prof … save_cha_prof: saving throw proficiency checkbox
skill_<skill>: skill bonus, skill_<skill>_prof: its proficiency checkbox. Skills: ${Object.keys(SKILLS).join(', ')}
prof_bonus | inspiration (checkbox) | ac: armor class | initiative | speed | hp_max | hp_current | hp_temp | hit_dice | passive_perception
attack1_name, attack1_bonus, attack1_damage … attack6_*: the weapon/attack table rows | attacks_text: attacks & spellcasting notes box
equipment: equipment/inventory box | cp, sp, ep, gp, pp: coins | features: features & traits box | proficiencies: other proficiencies & languages box | languages
traits, ideals, bonds, flaws: personality boxes | appearance | backstory | notes (allies, treasure, extra notes)
spell_class: spellcasting class | spell_ability | spell_dc: spell save DC | spell_attack: spell attack bonus
slots_1 … slots_9: spell slots total per level | slots_used_1 … slots_used_9: slots expended
spell_<L>_<N>: the Nth spell line of spell level L (L 0 = cantrips), spell_<L>_<N>_prepared: its prepared checkbox
spells_text: one box for all spells (only if the sheet has no per-level spell lines)`;

const KEY_RE = /^(name|player|class_level|classes|subclass|level|species|background|alignment|xp|(str|dex|con|int|wis|cha)(_mod)?|save_(str|dex|con|int|wis|cha)(_prof)?|skill_[a-z_]+?(_prof)?|prof_bonus|inspiration|ac|initiative|speed|hp_max|hp_current|hp_temp|hit_dice|passive_perception|attack[1-6]_(name|bonus|damage)|attacks_text|equipment|cp|sp|ep|gp|pp|features|proficiencies|languages|traits|ideals|bonds|flaws|appearance|backstory|notes|spell_class|spell_ability|spell_dc|spell_attack|slots_(used_)?[1-9]|spell_[0-9]_(1[0-3]|[1-9])(_prepared)?|spells_text)$/;
// Every key, for the "fix boxes" picker in the app.
export const ALL_KEYS = [
  'name', 'player', 'class_level', 'classes', 'subclass', 'level', 'species', 'background', 'alignment', 'xp',
  ...ABILITIES, ...ABILITIES.map((a) => `${a}_mod`), ...ABILITIES.map((a) => `save_${a}`), ...ABILITIES.map((a) => `save_${a}_prof`),
  ...Object.keys(SKILLS).flatMap((k) => [`skill_${k}`, `skill_${k}_prof`]),
  'prof_bonus', 'inspiration', 'ac', 'initiative', 'speed', 'hp_max', 'hp_current', 'hp_temp', 'hit_dice', 'passive_perception',
  ...[1, 2, 3, 4, 5, 6].flatMap((i) => [`attack${i}_name`, `attack${i}_bonus`, `attack${i}_damage`]), 'attacks_text',
  'equipment', 'cp', 'sp', 'ep', 'gp', 'pp', 'features', 'proficiencies', 'languages', 'traits', 'ideals', 'bonds', 'flaws',
  'appearance', 'backstory', 'notes', 'spell_class', 'spell_ability', 'spell_dc', 'spell_attack', 'spells_text',
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((l) => [`slots_${l}`, `slots_used_${l}`]),
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((l) => Array.from({ length: 13 }, (_, i) => [`spell_${l}_${i + 1}`, `spell_${l}_${i + 1}_prepared`]).flat()),
];
export const isKey = (k) => KEY_RE.test(k) && (!k.startsWith('skill_') || Object.keys(SKILLS).includes(k.replace(/^skill_/, '').replace(/_prof$/, '')));

// The other way: a filled sheet's boxes (by key) → a character. Used to import a sheet whose template we know.
export function fromValues(v) {
  const c = blankCharacter();
  const get = (k) => (v[k] == null ? '' : v[k]);
  const yes = (k) => v[k] === true || /^(yes|on|true|x|✓|1)$/i.test(String(v[k] ?? '').trim());
  c.name = str(get('name')); c.player = str(get('player'));
  c.species = str(get('species')); c.background = str(get('background')); c.alignment = str(get('alignment'));
  c.xp = num(get('xp'));
  // "Wizard 5 / Fighter 2", "Rogue (Thief) 3"
  const cl = str(get('class_level')) || [str(get('classes')), str(get('level'))].filter(Boolean).join(' ');
  for (const part of cl.split(/[/,]/)) {
    const m = part.trim().match(/^(.+?)(?:\s*\(([^)]+)\))?\s*(\d{1,2})?$/);
    if (m && m[1]) c.classes.push({ name: m[1].replace(/\s+level$/i, '').trim(), subclass: (m[2] || '').trim(), level: num(m[3]) || 1 });
  }
  if (!c.classes[0]?.subclass && get('subclass')) c.classes[0] && (c.classes[0].subclass = str(get('subclass')));
  for (const a of ABILITIES) {
    c.abilities[a] = num(get(a));
    c.saves[a].prof = yes(`save_${a}_prof`);
  }
  for (const s of Object.keys(SKILLS)) c.skills[s].prof = yes(`skill_${s}_prof`);
  c.profBonus = num(get('prof_bonus')); c.ac = num(get('ac')); c.initiative = num(get('initiative'));
  c.speed = str(get('speed')); c.inspiration = yes('inspiration'); c.hitDice = str(get('hit_dice'));
  c.hp = { max: num(get('hp_max')), current: num(get('hp_current')), temp: num(get('hp_temp')) };
  // Expertise isn't a box on most sheets: a bonus of ability mod + 2×proficiency means it.
  const pb = c.profBonus ?? profBonusFor(totalLevel(c));
  for (const [s, a] of Object.entries(SKILLS)) {
    const b = num(get(`skill_${s}`));
    if (b != null && c.abilities[a] != null) {
      if (b === mod(c.abilities[a]) + 2 * pb) Object.assign(c.skills[s], { prof: true, expertise: true });
      else if (b === mod(c.abilities[a]) + pb) c.skills[s].prof = true;
    }
  }
  for (let i = 1; i <= 6; i++) if (str(get(`attack${i}_name`))) c.attacks.push({ name: str(get(`attack${i}_name`)), bonus: str(get(`attack${i}_bonus`)), damage: str(get(`attack${i}_damage`)) });
  c.money = Object.fromEntries(['cp', 'sp', 'ep', 'gp', 'pp'].map((k) => [k, num(get(k)) || 0]));
  c.inventory = str(get('equipment')).split(/\n|,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = s.match(/^(\d+)\s*[x×]?\s+(.+)$/i);
    return m ? { name: m[2], qty: Number(m[1]) } : { name: s, qty: 1 };
  });
  c.features = str(get('features')).split(/\n+/).map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = s.match(/^([^:.]{2,40})[:.]\s*(.*)$/);
    return m ? { name: m[1].replace(/^[•*-]\s*/, ''), text: m[2] } : { name: s.replace(/^[•*-]\s*/, ''), text: '' };
  });
  c.proficiencies = str(get('proficiencies')); c.languages = str(get('languages'));
  c.personality = { traits: str(get('traits')), ideals: str(get('ideals')), bonds: str(get('bonds')), flaws: str(get('flaws')) };
  c.appearance = str(get('appearance')); c.backstory = str(get('backstory')); c.notes = str(get('notes'));
  const ab = str(get('spell_ability')).toLowerCase();
  c.spellcasting.ability = ABILITIES.find((a) => ab.startsWith(a) || ABILITY_NAMES[a].toLowerCase() === ab) || '';
  c.spellcasting.class = str(get('spell_class'));
  for (let l = 1; l <= 9; l++) { const n = num(get(`slots_${l}`)); if (n) c.spellcasting.slots[l] = { max: n, used: num(get(`slots_used_${l}`)) || 0 }; }
  for (let l = 0; l <= 9; l++) for (let i = 1; i <= 13; i++) {
    const n = str(get(`spell_${l}_${i}`));
    if (n) c.spellcasting.spells.push({ name: n, level: l, prepared: yes(`spell_${l}_${i}_prepared`) });
  }
  if (!c.spellcasting.ability && !c.spellcasting.spells.length && c.classes[0]) {
    // An empty spell page: leave spellcasting blank.
  }
  return normalize(c);
}

// ---------- characters on disk ----------
const charDir = (gid) => path.join(DATA_DIR, String(gid).replace(/\D/g, ''), 'characters');
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'character';
const safeId = (id) => String(id).replace(/[^a-z0-9-]/gi, '').slice(0, 40);

export function listCharacters(gid) {
  const dir = charDir(gid);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    try { return { id: f.slice(0, -5), ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}
export function getCharacter(gid, id) {
  try { return { id: safeId(id), ...JSON.parse(fs.readFileSync(path.join(charDir(gid), `${safeId(id)}.json`), 'utf8')) }; } catch { return null; }
}
// The player's own character, or one found by (part of) its name.
export function findCharacter(gid, { userId, name } = {}) {
  const all = listCharacters(gid);
  if (name) {
    const n = name.toLowerCase();
    return all.find((c) => c.name.toLowerCase() === n) || all.find((c) => c.name.toLowerCase().includes(n)) || all.find((c) => c.player.toLowerCase() === n) || null;
  }
  return all.find((c) => c.playerId === userId) || null;
}
export function saveCharacter(gid, character, { by = '', change = 'saved' } = {}) {
  const c = normalize(character);
  if (!c.name) throw new Error('The character needs a name.');
  const id = safeId(character.id || c.playerId || slug(c.name));
  fs.mkdirSync(charDir(gid), { recursive: true });
  const { id: _drop, ...body } = { ...c, updatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(charDir(gid), `${id}.json`), JSON.stringify(body, null, 2));
  fs.appendFileSync(path.join(charDir(gid), 'history.jsonl'), JSON.stringify({ at: body.updatedAt, id, name: c.name, by, change }) + '\n');
  return { id, ...body };
}
export function deleteCharacter(gid, id, { by = '' } = {}) {
  const file = path.join(charDir(gid), `${safeId(id)}.json`);
  if (!fs.existsSync(file)) return false;
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.rmSync(file);
  fs.appendFileSync(path.join(charDir(gid), 'history.jsonl'), JSON.stringify({ at: new Date().toISOString(), id: safeId(id), name: c.name, by, change: 'deleted' }) + '\n');
  return true;
}
export function characterHistory(gid, id, limit = 30) {
  try {
    return fs.readFileSync(path.join(charDir(gid), 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      .filter((h) => !id || h.id === safeId(id)).slice(-limit).reverse();
  } catch { return []; }
}

// ---------- reading PDFs ----------
// Same pdf.js setup as the rulebook library. Returns the document; .done() frees it.
async function openPdfjs(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const base = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf), verbosity: 0,
    cMapUrl: path.join(base, 'cmaps').replace(/\\/g, '/') + '/', cMapPacked: true,
    standardFontDataUrl: path.join(base, 'standard_fonts').replace(/\\/g, '/') + '/',
    wasmUrl: path.join(base, 'wasm').replace(/\\/g, '/') + '/',
    isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
  });
  const doc = await task.promise;
  doc.done = () => task.destroy();
  return doc;
}

// Every form box: name, type, page, position, current value, and the printed words nearest to it (its label).
export async function readFormBoxes(buf) {
  const doc = await openPdfjs(buf);
  const boxes = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const annots = (await page.getAnnotations()).filter((a) => a.subtype === 'Widget' && a.fieldName);
      if (!annots.length) continue;
      const text = (await page.getTextContent()).items.filter((t) => t.str && t.str.trim())
        .map((t) => ({ s: t.str.trim(), x: t.transform[4], y: t.transform[5], w: t.width || 0 }));
      for (const a of annots) {
        const [x1, y1, x2, y2] = a.rect;
        const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
        // Labels sit under, above or to the left of a box on most sheets.
        // Distance from the box's edge to the text's edge; text on the same line to the left, or just under/over, is closest.
        const near = text.map((t) => {
          const dx = Math.max(0, x1 - (t.x + t.w), t.x - x2);
          const dy = Math.max(0, y1 - (t.y + 8), t.y - y2);
          const sameLine = t.y >= y1 - 4 && t.y <= y2 + 2;
          return { s: t.s, d: sameLine ? dx * 0.3 : Math.hypot(dx, dy * 1.5) + 3 };
        }).filter((t) => t.d < 60).sort((p1, p2) => p1.d - p2.d).slice(0, 3).map((t) => t.s);
        const value = a.checkBox || a.radioButton ? (a.fieldValue && a.fieldValue !== 'Off' ? true : false)
          : Array.isArray(a.fieldValue) ? a.fieldValue.join(', ') : (a.fieldValue ?? '');
        boxes.push({
          name: a.fieldName, type: a.checkBox ? 'checkbox' : a.radioButton ? 'radio' : a.fieldType === 'Ch' ? 'choice' : 'text',
          multiline: Boolean(a.multiLine), page: p, x: Math.round(cx), y: Math.round(cy), w: Math.round(x2 - x1), h: Math.round(y2 - y1),
          value, label: near.join(' / '),
        });
      }
    }
  } finally { await doc.done(); }
  // One entry per field (a field can have several widgets, e.g. radio buttons).
  const seen = new Map();
  for (const b of boxes) if (!seen.has(b.name) || (b.value && !seen.get(b.name).value)) seen.set(b.name, b);
  return [...seen.values()];
}

export async function readPdfText(buf, maxChars = 40_000) {
  const doc = await openPdfjs(buf);
  let out = '';
  try {
    for (let p = 1; p <= doc.numPages && out.length < maxChars; p++) {
      const page = await doc.getPage(p);
      const items = (await page.getTextContent()).items;
      let line = '', lastY = null;
      for (const t of items) {
        const y = Math.round(t.transform[5]);
        if (lastY != null && Math.abs(y - lastY) > 3) { out += line.trim() + '\n'; line = ''; }
        line += t.str + ' ';
        lastY = y;
      }
      out += line.trim() + `\n--- page ${p} ---\n`;
    }
  } finally { await doc.done(); }
  return out.slice(0, maxChars);
}

// ---------- templates (blank sheets) ----------
export function listTemplates() {
  return fs.readdirSync(SHEETS_DIR).filter((f) => /\.pdf$/i.test(f)).map((f) => {
    const name = f.replace(/\.pdf$/i, '');
    let map = null;
    try { map = JSON.parse(fs.readFileSync(path.join(SHEETS_DIR, `${name}.map.json`), 'utf8')); } catch { /* not mapped yet */ }
    return {
      name, file: f,
      mapped: Boolean(map), boxes: map ? map.boxes.length : null,
      matched: map ? map.boxes.filter((b) => b.key).length : null, mappedBy: map?.by || null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
export const templateFile = (name) => path.join(SHEETS_DIR, `${path.basename(String(name)).replace(/\.pdf$/i, '')}.pdf`);
const mapFile = (name) => path.join(SHEETS_DIR, `${path.basename(String(name)).replace(/\.pdf$/i, '')}.map.json`);
export function readTemplateMap(name) {
  try { return JSON.parse(fs.readFileSync(mapFile(name), 'utf8')); } catch { return null; }
}
export function saveTemplateMap(name, map) {
  if (!fs.existsSync(templateFile(name))) throw new Error('No such sheet.');
  for (const b of map.boxes) if (b.key && !isKey(b.key)) b.key = null;
  fs.writeFileSync(mapFile(name), JSON.stringify(map, null, 2));
}
export async function addTemplate(name, buf) {
  const clean = path.basename(String(name)).replace(/\.pdf$/i, '').replace(/[^\w .()&-]+/g, '').trim().slice(0, 60) || 'Sheet';
  const boxes = await readFormBoxes(buf);
  if (!boxes.length) throw new Error('That PDF has no fillable boxes (saving a sheet with "Print to PDF" flattens them). Use the fillable version of the sheet, straight from where you downloaded it.');
  fs.writeFileSync(templateFile(clean), buf);
  fs.rmSync(mapFile(clean), { force: true });
  return { name: clean, boxes: boxes.length };
}
export function removeTemplate(name) {
  fs.rmSync(templateFile(name), { force: true });
  fs.rmSync(mapFile(name), { force: true });
}

// Matches each box of a blank sheet to a key, using the box names and the labels printed next to them.
// Known names are matched right away; the AI does the rest, a page's worth at a time.
const NAME_HINTS = [
  [/^(character\s*name|charname|name)$/i, 'name'], [/player\s*name/i, 'player'], [/class\s*&?\s*level|classlevel/i, 'class_level'],
  [/^race|species/i, 'species'], [/^background$/i, 'background'], [/alignment/i, 'alignment'], [/^(xp|experience)/i, 'xp'],
  [/^str(ength)?(\s*score)?$/i, 'str'], [/^dex(terity)?(\s*score)?$/i, 'dex'], [/^con(stitution)?(\s*score)?$/i, 'con'],
  [/^int(elligence)?(\s*score)?$/i, 'int'], [/^wis(dom)?(\s*score)?$/i, 'wis'], [/^cha(risma)?(\s*score)?$/i, 'cha'],
  [/^str\s*mod/i, 'str_mod'], [/^dex\s*mod/i, 'dex_mod'], [/^con\s*mod/i, 'con_mod'], [/^int\s*mod/i, 'int_mod'], [/^wis\s*mod/i, 'wis_mod'], [/^cha\s*mod/i, 'cha_mod'],
  [/prof(iciency)?\s*bonus/i, 'prof_bonus'], [/^inspiration$/i, 'inspiration'], [/^(ac|armor\s*class)$/i, 'ac'], [/^initiative$/i, 'initiative'],
  [/^speed$/i, 'speed'], [/hp\s*max|max\s*hp/i, 'hp_max'], [/hp\s*current|current\s*hp/i, 'hp_current'], [/hp\s*temp|temp\s*hp/i, 'hp_temp'],
  [/^hd$|hit\s*dice$/i, 'hit_dice'], [/passive/i, 'passive_perception'], [/^cp$/i, 'cp'], [/^sp$/i, 'sp'], [/^ep$/i, 'ep'], [/^gp$/i, 'gp'], [/^pp$/i, 'pp'],
  [/^equipment$/i, 'equipment'], [/features\s*(and|&)?\s*traits/i, 'features'], [/proficienc.*lang/i, 'proficiencies'],
  [/personality\s*traits/i, 'traits'], [/^ideals$/i, 'ideals'], [/^bonds$/i, 'bonds'], [/^flaws$/i, 'flaws'], [/backstory/i, 'backstory'],
  [/spellcasting\s*class/i, 'spell_class'], [/spellcasting\s*ability/i, 'spell_ability'], [/spell\s*save\s*dc/i, 'spell_dc'], [/spell\s*atk|spell\s*attack/i, 'spell_attack'],
];
const guessByName = (n) => (NAME_HINTS.find(([re]) => re.test(n.trim())) || [])[1] || null;

export async function mapTemplate(name, askAI, { onProgress = () => {} } = {}) {
  const boxes = await readFormBoxes(fs.readFileSync(templateFile(name)));
  const result = new Map();
  const used = new Set();
  for (const b of boxes) {
    const k = guessByName(b.name);
    if (k && !used.has(k)) { result.set(b.name, k); used.add(k); }
  }
  const todo = boxes.filter((b) => !result.has(b.name));
  const SYSTEM = `You match the boxes of a blank D&D 5e character sheet (a fillable PDF form) to data keys.
For each box you get its form name, its type, its page and position (x from the left, y from the bottom), and the
words printed nearest to it on the page (usually its label). Reply with JSON: {"<box name>": "<key>" or null, ...}
for EVERY box listed. Use only these keys (null when no key fits, e.g. decorative or unused boxes; each key once at most):
${KEY_GUIDE}
Hints: a checkbox next to a saving throw or skill is its _prof key. On a spell page, boxes run from cantrips (level 0)
through level 9; number each level's spell lines top to bottom (spell_1_1, spell_1_2, ...). A box whose position sits
right after the box for the same row (e.g. the attack table) belongs to that row.`;
  const chunks = [];
  for (let i = 0; i < todo.length; i += 45) chunks.push(todo.slice(i, i + 45));
  let done = 0;
  for (const chunk of chunks) {
    const list = chunk.map((b) => `${JSON.stringify(b.name)} [${b.type}${b.multiline ? ', big' : ''}, page ${b.page}, x ${b.x}, y ${b.y}]${b.label ? ` near: ${b.label}` : ''}`).join('\n');
    const already = [...result.entries()].map(([n, k]) => `${n} = ${k}`).slice(0, 200).join(', ');
    try {
      const raw = await askAI(SYSTEM, `Already matched (don't reuse these keys): ${already || 'none'}\n\nBOXES:\n${list}`, 3000, { json: true });
      const m = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      for (const b of chunk) {
        const k = m[b.name];
        if (typeof k === 'string' && isKey(k) && !used.has(k)) { result.set(b.name, k); used.add(k); }
      }
    } catch (err) {
      console.error(`[sheets] matching boxes on ${name} (part ${done + 1}):`, err.message);
    }
    onProgress(++done, chunks.length);
  }
  const map = {
    by: 'ai', at: new Date().toISOString(),
    boxes: boxes.map((b) => ({ name: b.name, type: b.type, page: b.page, label: b.label, key: result.get(b.name) || null })),
  };
  saveTemplateMap(name, map);
  return map;
}

// ---------- filling a sheet ----------
export async function fillSheet(name, character) {
  const map = readTemplateMap(name);
  if (!map) throw new Error(`The "${name}" sheet hasn't been set up yet (Library → Character sheets → Match boxes).`);
  const pdf = await PDFDocument.load(fs.readFileSync(templateFile(name)), { ignoreEncryption: true });
  const form = pdf.getForm();
  const values = fillValues(normalize(character));
  for (const b of map.boxes) {
    if (!b.key) continue;
    const v = values[b.key];
    if (v == null || v === '') continue;
    let f;
    try { f = form.getField(b.name); } catch { continue; }
    try {
      if (f instanceof PDFCheckBox) { if (v === true) f.check(); else f.uncheck(); }
      else if (f instanceof PDFTextField) {
        const text = String(v === true ? 'X' : v === false ? '' : v);
        const max = f.getMaxLength();
        if (!f.isMultiline() && text.includes('\n')) f.enableMultiline();
        f.setText(max ? text.slice(0, max) : text);
      } else if (f instanceof PDFDropdown) {
        const opt = f.getOptions().find((o) => o.toLowerCase() === String(v).toLowerCase());
        if (opt) f.select(opt); else if (f.isEditable()) f.select(String(v));
      } else if (f instanceof PDFRadioGroup) {
        if (v === true && f.getOptions()[0]) f.select(f.getOptions()[0]);
      }
    } catch (err) {
      console.error(`[sheets] box ${b.name}:`, err.message);
    }
  }
  return Buffer.from(await pdf.save({ updateFieldAppearances: true }));
}

// ---------- importing a filled sheet ----------
const EXTRACT_SYSTEM = `You read a D&D 5e character sheet and write the character as JSON. Copy what the sheet says; don't invent
anything. Leave a field empty (or out) when the sheet doesn't say. Reply with JSON only, in this shape:
{"name":"","player":"","edition":"2014 or 2024 if you can tell","classes":[{"name":"","subclass":"","level":1}],"species":"","background":"","alignment":"","xp":0,
"abilities":{"str":10,"dex":10,"con":10,"int":10,"wis":10,"cha":10},
"saves":{"str":{"prof":false},...},"skills":{"stealth":{"prof":true,"expertise":false},...},
"profBonus":2,"ac":10,"initiative":0,"speed":"30 ft","hp":{"max":0,"current":0,"temp":0},"hitDice":"1d8",
"attacks":[{"name":"","bonus":"+5","damage":"1d8+3 slashing"}],
"spellcasting":{"class":"","ability":"int|wis|cha","slots":{"1":{"max":2,"used":0}},"spells":[{"name":"","level":0,"prepared":false}]},
"inventory":[{"name":"","qty":1,"notes":""}],"money":{"cp":0,"sp":0,"ep":0,"gp":0,"pp":0},
"features":[{"name":"","text":"short"}],"proficiencies":"armor, weapons, tools","languages":"",
"personality":{"traits":"","ideals":"","bonds":"","flaws":""},"appearance":"","backstory":"short","notes":""}
Skill keys: ${Object.keys(SKILLS).join(', ')}. Ability scores are the big numbers (3-20), not the modifiers.
A skill or save is proficient when its box is checked or its bonus = modifier + proficiency bonus.
Keep feature and backstory text short (a sentence each).`;

// Returns { character, how } where how says which way it was read. Throws if nothing usable was found.
export async function importSheet(buf, askAI, { log = () => {} } = {}) {
  let boxes = [];
  try { boxes = await readFormBoxes(buf); } catch (err) { log(`[sheets] form read failed: ${err.message}`); }
  const filled = boxes.filter((b) => b.value !== '' && b.value !== false && b.value != null);

  // 1) The same form as one of our templates (e.g. a filled official sheet): read box by box, no AI needed.
  if (filled.length >= 8) {
    const names = new Set(boxes.map((b) => b.name));
    for (const t of listTemplates().filter((x) => x.mapped)) {
      const map = readTemplateMap(t.name);
      const overlap = map.boxes.filter((b) => names.has(b.name)).length / map.boxes.length;
      if (overlap < 0.85) continue;
      const v = {};
      const byName = new Map(boxes.map((b) => [b.name, b.value]));
      for (const b of map.boxes) if (b.key && byName.has(b.name)) v[b.key] = byName.get(b.name);
      const c = fromValues(v);
      if (c.name) return { character: c, how: `boxes of the "${t.name}" sheet` };
    }
  }

  // 2) A filled form we don't know (e.g. a D&D Beyond export): the AI reads the boxes with their labels.
  // 3) No boxes (a scan or a flattened PDF): the AI reads the page text.
  let source, how;
  if (filled.length >= 8) {
    source = filled.map((b) => `${b.label ? `${b.label} | ` : ''}${b.name}: ${b.value === true ? '[checked]' : String(b.value).replace(/\s+/g, ' ').slice(0, 600)}`).join('\n');
    how = 'its filled-in boxes (read by the AI)';
  } else {
    source = await readPdfText(buf);
    how = 'its text (read by the AI)';
  }
  if (source.replace(/\s/g, '').length < 80) throw new Error('I couldn\'t find any writing in that PDF. If it\'s a photo or scan, export it from D&D Beyond or type it into a fillable sheet.');
  const raw = await askAI(EXTRACT_SYSTEM, `CHARACTER SHEET:\n${source.slice(0, 30_000)}`, 4000, { json: true });
  let parsed;
  try { parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { throw new Error('The AI couldn\'t read that sheet. Try again, or try a different export.'); }
  const character = normalize(parsed);
  if (!character.name) throw new Error('I couldn\'t find the character\'s name on that sheet.');
  return { character, how };
}

// ---------- reading it out ----------
export function sheetSummary(c0, { short = false } = {}) {
  const c = normalize(c0);
  const d = derived(c);
  const lines = [];
  lines.push(`**${c.name}**${c.player ? ` (${c.player})` : ''}`);
  lines.push([classLine(c), c.species, c.background].filter(Boolean).join(' · ') || '*class not set*');
  lines.push(`🛡️ AC ${c.ac ?? '?'} · ❤️ HP ${c.hp.current ?? c.hp.max ?? '?'}/${c.hp.max ?? '?'}${c.hp.temp ? ` (+${c.hp.temp} temp)` : ''} · 👟 ${c.speed || '?'} · ⚡ Init ${signed(d.initiative)} · Prof ${signed(d.pb)}`);
  lines.push(ABILITIES.map((a) => `${a.toUpperCase()} ${c.abilities[a] ?? '?'} (${c.abilities[a] == null ? '?' : signed(d.mod[a])})`).join(' · '));
  if (short) return lines.join('\n');
  const saves = ABILITIES.filter((a) => c.saves[a].prof).map((a) => `${ABILITY_NAMES[a]} ${signed(d.save[a])}`);
  if (saves.length) lines.push(`**Saves:** ${saves.join(', ')}`);
  const skills = Object.keys(SKILLS).filter((s) => c.skills[s].prof).map((s) => `${skillLabel(s)} ${signed(d.skill[s])}${c.skills[s].expertise ? '★' : ''}`);
  if (skills.length) lines.push(`**Skills:** ${skills.join(', ')} · Passive Perception ${d.passivePerception}`);
  if (c.attacks.length) lines.push(`**Attacks:** ${c.attacks.map((a) => `${a.name} ${a.bonus} (${a.damage})`).join('; ')}`);
  if (c.spellcasting.ability || c.spellcasting.spells.length) {
    const slots = Object.entries(c.spellcasting.slots).map(([l, s]) => `L${l} ${s.max - s.used}/${s.max}`).join(', ');
    const byLevel = {};
    for (const s of c.spellcasting.spells) (byLevel[s.level] ||= []).push(s.name);
    lines.push(`**Spells** (DC ${d.spellDC ?? '?'}, attack ${d.spellAttack == null ? '?' : signed(d.spellAttack)}${slots ? `, slots ${slots}` : ''}): ` +
      Object.entries(byLevel).map(([l, n]) => `${l === '0' ? 'Cantrips' : `L${l}`}: ${n.join(', ')}`).join(' · '));
  }
  const coins = ['pp', 'gp', 'ep', 'sp', 'cp'].filter((k) => c.money[k]).map((k) => `${c.money[k]} ${k}`).join(', ');
  if (c.inventory.length || coins) lines.push(`**Gear:** ${c.inventory.map((i) => (i.qty > 1 ? `${i.qty}× ${i.name}` : i.name)).join(', ')}${coins ? ` · 💰 ${coins}` : ''}`);
  if (c.features.length) lines.push(`**Features:** ${c.features.map((f) => f.name).join(', ')}`);
  return lines.join('\n');
}

// Everything on the sheet as plain text, for the AI to answer from.
export function sheetForAI(c0) {
  const c = normalize(c0);
  const d = derived(c);
  return [
    sheetSummary(c).replace(/\*\*/g, ''),
    `Saving throws: ${ABILITIES.map((a) => `${ABILITY_NAMES[a]} ${signed(d.save[a])}${c.saves[a].prof ? ' (proficient)' : ''}`).join(', ')}`,
    `Skills: ${Object.keys(SKILLS).map((s) => `${skillLabel(s)} ${signed(d.skill[s])}${c.skills[s].expertise ? ' (expertise)' : c.skills[s].prof ? ' (proficient)' : ''}`).join(', ')}`,
    c.features.length ? `Features: ${c.features.map((f) => (f.text ? `${f.name}: ${f.text}` : f.name)).join(' | ')}` : '',
    c.inventory.length ? `Inventory: ${c.inventory.map((i) => `${i.qty > 1 ? `${i.qty}× ` : ''}${i.name}${i.notes ? ` (${i.notes})` : ''}`).join(', ')}` : '',
    c.proficiencies ? `Proficiencies: ${c.proficiencies}` : '', c.languages ? `Languages: ${c.languages}` : '',
    c.hitDice ? `Hit dice: ${c.hitDice}` : '',
    Object.values(c.personality).some(Boolean) ? `Personality: ${Object.entries(c.personality).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(' | ')}` : '',
    c.backstory ? `Backstory: ${c.backstory}` : '', c.notes ? `Notes: ${c.notes}` : '',
  ].filter(Boolean).join('\n');
}

export const ASK_SYSTEM = `You answer a D&D player's question about their character, using ONLY the character sheet below.
Give the number or fact first, then at most one short sentence of how it's worked out. If the sheet doesn't say, say
so plainly and suggest checking with the GM. Don't make up rules or items. Plain text, no headings.`;
