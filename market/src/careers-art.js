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
