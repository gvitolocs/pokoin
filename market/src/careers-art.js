/**
 * Editorial leftover picks for /careers principle + benefit panels.
 * Presentation is art-dependent: full-art bleed vs physical-card (≈50–70% visible).
 * Paths are Pi CDN leftover JPEGs (`/card-images/{ct_id}_…jpg`).
 */

/** @typedef {'full-art' | 'physical-card'} CareersArtMode */

/**
 * @typedef {object} CareersArt
 * @property {CareersArtMode} mode
 * @property {string} src
 * @property {string} card  Human label for mapping / a11y title
 * @property {string} reason Why this printing for this principle
 * @property {string} [pose] CSS modifier for composition variety
 */

/** Life-at-Pokoin media bleed — floating sleep bubbles (same circle treatment). */
export const LIFE_BUBBLES = [
  {
    src: '/card-images/322202_dragonite-v-jp-rare-secret-074-s7r-blue-sky-stream.jpg',
    card: 'Dragonite V Illustration Rare · Blue Sky Stream 074/067',
    face: '64% 24%',
    slot: 'a',
  },
  {
    src: '/card-images/502874_snorlax-181-165-pokemon-card-151.jpg',
    card: 'Snorlax Illustration Rare · Pokémon Card 151 181/165',
    face: '82% 27%',
    slot: 'b',
  },
  {
    src: '/card-images/241014_komala-114-145-guardians-rising.jpg',
    card: 'Komala · Guardians Rising 114/145',
    face: '52% 24%',
    slot: 'c',
  },
  {
    src: '/card-images/484062_slowpoke-204-198-scarlet-violet.jpg',
    card: 'Slowpoke Illustration Rare · Scarlet & Violet 204/198',
    face: '38% 40%',
    slot: 'd',
  },
];

/** @type {Array<{title: string, highlight: string, prefix?: string, rest?: string, tone: string, body: string, art: CareersArt}>} */
export const PRINCIPLES = [
  {
    title: 'Collectors first',
    highlight: 'Collectors',
    rest: ' first',
    tone: 'a',
    body: 'Every desk and listing flow should help a collector trade — not pad a house account.',
    art: {
      mode: 'full-art',
      src: '/card-images/332906_umbreon-vmax-secret-rare-215-203-evolving-skies.jpg',
      card: 'Umbreon VMAX SIR · Evolving Skies 215/203',
      reason: 'The collector chase card — edge-to-edge illustration reads as an art poster, not a windowed scan.',
      pose: 'bleed-low',
    },
  },
  {
    title: 'Stay honest',
    highlight: 'honest',
    prefix: 'Stay ',
    rest: '',
    tone: 'b',
    body: 'No invented prices or silent fallbacks. Empty books stay empty on the page.',
    art: {
      mode: 'physical-card',
      src: '/card-images/222470_professor-oak-88-102-base-set.jpg?v=bsu2',
      card: 'Professor Oak · Base Set 88/102',
      reason: 'Classic bordered Trainer — honesty and mentorship are the card object, not a cropped face.',
      pose: 'tilt-left',
    },
  },
  {
    title: 'Ship and iterate',
    highlight: 'Ship',
    rest: ' and iterate',
    tone: 'c',
    body: 'Ship the smallest correct surface, then tighten it in public.',
    art: {
      mode: 'physical-card',
      src: '/card-images/55591_magikarp-35-102-base-set.jpg?v=bsu2',
      card: 'Magikarp · Base Set 35/102',
      reason: 'Humble start, yellow frame intact — ship the weak version, then evolve.',
      pose: 'rise-center',
    },
  },
  {
    title: 'Own the stack',
    highlight: 'Own',
    rest: ' the stack',
    tone: 'd',
    body: 'Marketplace, wallet, and scan stay one product — fix the real path.',
    art: {
      mode: 'full-art',
      src: '/card-images/332912_rayquaza-vmax-secret-rare-218-203-evolving-skies.jpg',
      card: 'Rayquaza VMAX SIR · Evolving Skies 218/203',
      reason: 'One dragon spanning sky to valley — full-bleed stack ownership, not a framed window.',
      pose: 'bleed-wide',
    },
  },
];

/** @type {Array<{title: string, tone: string, art: CareersArt}>} */
export const REASONS = [
  {
    title: 'One product surface',
    tone: 'a',
    art: {
      mode: 'full-art',
      src: '/card-images/470360_giratina-vstar-secret-rare-gg69-gg70-crown-zenith.jpg',
      card: 'Giratina VSTAR SIR · Crown Zenith GG69/GG70',
      reason: 'Distortion-world gold SIR — one surface across realms; art is the composition.',
      pose: 'bleed-corner',
    },
  },
  {
    title: 'Real catalog depth',
    tone: 'b',
    art: {
      mode: 'physical-card',
      src: '/card-images/55609_computer-search-71-102-base-set.jpg?v=bsu2',
      card: 'Computer Search · Base Set 71/102',
      reason: 'Search your deck for any card — the catalog metaphor only lands if the Trainer frame stays.',
      pose: 'tilt-right',
    },
  },
  {
    title: 'Native PKN settlement',
    tone: 'c',
    art: {
      mode: 'physical-card',
      src: '/card-images/111151_charizard-holo-rare-4-102-base-set.jpg?v=bsu2',
      card: 'Charizard · Base Set Unlimited 4/102',
      reason: 'The classic store-of-value printing — settlement should feel like holding a real card.',
      pose: 'rise-right',
    },
  },
  {
    title: 'Peer-to-peer trading',
    tone: 'd',
    art: {
      mode: 'physical-card',
      src: '/card-images/455774_serena-164-195-silver-tempest.jpg',
      card: 'Serena · Silver Tempest 164/195',
      reason: 'Supporter who chooses how to help a partner — bordered card for a peer exchange, not a poster crop.',
      pose: 'tilt-left',
    },
  },
  {
    title: 'Public docs & explorer',
    tone: 'e',
    art: {
      mode: 'full-art',
      src: '/card-images/502844_bulbasaur-166-165-pokemon-card-151.jpg',
      card: 'Bulbasaur Illustration Rare · Pokémon Card 151 166/165',
      reason: 'Illustration Rare foliage — open, grow-in-public art for docs and explorer.',
      pose: 'bleed-low',
    },
  },
  {
    title: 'Direct email contact',
    tone: 'f',
    art: {
      mode: 'physical-card',
      src: '/card-images/55619_bill-full-v4.jpg?v=bsu2',
      card: 'Bill · Base Set 91/102',
      reason: 'Draw two / send a note — the letter-shaped Trainer stays a physical card for contact.',
      pose: 'rise-left',
    },
  },
];

/** Bottom product strip — one leftover per Pokoin surface. */
/** @type {Array<{label: string, tone: string, body: string, art: CareersArt}>} */
export const LIFE_STRIP = [
  {
    label: 'Card desk',
    tone: 'a',
    body: 'Open any printing and see the live book — asks, sold comps, and neighbors.',
    art: {
      mode: 'physical-card',
      src: '/card-images/397269_charizard.jpg?v=ct397',
      card: 'Charizard · Team Up 014/181',
      reason: 'Bordered desk hero — keep the physical card emerging, never stretch-cover.',
      pose: 'rise-center',
    },
  },
  {
    label: 'Scan',
    tone: 'b',
    body: 'Point the phone, lock the printing, list or collect without retyping the set.',
    art: {
      mode: 'full-art',
      src: '/card-images/401454_elesa-s-sparkle-233-264-fusion-strike.jpg',
      card: "Elesa's Sparkle · Fusion Strike 233/264",
      reason: 'Full-art sparkle — illustration fills the lower panel as an editorial crop.',
      pose: 'bleed-corner',
    },
  },
  {
    label: 'Wallet',
    tone: 'c',
    body: 'Hold PKN, send, and settle peer trades without leaving the product.',
    art: {
      mode: 'full-art',
      src: '/card-images/612658_pikachu-ex-full-art-219-191-surging-sparks.jpg',
      card: 'Pikachu ex Full-Art · Surging Sparks 219/191',
      reason: 'Full-art electricity for native settlement energy.',
      pose: 'bleed-wide',
    },
  },
  {
    label: 'Sets',
    tone: 'd',
    body: 'Browse expansions with print flags, symbols, and checklists that respect languages.',
    art: {
      mode: 'physical-card',
      src: '/card-images/55576_clefairy-rare-holo-5-102-base-set.jpg?v=bsu2',
      card: 'Clefairy · Base Set 5/102',
      reason: 'Classic bordered set piece — physical card clipped by the pastel bottom.',
      pose: 'tilt-right',
    },
  },
  {
    label: 'Artists',
    tone: 'e',
    body: 'Album tiles for illustrators — same artwork groups, Pokédex order, real credits.',
    art: {
      mode: 'full-art',
      src: '/card-images/332900_sylveon-vmax-secret-rare-212-203-evolving-skies.jpg',
      card: 'Sylveon VMAX SIR · Evolving Skies 212/203',
      reason: 'SIR painting as album-scale editorial art.',
      pose: 'bleed-low',
    },
  },
  {
    label: 'Signal',
    tone: 'f',
    body: 'Follow the market pulse — sold books and activity without invented volume.',
    art: {
      mode: 'full-art',
      src: '/card-images/470296_mewtwo-vstar-ultra-rare-gg44-gg70-crown-zenith.jpg',
      card: 'Mewtwo VSTAR SIR · Crown Zenith GG44/GG70',
      reason: 'Illustration-heavy signal — bleed into the lower pastel, text stays clear above.',
      pose: 'bleed-corner',
    },
  },
];
