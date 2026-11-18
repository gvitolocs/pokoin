/**
 * Mono-colour Full Art printings, Black & White → Mega Evolution: the
 * textured single-colour background behind a Full Art EX / GX / V / ex or a
 * Full Art supporter (Guardians Rising Sylveon GX 140/145 is pink). The
 * suggest row tints with that colour, like the rainbow and gold rows.
 * Painted alt arts, Illustration Rare / SIR, Trainer Gallery, Amazing,
 * framed Shiny Rare, rainbow and gold are not this.
 *
 * Catalog only — rarity + collector + era + print nationality:
 * - `Full-Art | n/m` (CardTrader's own label).
 * - Western Black & White → Sword & Shield: `Ultra Rare` inside the set's
 *   trailing Full Art block (FULL_ART_BLOCKS). The regular GX / V is also
 *   `Ultra Rare` (Sylveon GX 92/145), so the block start comes from the set,
 *   not a guess. SM tag team and SWSH alt arts sit in the block right after
 *   their Full Art (Umbreon V 188 → 189) and are listed to skip.
 * - XY Full Art EX / Mega secrets (`Secret Rare` EX, BREAKthrough 163/162).
 * - Scarlet & Violet / Mega Evolution: secret-numbered `Ultra Rare`
 *   (Paldea Evolved 232/193). In-set SV `Ultra Rare` is the regular ex.
 * - Chinese `Ultra Rare` n > m (CSM1c Cynthia 186/151). Japanese
 *   `Ultra Rare` n > m before Scarlet & Violet is the gold UR (Sword Zacian V
 *   73/060), so Japanese BW–SWSH Full Arts come from the Full-Art label, plus
 *   XY/BW rule-box Pokémon past the set size (Wild Blaze Charizard EX 081/080).
 * - Shiny full arts: Shiny Ultra Rare, and Shiny Rare GX / V / VMAX / ex
 *   (Hidden Fates SV76 Sylveon GX). Shiny Rare baby Pokémon stay framed.
 */
import { isItemAlbumCard } from './art-layout.js';
import { isLandscapePrintName } from './art-cut-landscape.js';
import { compactQuery } from './compact-query.js';
import { expansionNationality } from './expansion-nationality.js';
import { printingIdentity } from './identity.js';
import { rarityRowTheme } from './rarity-theme.js';
import { matchTcgEra } from './tcg-eras.js';

/**
 * Western set → [first collector of the trailing Full Art block, …alt arts
 * inside it]. From the catalog 2026-10-22: the longest run of
 * `Ultra Rare` / `Full-Art` collectors that ends at the set size; an alt art
 * is the second consecutive printing of one name (SM tag teams, SWSH V).
 */
export const FULL_ART_BLOCKS = {
  "astralradiance": [160, 161, 163, 172, 175], // Astral Radiance 160–189
  "battlestyles": [142, 146, 151, 153, 155], // Battle Styles 142–163
  "blackwhite": [113], // Black & White 113–114
  "boundariescrossed": [141], // Boundaries Crossed 141–149
  "breakpoint": [114], // BREAKpoint 114–122
  "breakthrough": [153], // BREAKthrough 153–162
  "brilliantstars": [152, 154, 156, 162, 166], // Brilliant Stars 152–172
  "burningshadows": [129], // Burning Shadows 129–147
  "celestialstorm": [152], // Celestial Storm 152–168
  "championspath": [69], // Champion's Path 69–73
  "chillingreign": [160, 164, 166, 168, 170, 172, 174, 177, 179, 183, 185], // Chilling Reign 160–198
  "cosmiceclipse": [210, 215, 221, 224, 226], // Cosmic Eclipse 210–236
  "crimsoninvasion": [101], // Crimson Invasion 101–111
  "crownzenith": [147], // Crown Zenith 147–159
  "darkexplorers": [103], // Dark Explorers 103–108
  "darknessablaze": [177], // Darkness Ablaze 177–189
  "dragonmajesty": [65], // Dragon Majesty 65–70
  "dragonsexalted": [119], // Dragons Exalted 119–124
  "emergingpowers": [97], // Emerging Powers 97–98
  "evolutions": [100], // Evolutions 100–108
  "evolvingskies": [166, 167, 175, 180, 182, 184, 186, 189, 192, 194, 196, 198], // Evolving Skies 166–203
  "fatescollide": [116], // Fates Collide 116–124
  "flashfire": [100], // Flashfire 100–106
  "forbiddenlight": [119], // Forbidden Light 119–131
  "furiousfists": [105], // Furious Fists 105–111
  "fusionstrike": [245, 251, 255, 257], // Fusion Strike 245–264
  "guardiansrising": [131], // Guardians Rising 131–145
  "hiddenfates": [66], // Hidden Fates 66–68
  "lostorigin": [172, 177, 180, 184, 186], // Lost Origin 172–196
  "lostthunder": [195], // Lost Thunder 195–214
  "nextdestinies": [94], // Next Destinies 94–99
  "noblevictories": [97], // Noble Victories 97–101
  "phantomforces": [113], // Phantom Forces 113–119
  "plasmablast": [96], // Plasma Blast 96–101
  "plasmafreeze": [109], // Plasma Freeze 109–116
  "plasmastorm": [131], // Plasma Storm 131–135
  "pokemontcgpokemongo": [71, 74], // Pokémon TCG: Pokémon GO 71–78
  "primalclash": [145], // Primal Clash 145–160
  "rebelclash": [175], // Rebel Clash 175–192
  "roaringskies": [98], // Roaring Skies 98–108
  "shiningfates": [64], // Shining Fates 64–72
  "shininglegends": [71], // Shining Legends 71–73
  "silvertempest": [170, 177, 181, 184, 186], // Silver Tempest 170–195
  "steamsiege": [107], // Steam Siege 107–114
  "sunmoon": [138], // Sun & Moon 138–149
  "swordshield": [187], // Sword & Shield 187–202
  "teamup": [159, 161, 165, 170], // Team Up 159–181
  "ultraprism": [139], // Ultra Prism 139–156
  "unbrokenbonds": [191, 192, 197, 199, 201, 205], // Unbroken Bonds 191–214
  "unifiedminds": [214, 215, 218, 221, 226], // Unified Minds 214–236
  "vividvoltage": [166], // Vivid Voltage 166–185
  "xy": [141], // XY 141–146
};

const FULL_ART_ERAS = new Set([
  'Black & White', 'XY', 'Sun & Moon', 'Sword & Shield', 'Scarlet & Violet', 'Mega Evolution',
]);
const SECRET_NUMBERED_ERAS = new Set(['Scarlet & Violet', 'Mega Evolution']);

const FULL_ART_TOKEN = /\bfull[\s-]*art\b|\bfullart\b/i;
const ULTRA_RARE = /\bultra\s*rare\b/i;
const SECRET_RARE = /\bsecret\s*rare\b/i;
const SHINY = /\bshiny\b/i;
const SHINY_ULTRA = /\bshiny\s*ultra\s*rare\b/i;
/** Painted, foil, or framed treatments — not a mono-colour background. */
const NOT_MONO = /illustration|special\s*art|\bart\s*rare\b|\bsir\b|\bsar\b|character\s*(super\s*)?rare|trainer\s*gallery|galarian\s*gallery|amazing|radiant|alternate\s*art|\balt\s*art\b|hyper|rainbow|\bgold\b|crown|ace\s*spec|prism|stamp|\b[tg]g\s*\d/i;
/** EX / GX / V / VMAX / VSTAR / ex / tag team: the cards printed as Full Art. */
const RULE_BOX = /\b(?:ex|gx|v|vmax|vstar|v-union)\b|&/i;

function catalogHay(card) {
  const identity = printingIdentity(card || {});
  return [identity.rarity, card?.rarity, card?.number, card?.card_number].filter(Boolean).join(' ');
}

function setName(card) {
  return String(card?.set || card?.set_name || card?.expansion_name || '');
}

function collector(hay) {
  const last = [...String(hay || '').matchAll(/(\d+)\s*\/\s*(\d+)/g)].at(-1);
  if (!last) return null;
  const n = Number(last[1]);
  const m = Number(last[2]);
  return m ? { n, m } : null;
}

function nationality(set) {
  const value = expansionNationality(set);
  return value === 'japanese' || value === 'chinese' || value === 'korean' ? value : 'western';
}

export function isMonoFullArt(card) {
  if (!card) return false;
  const name = String(card.name || card.english_name || '').trim();
  if (!name || isLandscapePrintName(name) || isItemAlbumCard(card)) return false;
  if (rarityRowTheme(card)) return false;
  const hay = catalogHay(card);
  if (NOT_MONO.test(hay)) return false;
  const set = setName(card);
  const era = matchTcgEra(`${card.slug || ''} ${set}`);
  if (!FULL_ART_ERAS.has(era)) return false;
  if (SHINY.test(hay)) return SHINY_ULTRA.test(hay) || RULE_BOX.test(name);
  const at = collector(hay);
  const block = FULL_ART_BLOCKS[compactQuery(set)];
  if (block && at && block.indexOf(at.n, 1) > 0) return false;
  const print = nationality(set);
  if (FULL_ART_TOKEN.test(hay)) {
    // CardTrader also labels some regular GX `Full-Art` (Hidden Fates Charizard
    // GX 009/068, Cosmic Eclipse 001/236): only the Full Art block counts.
    if (!at) return true;
    if (print === 'western') return !block || at.n >= block[0];
    return at.n > at.m;
  }
  if (!at) return false;
  const ultra = ULTRA_RARE.test(hay);
  const secret = at.n > at.m;
  if (SECRET_NUMBERED_ERAS.has(era)) return ultra && secret;
  if (print === 'chinese') return ultra && secret;
  if (print !== 'western') {
    return secret && (era === 'XY' || era === 'Black & White')
      && (ultra || SECRET_RARE.test(hay)) && RULE_BOX.test(name);
  }
  // XY Full Art EX / Mega secrets (BREAKthrough M Mewtwo-EX 163/162).
  if (era === 'XY' && secret && SECRET_RARE.test(hay) && RULE_BOX.test(name)) return true;
  if (!ultra) return false;
  if (secret) return true;
  return Boolean(block) && at.n >= block[0];
}
