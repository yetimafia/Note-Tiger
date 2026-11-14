// D&D 5e rules data for the character builder: classes, species, backgrounds, armor, weapons and spell slots, for the
// 2014 and the 2024 Player's Handbook. Game mechanics only (numbers, names, lists); the rules text stays in your books.

const ALL_SKILLS = ['acrobatics', 'animal_handling', 'arcana', 'athletics', 'deception', 'history', 'insight', 'intimidation', 'investigation',
  'medicine', 'nature', 'perception', 'performance', 'persuasion', 'religion', 'sleight_of_hand', 'stealth', 'survival'];

// Features by level: index 0 = level 1. "Subclass feature" lines are filled in with the subclass name.
const F = (s) => s.split('|').map((x) => (x ? x.split(';').map((y) => y.trim()) : []));

// ---------- classes ----------
// prep: 'known' (a fixed list) or 'prepared'; caster: full | half | pact | none.
// spells14/spells24: spells known or prepared per level (when it's a table, not ability mod + level).
const CLASSES = {
  Barbarian: {
    hitDie: 12, saves: ['str', 'con'], skills: { n: 2, from: ['animal_handling', 'athletics', 'intimidation', 'nature', 'perception', 'survival'] },
    armor: 'Light armor, medium armor, shields', weapons: { 2014: 'simple, martial', 2024: 'simple, martial' }, caster: 'none',
    unarmored: 'con',
    sub: { 2014: { at: 3, label: 'Primal Path', list: ['Path of the Berserker', 'Path of the Totem Warrior', 'Path of the Ancestral Guardian', 'Path of the Storm Herald', 'Path of the Zealot', 'Path of the Beast', 'Path of Wild Magic'] },
      2024: { at: 3, label: 'Barbarian Subclass', list: ['Path of the Berserker', 'Path of the Wild Heart', 'Path of the World Tree', 'Path of the Zealot'] } },
    features: {
      2014: F('Rage; Unarmored Defense|Reckless Attack; Danger Sense|Primal Path|ASI|Extra Attack; Fast Movement|Subclass feature|Feral Instinct|ASI|Brutal Critical (1 die)|Subclass feature|Relentless Rage|ASI|Brutal Critical (2 dice)|Subclass feature|Persistent Rage|ASI|Brutal Critical (3 dice)|Indomitable Might|ASI|Primal Champion'),
      2024: F('Rage; Unarmored Defense; Weapon Mastery|Danger Sense; Reckless Attack|Barbarian Subclass; Primal Knowledge|ASI|Extra Attack; Fast Movement|Subclass feature|Feral Instinct; Instinctive Pounce|ASI|Brutal Strike|Subclass feature|Relentless Rage|ASI|Improved Brutal Strike|Subclass feature|Persistent Rage|ASI|Improved Brutal Strike|Indomitable Might|Epic Boon|Primal Champion'),
    },
  },
  Bard: {
    hitDie: 8, saves: ['dex', 'cha'], skills: { n: 3, from: ALL_SKILLS }, armor: 'Light armor',
    weapons: { 2014: 'simple, hand crossbow, longsword, rapier, shortsword', 2024: 'simple' }, tools: 'Three musical instruments',
    caster: 'full', ability: 'cha', prep: { 2014: 'known', 2024: 'prepared' },
    cantrips: [2, 3, 4], spells14: [4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 15, 16, 18, 19, 19, 20, 22, 22, 22],
    spells24: [4, 5, 6, 7, 9, 10, 11, 12, 14, 15, 16, 16, 17, 17, 18, 18, 19, 20, 21, 22],
    expertise: { 2014: { 3: 2, 10: 2 }, 2024: { 2: 2, 9: 2 } },
    sub: { 2014: { at: 3, label: 'Bard College', list: ['College of Lore', 'College of Valor', 'College of Glamour', 'College of Swords', 'College of Whispers', 'College of Creation', 'College of Eloquence'] },
      2024: { at: 3, label: 'Bard Subclass', list: ['College of Dance', 'College of Glamour', 'College of Lore', 'College of Valor'] } },
    features: {
      2014: F('Spellcasting; Bardic Inspiration (d6)|Jack of All Trades; Song of Rest (d6)|Bard College; Expertise|ASI|Bardic Inspiration (d8); Font of Inspiration|Countercharm; Subclass feature||ASI|Song of Rest (d8)|Bardic Inspiration (d10); Expertise; Magical Secrets||ASI|Song of Rest (d10)|Magical Secrets; Subclass feature|Bardic Inspiration (d12)|ASI|Song of Rest (d12)|Magical Secrets|ASI|Superior Inspiration'),
      2024: F('Bardic Inspiration; Spellcasting|Expertise; Jack of All Trades|Bard Subclass|ASI|Font of Inspiration|Subclass feature|Countercharm|ASI|Expertise|Magical Secrets||ASI||Subclass feature||ASI||Superior Inspiration|Epic Boon|Words of Creation'),
    },
  },
  Cleric: {
    hitDie: 8, saves: ['wis', 'cha'], skills: { n: 2, from: ['history', 'insight', 'medicine', 'persuasion', 'religion'] },
    armor: 'Light armor, medium armor, shields', weapons: { 2014: 'simple', 2024: 'simple' },
    caster: 'full', ability: 'wis', prep: { 2014: 'prepared', 2024: 'prepared' }, cantrips: [3, 4, 5],
    spells24: [4, 5, 6, 7, 9, 10, 11, 12, 14, 15, 16, 16, 17, 17, 18, 18, 19, 20, 21, 22],
    sub: { 2014: { at: 1, label: 'Divine Domain', list: ['Knowledge Domain', 'Life Domain', 'Light Domain', 'Nature Domain', 'Tempest Domain', 'Trickery Domain', 'War Domain', 'Forge Domain', 'Grave Domain', 'Order Domain', 'Peace Domain', 'Twilight Domain'] },
      2024: { at: 3, label: 'Cleric Subclass', list: ['Life Domain', 'Light Domain', 'Trickery Domain', 'War Domain'] } },
    features: {
      2014: F('Spellcasting; Divine Domain|Channel Divinity (1/rest); Subclass feature||ASI|Destroy Undead (CR 1/2)|Channel Divinity (2/rest); Subclass feature||ASI; Destroy Undead (CR 1); Subclass feature||Divine Intervention|Destroy Undead (CR 2)|ASI||Destroy Undead (CR 3)||ASI|Destroy Undead (CR 4); Subclass feature|Channel Divinity (3/rest)|ASI|Divine Intervention Improvement'),
      2024: F('Spellcasting; Divine Order|Channel Divinity|Cleric Subclass|ASI|Sear Undead|Subclass feature|Blessed Strikes|ASI||Divine Intervention||ASI||Improved Blessed Strikes||ASI|Subclass feature||Epic Boon|Greater Divine Intervention'),
    },
  },
  Druid: {
    hitDie: 8, saves: ['int', 'wis'], skills: { n: 2, from: ['arcana', 'animal_handling', 'insight', 'medicine', 'nature', 'perception', 'religion', 'survival'] },
    armor: 'Light armor, medium armor, shields (no metal)', weapons: { 2014: 'club, dagger, dart, javelin, mace, quarterstaff, scimitar, sickle, sling, spear', 2024: 'simple' },
    tools: 'Herbalism kit', languages: 'Druidic',
    caster: 'full', ability: 'wis', prep: { 2014: 'prepared', 2024: 'prepared' }, cantrips: [2, 3, 4],
    spells24: [4, 5, 6, 7, 9, 10, 11, 12, 14, 15, 16, 16, 17, 17, 18, 18, 19, 20, 21, 22],
    sub: { 2014: { at: 2, label: 'Druid Circle', list: ['Circle of the Land', 'Circle of the Moon', 'Circle of Dreams', 'Circle of the Shepherd', 'Circle of Spores', 'Circle of Stars', 'Circle of Wildfire'] },
      2024: { at: 3, label: 'Druid Subclass', list: ['Circle of the Land', 'Circle of the Moon', 'Circle of the Sea', 'Circle of the Stars'] } },
    features: {
      2014: F('Druidic; Spellcasting|Wild Shape; Druid Circle||Wild Shape Improvement; ASI||Subclass feature||Wild Shape Improvement; ASI||Subclass feature||ASI||Subclass feature||ASI||Timeless Body; Beast Spells|ASI|Archdruid'),
      2024: F('Spellcasting; Druidic; Primal Order|Wild Shape; Wild Companion|Druid Subclass|ASI|Wild Resurgence|Subclass feature|Elemental Fury|ASI||Subclass feature||ASI||Subclass feature|Improved Elemental Fury|ASI||Beast Spells|Epic Boon|Archdruid'),
    },
  },
  Fighter: {
    hitDie: 10, saves: ['str', 'con'], skills: { n: 2, from: ['acrobatics', 'animal_handling', 'athletics', 'history', 'insight', 'intimidation', 'perception', 'survival'] },
    armor: 'All armor, shields', weapons: { 2014: 'simple, martial', 2024: 'simple, martial' }, caster: 'none',
    sub: { 2014: { at: 3, label: 'Martial Archetype', list: ['Champion', 'Battle Master', 'Eldritch Knight', 'Arcane Archer', 'Cavalier', 'Samurai', 'Psi Warrior', 'Rune Knight'] },
      2024: { at: 3, label: 'Fighter Subclass', list: ['Battle Master', 'Champion', 'Eldritch Knight', 'Psi Warrior'] } },
    features: {
      2014: F('Fighting Style; Second Wind|Action Surge (one use)|Martial Archetype|ASI|Extra Attack|ASI|Subclass feature|ASI|Indomitable (one use)|Subclass feature|Extra Attack (2)|ASI|Indomitable (two uses)|ASI|Subclass feature|ASI|Action Surge (two uses); Indomitable (three uses)|Subclass feature|ASI|Extra Attack (3)'),
      2024: F('Fighting Style; Second Wind; Weapon Mastery|Action Surge; Tactical Mind|Fighter Subclass|ASI|Extra Attack; Tactical Shift|ASI|Subclass feature|ASI|Indomitable; Tactical Master|Subclass feature|Two Extra Attacks|ASI|Indomitable (two uses); Studied Attacks|ASI|Subclass feature|ASI|Action Surge (two uses); Indomitable (three uses)|Subclass feature|Epic Boon|Three Extra Attacks'),
    },
  },
  Monk: {
    hitDie: 8, saves: ['str', 'dex'], skills: { n: 2, from: ['acrobatics', 'athletics', 'history', 'insight', 'religion', 'stealth'] },
    armor: 'None', weapons: { 2014: 'simple, shortsword', 2024: 'simple, martial (Light)' }, tools: 'One artisan\'s tool or musical instrument',
    caster: 'none', unarmored: 'wis',
    sub: { 2014: { at: 3, label: 'Monastic Tradition', list: ['Way of the Open Hand', 'Way of Shadow', 'Way of the Four Elements', 'Way of the Drunken Master', 'Way of the Kensei', 'Way of the Sun Soul', 'Way of the Astral Self', 'Way of Mercy'] },
      2024: { at: 3, label: 'Monk Subclass', list: ['Warrior of Mercy', 'Warrior of Shadow', 'Warrior of the Elements', 'Warrior of the Open Hand'] } },
    features: {
      2014: F('Unarmored Defense; Martial Arts|Ki; Unarmored Movement|Monastic Tradition; Deflect Missiles|ASI; Slow Fall|Extra Attack; Stunning Strike|Ki-Empowered Strikes; Subclass feature|Evasion; Stillness of Mind|ASI|Unarmored Movement improvement|Purity of Body|Subclass feature|ASI|Tongue of the Sun and Moon|Diamond Soul|Timeless Body|ASI|Subclass feature|Empty Body|ASI|Perfect Self'),
      2024: F('Martial Arts; Unarmored Defense|Monk\'s Focus; Unarmored Movement; Uncanny Metabolism|Deflect Attacks; Monk Subclass|ASI; Slow Fall|Extra Attack; Stunning Strike|Empowered Strikes; Subclass feature|Evasion|ASI|Acrobatic Movement|Heightened Focus; Self-Restoration|Subclass feature|ASI|Deflect Energy|Disciplined Survivor|Perfect Focus|ASI|Subclass feature|Superior Defense|Epic Boon|Body and Mind'),
    },
  },
  Paladin: {
    hitDie: 10, saves: ['wis', 'cha'], skills: { n: 2, from: ['athletics', 'insight', 'intimidation', 'medicine', 'persuasion', 'religion'] },
    armor: 'All armor, shields', weapons: { 2014: 'simple, martial', 2024: 'simple, martial' },
    caster: 'half', ability: 'cha', prep: { 2014: 'prepared', 2024: 'prepared' }, halfPrep14: true,
    spells24: [2, 3, 4, 5, 6, 6, 7, 7, 9, 9, 10, 10, 11, 11, 12, 12, 14, 14, 15, 15],
    sub: { 2014: { at: 3, label: 'Sacred Oath', list: ['Oath of Devotion', 'Oath of the Ancients', 'Oath of Vengeance', 'Oath of Conquest', 'Oath of Redemption', 'Oath of Glory', 'Oath of the Watchers'] },
      2024: { at: 3, label: 'Paladin Subclass', list: ['Oath of Devotion', 'Oath of Glory', 'Oath of the Ancients', 'Oath of Vengeance'] } },
    features: {
      2014: F('Divine Sense; Lay on Hands|Fighting Style; Spellcasting; Divine Smite|Divine Health; Sacred Oath|ASI|Extra Attack|Aura of Protection|Subclass feature|ASI||Aura of Courage|Improved Divine Smite|ASI||Cleansing Touch|Subclass feature|ASI||Aura improvements|ASI|Subclass feature'),
      2024: F('Lay On Hands; Spellcasting; Weapon Mastery|Fighting Style; Paladin\'s Smite|Channel Divinity; Paladin Subclass|ASI|Extra Attack; Faithful Steed|Aura of Protection|Subclass feature|ASI|Abjure Foes|Aura of Courage|Radiant Strikes|ASI||Restoring Touch|Subclass feature|ASI||Aura Expansion|Epic Boon|Subclass feature'),
    },
  },
  Ranger: {
    hitDie: 10, saves: ['str', 'dex'], skills: { n: 3, from: ['animal_handling', 'athletics', 'insight', 'investigation', 'nature', 'perception', 'stealth', 'survival'] },
    armor: 'Light armor, medium armor, shields', weapons: { 2014: 'simple, martial', 2024: 'simple, martial' },
    caster: 'half', ability: 'wis', prep: { 2014: 'known', 2024: 'prepared' },
    spells14: [0, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11],
    spells24: [2, 3, 4, 5, 6, 6, 7, 7, 9, 9, 10, 10, 11, 11, 12, 12, 14, 14, 15, 15],
    expertise: { 2024: { 9: 2 } },
    sub: { 2014: { at: 3, label: 'Ranger Archetype', list: ['Hunter', 'Beast Master', 'Gloom Stalker', 'Horizon Walker', 'Monster Slayer', 'Fey Wanderer', 'Swarmkeeper'] },
      2024: { at: 3, label: 'Ranger Subclass', list: ['Beast Master', 'Fey Wanderer', 'Gloom Stalker', 'Hunter'] } },
    features: {
      2014: F('Favored Enemy; Natural Explorer|Fighting Style; Spellcasting|Ranger Archetype; Primeval Awareness|ASI|Extra Attack|Favored Enemy and Natural Explorer improvements|Subclass feature|ASI; Land\'s Stride||Natural Explorer improvement; Hide in Plain Sight|Subclass feature|ASI||Favored Enemy improvement; Vanish|Subclass feature|ASI||Feral Senses|ASI|Foe Slayer'),
      2024: F('Spellcasting; Favored Enemy; Weapon Mastery|Deft Explorer; Fighting Style|Ranger Subclass|ASI|Extra Attack|Roving|Subclass feature|ASI|Expertise|Tireless|Subclass feature|ASI|Relentless Hunter|Nature\'s Veil|Subclass feature|ASI|Precise Hunter|Feral Senses|Epic Boon|Foe Slayer'),
    },
  },
  Rogue: {
    hitDie: 8, saves: ['dex', 'int'], skills: { n: 4, from: ['acrobatics', 'athletics', 'deception', 'insight', 'intimidation', 'investigation', 'perception', 'performance', 'persuasion', 'sleight_of_hand', 'stealth'] },
    armor: 'Light armor', weapons: { 2014: 'simple, hand crossbow, longsword, rapier, shortsword', 2024: 'simple, martial (Finesse or Light)' },
    tools: 'Thieves\' tools', languages: 'Thieves\' Cant', caster: 'none',
    expertise: { 2014: { 1: 2, 6: 2 }, 2024: { 1: 2, 6: 2 } },
    sub: { 2014: { at: 3, label: 'Roguish Archetype', list: ['Thief', 'Assassin', 'Arcane Trickster', 'Inquisitive', 'Mastermind', 'Scout', 'Swashbuckler', 'Phantom', 'Soulknife'] },
      2024: { at: 3, label: 'Rogue Subclass', list: ['Arcane Trickster', 'Assassin', 'Soulknife', 'Thief'] } },
    features: {
      2014: F('Expertise; Sneak Attack; Thieves\' Cant|Cunning Action|Roguish Archetype|ASI|Uncanny Dodge|Expertise|Evasion|ASI|Subclass feature|ASI|Reliable Talent|ASI|Subclass feature|Blindsense|Slippery Mind|ASI|Subclass feature|Elusive|ASI|Stroke of Luck'),
      2024: F('Expertise; Sneak Attack; Thieves\' Cant; Weapon Mastery|Cunning Action|Rogue Subclass; Steady Aim|ASI|Cunning Strike; Uncanny Dodge|Expertise|Evasion; Reliable Talent|ASI|Subclass feature|ASI|Improved Cunning Strike|ASI|Subclass feature|Devious Strikes|Slippery Mind|ASI|Subclass feature|Elusive|Epic Boon|Stroke of Luck'),
    },
  },
  Sorcerer: {
    hitDie: 6, saves: ['con', 'cha'], skills: { n: 2, from: ['arcana', 'deception', 'insight', 'intimidation', 'persuasion', 'religion'] },
    armor: 'None', weapons: { 2014: 'dagger, dart, sling, quarterstaff, light crossbow', 2024: 'simple' },
    caster: 'full', ability: 'cha', prep: { 2014: 'known', 2024: 'prepared' }, cantrips: [4, 5, 6],
    spells14: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12, 13, 13, 14, 14, 15, 15, 15, 15],
    spells24: [2, 4, 6, 7, 9, 10, 11, 12, 14, 15, 16, 16, 17, 17, 18, 18, 19, 20, 21, 22],
    sub: { 2014: { at: 1, label: 'Sorcerous Origin', list: ['Draconic Bloodline', 'Wild Magic', 'Divine Soul', 'Shadow Magic', 'Storm Sorcery', 'Aberrant Mind', 'Clockwork Soul'] },
      2024: { at: 3, label: 'Sorcerer Subclass', list: ['Aberrant Sorcery', 'Clockwork Sorcery', 'Draconic Sorcery', 'Wild Magic Sorcery'] } },
    features: {
      2014: F('Spellcasting; Sorcerous Origin|Font of Magic|Metamagic|ASI||Subclass feature||ASI||Metamagic||ASI||Subclass feature||ASI|Metamagic|Subclass feature|ASI|Sorcerous Restoration'),
      2024: F('Spellcasting; Innate Sorcery|Font of Magic; Metamagic|Sorcerer Subclass|ASI|Sorcerous Restoration|Subclass feature|Sorcery Incarnate|ASI||Metamagic||ASI||Subclass feature||ASI|Metamagic|Subclass feature|Epic Boon|Arcane Apotheosis'),
    },
  },
  Warlock: {
    hitDie: 8, saves: ['wis', 'cha'], skills: { n: 2, from: ['arcana', 'deception', 'history', 'intimidation', 'investigation', 'nature', 'religion'] },
    armor: 'Light armor', weapons: { 2014: 'simple', 2024: 'simple' },
    caster: 'pact', ability: 'cha', prep: { 2014: 'known', 2024: 'prepared' }, cantrips: [2, 3, 4],
    spells14: [2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15],
    spells24: [2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15],
    sub: { 2014: { at: 1, label: 'Otherworldly Patron', list: ['The Archfey', 'The Fiend', 'The Great Old One', 'The Celestial', 'The Hexblade', 'The Fathomless', 'The Genie', 'The Undead'] },
      2024: { at: 3, label: 'Warlock Subclass', list: ['Archfey Patron', 'Celestial Patron', 'Fiend Patron', 'Great Old One Patron'] } },
    features: {
      2014: F('Otherworldly Patron; Pact Magic|Eldritch Invocations|Pact Boon|ASI||Subclass feature||ASI||Subclass feature|Mystic Arcanum (6th level)|ASI|Mystic Arcanum (7th level)|Subclass feature|Mystic Arcanum (8th level)|ASI|Mystic Arcanum (9th level)||ASI|Eldritch Master'),
      2024: F('Eldritch Invocations; Pact Magic|Magical Cunning|Warlock Subclass|ASI||Subclass feature||ASI|Contact Patron|Subclass feature|Mystic Arcanum (6th level)|ASI|Mystic Arcanum (7th level)|Subclass feature|Mystic Arcanum (8th level)|ASI|Mystic Arcanum (9th level)||Epic Boon|Eldritch Master'),
    },
  },
  Wizard: {
    hitDie: 6, saves: ['int', 'wis'], skills: { n: 2, from: ['arcana', 'history', 'insight', 'investigation', 'medicine', 'religion'] },
    armor: 'None', weapons: { 2014: 'dagger, dart, sling, quarterstaff, light crossbow', 2024: 'simple' },
    caster: 'full', ability: 'int', prep: { 2014: 'prepared', 2024: 'prepared' }, cantrips: [3, 4, 5],
    spells24: [4, 5, 6, 7, 9, 10, 11, 12, 14, 15, 16, 16, 17, 18, 19, 21, 22, 23, 24, 25],
    sub: { 2014: { at: 2, label: 'Arcane Tradition', list: ['School of Abjuration', 'School of Conjuration', 'School of Divination', 'School of Enchantment', 'School of Evocation', 'School of Illusion', 'School of Necromancy', 'School of Transmutation', 'Bladesinging', 'War Magic', 'Order of Scribes'] },
      2024: { at: 3, label: 'Wizard Subclass', list: ['Abjurer', 'Diviner', 'Evoker', 'Illusionist'] } },
    features: {
      2014: F('Spellcasting; Arcane Recovery|Arcane Tradition||ASI||Subclass feature||ASI||Subclass feature||ASI||Subclass feature||ASI||Spell Mastery|ASI|Signature Spells'),
      2024: F('Spellcasting; Ritual Adept; Arcane Recovery|Scholar|Wizard Subclass|ASI|Memorize Spell|Subclass feature||ASI||Subclass feature||ASI||Subclass feature||ASI||Spell Mastery|Epic Boon|Signature Spells'),
    },
  },
};

// ---------- species ----------
// asi (2014 only): fixed increases; pick: { n, amount } = choose n other abilities to raise by amount.
// skills: proficiencies it gives; anySkills: extra skills of the player's choice; hpPerLevel: extra HP each level.
const SPECIES = {
  2014: {
    Dragonborn: { asi: { str: 2, cha: 1 }, speed: 30, languages: 'Common, Draconic', traits: ['Draconic Ancestry', 'Breath Weapon', 'Damage Resistance'] },
    Dwarf: { asi: { con: 2 }, speed: 25, languages: 'Common, Dwarvish', traits: ['Darkvision', 'Dwarven Resilience', 'Dwarven Combat Training', 'Tool Proficiency', 'Stonecunning'],
      sub: { 'Hill Dwarf': { asi: { wis: 1 }, traits: ['Dwarven Toughness'], hpPerLevel: 1 }, 'Mountain Dwarf': { asi: { str: 2 }, traits: ['Dwarven Armor Training'], armor: 'Light armor, medium armor' } } },
    Elf: { asi: { dex: 2 }, speed: 30, languages: 'Common, Elvish', skills: ['perception'], traits: ['Darkvision', 'Keen Senses', 'Fey Ancestry', 'Trance'],
      sub: { 'High Elf': { asi: { int: 1 }, traits: ['Elf Weapon Training', 'Cantrip', 'Extra Language'], extraLanguages: 1 },
        'Wood Elf': { asi: { wis: 1 }, speed: 35, traits: ['Elf Weapon Training', 'Fleet of Foot', 'Mask of the Wild'] },
        'Dark Elf (Drow)': { asi: { cha: 1 }, traits: ['Superior Darkvision', 'Sunlight Sensitivity', 'Drow Magic', 'Drow Weapon Training'] } } },
    Gnome: { asi: { int: 2 }, speed: 25, languages: 'Common, Gnomish', traits: ['Darkvision', 'Gnome Cunning'],
      sub: { 'Forest Gnome': { asi: { dex: 1 }, traits: ['Natural Illusionist', 'Speak with Small Beasts'] }, 'Rock Gnome': { asi: { con: 1 }, traits: ['Artificer\'s Lore', 'Tinker'] } } },
    'Half-Elf': { asi: { cha: 2 }, pick: { n: 2, amount: 1 }, speed: 30, languages: 'Common, Elvish', extraLanguages: 1, anySkills: 2, traits: ['Darkvision', 'Fey Ancestry', 'Skill Versatility'] },
    'Half-Orc': { asi: { str: 2, con: 1 }, speed: 30, languages: 'Common, Orc', skills: ['intimidation'], traits: ['Darkvision', 'Menacing', 'Relentless Endurance', 'Savage Attacks'] },
    Halfling: { asi: { dex: 2 }, speed: 25, languages: 'Common, Halfling', traits: ['Lucky', 'Brave', 'Halfling Nimbleness'],
      sub: { 'Lightfoot Halfling': { asi: { cha: 1 }, traits: ['Naturally Stealthy'] }, 'Stout Halfling': { asi: { con: 1 }, traits: ['Stout Resilience'] } } },
    Human: { asi: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 }, speed: 30, languages: 'Common', extraLanguages: 1, traits: [],
      sub: { 'Human': {}, 'Variant Human': { replaceAsi: true, pick: { n: 2, amount: 1 }, anySkills: 1, feats: 1, traits: [] } } },
    Tiefling: { asi: { cha: 2, int: 1 }, speed: 30, languages: 'Common, Infernal', traits: ['Darkvision', 'Hellish Resistance', 'Infernal Legacy'] },
  },
  2024: {
    Aasimar: { speed: 30, traits: ['Celestial Resistance', 'Darkvision', 'Healing Hands', 'Light Bearer', 'Celestial Revelation'] },
    Dragonborn: { speed: 30, traits: ['Draconic Ancestry', 'Breath Weapon', 'Damage Resistance', 'Darkvision', 'Draconic Flight'] },
    Dwarf: { speed: 30, hpPerLevel: 1, traits: ['Darkvision', 'Dwarven Resilience', 'Dwarven Toughness', 'Stonecunning'] },
    Elf: { speed: 30, skills: ['perception'], traits: ['Darkvision', 'Elven Lineage', 'Fey Ancestry', 'Keen Senses', 'Trance'],
      sub: { 'Drow lineage': { traits: ['Drow lineage'] }, 'High Elf lineage': { traits: ['High Elf lineage'] }, 'Wood Elf lineage': { speed: 35, traits: ['Wood Elf lineage'] } } },
    Gnome: { speed: 30, traits: ['Darkvision', 'Gnomish Cunning', 'Gnomish Lineage'],
      sub: { 'Forest Gnome lineage': { traits: ['Forest Gnome lineage'] }, 'Rock Gnome lineage': { traits: ['Rock Gnome lineage'] } } },
    Goliath: { speed: 35, traits: ['Giant Ancestry', 'Large Form', 'Powerful Build'] },
    Halfling: { speed: 30, traits: ['Brave', 'Halfling Nimbleness', 'Luck', 'Naturally Stealthy'] },
    Human: { speed: 30, anySkills: 1, feats: 1, traits: ['Resourceful', 'Skillful', 'Versatile'] },
    Orc: { speed: 30, traits: ['Adrenaline Rush', 'Darkvision', 'Relentless Endurance'] },
    Tiefling: { speed: 30, traits: ['Darkvision', 'Fiendish Legacy', 'Otherworldly Presence'],
      sub: { 'Abyssal legacy': { traits: ['Abyssal legacy'] }, 'Chthonic legacy': { traits: ['Chthonic legacy'] }, 'Infernal legacy': { traits: ['Infernal legacy'] } } },
  },
};

// ---------- backgrounds ----------
// 2014: skills, tools/languages, a feature. 2024: three abilities to raise (+2/+1 or +1/+1/+1), an origin feat, skills, a tool.
const BACKGROUNDS = {
  2014: {
    Acolyte: { skills: ['insight', 'religion'], languages: 2, feature: 'Shelter of the Faithful' },
    Charlatan: { skills: ['deception', 'sleight_of_hand'], tools: 'Disguise kit, forgery kit', feature: 'False Identity' },
    Criminal: { skills: ['deception', 'stealth'], tools: 'One gaming set, thieves\' tools', feature: 'Criminal Contact' },
    Entertainer: { skills: ['acrobatics', 'performance'], tools: 'Disguise kit, one musical instrument', feature: 'By Popular Demand' },
    'Folk Hero': { skills: ['animal_handling', 'survival'], tools: 'One artisan\'s tools, vehicles (land)', feature: 'Rustic Hospitality' },
    'Guild Artisan': { skills: ['insight', 'persuasion'], tools: 'One artisan\'s tools', languages: 1, feature: 'Guild Membership' },
    Hermit: { skills: ['medicine', 'religion'], tools: 'Herbalism kit', languages: 1, feature: 'Discovery' },
    Noble: { skills: ['history', 'persuasion'], tools: 'One gaming set', languages: 1, feature: 'Position of Privilege' },
    Outlander: { skills: ['athletics', 'survival'], tools: 'One musical instrument', languages: 1, feature: 'Wanderer' },
    Sage: { skills: ['arcana', 'history'], languages: 2, feature: 'Researcher' },
    Sailor: { skills: ['athletics', 'perception'], tools: 'Navigator\'s tools, vehicles (water)', feature: 'Ship\'s Passage' },
    Soldier: { skills: ['athletics', 'intimidation'], tools: 'One gaming set, vehicles (land)', feature: 'Military Rank' },
    Urchin: { skills: ['sleight_of_hand', 'stealth'], tools: 'Disguise kit, thieves\' tools', feature: 'City Secrets' },
  },
  2024: {
    Acolyte: { abilities: ['int', 'wis', 'cha'], feat: 'Magic Initiate (Cleric)', skills: ['insight', 'religion'], tools: 'Calligrapher\'s supplies' },
    Artisan: { abilities: ['str', 'dex', 'int'], feat: 'Crafter', skills: ['investigation', 'persuasion'], tools: 'One artisan\'s tools' },
    Charlatan: { abilities: ['dex', 'con', 'cha'], feat: 'Skilled', skills: ['deception', 'sleight_of_hand'], tools: 'Forgery kit' },
    Criminal: { abilities: ['dex', 'con', 'int'], feat: 'Alert', skills: ['sleight_of_hand', 'stealth'], tools: 'Thieves\' tools' },
    Entertainer: { abilities: ['str', 'dex', 'cha'], feat: 'Musician', skills: ['acrobatics', 'performance'], tools: 'One musical instrument' },
    Farmer: { abilities: ['str', 'con', 'wis'], feat: 'Tough', skills: ['animal_handling', 'nature'], tools: 'Carpenter\'s tools' },
    Guard: { abilities: ['str', 'int', 'wis'], feat: 'Alert', skills: ['athletics', 'perception'], tools: 'One gaming set' },
    Guide: { abilities: ['dex', 'con', 'wis'], feat: 'Magic Initiate (Druid)', skills: ['stealth', 'survival'], tools: 'Cartographer\'s tools' },
    Hermit: { abilities: ['con', 'wis', 'cha'], feat: 'Healer', skills: ['medicine', 'religion'], tools: 'Herbalism kit' },
    Merchant: { abilities: ['con', 'int', 'cha'], feat: 'Lucky', skills: ['animal_handling', 'persuasion'], tools: 'Navigator\'s tools' },
    Noble: { abilities: ['str', 'int', 'cha'], feat: 'Skilled', skills: ['history', 'persuasion'], tools: 'One gaming set' },
    Sage: { abilities: ['con', 'int', 'wis'], feat: 'Magic Initiate (Wizard)', skills: ['arcana', 'history'], tools: 'Calligrapher\'s supplies' },
    Sailor: { abilities: ['str', 'dex', 'wis'], feat: 'Tavern Brawler', skills: ['acrobatics', 'perception'], tools: 'Navigator\'s tools' },
    Scribe: { abilities: ['dex', 'int', 'wis'], feat: 'Skilled', skills: ['investigation', 'perception'], tools: 'Calligrapher\'s supplies' },
    Soldier: { abilities: ['str', 'dex', 'con'], feat: 'Savage Attacker', skills: ['athletics', 'intimidation'], tools: 'One gaming set' },
    Wayfarer: { abilities: ['dex', 'wis', 'cha'], feat: 'Lucky', skills: ['insight', 'stealth'], tools: 'Thieves\' tools' },
  },
};

// ---------- armor and weapons (the same in both books, except where noted) ----------
const ARMOR = {
  'Padded armor': { type: 'light', ac: 11 }, 'Leather armor': { type: 'light', ac: 11 }, 'Studded leather armor': { type: 'light', ac: 12 },
  'Hide armor': { type: 'medium', ac: 12 }, 'Chain shirt': { type: 'medium', ac: 13 }, 'Scale mail': { type: 'medium', ac: 14 },
  Breastplate: { type: 'medium', ac: 14 }, 'Half plate armor': { type: 'medium', ac: 15 },
  'Ring mail': { type: 'heavy', ac: 14 }, 'Chain mail': { type: 'heavy', ac: 16 }, 'Splint armor': { type: 'heavy', ac: 17 }, 'Plate armor': { type: 'heavy', ac: 18 },
};
// [damage, type, properties]: f finesse, l light, t thrown, r ranged, v<die> versatile, 2 two-handed
const WEAPONS = {
  simple: {
    Club: ['1d4', 'bludgeoning', 'l'], Dagger: ['1d4', 'piercing', 'flt'], Greatclub: ['1d8', 'bludgeoning', '2'], Handaxe: ['1d6', 'slashing', 'lt'],
    Javelin: ['1d6', 'piercing', 't'], 'Light hammer': ['1d4', 'bludgeoning', 'lt'], Mace: ['1d6', 'bludgeoning', ''], Quarterstaff: ['1d6', 'bludgeoning', 'v1d8'],
    Sickle: ['1d4', 'slashing', 'l'], Spear: ['1d6', 'piercing', 'tv1d8'], 'Light crossbow': ['1d8', 'piercing', 'r2'], Dart: ['1d4', 'piercing', 'ft'],
    Shortbow: ['1d6', 'piercing', 'r2'], Sling: ['1d4', 'bludgeoning', 'r'],
  },
  martial: {
    Battleaxe: ['1d8', 'slashing', 'v1d10'], Flail: ['1d8', 'bludgeoning', ''], Glaive: ['1d10', 'slashing', '2'], Greataxe: ['1d12', 'slashing', '2'],
    Greatsword: ['2d6', 'slashing', '2'], Halberd: ['1d10', 'slashing', '2'], Lance: ['1d12', 'piercing', ''], Longsword: ['1d8', 'slashing', 'v1d10'],
    Maul: ['2d6', 'bludgeoning', '2'], Morningstar: ['1d8', 'piercing', ''], Pike: ['1d10', 'piercing', '2'], Rapier: ['1d8', 'piercing', 'f'],
    Scimitar: ['1d6', 'slashing', 'fl'], Shortsword: ['1d6', 'piercing', 'fl'], Trident: ['1d6', 'piercing', 'tv1d8'], 'War pick': ['1d8', 'piercing', ''],
    Warhammer: ['1d8', 'bludgeoning', 'v1d10'], Whip: ['1d4', 'slashing', 'f'], Blowgun: ['1', 'piercing', 'r'], 'Hand crossbow': ['1d6', 'piercing', 'rl'],
    'Heavy crossbow': ['1d10', 'piercing', 'r2'], Longbow: ['1d8', 'piercing', 'r2'],
  },
};
const WEAPON_2024 = { Lance: ['1d10', 'piercing', ''], Trident: ['1d8', 'piercing', 'tv1d10'] };

// ---------- spell slots ----------
const FULL_SLOTS = [[2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2], [4, 3, 3, 3, 1], [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1], [4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1]];
export function spellSlots(cls, level, edition) {
  const c = CLASSES[cls];
  if (!c || c.caster === 'none') return {};
  if (c.caster === 'pact') {
    const n = level >= 17 ? 4 : level >= 11 ? 3 : level >= 2 ? 2 : 1;
    const lvl = Math.min(5, Math.ceil(level / 2));
    return { [lvl]: n };
  }
  // Half casters use the full table at half their level (rounded up); in 2014 they start at level 2.
  const casterLevel = c.caster === 'full' ? level : (edition === '2014' && level < 2 ? 0 : Math.ceil(level / 2));
  if (!casterLevel) return {};
  return Object.fromEntries(FULL_SLOTS[casterLevel - 1].map((n, i) => [i + 1, n]));
}

export const ABILITY_LIST = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
export { CLASSES, SPECIES, BACKGROUNDS, ARMOR, WEAPONS, WEAPON_2024, ALL_SKILLS };

export function asiLevels(cls, edition) {
  const base = edition === '2024' ? [4, 8, 12, 16] : [4, 8, 12, 16, 19];
  if (cls === 'Fighter') base.push(6, 14);
  if (cls === 'Rogue') base.push(10);
  return base.sort((a, b) => a - b);
}
export const epicBoonLevel = (edition) => (edition === '2024' ? 19 : null);

// ---------- feats (names; the rules are in your books) ----------
export const FEATS = {
  2014: {
    general: ['Actor', 'Alert', 'Athlete', 'Charger', 'Chef', 'Crossbow Expert', 'Crusher', 'Defensive Duelist', 'Dual Wielder', 'Dungeon Delver',
      'Durable', 'Eldritch Adept', 'Elemental Adept', 'Fey Touched', 'Fighting Initiate', 'Grappler', 'Great Weapon Master', 'Healer', 'Heavily Armored',
      'Heavy Armor Master', 'Inspiring Leader', 'Keen Mind', 'Lightly Armored', 'Linguist', 'Lucky', 'Mage Slayer', 'Magic Initiate', 'Martial Adept',
      'Medium Armor Master', 'Metamagic Adept', 'Mobile', 'Moderately Armored', 'Mounted Combatant', 'Observant', 'Piercer', 'Poisoner', 'Polearm Master',
      'Resilient', 'Ritual Caster', 'Savage Attacker', 'Sentinel', 'Shadow Touched', 'Sharpshooter', 'Shield Master', 'Skill Expert', 'Skilled', 'Skulker',
      'Slasher', 'Spell Sniper', 'Tavern Brawler', 'Telekinetic', 'Telepathic', 'Tough', 'War Caster', 'Weapon Master'],
    style: ['Archery', 'Blind Fighting', 'Defense', 'Dueling', 'Great Weapon Fighting', 'Interception', 'Protection', 'Superior Technique',
      'Thrown Weapon Fighting', 'Two-Weapon Fighting', 'Unarmed Fighting', 'Blessed Warrior', 'Druidic Warrior'],
  },
  2024: {
    origin: ['Alert', 'Crafter', 'Healer', 'Lucky', 'Magic Initiate (Cleric)', 'Magic Initiate (Druid)', 'Magic Initiate (Wizard)', 'Musician',
      'Savage Attacker', 'Skilled', 'Tavern Brawler', 'Tough'],
    general: ['Ability Score Improvement', 'Actor', 'Athlete', 'Charger', 'Chef', 'Crossbow Expert', 'Crusher', 'Defensive Duelist', 'Dual Wielder',
      'Durable', 'Elemental Adept', 'Fey Touched', 'Grappler', 'Great Weapon Master', 'Heavily Armored', 'Heavy Armor Master', 'Inspiring Leader',
      'Keen Mind', 'Lightly Armored', 'Mage Slayer', 'Martial Weapon Training', 'Medium Armor Master', 'Moderately Armored', 'Mounted Combatant',
      'Observant', 'Piercer', 'Poisoner', 'Polearm Master', 'Resilient', 'Ritual Caster', 'Sentinel', 'Shadow Touched', 'Sharpshooter',
      'Shield Master', 'Skill Expert', 'Skulker', 'Slasher', 'Speedy', 'Spell Sniper', 'Telekinetic', 'Telepathic', 'War Caster', 'Weapon Master'],
    style: ['Archery', 'Blind Fighting', 'Defense', 'Dueling', 'Great Weapon Fighting', 'Interception', 'Protection', 'Thrown Weapon Fighting',
      'Two-Weapon Fighting', 'Unarmed Fighting'],
    epic: ['Boon of Combat Prowess', 'Boon of Dimensional Travel', 'Boon of Energy Resistance', 'Boon of Fate', 'Boon of Fortitude',
      'Boon of Irresistible Offense', 'Boon of Recovery', 'Boon of Skill', 'Boon of Speed', 'Boon of Spell Recall', 'Boon of the Night Spirit', 'Boon of Truesight'],
  },
};
export const FIGHTING_STYLE_AT = { Fighter: 1, Paladin: 2, Ranger: 2 };

// ---------- gear ----------
export const PACKS = {
  "Burglar's Pack": 'backpack, ball bearings (1,000), 10 ft of string, bell, 5 candles, crowbar, hammer, 10 pitons, hooded lantern, 2 flasks of oil, 5 days of rations, tinderbox, waterskin, 50 ft of hempen rope',
  "Diplomat's Pack": 'chest, 2 map/scroll cases, fine clothes, ink and pen, lamp, 2 flasks of oil, 5 sheets of paper, perfume, sealing wax, soap',
  "Dungeoneer's Pack": 'backpack, crowbar, hammer, 10 pitons, 10 torches, tinderbox, 10 days of rations, waterskin, 50 ft of hempen rope',
  "Entertainer's Pack": 'backpack, bedroll, 2 costumes, 5 candles, 5 days of rations, waterskin, disguise kit',
  "Explorer's Pack": 'backpack, bedroll, mess kit, tinderbox, 10 torches, 10 days of rations, waterskin, 50 ft of hempen rope',
  "Priest's Pack": 'backpack, blanket, 10 candles, tinderbox, alms box, 2 blocks of incense, censer, vestments, 2 days of rations, waterskin',
  "Scholar's Pack": 'backpack, book of lore, ink and pen, 10 sheets of parchment, little bag of sand, small knife',
};
export const ADVENTURING_GEAR = ['Potion of Healing', "Healer's Kit", 'Rope, hempen (50 ft)', 'Torch', 'Rations (1 day)', 'Waterskin', 'Bedroll',
  'Tinderbox', 'Crowbar', 'Grappling Hook', 'Hooded Lantern', 'Oil (flask)', 'Caltrops (bag of 20)', 'Ball Bearings (bag of 1,000)', 'Chalk',
  'Steel Mirror', "Climber's Kit", 'Manacles', 'Holy Water (flask)', 'Antitoxin (vial)', "Thieves' Tools", 'Spellbook', 'Component Pouch',
  'Arcane Focus (crystal)', 'Holy Symbol (amulet)'];
// Two quick starting kits per class. items: extra gear; qty: how many of a weapon.
export const KITS = {
  Barbarian: [
    { name: 'Greataxe & javelins', armor: 'none', shield: false, weapons: ['Greataxe', 'Handaxe', 'Javelin'], qty: { Handaxe: 2, Javelin: 4 }, pack: "Explorer's Pack" },
    { name: 'Axe & shield', armor: 'none', shield: true, weapons: ['Battleaxe', 'Javelin'], qty: { Javelin: 4 }, pack: "Explorer's Pack" }],
  Bard: [
    { name: 'Rapier & lute', armor: 'Leather armor', shield: false, weapons: ['Rapier', 'Dagger'], pack: "Diplomat's Pack", items: ['Lute'] },
    { name: 'Longsword & stage', armor: 'Leather armor', shield: false, weapons: ['Longsword', 'Dagger'], pack: "Entertainer's Pack", items: ['Lute'] }],
  Cleric: [
    { name: 'Mace & shield', armor: 'Scale mail', shield: true, weapons: ['Mace', 'Light crossbow'], pack: "Priest's Pack", items: ['Holy Symbol (amulet)', 'Crossbow bolts (20)'] },
    { name: 'Light and quick', armor: 'Leather armor', shield: true, weapons: ['Mace'], pack: "Explorer's Pack", items: ['Holy Symbol (amulet)'] }],
  Druid: [
    { name: 'Scimitar & shield', armor: 'Leather armor', shield: true, weapons: ['Scimitar'], pack: "Explorer's Pack", items: ['Druidic Focus (wooden staff)', 'Herbalism Kit'] },
    { name: 'Staff & sickle', armor: 'Leather armor', shield: false, weapons: ['Quarterstaff', 'Sickle'], pack: "Explorer's Pack", items: ['Druidic Focus (sprig of mistletoe)', 'Herbalism Kit'] }],
  Fighter: [
    { name: 'Sword & board', armor: 'Chain mail', shield: true, weapons: ['Longsword', 'Light crossbow'], pack: "Dungeoneer's Pack", items: ['Crossbow bolts (20)'] },
    { name: 'Archer', armor: 'Leather armor', shield: false, weapons: ['Longbow', 'Shortsword'], qty: { Shortsword: 2 }, pack: "Explorer's Pack", items: ['Arrows (20)'] }],
  Monk: [
    { name: 'Shortsword & darts', armor: 'none', shield: false, weapons: ['Shortsword', 'Dart'], qty: { Dart: 10 }, pack: "Explorer's Pack" },
    { name: 'Spear & darts', armor: 'none', shield: false, weapons: ['Spear', 'Dart'], qty: { Dart: 10 }, pack: "Dungeoneer's Pack" }],
  Paladin: [
    { name: 'Sword & shield', armor: 'Chain mail', shield: true, weapons: ['Longsword', 'Javelin'], qty: { Javelin: 5 }, pack: "Priest's Pack", items: ['Holy Symbol (amulet)'] },
    { name: 'Greatsword', armor: 'Chain mail', shield: false, weapons: ['Greatsword', 'Javelin'], qty: { Javelin: 5 }, pack: "Explorer's Pack", items: ['Holy Symbol (amulet)'] }],
  Ranger: [
    { name: 'Two blades & bow', armor: 'Scale mail', shield: false, weapons: ['Shortsword', 'Longbow'], qty: { Shortsword: 2 }, pack: "Explorer's Pack", items: ['Arrows (20)', 'Quiver'] },
    { name: 'Light scout', armor: 'Leather armor', shield: false, weapons: ['Scimitar', 'Longbow'], qty: { Scimitar: 2 }, pack: "Dungeoneer's Pack", items: ['Arrows (20)', 'Quiver'] }],
  Rogue: [
    { name: 'Rapier & bow', armor: 'Leather armor', shield: false, weapons: ['Rapier', 'Shortbow', 'Dagger'], qty: { Dagger: 2 }, pack: "Burglar's Pack", items: ['Arrows (20)', "Thieves' Tools"] },
    { name: 'Shortsword & bow', armor: 'Leather armor', shield: false, weapons: ['Shortsword', 'Shortbow', 'Dagger'], qty: { Dagger: 2 }, pack: "Explorer's Pack", items: ['Arrows (20)', "Thieves' Tools"] }],
  Sorcerer: [
    { name: 'Crossbow & pouch', armor: 'none', shield: false, weapons: ['Light crossbow', 'Dagger'], qty: { Dagger: 2 }, pack: "Explorer's Pack", items: ['Crossbow bolts (20)', 'Component Pouch'] },
    { name: 'Staff & focus', armor: 'none', shield: false, weapons: ['Quarterstaff', 'Dagger'], qty: { Dagger: 2 }, pack: "Dungeoneer's Pack", items: ['Arcane Focus (crystal)'] }],
  Warlock: [
    { name: 'Crossbow & pouch', armor: 'Leather armor', shield: false, weapons: ['Light crossbow', 'Dagger'], qty: { Dagger: 2 }, pack: "Scholar's Pack", items: ['Crossbow bolts (20)', 'Component Pouch'] },
    { name: 'Staff & focus', armor: 'Leather armor', shield: false, weapons: ['Quarterstaff', 'Dagger'], qty: { Dagger: 2 }, pack: "Dungeoneer's Pack", items: ['Arcane Focus (orb)'] }],
  Wizard: [
    { name: 'Staff & pouch', armor: 'none', shield: false, weapons: ['Quarterstaff'], pack: "Scholar's Pack", items: ['Spellbook', 'Component Pouch'] },
    { name: 'Dagger & focus', armor: 'none', shield: false, weapons: ['Dagger'], pack: "Explorer's Pack", items: ['Spellbook', 'Arcane Focus (wand)'] }],
};
