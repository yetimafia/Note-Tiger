// /sheet build: a step-by-step D&D character builder in Discord (only the player sees it). Every choice is a menu or
// a button; the numbers (HP, AC, attacks, saves, skills, spell slots, features by level) are worked out here.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} from 'discord.js';
import {
  CLASSES, SPECIES, BACKGROUNDS, ARMOR, WEAPONS, WEAPON_2024, ALL_SKILLS, ABILITY_LIST, spellSlots, asiLevels,
} from './rules5e.js';
import { normalize, skillLabel, ABILITY_NAMES, signed, mod, profBonusFor, sheetSummary } from './sheets.js';

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
  };
}

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
  const typedFeats = String(s.feats || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  const tough = typedFeats.some((f) => /^tough$/i.test(f)) || (ed === '2024' && bg.feat === 'Tough');

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
    const bonus = m[abil] + (weaponProficient(s.cls, ed, name, group, props) ? pb : 0);
    const vers = props.match(/v(\d+d\d+)/);
    attacks.push({ name, bonus: signed(bonus), damage: `${die}${m[abil] ? signed(m[abil]) : ''} ${type}${vers ? ` (${vers[1]} two-handed)` : ''}` });
  }

  // Spells.
  const spellcasting = { ability: c.ability || '', class: c.ability ? s.cls : '', slots: {}, spells: [] };
  for (const [l, n] of Object.entries(spellSlots(s.cls, lvl, ed))) spellcasting.slots[l] = { max: n, used: 0 };
  const parseSpells = (text, defLevel) => String(text || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean).map((x) => {
    const mm = x.match(/^(.+?)\s*\((?:level\s*)?(\d)\)$/i);
    return mm ? { name: mm[1].trim(), level: Number(mm[2]), prepared: true } : { name: x, level: defLevel, prepared: defLevel > 0 };
  });
  spellcasting.spells = [...parseSpells(s.cantrips, 0), ...parseSpells(s.spells, 1)];

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
      if (f === 'Subclass feature') name = subName ? `${subName} feature` : `${label} feature`;
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

  const inventory = [
    ...(s.armor && s.armor !== 'none' ? [{ name: s.armor, qty: 1 }] : []), ...(s.shield ? [{ name: 'Shield', qty: 1 }] : []),
    ...(s.weapons || []).map((w) => ({ name: w, qty: 1 })),
    ...String(s.gear || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean).map((x) => {
      const mm = x.match(/^(\d+)\s*[x×]?\s+(.+)$/i);
      return mm ? { name: mm[2], qty: Number(mm[1]) } : { name: x, qty: 1 };
    }),
  ];

  return normalize({
    name: s.name || 'Unnamed', player: s.player || '', playerId: s.playerId || '', edition: ed,
    classes: [{ name: s.cls, subclass: subName, level: lvl }],
    species: s.subspecies && s.subspecies !== s.species && !/lineage|legacy/.test(s.subspecies) ? s.subspecies : [s.species, /lineage|legacy/.test(s.subspecies || '') ? `(${s.subspecies})` : ''].filter(Boolean).join(' '),
    background: s.background, alignment: s.alignment || '', xp: null,
    abilities: sc, saves: Object.fromEntries(c.saves.map((a) => [a, { prof: true }])), skills,
    profBonus: pb, ac, speed: `${speed} ft`, hp: { max: hp, current: hp, temp: 0 }, hitDice: `${lvl}d${c.hitDie}`,
    attacks, spellcasting, inventory, money: { gp: Number(s.gold) || 0 },
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

const STEPS = ['edition', 'class', 'species', 'background', 'method', 'assign', 'skills', 'expertise', 'asi', 'gear', 'details', 'review'];
function nextStep(s, from) {
  let i = STEPS.indexOf(from) + 1;
  while (i < STEPS.length) {
    const st = STEPS[i];
    if (st === 'expertise' && !expertiseCount(s)) { i++; continue; }
    if (st === 'asi' && !asiCount(s)) { i++; continue; }
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
    text += '**Armor and weapons.** (The rest of your gear you can type in at the end.)';
    rows.push(row(select(id('pick', 'armor'), s.armor ? s.armor : 'Armor', [{ label: 'No armor', value: 'none', description: c.unarmored ? 'Your class has Unarmored Defense' : undefined, default: s.armor === 'none' },
      ...Object.entries(ARMOR).map(([k, v]) => ({ label: k, value: k, description: `${v.type}, AC ${v.ac}${v.type === 'light' ? ' + Dex' : v.type === 'medium' ? ' + Dex (max 2)' : ''}`, default: s.armor === k }))])));
    rows.push(row(select(id('pick', 'shield'), s.shield ? 'Shield (+2 AC)' : 'Shield?', [{ label: 'No shield', value: 'no', default: s.shield === false }, { label: 'Shield (+2 AC)', value: 'yes', default: s.shield === true }])));
    const wopts = (group) => Object.entries(WEAPONS[group]).map(([k, [d, t, p]]) => {
      const [dd, tt] = (ed === '2024' && WEAPON_2024[k]) || [d, t];
      return { label: k, value: k, description: `${dd} ${tt}${p.includes('f') ? ', finesse' : ''}${p.includes('r') ? ', ranged' : ''}${p.includes('2') ? ', two-handed' : ''}`, default: (s.weapons || []).includes(k) };
    });
    rows.push(row(select(id('weap', 'simple'), 'Simple weapons (up to 3)', wopts('simple'), { min: 0, max: 3 })));
    rows.push(row(select(id('weap', 'martial'), 'Martial weapons (up to 3)', wopts('martial'), { min: 0, max: 3 })));
    rows.push(nav(Boolean(s.armor) && s.shield !== undefined));
  } else if (s.step === 'details') {
    const sc = spellCounts(s);
    text += `Last bit: **who is this character?**${s.name ? `\n✅ ${s.name}` : ''}${s.extrasDone ? '\n✅ Spells, feats & gear' : ''}`;
    if (sc) text += `\n\n✨ Spells to choose from your book: **${sc.cantrips} cantrips** and **${sc.spells} spells ${sc.word}**${sc.wizardBook ? ' (plus your spellbook)' : ''}.`;
    const feats = (s.asis || []).filter((x) => x?.kind === 'feat').length + (speciesData(s)?.feats || 0);
    if (feats) text += `\n⭐ Feats to name: **${feats}**${ed === '2024' ? ` (your background's ${BACKGROUNDS[ed][s.background].feat} is already added)` : ''}.`;
    rows.push(row(btn(id('modal', 'who'), '✍️ Name & personality', s.name ? ButtonStyle.Secondary : ButtonStyle.Primary),
      btn(id('modal', 'extras'), '🎒 Spells, feats & gear', ButtonStyle.Secondary)));
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
    if (arg === 'cls') { s.cls = v; s.subclass = null; s.classSkills = []; s.expertise = []; s.asis = []; }
    else if (arg === 'species') { s.species = v; s.subspecies = null; s.speciesPick = []; s.anySkills = []; }
    else if (arg === 'subspecies') { s.subspecies = v; s.speciesPick = []; s.anySkills = []; }
    else if (arg === 'background') { s.background = v; s.bgBonus = null; s.classSkills = []; }
    else if (arg === 'bgBonus') s.bgBonus = Object.fromEntries(v.split(',').map((x) => { const [a, n] = x.split(':'); return [a, Number(n)]; }));
    else if (arg === 'shield') s.shield = v === 'yes';
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
    const sc = spellCounts(s);
    const m = new ModalBuilder().setCustomId(id('form', 'extras')).setTitle('Spells, feats & gear');
    if (sc) {
      m.addComponents(row(new TextInputBuilder().setCustomId('cantrips').setLabel(`Cantrips (${sc.cantrips}), comma-separated`).setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500).setValue(s.cantrips || '')));
      m.addComponents(row(new TextInputBuilder().setCustomId('spells').setLabel(`Spells (${sc.spells}). Add the level: Fireball (3)`).setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1500).setValue(s.spells || '')));
    }
    m.addComponents(row(new TextInputBuilder().setCustomId('feats').setLabel('Feats (comma-separated)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300).setValue(s.feats || '')));
    m.addComponents(row(new TextInputBuilder().setCustomId('gear').setLabel('Other gear (comma-separated)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000).setPlaceholder('Explorer\'s pack, rope (50 ft), 2 potions of healing').setValue(s.gear || '')));
    m.addComponents(row(new TextInputBuilder().setCustomId('gold').setLabel('Gold pieces').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(8).setValue(String(s.gold ?? ''))));
    return interaction.showModal(m);
  }
  if (action === 'form') {
    const f = (k) => { try { return interaction.fields.getTextInputValue(k).trim(); } catch { return undefined; } };
    if (arg === 'who') {
      s.name = f('name'); s.alignment = f('alignment') || ''; s.traits = f('traits') || ''; s.backstory = f('backstory') || '';
      const [i1, b1, f1] = (f('ibf') || '').split('\n');
      s.ideals = (i1 || '').trim(); s.bonds = (b1 || '').trim(); s.flaws = (f1 || '').trim();
    } else {
      for (const k of ['cantrips', 'spells', 'feats', 'gear']) { const v = f(k); if (v !== undefined) s[k] = v; }
      const g = Number(String(f('gold') || '').replace(/[^\d.]/g, ''));
      s.gold = Number.isFinite(g) ? g : 0;
      s.extrasDone = true;
    }
  }
  if (action === 'save') {
    const ch = buildCharacter(s);
    const saved = await onSave(ch, s);
    sessions.delete(interaction.user.id);
    return interaction.update({ content: `✅ **${saved.name}** is saved! \`/sheet show\` to see it, \`/sheet pdf\` for a filled-in sheet.\n\n${sheetSummary(saved, { short: true })}`, components: [] });
  }
  void arg2;
  return interaction.update(view(s));
}
