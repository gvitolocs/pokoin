// DOM hooks, routes, timings and device profiles for the Pokoin benchmark.
// Keep every selector here so a rebuilt SPA (e.g. the Solid port) with the same
// markup reuses the suite unchanged.

/** CSS selectors the journeys rely on. */
export const SELECTORS = {
  // Header search (market/src/components/Chrome.jsx)
  searchInput: '#market-search',
  suggestPopup: '#market-suggest',
  // One element per visible suggestion row; rows carry data-suggest-id.
  suggestRows: '#market-suggest .suggest-list li li',
  suggestRowId: 'data-suggest-id',
  suggestEmpty: '#market-suggest .suggest-empty',

  // Print / title language toggles in the search pill.
  printLangButton: 'button[aria-label^="Card print language,"]',
  printLangMenu: 'ul.lang-menu[role="listbox"][aria-label="Card print language"]',
  titleLangButton: 'button[aria-label^="Card title language,"]',
  titleLangMenu: 'ul.lang-menu[role="listbox"][aria-label="Card title language"]',
  langOption: 'li[role="option"]',

  // Card tiles (market/src/components/CardTile.jsx); href /marketplace/:lang/cards/:id/:slug
  tile: 'a.tile',
  resultsTile: '.grid a.tile',
  // Search results page "Load more" button (market/src/pages/Search.jsx).
  loadMore: 'button.more',

  // Card desk (market/src/pages/Card.jsx)
  deskRoot: 'article.card-page',
  deskHeading: 'article.card-page .asset-header h1',
  deskSkeleton: '.skel-line',
  deskArtFrame: '.art-frame',
  deskImage: '.art-frame img',
  deskNext: 'a[aria-label="Next card in set"]',
  deskPrev: 'a[aria-label="Previous card in set"]',
};

/** In-app routes. */
export const ROUTES = {
  home: '/marketplace',
  search: (q) => `/marketplace/search?q=${encodeURIComponent(q)}`,
  searchPath: '/marketplace/search',
};

/** Extracts the card id from a desk URL or tile href. */
export const CARD_ID_RE = /\/cards\/([^/?#]+)/;

/** Visible labels of the print-language options (market/src/locale.js PRINT_LANGS). */
export const PRINT_LANG_LABELS = {
  all: 'All prints',
  western: 'Western print',
  japanese: 'Japanese print',
  chinese: 'Chinese print',
};

export const QUERIES = {
  search: 'pikachu',
  typo: 'pikahcu',
  langtypeA: 'char',
  langtypeB: 'izard',
  scroll: 'energy',
  results: 'pikachu',
};

export const TIMING = {
  keyIntervalMs: 120,        // keystroke cadence (key i is sent at start + i * interval)
  rowsTimeoutMs: 1500,       // keystroke -> rows change budget, else null
  langTimeoutMs: 5000,       // print-language click -> rows change budget, else null
  settleMs: 2000,            // quiet time after a page is ready, before measuring
  rowsStableMs: 1000,        // rows unchanged this long = results settled
  coldTailMs: 5000,          // cold/warm keep observing this long after the load event
  scrollMs: 8000,
  scrollStepPx: 500,
  scrollStepMs: 100,
  realtimeMs: 30000,
  cardTiles: 8,
  rapidNavs: 20,
  navTimeoutMs: 15000,
  readyTimeoutMs: 20000,
  gotoTimeoutMs: 60000,
  heapSampleMs: 500,
  journeyTimeoutMs: 180000,
};

/** Requests that count as API calls. */
export const API_MATCH = {
  hosts: ['api.pokoin.com'],
  pathPrefix: '/api/',
};

/** Device profiles. `{major}` in userAgent is replaced with the browser major version. */
export const PROFILES = {
  desktop: {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    cpuThrottle: 1,
    useTap: false,
    userAgent: null,
  },
  mobile: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    cpuThrottle: 4,
    useTap: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Mobile Safari/537.36',
  },
};

/** CDP Network.emulateNetworkConditions presets (Lighthouse "slow 4G"). */
export const NETWORKS = {
  slow4g: {
    offline: false,
    latency: 562.5,
    downloadThroughput: (1.6 * 1024 * 1024 * 0.9) / 8,
    uploadThroughput: (750 * 1024 * 0.9) / 8,
  },
};

/** Optional authenticated journeys (need --auth-state). They never submit anything. */
export const AUTH = {
  collectionPath: '/collection',
  collectionReady: 'main h1, .page h1',
  collectionEdit: 'button[aria-label^="Edit"]',
  collectionEditor: '[role="dialog"]',
  cartPath: '/cart',
  cartReady: '#bk-title',
  cartEmptyText: /empty/i,
  checkoutLink: 'a[href$="/checkout"], a[href*="/checkout?"]',
  checkoutPath: '/checkout',
  checkoutReady: '.page.desk h1, .page.desk form',
};

export const PUBLIC_JOURNEYS = [
  'cold', 'warm', 'search', 'typo', 'printlang', 'langtype',
  'card', 'back', 'rapid20', 'scroll', 'realtime',
];

export const AUTH_JOURNEYS = ['collection', 'checkout'];

/** compare.mjs flags a p50 increase above the threshold on these metrics. */
export const REGRESSION_METRICS = [
  'inp',
  'keys.toRowsMs',
  'keys.lastToFinalRowsMs',
  'lang.toRowsMs',
  'nav.toHeadingMs',
  'vitals.lcp',
  'tbt',
];
