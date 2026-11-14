// /sheet build: a step-by-step D&D character builder in Discord (only the player sees it). Every choice is a menu or
// a button; the numbers (HP, AC, attacks, saves, skills, spell slots, features by level) are worked out here.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} from 'discord.js';
import {
  CLASSES, SPECIES, BACKGROUNDS, ARMOR, WEAPONS, WEAPON_2024, ALL_SKILLS, ABILITY_LIST, spellSlots, asiLevels,
  FEATS, FIGHTING_STYLE_AT, PACKS, ADVENTURING_GEAR, KITS,
} from './rules5e.js';
import { normalize, skillLabel, ABILITY_NAMES, signed, mod, profBonusFor, sheetSummary, srdSpells } from './sheets.js';

const UP = (a) => a.toUpperCase();
const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
const POINT_COST = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };

// ---------- the math: choices → a character ----------
function speciesData(s) {
  const base = SPECIES[s.edition]?.[s.species];
  if (!base) return null;
  const sub = base.sub?.[s.subspecies] || {};
  return {
    asi: sub.replaceAsi ? {} : { ...(base.asi || {}), ...Object.fromEntries(Object.entries(sub.asi || {}).map(([k, v]) => [k, (base.asi?.[k] || 0) + v])) },
    pick: sub.pick || base.pick || null,
    speed: sub.speed || base.speed || 30,
    skills: [...(base.skills || []), ...(sub.skills || [])],
    anySkills: (base.anySkills || 0) + (sub.anySkills || 0),
    feats: (base.feats || 0) + (sub.feats || 0),
    traits: [...(base.traits || []), ...(sub.traits || [])],
    languages: base.languages || 'Common',
    extraLanguages: (base.extraLanguages || 0) + (sub.extraLanguages || 0),
    hpPerLevel: (base.hpPerLevel || 0) + (sub.hpPerLevel || 0),
    armor: sub.armor || '',
    size: ['Halfling', 'Gnome'].includes(s.species) ? 'Small' : 'Medium',
  };
}

// The spells a class can pick, by level (SRD lists), and the highest level it can cast at this character level.
export function classSpells(s, level) {
  return srdSpells(s.edition).filter((x) => x.l === level && x.c.includes(s.cls)).sort((a, b) => a.n.localeCompare(b.n));
}
export function maxSpellLevel(s) {
  const slots = Object.keys(spellSlots(s.cls, s.level, s.edition)).map(Number);
  return slots.length ? Math.max(...slots) : 0;
}
const castsSpells = (s) => Boolean(CLASSES[s.cls]?.ability) && (maxSpellLevel(s) > 0 || (CLASSES[s.cls].cantrips || [0])[0] > 0);
// Every feat this character picks: fighting style, species feat, ASIs taken as feats, a 2024 Epic Boon.
export function featSlots(s) {
  const out = [];
  const ed = s.edition;
  if (FIGHTING_STYLE_AT[s.cls] && s.level >= FIGHTING_STYLE_AT[s.cls]) out.push({ type: 'style', label: 'Fighting Style' });
  const sp = speciesData(s);
  for (let i = 0; i < (sp?.feats || 0); i++) out.push({ type: ed === '2024' ? 'origin' : 'general', label: ed === '2024' ? 'Human: Versatile (an origin feat)' : `${s.subspecies || s.species} feat` });
  const lv = asiLevels(s.cls, ed).filter((l) => l <= s.level);
  (s.asis || []).slice(0, lv.length).forEach((x, i) => { if (x?.kind === 'feat') out.push({ type: 'general', label: `Level ${lv[i]} feat` }); });
  if (ed === '2024' && s.level >= 19) out.push({ type: 'epic', label: 'Level 19 Epic Boon' });
  return out;
}
const featList = (s, type) => (FEATS[s.edition][type] || FEATS[s.edition].general);
const kitText = (k) => [k.armor && k.armor !== 'none' ? k.armor : '', k.shield ? 'shield' : '',
  ...k.weapons.map((w) => (k.qty?.[w] ? `${k.qty[w]} ${w.toLowerCase()}s` : w.toLowerCase())), ...(k.items || []).map((x) => x.toLowerCase()), k.pack].filter(Boolean).join(', ');
const spellDesc = (x) => [x.t, x.r, x.v.split('').join(', '), x.co && 'Concentration', x.ri && 'Ritual'].filter(Boolean).join(' · ');

export function finalScores(s) {
  const sp = speciesData(s) || { asi: {} };
  const out = Object.fromEntries(ABILITY_LIST.map((a) => [a, s.base?.[a] ?? 10]));
  for (const [a, v] of Object.entries(sp.asi || {})) out[a] += v;
  for (const a of s.speciesPick || []) out[a] += sp.pick?.amount || 1;
  if (s.edition === '2024' && s.bgBonus) for (const [a, v] of Object.entries(s.bgBonus)) out[a] += v;
  // Only as many increases as the class gets by this level (a changed level or class can leave extras behind).
  for (const x of (s.asis || []).slice(0, asiLevels(s.cls, s.edition).filter((l) => l <= s.level).length)) {
    if (x?.kind === 'two') out[x.a] += 2;
    else if (x?.kind === 'split') { out[x.a] += 1; out[x.b] += 1; }
  }
  for (const a of ABILITY_LIST) out[a] = Math.min(20, out[a]);
  return out;
}

function weaponProficient(cls, edition, name, group, props) {
  const w = (CLASSES[cls]?.weapons?.[edition] || '').toLowerCase();
  if (w.includes('simple') && group === 'simple') return true;
  if (/martial(?!\s*\()/.test(w) && group === 'martial') return true;
  if (group === 'martial' && /martial \(light\)/.test(w) && props.includes('l')) return true;
  if (group === 'martial' && /martial \(finesse or light\)/.test(w) && (props.includes('l') || props.includes('f'))) return true;
  return w.split(',').map((x) => x.trim()).includes(name.toLowerCase());
}

export function buildCharacter(s) {
  const c = CLASSES[s.cls];
  const ed = s.edition;
  const lvl = s.level;
  const sp = speciesData(s);
  const bg = BACKGROUNDS[ed]?.[s.background] || {};
  const sc = finalScores(s);
  const m = Object.fromEntries(ABILITY_LIST.map((a) => [a, mod(sc[a])]));
  const pb = profBonusFor(lvl);

  // Feats: background (2024), species, and any ASIs taken as feats; names typed by the player fill them in.
  const slots = featSlots(s);
  const pickedFeats = slots.map((sl, i) => ({ ...sl, name: (s.featPicks || [])[i] })).filter((x) => x.name);
  const style = pickedFeats.find((x) => x.type === 'style')?.name || '';
  const typedFeats = [...pickedFeats.filter((x) => x.type !== 'style').map((x) => x.name),
    ...String(s.feats || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean)];
  const hasFeat = (n) => typedFeats.some((f) => f.toLowerCase() === n.toLowerCase()) || (ed === '2024' && bg.feat === n);
  const tough = hasFeat('Tough');

  // HP: full hit die at level 1, then the average (rounded up) each level.
  const avg = c.hitDie / 2 + 1;
  const hp = Math.max(1, c.hitDie + m.con + (lvl - 1) * (avg + m.con) + (sp?.hpPerLevel || 0) * lvl + (tough ? 2 * lvl : 0));

  // Skills.
  const skills = {};
  const prof = new Set([...(bg.skills || []), ...(sp?.skills || []), ...(s.classSkills || []), ...(s.anySkills || [])]);
  for (const k of prof) skills[k] = { prof: true, expertise: (s.expertise || []).includes(k) };

  // AC.
  const armor = ARMOR[s.armor];
  let ac;
  if (armor) ac = armor.ac + (armor.type === 'light' ? m.dex : armor.type === 'medium' ? Math.min(2, m.dex) : 0);
  else if (c.unarmored === 'con') ac = 10 + m.dex + m.con;
  else if (c.unarmored === 'wis' && !s.shield) ac = 10 + m.dex + m.wis;
  else ac = 10 + m.dex;
  if (s.shield) ac += 2;
  if (style === 'Defense' && armor) ac += 1;

  // Speed.
  let speed = sp?.speed || 30;
  if (s.cls === 'Barbarian' && lvl >= 5 && armor?.type !== 'heavy') speed += 10;
  if (s.cls === 'Monk' && lvl >= 2 && !armor && !s.shield) speed += [0, 10, 15, 20, 25, 30][Math.min(5, Math.floor((lvl + 2) / 4))];

  // Attacks.
  const attacks = [];
  for (const name of s.weapons || []) {
    const group = WEAPONS.simple[name] ? 'simple' : 'martial';
    const [die, type, props] = (ed === '2024' && WEAPON_2024[name]) || WEAPONS[group][name];
    const ranged = props.includes('r');
    const monkWeapon = s.cls === 'Monk' && !ranged && ((group === 'simple' && !props.includes('2')) || (ed === '2014' ? name === 'Shortsword' : props.includes('l')));
    const abil = ranged ? 'dex' : (props.includes('f') || monkWeapon) ? (m.dex > m.str ? 'dex' : 'str') : 'str';
    const bonus = m[abil] + (weaponProficient(s.cls, ed, name, group, props) ? pb : 0) + (ranged && style === 'Archery' ? 2 : 0);
    const vers = props.match(/v(\d+d\d+)/);
    const notes = [props.includes('f') && 'Finesse', props.includes('l') && 'Light', props.includes('t') && 'Thrown', props.includes('2') && 'Two-handed',
      vers && `Versatile (${vers[1]})`, ranged && 'Ranged'].filter(Boolean).join(', ');
    attacks.push({ name, bonus: signed(bonus), damage: `${die}${m[abil] ? signed(m[abil]) : ''} ${type}`, notes });
  }

  // Spells.
  const spellcasting = { ability: c.ability || '', class: c.ability ? s.cls : '', slots: {}, spells: [] };
  for (const [l, n] of Object.entries(spellSlots(s.cls, lvl, ed))) spellcasting.slots[l] = { max: n, used: 0 };
  const parseSpells = (text, defLevel) => String(text || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean).map((x) => {
    const mm = x.match(/^(.+?)\s*\((?:level\s*)?(\d)\)$/i);
    return mm ? { name: mm[1].trim(), level: Number(mm[2]), prepared: true } : { name: x, level: defLevel, prepared: defLevel > 0 };
  });
  const picked = Object.entries(s.spellPicks || {}).map(([n, l]) => {
    const info = srdSpells(ed).find((x) => x.n === n) || {};
    return { name: n, level: l, prepared: l > 0, time: info.t || '', range: info.r || '' };
  });
  spellcasting.spells = [...picked, ...parseSpells(s.cantrips, 0), ...parseSpells(s.spells, 1)];

  // Features: species traits, background feature or feat, class features up to this level.
  const subName = s.subclass || '';
  const features = [];
  for (const t of sp?.traits || []) features.push({ name: t, text: `${s.subspecies || s.species} trait` });
  if (ed === '2014' && bg.feature) features.push({ name: bg.feature, text: `${s.background} background feature` });
  if (ed === '2024' && bg.feat) features.push({ name: bg.feat, text: `Origin feat (${s.background})` });
  const table = c.features[ed];
  let asiIdx = 0;
  for (let l = 1; l <= lvl; l++) {
    for (const f of table[l - 1] || []) {
      if (f === 'ASI') {
        const x = (s.asis || [])[asiIdx++];
        const what = !x ? 'Ability Score Improvement' : x.kind === 'two' ? `Ability Score Improvement (+2 ${UP(x.a)})`
          : x.kind === 'split' ? `Ability Score Improvement (+1 ${UP(x.a)}, +1 ${UP(x.b)})` : 'Feat';
        features.push({ name: what, text: `Level ${l}` });
        continue;
      }
      const label = c.sub[ed].label;
      let name = f;
      if (f === 'Fighting Style' && style) name = `Fighting Style: ${style}`;
      else if (f === 'Subclass feature') name = subName ? `${subName} feature` : `${label} feature`;
      else if (f === label && subName) name = `${label}: ${subName}`;
      else if (f === 'Sneak Attack') name = `Sneak Attack (${Math.ceil(lvl / 2)}d6)`;
      features.push({ name, text: `${s.cls} ${l}` });
    }
  }
  for (const f of typedFeats) features.push({ name: f, text: 'Feat' });

  // Proficiencies and languages.
  const profs = [`Armor: ${[c.armor, sp?.armor].filter((x) => x && x !== 'None').join(', ') || 'none'}`,
    `Weapons: ${c.weapons[ed]}`, [c.tools, bg.tools].filter(Boolean).length ? `Tools: ${[c.tools, bg.tools].filter(Boolean).join(', ')}` : ''].filter(Boolean).join('\n');
  const langExtra = ed === '2024' ? 2 : (sp?.extraLanguages || 0) + (bg.languages || 0);
  const languages = [ed === '2024' ? 'Common' : sp?.languages, c.languages, langExtra ? `+${langExtra} of your choice` : ''].filter(Boolean).join(', ');

  const qty = s.weaponQty || {};
  const inventory = [
    ...(s.armor && s.armor !== 'none' ? [{ name: s.armor, qty: 1 }] : []), ...(s.shield ? [{ name: 'Shield', qty: 1 }] : []),
    ...(s.weapons || []).map((w) => ({ name: w, qty: qty[w] || 1 })),
    ...(s.pack ? [{ name: s.pack, qty: 1, notes: PACKS[s.pack] }] : []),
    ...(s.kitItems || []).map((x) => ({ name: x, qty: 1 })),
    ...(s.items || []).map((x) => ({ name: x, qty: 1 })),
    ...String(s.gear || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean).map((x) => {
      const mm = x.match(/^(\d+)\s*[x×]?\s+(.+)$/i);
      return mm ? { name: mm[2], qty: Number(mm[1]) } : { name: x, qty: 1 };
    }),
  ];

  return normalize({
    name: s.name || 'Unnamed', player: s.player || '', playerId: s.playerId || '', edition: ed,
    classes: [{ name: s.cls, subclass: subName, level: lvl }],
    size: sp?.size || 'Medium',
    species: s.subspecies && s.subspecies !== s.species && !/lineage|legacy/.test(s.subspecies) ? s.subspecies : [s.species, /lineage|legacy/.test(s.subspecies || '') ? `(${s.subspecies})` : ''].filter(Boolean).join(' '),
    background: s.background, alignment: s.alignment || '', xp: null,
    abilities: sc, saves: Object.fromEntries(c.saves.map((a) => [a, { prof: true }])), skills,
    profBonus: pb, ac, speed: `${speed} ft`, initiative: hasFeat('Alert') ? m.dex + (ed === '2024' ? pb : 5) : null, hp: { max: hp, current: hp, temp: 0 }, hitDice: `${lvl}d${c.hitDie}`,
    attacks, spellcasting, inventory, money: { gp: s.gold == null ? 10 : Number(s.gold) || 0 },
    features, proficiencies: profs, languages,
    personality: { traits: s.traits || '', ideals: s.ideals || '', bonds: s.bonds || '', flaws: s.flaws || '' },
    backstory: s.backstory || '', appearance: '', notes: `Made with /sheet build (${ed} rules)`,
  });
}

// How many spells to pick, for the prompt.
export function spellCounts(s) {
  const c = CLASSES[s.cls];
  if (!c?.ability) return null;
  const lvl = s.level;
  const sc = finalScores(s);
  const m = mod(sc[c.ability]);
  const cantrips = c.cantrips ? c.cantrips[lvl < 4 ? 0 : lvl < 10 ? 1 : 2] : 0;
  let spells;
  if (s.edition === '2024') spells = c.spells24[lvl - 1];
  else if (c.prep[2014] === 'known') spells = c.spells14[lvl - 1];
  else spells = Math.max(1, m + (c.halfPrep14 ? Math.floor(lvl / 2) : lvl));
  const word = c.prep[s.edition] === 'known' ? 'known' : 'prepared';
  return { cantrips, spells, word, wizardBook: s.cls === 'Wizard' };
}

// ---------- the Discord side ----------
const sessions = new Map(); // user id → state
const TTL = 45 * 60_000;
const fresh = (userId, opts) => ({ userId, step: opts.edition ? 'class' : 'edition', at: Date.now(), asiPage: 0, ...opts });
const id = (...p) => ['sb', ...p].join('|');
const btn = (cid, label, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder().setCustomId(cid).setLabel(label).setStyle(style).setDisabled(disabled);
const select = (cid, placeholder, options, { min = 1, max = 1 } = {}) => new StringSelectMenuBuilder().setCustomId(cid).setPlaceholder(placeholder)
  .setMinValues(min).setMaxValues(Math.max(min, Math.min(max, options.length))).addOptions(options.slice(0, 25).map((o) => ({ ...o, label: String(o.label).slice(0, 100), value: String(o.value).slice(0, 100), description: o.description ? String(o.description).slice(0, 100) : undefined })));
const row = (...c) => new ActionRowBuilder().addComponents(...c);

function header(s) {
  const bits = [s.edition && `${s.edition} rules`, `level ${s.level}`, s.cls && `${s.cls}${s.subclass ? ` (${s.subclass})` : ''}`,
    s.species && (s.subspecies || s.species), s.background].filter(Boolean);
  return `🧙 **Character builder**: ${bits.join(' · ')}\n`;
}
const scoreLine = (sc) => ABILITY_LIST.map((a) => `${UP(a)} ${sc[a]} (${signed(mod(sc[a]))})`).join(' · ');

function fixedSkills(s) {
  const sp = speciesData(s);
  const bg = BACKGROUNDS[s.edition]?.[s.background] || {};
  return new Set([...(bg.skills || []), ...(sp?.skills || [])]);
}
function expertiseCount(s) {
  const e = CLASSES[s.cls]?.expertise?.[s.edition] || {};
  return Object.entries(e).filter(([l]) => Number(l) <= s.level).reduce((n, [, v]) => n + v, 0);
}
const asiCount = (s) => asiLevels(s.cls, s.edition).filter((l) => l <= s.level).length;

const STEPS = ['edition', 'class', 'species', 'background', 'method', 'assign', 'skills', 'expertise', 'asi', 'feats', 'gear', 'gear2', 'spells', 'details', 'review'];
function nextStep(s, from) {
  let i = STEPS.indexOf(from) + 1;
  while (i < STEPS.length) {
    const st = STEPS[i];
    if (st === 'expertise' && !expertiseCount(s)) { i++; continue; }
    if (st === 'asi' && !asiCount(s)) { i++; continue; }
    if (st === 'spells' && !castsSpells(s)) { i++; continue; }
    if (st === 'feats' && !featSlots(s).length) { i++; continue; }
    return st;
  }
  return 'review';
}

function view(s) {
  const c = CLASSES[s.cls];
  const ed = s.edition;
  const rows = [];
  let text = header(s);
  const nav = (ok, label = 'Next →') => row(btn(id('next', s.step), label, ButtonStyle.Primary, !ok), btn(id('cancel'), 'Cancel', ButtonStyle.Danger));

  if (s.step === 'edition') {
    text += 'Which rules does your table use?';
    rows.push(row(btn(id('ed', '2014'), '2014 Player\'s Handbook', ButtonStyle.Primary), btn(id('ed', '2024'), '2024 Player\'s Handbook', ButtonStyle.Primary), btn(id('cancel'), 'Cancel', ButtonStyle.Danger)));
  } else if (s.step === 'class') {
    text += 'Pick a **class**.';
    rows.push(row(select(id('pick', 'cls'), s.cls || 'Class', Object.keys(CLASSES).map((k) => ({ label: k, value: k, description: `d${CLASSES[k].hitDie} hit die · saves ${CLASSES[k].saves.map(UP).join(', ')}`, default: s.cls === k })))));
    const sub = s.cls && c.sub[ed];
    if (sub && s.level >= sub.at) {
      text += ` Then a **${sub.label}** (you get it at level ${sub.at}).`;
      rows.push(row(select(id('pick', 'subclass'), s.subclass || sub.label, sub.list.map((x) => ({ label: x, value: x, default: s.subclass === x })))));
    }
    rows.push(nav(s.cls && (!sub || s.level < sub.at || s.subclass)));
  } else if (s.step === 'species') {
    const list = SPECIES[ed];
    text += `Pick a **${ed === '2014' ? 'race' : 'species'}**.`;
    rows.push(row(select(id('pick', 'species'), s.species || 'Species', Object.keys(list).map((k) => ({
      label: k, value: k, default: s.species === k,
      description: ed === '2014' ? `${Object.entries(list[k].asi || {}).map(([a, v]) => `+${v} ${UP(a)}`).join(' ')}${list[k].pick ? ` +1 to ${list[k].pick.n} more` : ''} · speed ${list[k].speed}` : `speed ${list[k].speed} · ${list[k].traits.slice(0, 3).join(', ')}`,
    })))));
    const subs = s.species && list[s.species].sub;
    if (subs) rows.push(row(select(id('pick', 'subspecies'), s.subspecies || (ed === '2014' ? 'Subrace' : 'Lineage / legacy'), Object.keys(subs).map((k) => ({
      label: k, value: k, default: s.subspecies === k, description: Object.entries(subs[k].asi || {}).map(([a, v]) => `+${v} ${UP(a)}`).join(' ') || undefined,
    })))));
    const sp = s.species && (!subs || s.subspecies) ? speciesData(s) : null;
    if (sp?.pick) {
      const exclude = new Set(Object.keys(sp.asi || {}).filter(() => s.species === 'Half-Elf'));
      const opts = ABILITY_LIST.filter((a) => !exclude.has(a)).map((a) => ({ label: `+${sp.pick.amount} ${ABILITY_NAMES[a]}`, value: a, default: (s.speciesPick || []).includes(a) }));
      text += ` Also pick **${sp.pick.n} abilities** to raise by ${sp.pick.amount}.`;
      rows.push(row(select(id('multi', 'speciesPick'), `Raise ${sp.pick.n} abilities`, opts, { min: sp.pick.n, max: sp.pick.n })));
    }
    rows.push(nav(sp && (!sp.pick || (s.speciesPick || []).length === sp.pick.n)));
  } else if (s.step === 'background') {
    const list = BACKGROUNDS[ed];
    text += 'Pick a **background**.';
    rows.push(row(select(id('pick', 'background'), s.background || 'Background', Object.keys(list).map((k) => ({
      label: k, value: k, default: s.background === k,
      description: `${list[k].skills.map(skillLabel).join(', ')}${ed === '2024' ? ` · ${list[k].feat} · ${list[k].abilities.map(UP).join('/')}` : ` · ${list[k].feature}`}`,
    })))));
    let ok = Boolean(s.background);
    if (ed === '2024' && s.background) {
      const [a, b, cc] = list[s.background].abilities;
      const combos = [[a, b], [a, cc], [b, a], [b, cc], [cc, a], [cc, b]].map(([x, y]) => ({ label: `+2 ${UP(x)}, +1 ${UP(y)}`, value: `${x}:2,${y}:1` }));
      combos.push({ label: `+1 ${UP(a)}, +1 ${UP(b)}, +1 ${UP(cc)}`, value: `${a}:1,${b}:1,${cc}:1` });
      const cur = s.bgBonus ? Object.entries(s.bgBonus).map(([k, v]) => `${k}:${v}`).join(',') : '';
      text += ' Then how its **ability scores** go up.';
      rows.push(row(select(id('pick', 'bgBonus'), 'Ability increases from your background', combos.map((o) => ({ ...o, default: o.value === cur })))));
      ok = ok && Boolean(s.bgBonus);
    }
    rows.push(nav(ok));
  } else if (s.step === 'method') {
    text += 'How do you want to get your **ability scores**?\n• **Standard array**: 15, 14, 13, 12, 10, 8\n• **Point buy**: 27 points, scores 8–15\n• **Roll**: I roll 4d6 (drop the lowest) six times for you\n• **Enter my own**: you already rolled at the table';
    rows.push(row(btn(id('method', 'array'), 'Standard array', ButtonStyle.Primary), btn(id('method', 'pointbuy'), 'Point buy', ButtonStyle.Primary),
      btn(id('method', 'roll'), '🎲 Roll', ButtonStyle.Primary), btn(id('method', 'own'), 'Enter my own', ButtonStyle.Primary)));
    rows.push(row(btn(id('cancel'), 'Cancel', ButtonStyle.Danger)));
  } else if (s.step === 'assign') {
    const i = s.assignIdx;
    const a = ABILITY_LIST[i];
    const done = ABILITY_LIST.slice(0, i).map((x) => `${UP(x)} **${s.base[x]}**`).join(' · ');
    text += `${s.method === 'roll' ? `🎲 You rolled: **${s.pool.join(', ')}**\n` : ''}${done ? `${done}\n` : ''}`;
    let opts;
    if (s.method === 'array' || s.method === 'roll') {
      const used = ABILITY_LIST.slice(0, i).map((x) => s.base[x]);
      const left = [...s.pool];
      for (const u of used) left.splice(left.indexOf(u), 1);
      opts = [...new Set(left)].sort((x, y) => y - x).map((v) => ({ label: String(v), value: String(v) }));
    } else if (s.method === 'pointbuy') {
      const spent = ABILITY_LIST.slice(0, i).reduce((n, x) => n + POINT_COST[s.base[x]], 0);
      const reserve = 0; // the rest can always stay at 8 (free)
      const left = 27 - spent - reserve;
      text += `Points left: **${left}** of 27.\n`;
      opts = Object.entries(POINT_COST).filter(([, cost]) => cost <= left).map(([v, cost]) => ({ label: `${v} (costs ${cost})`, value: v }));
    } else {
      opts = Array.from({ length: 18 }, (_, k) => 20 - k).map((v) => ({ label: String(v), value: String(v) }));
    }
    text += `Score for **${ABILITY_NAMES[a]}**${CLASSES[s.cls].saves.includes(a) ? ' (a saving throw of your class)' : ''}${CLASSES[s.cls].ability === a ? ' (your spellcasting ability)' : ''}:`;
    rows.push(row(select(id('score', a), ABILITY_NAMES[a], opts)));
    rows.push(row(btn(id('method', 'back'), '← Change method'), btn(id('cancel'), 'Cancel', ButtonStyle.Danger)));
  } else if (s.step === 'skills') {
    const fixed = fixedSkills(s);
    const sp = speciesData(s);
    text += `Your scores: ${scoreLine(finalScores(s))}\n`;
    text += `Already proficient: ${[...fixed].map(skillLabel).join(', ') || 'none'}.\nPick **${c.skills.n} class skills**${sp.anySkills ? ` and **${sp.anySkills} more of any kind** (from your ${ed === '2014' ? 'race' : 'species'})` : ''}.`;
    rows.push(row(select(id('multi', 'classSkills'), `${c.skills.n} ${s.cls} skills`, c.skills.from.filter((k) => !fixed.has(k)).map((k) => ({ label: skillLabel(k), value: k, default: (s.classSkills || []).includes(k) })), { min: c.skills.n, max: c.skills.n })));
    if (sp.anySkills) rows.push(row(select(id('multi', 'anySkills'), `${sp.anySkills} skill${sp.anySkills > 1 ? 's' : ''} of any kind`, ALL_SKILLS.filter((k) => !fixed.has(k)).map((k) => ({ label: skillLabel(k), value: k, default: (s.anySkills || []).includes(k) })), { min: sp.anySkills, max: sp.anySkills })));
    const clash = (s.classSkills || []).some((k) => (s.anySkills || []).includes(k));
    if (clash) text += '\n⚠️ You picked the same skill twice; change one.';
    rows.push(nav((s.classSkills || []).length === c.skills.n && (s.anySkills || []).length === sp.anySkills && !clash));
  } else if (s.step === 'expertise') {
    const n = expertiseCount(s);
    const profs = [...new Set([...fixedSkills(s), ...(s.classSkills || []), ...(s.anySkills || [])])];
    text += `**Expertise**: pick ${n} of your skills to double your proficiency bonus.`;
    rows.push(row(select(id('multi', 'expertise'), `${n} skills`, profs.map((k) => ({ label: skillLabel(k), value: k, default: (s.expertise || []).includes(k) })), { min: n, max: n })));
    rows.push(nav((s.expertise || []).length === n));
  } else if (s.step === 'asi') {
    const lv = asiLevels(s.cls, ed).filter((l) => l <= s.level);
    const page = s.asiPage || 0;
    const shown = lv.slice(page * 4, page * 4 + 4);
    text += `Your scores so far: ${scoreLine(finalScores(s))}\nFor each **Ability Score Improvement**, raise one score by 2, two scores by 1, or take a feat (you'll name it at the end).`;
    const opts = [...ABILITY_LIST.map((a) => ({ label: `+2 ${ABILITY_NAMES[a]}`, value: `two:${a}` })),
      ...ABILITY_LIST.flatMap((a, i) => ABILITY_LIST.slice(i + 1).map((b) => ({ label: `+1 ${UP(a)}, +1 ${UP(b)}`, value: `split:${a}:${b}` }))),
      { label: 'A feat instead', value: 'feat' }];
    const cur = (x) => (!x ? '' : x.kind === 'two' ? `two:${x.a}` : x.kind === 'split' ? `split:${x.a}:${x.b}` : 'feat');
    shown.forEach((l, k) => {
      const idx = page * 4 + k;
      rows.push(row(select(id('asi', String(idx)), `Level ${l}`, opts.map((o) => ({ ...o, default: o.value === cur((s.asis || [])[idx]) })))));
    });
    const more = lv.length > (page + 1) * 4;
    const allSet = lv.every((_, idx) => (s.asis || [])[idx]);
    rows.push(more ? row(btn(id('asipage', String(page + 1)), 'More →', ButtonStyle.Primary), btn(id('cancel'), 'Cancel', ButtonStyle.Danger)) : nav(allSet));
  } else if (s.step === 'gear') {
    const kits = KITS[s.cls] || [];
    if (s.kit !== 'custom') {
      text += '🎒 **Starting gear.** Pick a ready-made kit, or build your own.';
      const k = kits[Number(s.kit)];
      if (k) text += `\n**${k.name}:** ${kitText(k)}`;
      rows.push(row(select(id('kit'), k ? k.name : 'Starting kit', [...kits.map((x, i) => ({ label: `${s.cls}: ${x.name}`, value: String(i), description: kitText(x).slice(0, 100), default: s.kit === String(i) })),
        { label: '🛠 Build my own', value: 'custom', description: 'Choose armor, shield and weapons yourself' }])));
      rows.push(nav(Boolean(k)));
    } else {
      text += '🛠 **Build your own:** armor and weapons. (Packs and other gear come next.)';
      rows.push(row(select(id('pick', 'armor'), s.armor ? s.armor : 'Armor', [{ label: 'No armor', value: 'none', description: c.unarmored ? 'Your class has Unarmored Defense' : undefined, default: s.armor === 'none' },
        ...Object.entries(ARMOR).map(([k, v]) => ({ label: k, value: k, description: `${v.type}, AC ${v.ac}${v.type === 'light' ? ' + Dex' : v.type === 'medium' ? ' + Dex (max 2)' : ''}`, default: s.armor === k }))])));
      rows.push(row(select(id('pick', 'shield'), s.shield ? 'Shield (+2 AC)' : 'Shield?', [{ label: 'No shield', value: 'no', default: s.shield === false }, { label: 'Shield (+2 AC)', value: 'yes', default: s.shield === true }])));
      const wopts = (group) => Object.entries(WEAPONS[group]).map(([k, [d, t, p]]) => {
        const [dd, tt] = (ed === '2024' && WEAPON_2024[k]) || [d, t];
        return { label: k, value: k, description: `${dd} ${tt}${p.includes('f') ? ', finesse' : ''}${p.includes('r') ? ', ranged' : ''}${p.includes('2') ? ', two-handed' : ''}`, default: (s.weapons || []).includes(k) };
      });
      rows.push(row(select(id('weap', 'simple'), 'Simple weapons (up to 3)', wopts('simple'), { min: 0, max: 3 })));
      rows.push(row(select(id('weap', 'martial'), 'Martial weapons (up to 3)', wopts('martial'), { min: 0, max: 3 })));
      rows.push(row(btn(id('next', s.step), 'Next →', ButtonStyle.Primary, !(s.armor && s.shield !== undefined)), btn(id('kit', 'pick'), '↩ Use a kit instead'), btn(id('cancel'), 'Cancel', ButtonStyle.Danger)));
    }
  } else if (s.step === 'gear2') {
    const extra = [s.pack, ...(s.kitItems || []), ...(s.items || []), ...String(s.gear || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean)].filter(Boolean);
    text += `🎒 **Pack and extra gear.**${extra.length ? `\nSo far: ${extra.join(', ')}` : ''}\n💰 Gold: **${s.gold == null ? 10 : s.gold} gp** (change it with ✍️)`;
    rows.push(row(select(id('pick', 'pack'), s.pack || 'Equipment pack', [{ label: 'No pack', value: 'none', default: !s.pack },
      ...Object.entries(PACKS).map(([k, v]) => ({ label: k, value: k, description: v.slice(0, 100), default: s.pack === k }))])));
    rows.push(row(select(id('multi', 'items'), 'Adventuring gear (pick any)', ADVENTURING_GEAR.map((x) => ({ label: x, value: x, default: (s.items || []).includes(x) })), { min: 0, max: ADVENTURING_GEAR.length })));
    rows.push(row(btn(id('modal', 'gear'), '✍️ Other items & gold'), btn(id('next', s.step), 'Next →', ButtonStyle.Primary), btn(id('cancel'), 'Cancel', ButtonStyle.Danger)));
  } else if (s.step === 'feats') {
    const slots = featSlots(s);
    const i = Math.min(s.featIdx || 0, slots.length);
    const picks = s.featPicks || [];
    const done = slots.map((sl, k) => `${k === i ? '▶ ' : ''}${sl.label}: **${picks[k] || '…'}**`).join('\n');
    if (i < slots.length) {
      const sl = slots[i];
      const list = featList(s, sl.type);
      text += `⭐ **${sl.type === 'style' ? 'Fighting Style' : 'Feats'}** (${i + 1} of ${slots.length})\n${done}`;
      for (let g = 0; g * 25 < list.length && g < 3; g++) {
        const part = list.slice(g * 25, g * 25 + 25);
        rows.push(row(select(id('feat', String(i), String(g)), list.length > 25 ? `${part[0][0]}–${part[part.length - 1][0]}` : sl.label,
          part.map((n) => ({ label: n, value: n, default: picks[i] === n })))));
      }
      rows.push(row(btn(id('modal', `feat${i}`), '✍️ From another book'), btn(id('featidx', String(i + 1)), picks[i] ? 'Next ▶' : 'Skip for now'),
        btn(id('featidx', String(Math.max(0, i - 1))), '◀ Back', ButtonStyle.Secondary, i === 0), btn(id('cancel'), 'Cancel', ButtonStyle.Danger)));
    } else {
      text += `⭐ **Feats**\n${done}`;
      rows.push(row(btn(id('featidx', '0'), 'Change feats'), btn(id('next', s.step), 'Next →', ButtonStyle.Primary), btn(id('cancel'), 'Cancel', ButtonStyle.Danger)));
    }
  } else if (s.step === 'spells') {
    const sc = spellCounts(s);
    const maxL = maxSpellLevel(s);
    const picks = s.spellPicks || {};
    const nC = Object.values(picks).filter((l) => l === 0).length;
    const nS = Object.values(picks).filter((l) => l > 0).length;
    const lv = s.spellLevel ?? (sc.cantrips ? 0 : 1);
    const all = classSpells(s, lv);
    const page = Math.min(s.spellPage || 0, Math.max(0, Math.ceil(all.length / 25) - 1));
    const shown = all.slice(page * 25, page * 25 + 25);
    text += `✨ **Spells.** Pick **${sc.cantrips} cantrips** (${nC} picked) and **${sc.spells} spells ${sc.word}** (${nS} picked)${maxL ? `, up to level ${maxL}` : ''}.`;
    if (sc.wizardBook) text += ' Wizards: these are your prepared spells; add the rest of your spellbook with ✍️.';
    const byL = {};
    for (const [n, l] of Object.entries(picks)) (byL[l] ||= []).push(n);
    const listed = Object.keys(byL).sort().map((l) => `${l === '0' ? 'Cantrips' : `Level ${l}`}: ${byL[l].sort().join(', ')}`).join('\n');
    if (listed) text += `\n${listed}`;
    if (nC > sc.cantrips || nS > sc.spells) text += '\n⚠️ That\'s more than you get; remove some.';
    if (s.spells) text += `\nFrom other books: ${s.spells}`;
    text += `\n*Lists are from the free rules (SRD). Use ✍️ for spells from your other books.*`;
    const levels = [...(sc.cantrips ? [0] : []), ...Array.from({ length: maxL }, (_, k) => k + 1)];
    rows.push(row(select(id('pick', 'spellLevel'), lv ? `Level ${lv} spells` : 'Cantrips', levels.map((l) => ({
      label: l ? `Level ${l} spells` : 'Cantrips', value: String(l), default: l === lv, description: `${classSpells(s, l).length} to choose from`,
    })))));
    if (shown.length) {
      rows.push(row(select(id('spells', String(lv), String(page)), `${lv ? `Level ${lv}` : 'Cantrips'}${all.length > 25 ? ` (${page * 25 + 1}–${page * 25 + shown.length} of ${all.length})` : ''}: pick any`,
        shown.map((x) => ({ label: x.n, value: x.n, description: spellDesc(x), default: picks[x.n] !== undefined })), { min: 0, max: shown.length })));
    }
    if (all.length > 25) {
      rows.push(row(btn(id('spellpage', String(page - 1)), '◀ Previous', ButtonStyle.Secondary, page === 0),
        btn(id('spellpage', String(page + 1)), 'More ▶', ButtonStyle.Secondary, (page + 1) * 25 >= all.length)));
    }
    rows.push(row(btn(id('next', s.step), 'Next →', ButtonStyle.Primary), btn(id('modal', 'spells'), '✍️ Spells from other books'), btn(id('cancel'), 'Cancel', ButtonStyle.Danger)));
  } else if (s.step === 'details') {
    text += `Last bit: **who is this character?**${s.name ? `\n✅ ${s.name}${s.alignment ? ` (${s.alignment})` : ''}` : ''}`;
    rows.push(row(btn(id('modal', 'who'), '✍️ Name & personality', s.name ? ButtonStyle.Secondary : ButtonStyle.Primary)));
    rows.push(nav(Boolean(s.name), 'Review →'));
  } else if (s.step === 'review') {
    const ch = buildCharacter(s);
    text += `\n${sheetSummary(ch)}\n\n*Save it, then get it on a sheet with \`/sheet pdf\`.${s.replaces ? ` This replaces your current character, **${s.replaces}**.` : ''}*`;
    rows.push(row(btn(id('save'), '💾 Save character', ButtonStyle.Success), btn(id('back', 'details'), '← Back'), btn(id('restart'), 'Start over'), btn(id('cancel'), 'Cancel', ButtonStyle.Danger)));
  }
  return { content: text.slice(0, 1990), components: rows.slice(0, 5) };
}

function rollStat() {
  const d = Array.from({ length: 4 }, () => 1 + Math.floor(Math.random() * 6)).sort((a, b) => a - b);
  return d[1] + d[2] + d[3];
}

// Starts the builder (the /sheet build command).
export async function startBuilder(interaction, { level = 1, edition = null, playerName = '', replaces = null }) {
  const s = fresh(interaction.user.id, { level, edition, player: playerName, playerId: interaction.user.id, replaces, guildId: interaction.guildId });
  sessions.set(interaction.user.id, s);
  for (const [k, v] of sessions) if (Date.now() - v.at > TTL) sessions.delete(k);
  return interaction.reply({ ...view(s), flags: MessageFlags.Ephemeral });
}

// Every button, menu and form of the builder (custom ids starting "sb|"). onSave(character) stores it.
export async function handleBuilder(interaction, { onSave }) {
  const s = sessions.get(interaction.user.id);
  if (!s) return interaction.reply({ content: 'That builder timed out. Start again with `/sheet build`.', flags: MessageFlags.Ephemeral });
  s.at = Date.now();
  const [, action, arg, arg2] = interaction.customId.split('|');
  const values = interaction.values || [];

  if (action === 'cancel') { sessions.delete(interaction.user.id); return interaction.update({ content: 'Character builder closed.', components: [] }); }
  if (action === 'restart') { Object.assign(s, fresh(s.userId, { level: s.level, edition: s.edition, player: s.player, playerId: s.playerId, replaces: s.replaces, guildId: s.guildId })); }
  if (action === 'ed') { s.edition = arg; s.step = 'class'; }
  if (action === 'pick') {
    const v = values[0];
    if (arg === 'cls') { s.cls = v; s.subclass = null; s.classSkills = []; s.expertise = []; s.asis = []; s.spellPicks = {}; s.spellLevel = null; s.kit = null; s.featPicks = []; s.featIdx = 0; }
    else if (arg === 'species') { s.species = v; s.subspecies = null; s.speciesPick = []; s.anySkills = []; }
    else if (arg === 'subspecies') { s.subspecies = v; s.speciesPick = []; s.anySkills = []; }
    else if (arg === 'background') { s.background = v; s.bgBonus = null; s.classSkills = []; }
    else if (arg === 'bgBonus') s.bgBonus = Object.fromEntries(v.split(',').map((x) => { const [a, n] = x.split(':'); return [a, Number(n)]; }));
    else if (arg === 'shield') s.shield = v === 'yes';
    else if (arg === 'spellLevel') { s.spellLevel = Number(v); s.spellPage = 0; }
    else if (arg === 'pack') s.pack = v === 'none' ? null : v;
    else s[arg] = v;
  }
  if (action === 'multi') s[arg] = values;
  if (action === 'weap') {
    const other = (s.weapons || []).filter((w) => (arg === 'simple' ? !WEAPONS.simple[w] : WEAPONS.simple[w]));
    s.weapons = [...other, ...values];
  }
  if (action === 'method') {
    if (arg === 'back') { s.step = 'method'; }
    else {
      s.method = arg; s.base = {}; s.assignIdx = 0; s.step = 'assign';
      s.pool = arg === 'array' ? [...STANDARD_ARRAY] : arg === 'roll' ? Array.from({ length: 6 }, rollStat).sort((a, b) => b - a) : null;
    }
  }
  if (action === 'score') {
    s.base[arg] = Number(values[0]);
    s.assignIdx++;
    if (s.assignIdx >= 6) s.step = nextStep(s, 'assign');
  }
  if (action === 'asi') {
    const v = values[0];
    s.asis = s.asis || [];
    s.asis[Number(arg)] = v === 'feat' ? { kind: 'feat' } : v.startsWith('two:') ? { kind: 'two', a: v.slice(4) } : { kind: 'split', a: v.split(':')[1], b: v.split(':')[2] };
  }
  if (action === 'asipage') s.asiPage = Number(arg);
  if (action === 'kit') {
    const v = arg === 'pick' ? 'pick' : values[0];
    if (v === 'pick') s.kit = null;
    else if (v === 'custom') { s.kit = 'custom'; s.kitItems = []; s.weaponQty = {}; }
    else {
      const k = KITS[s.cls][Number(v)];
      Object.assign(s, { kit: v, armor: k.armor, shield: k.shield, weapons: [...k.weapons], weaponQty: { ...(k.qty || {}) }, pack: k.pack || null, kitItems: [...(k.items || [])] });
    }
  }
  if (action === 'feat') {
    s.featPicks = s.featPicks || [];
    s.featPicks[Number(arg)] = values[0];
    s.featIdx = Number(arg) + 1;
  }
  if (action === 'featidx') s.featIdx = Number(arg);
  if (action === 'spells') {
    // This menu shows one page of one spell level: swap that page's picks for what's ticked now.
    const lv = Number(arg);
    const page = Number(arg2) || 0;
    const onPage = new Set(classSpells(s, lv).slice(page * 25, page * 25 + 25).map((x) => x.n));
    s.spellPicks = Object.fromEntries(Object.entries(s.spellPicks || {}).filter(([n]) => !onPage.has(n)));
    for (const n of values) s.spellPicks[n] = lv;
  }
  if (action === 'spellpage') s.spellPage = Math.max(0, Number(arg));
  if (action === 'next') s.step = nextStep(s, arg);
  if (action === 'back') s.step = arg;

  if (action === 'modal') {
    if (arg === 'who') {
      const m = new ModalBuilder().setCustomId(id('form', 'who')).setTitle('Name & personality').addComponents(
        row(new TextInputBuilder().setCustomId('name').setLabel('Character name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(60).setValue(s.name || '')),
        row(new TextInputBuilder().setCustomId('alignment').setLabel('Alignment').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(30).setPlaceholder('Chaotic Good').setValue(s.alignment || '')),
        row(new TextInputBuilder().setCustomId('traits').setLabel('Personality traits').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(400).setValue(s.traits || '')),
        row(new TextInputBuilder().setCustomId('ibf').setLabel('Ideals / bonds / flaws (one per line)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)
          .setValue([s.ideals, s.bonds, s.flaws].filter(Boolean).join('\n'))),
        row(new TextInputBuilder().setCustomId('backstory').setLabel('Backstory (short)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1500).setValue(s.backstory || '')),
      );
      return interaction.showModal(m);
    }
    if (arg === 'spells') {
      return interaction.showModal(new ModalBuilder().setCustomId(id('form', 'spells')).setTitle('Spells from other books').addComponents(
        row(new TextInputBuilder().setCustomId('spells').setLabel('Spell names, with the level: Toll the Dead (0)').setStyle(TextInputStyle.Paragraph)
          .setRequired(false).setMaxLength(1500).setPlaceholder('Toll the Dead (0), Silvery Barbs (1), Shadow Blade (2)').setValue(s.spells || ''))));
    }
    if (arg === 'gear') {
      return interaction.showModal(new ModalBuilder().setCustomId(id('form', 'gear')).setTitle('Other items & gold').addComponents(
        row(new TextInputBuilder().setCustomId('gear').setLabel('Other items (comma-separated)').setStyle(TextInputStyle.Paragraph).setRequired(false)
          .setMaxLength(1000).setPlaceholder('Lucky coin, letter from my sister, 2 bottles of wine').setValue(s.gear || '')),
        row(new TextInputBuilder().setCustomId('gold').setLabel('Gold pieces').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(8).setValue(String(s.gold ?? 10)))));
    }
    const fi = Number(arg.replace('feat', ''));
    const m = new ModalBuilder().setCustomId(id('form', `feat${fi}`)).setTitle('A feat from another book').addComponents(
      row(new TextInputBuilder().setCustomId('feat').setLabel('Feat name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(60).setValue((s.featPicks || [])[fi] || '')));
    return interaction.showModal(m);
  }
  if (action === 'form') {
    const f = (k) => { try { return interaction.fields.getTextInputValue(k).trim(); } catch { return undefined; } };
    if (arg === 'who') {
      s.name = f('name'); s.alignment = f('alignment') || ''; s.traits = f('traits') || ''; s.backstory = f('backstory') || '';
      const [i1, b1, f1] = (f('ibf') || '').split('\n');
      s.ideals = (i1 || '').trim(); s.bonds = (b1 || '').trim(); s.flaws = (f1 || '').trim();
    } else if (arg === 'spells') {
      s.spells = f('spells') || '';
    } else if (arg === 'gear') {
      s.gear = f('gear') || '';
      const g = Number(String(f('gold') || '').replace(/[^\d.]/g, ''));
      s.gold = Number.isFinite(g) ? g : 0;
    } else if (arg.startsWith('feat')) {
      const fi = Number(arg.replace('feat', ''));
      s.featPicks = s.featPicks || [];
      s.featPicks[fi] = f('feat');
      s.featIdx = fi + 1;
    }
  }
  if (action === 'save') {
    const ch = buildCharacter(s);
    const saved = await onSave(ch, s);
    sessions.delete(interaction.user.id);
    return interaction.update({ content: `✅ **${saved.name}** is saved! \`/sheet show\` to see it, \`/sheet pdf\` for a filled-in sheet.\n\n${sheetSummary(saved, { short: true })}`, components: [] });
  }
  return interaction.update(view(s));
}

// ---------- random characters (for pickup games and other programs, through the connection API) ----------
const PRIORITY = {
  Barbarian: ['str', 'con', 'dex', 'wis', 'cha', 'int'], Bard: ['cha', 'dex', 'con', 'wis', 'int', 'str'], Cleric: ['wis', 'con', 'str', 'dex', 'cha', 'int'],
  Druid: ['wis', 'con', 'dex', 'int', 'cha', 'str'], Fighter: ['str', 'con', 'dex', 'wis', 'cha', 'int'], Monk: ['dex', 'wis', 'con', 'str', 'int', 'cha'],
  Paladin: ['str', 'cha', 'con', 'wis', 'dex', 'int'], Ranger: ['dex', 'wis', 'con', 'str', 'int', 'cha'], Rogue: ['dex', 'con', 'int', 'cha', 'wis', 'str'],
  Sorcerer: ['cha', 'con', 'dex', 'wis', 'int', 'str'], Warlock: ['cha', 'con', 'dex', 'wis', 'int', 'str'], Wizard: ['int', 'con', 'dex', 'wis', 'cha', 'str'],
};
const NAMES = {
  first: ['Aria', 'Bram', 'Cora', 'Dax', 'Elara', 'Finn', 'Gwen', 'Hale', 'Isla', 'Joren', 'Kira', 'Lio', 'Mira', 'Nox', 'Orin', 'Pell', 'Quill', 'Rhea',
    'Soren', 'Tamsin', 'Ulric', 'Vex', 'Wren', 'Xan', 'Yara', 'Zed', 'Bryn', 'Calla', 'Dorian', 'Esme', 'Garrick', 'Hesper', 'Ivo', 'Juno', 'Kael', 'Lark'],
  last: ['Ashdown', 'Brightwater', 'Coldbrook', 'Duskmantle', 'Emberfall', 'Fairwind', 'Grimsby', 'Hollowell', 'Ironfoot', 'Jadecrest', 'Kettleburn',
    'Lightfoot', 'Moonwhisper', 'Nettlefield', 'Oakhart', 'Pinecrest', 'Quickhand', 'Ravenmoor', 'Stonebrook', 'Thornwood', 'Underbough', 'Vale', 'Whitlock'],
};
const TRAITS = ['Always counts the exits.', 'Laughs at danger, then regrets it.', 'Collects odd trinkets.', 'Talks to their weapon.',
  'Never turns down a bet.', 'Hums when nervous.', 'Distrusts anyone too polite.', 'Keeps a journal of every monster seen.', 'Shares food with strangers.'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// opts: { edition '2014'|'2024', level 1-20, cls, species, background, name, method 'array'|'roll', player, playerId }
export function randomCharacter(opts = {}) {
  const edition = opts.edition === '2014' ? '2014' : '2024';
  const level = Math.max(1, Math.min(20, Number(opts.level) || 1));
  const cls = CLASSES[opts.cls] ? opts.cls : pick(Object.keys(CLASSES));
  const c = CLASSES[cls];
  const s = { edition, level, cls, player: opts.player || '', playerId: opts.playerId || '' };
  const sub = c.sub[edition];
  if (level >= sub.at) s.subclass = pick(sub.list);
  const speciesList = SPECIES[edition];
  s.species = speciesList[opts.species] ? opts.species : pick(Object.keys(speciesList));
  if (speciesList[s.species].sub) s.subspecies = pick(Object.keys(speciesList[s.species].sub));
  const prio = PRIORITY[cls];
  // 2024 backgrounds raise abilities: pick one that helps this class.
  const bgNames = Object.keys(BACKGROUNDS[edition]);
  const suits = edition === '2024' ? bgNames.filter((b) => BACKGROUNDS[edition][b].abilities.includes(prio[0])) : bgNames;
  s.background = BACKGROUNDS[edition][opts.background] ? opts.background : pick(suits.length ? suits : bgNames);
  // Ability scores: the best scores in what the class needs.
  const pool = opts.method === 'roll' ? Array.from({ length: 6 }, rollStat).sort((a, b) => b - a) : [...STANDARD_ARRAY];
  s.base = Object.fromEntries(prio.map((a, i) => [a, pool[i]]));
  const sp = speciesData(s);
  if (sp.pick) s.speciesPick = prio.filter((a) => !(s.species === 'Half-Elf' && a === 'cha')).slice(0, sp.pick.n);
  if (edition === '2024') {
    const bgAb = BACKGROUNDS[edition][s.background].abilities;
    const order = [...bgAb].sort((a, b) => prio.indexOf(a) - prio.indexOf(b));
    s.bgBonus = { [order[0]]: 2, [order[1]]: 1 };
  }
  // Skills and expertise.
  const fixed = fixedSkills(s);
  s.classSkills = shuffle(c.skills.from.filter((k) => !fixed.has(k))).slice(0, c.skills.n);
  s.anySkills = shuffle(ALL_SKILLS.filter((k) => !fixed.has(k) && !s.classSkills.includes(k))).slice(0, sp.anySkills);
  const profs = [...new Set([...fixed, ...s.classSkills, ...s.anySkills])];
  s.expertise = shuffle(profs).slice(0, expertiseCount(s));
  // Ability increases: the main score to 20, now and then a feat.
  s.asis = [];
  for (let i = 0; i < asiCount(s); i++) {
    const sc = finalScores(s);
    if (Math.random() < 0.25 && sc[prio[0]] >= 18) s.asis.push({ kind: 'feat' });
    else if (sc[prio[0]] <= 18) s.asis.push({ kind: 'two', a: prio[0] });
    else s.asis.push({ kind: 'split', a: prio[1], b: sc[prio[2]] < 20 ? prio[2] : prio[3] });
  }
  // Gear: one of the class kits.
  const kits = KITS[cls];
  const kitIdx = Math.floor(Math.random() * kits.length);
  const k = kits[kitIdx];
  Object.assign(s, { kit: String(kitIdx), armor: k.armor, shield: k.shield, weapons: [...k.weapons], weaponQty: { ...(k.qty || {}) }, pack: k.pack || null,
    kitItems: [...(k.items || [])], items: ['Potion of Healing'], gold: 10 + Math.floor(Math.random() * 15) });
  // Feats (a fighting style that suits the kit).
  s.featPicks = featSlots(s).map((sl) => {
    if (sl.type === 'style') return k.weapons.some((w) => WEAPONS.martial[w]?.[2]?.includes('r') || WEAPONS.simple[w]?.[2]?.includes('r')) && /Archer|bow/i.test(k.name) ? 'Archery' : 'Defense';
    return pick(featList(s, sl.type).filter((n) => n !== 'Ability Score Improvement'));
  });
  // Spells: cantrips that deal damage first, then spells spread over the levels it can cast.
  const counts = spellCounts(s);
  if (counts && castsSpells(s)) {
    s.spellPicks = {};
    const cantrips = classSpells(s, 0);
    const dmg = shuffle(cantrips.filter((x) => x.d)); const rest = shuffle(cantrips.filter((x) => !x.d));
    for (const x of [...dmg.slice(0, 1), ...shuffle([...dmg.slice(1), ...rest])].slice(0, counts.cantrips)) s.spellPicks[x.n] = 0;
    const maxL = maxSpellLevel(s);
    for (let i = 0; i < counts.spells && maxL > 0; i++) {
      // Lean towards the higher levels it can cast, like a real character would.
      const lv = Math.min(maxL, 1 + Math.floor(Math.sqrt(Math.random()) * maxL));
      const options = classSpells(s, lv).filter((x) => s.spellPicks[x.n] === undefined);
      const healers = options.filter((x) => x.h);
      const chosen = i === 0 && healers.length && ['Cleric', 'Druid', 'Paladin', 'Bard'].includes(cls) ? pick(healers) : pick(options.filter((x) => x.d).length && Math.random() < 0.6 ? options.filter((x) => x.d) : options);
      if (chosen) s.spellPicks[chosen.n] = lv;
    }
  }
  s.name = opts.name || `${pick(NAMES.first)} ${pick(NAMES.last)}`;
  s.traits = pick(TRAITS);
  s.alignment = pick(['Neutral Good', 'Chaotic Good', 'Lawful Good', 'True Neutral', 'Chaotic Neutral', 'Lawful Neutral']);
  return buildCharacter(s);
}
