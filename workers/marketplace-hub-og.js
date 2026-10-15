/** Search-engine HTML for catalog hubs, sets, eras, artists, and the marketplace home. */

import { GAMES, publicGamePath } from '../market/src/game.js';
import { TCG_ERA_ORDER, tcgEraYears } from '../market/src/tcg-eras.js';
import {
  API_ORIGIN,
  OG_CACHE_TTL_SEC,
  cardOgImageUrl,
  crawlerNotFound,
  crawlerUnavailable,
  OG_CACHE_VERSION,
  isLinkPreviewBot,
  isSearchEngineBot,
  redirectLocation,
  siteOriginFromHost,
  utcSnapshotDate,
} from './marketplace-card-og.js';

/** Artist and catalog lookups must not stall the edge; one artist call took ~13s. */
export const HUB_API_TIMEOUT_MS = 4000;

async function fetchHubApi(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HUB_API_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'pokoin-origin-og/1' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

const SLUG_TO_GAME = Object.fromEntries(
  Object.values(GAMES).filter((game) => game.slug).map((game) => [game.slug, game.id]),
);
const LANG_RE = /^[a-z]{2}(?:-[a-z]{2})?$/i;

function eraId(name) {
  return String(name || 'other').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'other';
}

function gameTitle(gameId) {
  return Object.values(GAMES).find((game) => game.id === (gameId || 'pokemon'))?.title || 'Pokoin marketplace';
}

const HUB_RE =
  /^\/marketplace\/([a-z]{2}(?:-[a-z]{2})?)\/(pokemon|rarities|languages|guides)(?:\/([^/?#]+))?\/?$/i;

/** First card scan as an absolute, crawlable CDN URL (og:image / JSON-LD). */
export function hubImageFromCards(cards = []) {
  for (const row of cards || []) {
    const id = row?.id || row?.card_id || '';
    const image = cardOgImageUrl(
      row?.heroImageUrl || row?.imageUrl || row?.gridImageUrl || row?.image_url || row?.cdn_image_url || '',
      id,
    );
    if (image) return image;
  }
  return '';
}

function imageMetaHtml(image, alt) {
  if (!image) return '';
  const src = escapeHtml(image);
  return `\n  <meta property="og:image" content="${src}" />\n  <meta property="og:image:alt" content="${escapeHtml(alt)}" />\n  <meta name="twitter:card" content="summary_large_image" />\n  <meta name="twitter:image" content="${src}" />`;
}

const EN_HUB_KINDS = new Set(['pokemon', 'rarities', 'languages', 'guides', 'artists']);

function marketplaceParts(pathname) {
  let path = String(pathname || '').split(/[?#]/)[0];
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const parts = path.split('/').filter(Boolean);
  const prefix = parts[0] && SLUG_TO_GAME[parts[0]] ? `/${parts.shift()}` : '';
  return { prefix, parts };
}

/**
 * Language-less species/rarity/language/guide/artist hubs. Every client 301s;
 * `_redirects` already intended this, but Workers Static Assets served the shell.
 * Returns the canonical path or ''.
 */
export function languageLessHubRedirectPath(pathname) {
  const { prefix, parts } = marketplaceParts(pathname);
  if (parts[0] !== 'marketplace' || parts.length < 2) return '';
  const rest = parts.slice(1);
  if (EN_HUB_KINDS.has(rest[0]) && rest.length <= 2) {
    return `${prefix}/marketplace/en/${rest.map((part) => part.toLowerCase()).join('/')}`;
  }
  return '';
}

/**
 * Crawler 301 for duplicate hub URLs that otherwise served the empty SPA shell
 * or a self-canonical copy: locale-less hubs (also redirected for every client),
 * non-en locales (the sitemap only lists en), and locale-prefixed sets/eras
 * (canonical has no locale). Returns the canonical path or ''.
 */
export function hubRedirectPath(pathname) {
  const bare = languageLessHubRedirectPath(pathname);
  if (bare) return bare;
  const { prefix, parts } = marketplaceParts(pathname);
  if (parts[0] !== 'marketplace' || parts.length < 2) return '';
  const rest = parts.slice(1);
  if (LANG_RE.test(rest[0]) && rest.length >= 2 && rest.length <= 3) {
    const kind = rest[1].toLowerCase();
    if (kind === 'sets' || kind === 'eras') {
      return `${prefix}/marketplace/${rest.slice(1).join('/')}`;
    }
    if (EN_HUB_KINDS.has(kind) && rest[0].toLowerCase() !== 'en') {
      return `${prefix}/marketplace/en/${rest.slice(1).join('/')}`;
    }
  }
  return '';
}

function crawlerRedirect(location) {
  return new Response(null, {
    status: 301,
    headers: { location, 'cache-control': 'public, max-age=3600' },
  });
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function labelFromSlug(slug) {
  return String(slug || '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export function parseHubPath(pathname) {
  const match = String(pathname || '').match(HUB_RE);
  if (!match) {
    return null;
  }
  return {
    language: match[1].toLowerCase(),
    kind: match[2].toLowerCase(),
    slug: match[3] ? String(match[3]).toLowerCase() : '',
  };
}

export function hubSeo(parsed) {
  const lang = parsed.language || 'en';
  const root = `/marketplace/${lang}/${parsed.kind}`;
  const path = parsed.slug ? `${root}/${parsed.slug}` : root;
  if (parsed.kind === 'pokemon') {
    const name = parsed.slug ? labelFromSlug(parsed.slug) : '';
    return {
      path,
      title: name
        ? `${name} Pokémon Cards: Full List & Prices | Pokoin`
        : 'Pokémon Cards by Species | Pokoin',
      heading: name ? `${name} Pokémon Cards` : 'Pokémon Cards',
      description: name
        ? `Browse every ${name} Pokémon TCG card. Compare versions, languages, prices and cards currently available for sale.`
        : 'Browse Pokémon TCG cards by National Dex species.',
    };
  }
  if (parsed.kind === 'rarities') {
    const name = parsed.slug ? labelFromSlug(parsed.slug) : '';
    return {
      path,
      title: name ? `${name} Pokémon Cards | Pokoin` : 'Pokémon Card Rarities | Pokoin',
      heading: name ? `${name} Pokémon Cards` : 'Rarities',
      description: name
        ? `${name} Pokémon TCG printings on Pokoin.`
        : 'Browse Pokémon TCG cards by rarity.',
    };
  }
  if (parsed.kind === 'languages') {
    const name = parsed.slug ? labelFromSlug(parsed.slug) : '';
    return {
      path,
      title: name ? `${name} Pokémon Cards | Pokoin` : 'Pokémon Card Languages | Pokoin',
      heading: name ? `${name} Pokémon Cards` : 'Languages',
      description: name
        ? `${name} Pokémon TCG expansions and printings on Pokoin.`
        : 'Browse Pokémon TCG expansions by print language.',
    };
  }
  const name = parsed.slug ? labelFromSlug(parsed.slug) : '';
  return {
    path,
    title: name ? `${name} | Pokoin` : 'Pokémon Card Guides | Pokoin',
    heading: name || 'Pokémon card guides',
    description: name
      ? `${name} on Pokoin.`
      : 'Short Pokoin guides: card condition, rarity, and how listed PKN works.',
  };
}

export function renderHubOgHtml(parsed, cards = [], image = hubImageFromCards(cards)) {
  const seo = hubSeo(parsed);
  const title = escapeHtml(seo.title);
  const heading = escapeHtml(seo.heading);
  const description = escapeHtml(seo.description);
  const path = escapeHtml(seo.path);
  const indexHref = `/marketplace/${escapeHtml(parsed.language)}/${escapeHtml(parsed.kind)}`;
  const links = (cards || []).slice(0, 24).map((row) => {
    const href = escapeHtml(row.canonicalPath || row.canonical_path || `/marketplace/${parsed.language}/cards/${row.id || row.card_id}`);
    const name = escapeHtml(row.name || row.id || '');
    return `<li><a href="${href}">${name}</a></li>`;
  }).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <meta name="description" content="${description}" />
  <link rel="canonical" href="https://pokoin.com${path}" />
  <meta property="og:title" content="${title}" />
  <meta name="robots" content="index, follow, max-image-preview:large" />
  <meta property="og:url" content="https://pokoin.com${path}" />${imageMetaHtml(image, seo.heading)}
  <script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: seo.title,
    description: seo.description,
    url: `https://pokoin.com${seo.path}`,
    ...(image ? { image } : {}),
    isPartOf: { '@type': 'WebSite', name: 'Pokoin', url: 'https://pokoin.com' },
    dateModified: utcSnapshotDate(),
  }).replace(/</g, '\\u003c')}</script>
</head>
<body>
  <nav><a href="/marketplace">Marketplace</a> / <a href="${indexHref}">${escapeHtml(parsed.kind)}</a></nav>
  <h1>${heading}</h1>
  <p>${description}</p>
  <p>Prices in PKN on <a href="https://pokoin.com">Pokoin</a>, the collectors' marketplace.</p>
  ${links ? `<ul>${links}</ul>` : ''}
</body>
</html>`;
}

async function fetchHubCards(parsed) {
  if (!parsed.slug || parsed.kind === 'guides' || parsed.kind === 'languages') {
    return [];
  }
  const query = labelFromSlug(parsed.slug);
  const params = new URLSearchParams({
    query,
    limit: '24',
    includeFacets: '0',
    productType: 'card',
  });
  const response = await fetchHubApi(`${API_ORIGIN}/api/marketplace-search-page?${params}`);
  if (!response.ok) {
    const error = new Error(`hub-search ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  return data.cards || [];
}

/**
 * Sitemap surfaces that were only the SPA shell: home, sets, eras, artists.
 * Existing species/rarity/language/guide hubs stay on parseHubPath.
 */
export function parseCatalogPath(pathname) {
  let path = String(pathname || '').split(/[?#]/)[0];
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const parts = path.split('/').filter(Boolean);
  let game = '';
  if (parts[0] && SLUG_TO_GAME[parts[0]]) {
    game = SLUG_TO_GAME[parts[0]];
    parts.shift();
  }
  if (parts[0] !== 'marketplace') return null;
  const rest = parts.slice(1);
  if (rest.length === 0) {
    return { kind: 'home', game, language: 'en', slug: '' };
  }
  if (rest[0] === 'sets' && rest.length <= 2) {
    return { kind: 'sets', game, language: 'en', slug: String(rest[1] || '').toLowerCase() };
  }
  if (rest[0] === 'eras' && rest.length <= 2) {
    return { kind: 'eras', game, language: 'en', slug: String(rest[1] || '').toLowerCase() };
  }
  if (rest.length >= 2 && rest.length <= 3 && LANG_RE.test(rest[0]) && rest[1] === 'artists') {
    return {
      kind: 'artists',
      game,
      language: rest[0].toLowerCase(),
      slug: String(rest[2] || '').toLowerCase(),
    };
  }
  return null;
}

export function catalogSeo(parsed, { name = '' } = {}) {
  const apply = (href) => publicGamePath(href, parsed.game || '') || href;
  if (parsed.kind === 'home') {
    return {
      path: apply('/marketplace'),
      type: 'WebPage',
      title: gameTitle(parsed.game),
      heading: 'Marketplace',
      description: 'Buy and sell Pokémon TCG cards in PKN. Browse Pokémon, sets, eras, artists, and listings.',
      robots: '',
    };
  }
  if (parsed.kind === 'sets') {
    const setName = String(name || '').trim() || (parsed.slug ? labelFromSlug(parsed.slug) : '');
    return {
      path: apply(parsed.slug ? `/marketplace/sets/${parsed.slug}` : '/marketplace/sets'),
      type: 'CollectionPage',
      title: setName
        ? `${setName} Card List, Prices & Values | Pokoin`
        : 'Pokémon TCG Set List, Prices & Values | Pokoin',
      heading: setName || 'Sets',
      description: setName
        ? `${setName} card list with prices and values on Pokoin.`
        : 'Pokémon expansions from the marketplace catalog: English, Japanese, and Chinese sets with card lists and prices.',
      robots: '',
    };
  }
  if (parsed.kind === 'eras') {
    const eraName = parsed.slug
      ? (TCG_ERA_ORDER.find((era) => eraId(era) === parsed.slug) || '')
      : '';
    if (parsed.slug && !eraName) {
      return {
        path: apply('/marketplace/eras'),
        type: 'CollectionPage',
        title: 'Pokémon TCG Eras | Pokoin',
        heading: 'Eras',
        description: 'Pokémon TCG blocks. JP, EN, and CN of the same generation stay together.',
        robots: 'noindex, follow',
      };
    }
    const years = eraName ? tcgEraYears(eraName) : '';
    return {
      path: apply(eraName ? `/marketplace/eras/${eraId(eraName)}` : '/marketplace/eras'),
      type: 'CollectionPage',
      title: eraName ? `${eraName} Pokémon TCG Sets | Pokoin` : 'Pokémon TCG Eras | Pokoin',
      heading: eraName || 'Eras',
      description: eraName
        ? (years
          ? `${eraName} Pokémon TCG sets (${years}). English, Japanese, and Chinese expansions in this block.`
          : `${eraName} Pokémon TCG sets. English, Japanese, and Chinese expansions in this block.`)
        : 'Pokémon TCG blocks. JP, EN, and CN of the same generation stay together.',
      robots: '',
    };
  }
  const artist = parsed.slug ? labelFromSlug(parsed.slug) : '';
  const lang = parsed.language || 'en';
  return {
    path: apply(artist ? `/marketplace/${lang}/artists/${parsed.slug}` : `/marketplace/${lang}/artists`),
    type: 'CollectionPage',
    title: artist ? `${artist} Pokémon Cards & Values | Pokoin` : 'Pokémon Card Artists | Pokoin',
    heading: artist || 'Pokémon Card Artists',
    description: artist
      ? `${artist} Pokémon card illustrations and values on Pokoin.`
      : 'Pokémon TCG illustrators. Open an artist for the cards they painted.',
    robots: '',
  };
}

export function renderCatalogOgHtml(seo, links = [], image = '') {
  const title = escapeHtml(seo.title);
  const heading = escapeHtml(seo.heading);
  const description = escapeHtml(seo.description);
  const path = escapeHtml(seo.path);
  const type = seo.type === 'WebPage' ? 'WebPage' : 'CollectionPage';
  const robots = seo.robots
    ? `\n  <meta name="robots" content="${escapeHtml(seo.robots)}" />`
    : '\n  <meta name="robots" content="index, follow, max-image-preview:large" />';
  const items = (links || []).slice(0, 24).map((row) => {
    const href = escapeHtml(row.href || row.canonicalPath || '');
    const name = escapeHtml(row.name || '');
    if (!href || !name) return '';
    return `<li><a href="${href}">${name}</a></li>`;
  }).filter(Boolean).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <meta name="description" content="${description}" />
  <link rel="canonical" href="https://pokoin.com${path}" />${robots}
  <meta property="og:title" content="${title}" />
  <meta property="og:url" content="https://pokoin.com${path}" />${imageMetaHtml(image, seo.heading)}
  <script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': type,
    name: seo.title,
    description: seo.description,
    url: `https://pokoin.com${seo.path}`,
    ...(image ? { image } : {}),
    isPartOf: { '@type': 'WebSite', name: 'Pokoin', url: 'https://pokoin.com' },
    dateModified: utcSnapshotDate(),
  }).replace(/</g, '\\u003c')}</script>
</head>
<body>
  <nav><a href="/marketplace">Marketplace</a></nav>
  <h1>${heading}</h1>
  <p>${description}</p>
  <p>Prices in PKN on <a href="https://pokoin.com">Pokoin</a>, the collectors' marketplace.</p>
  ${items ? `<ul>${items}</ul>` : ''}
</body>
</html>`;
}

async function fetchCatalogExtras(parsed) {
  if (parsed.kind === 'eras' && !parsed.slug) {
    return {
      name: '',
      links: TCG_ERA_ORDER.map((name) => ({
        name,
        href: publicGamePath(`/marketplace/eras/${eraId(name)}`, parsed.game || '') || `/marketplace/eras/${eraId(name)}`,
      })),
    };
  }
  if (parsed.kind === 'artists' && parsed.slug) {
    const params = new URLSearchParams({ slug: parsed.slug, limit: '12' });
    if (parsed.game) params.set('game', parsed.game);
    const response = await fetchHubApi(`${API_ORIGIN}/api/marketplace-artist-cards?${params}`);
    if (response.status === 404) return { name: '', links: [], notFound: true };
    if (!response.ok) throw new Error(`artist-cards ${response.status}`);
    const data = await response.json();
    if (!data?.artist) return { name: '', links: [], notFound: true };
    const cards = (data.cards || []).slice(0, 12);
    return {
      name: data.artist.name || '',
      image: hubImageFromCards(cards),
      links: cards.map((row) => ({
        name: row.name || '',
        href: row.canonical_path || row.canonicalPath
          || (row.card_id || row.id ? `/marketplace/en/cards/${row.card_id || row.id}` : ''),
      })),
    };
  }
  if (parsed.kind !== 'sets') return { name: '', links: [] };
  const params = new URLSearchParams();
  if (parsed.game) params.set('game', parsed.game);
  if (parsed.slug) {
    params.set('slug', parsed.slug);
    params.set('includeCards', '1');
    params.set('limit', '12');
  } else {
    params.set('limit', '24');
  }
  const response = await fetchHubApi(`${API_ORIGIN}/api/marketplace-expansion-page?${params}`);
  if (parsed.slug && response.status === 404) return { name: '', links: [], notFound: true };
  if (!response.ok) throw new Error(`expansion-page ${response.status}`);
  const data = await response.json();
  if (parsed.slug) {
    if (!data?.expansion) return { name: '', links: [], notFound: true };
    const name = data.expansion?.name || '';
    const cards = (data.cards || []).slice(0, 12);
    const links = cards.map((row) => ({
      name: row.name || '',
      href: row.canonical_path || row.canonicalPath || '',
    }));
    return { name, links, image: hubImageFromCards(cards) };
  }
  return {
    name: '',
    links: (data.expansions || []).slice(0, 24).map((row) => ({
      name: row.name || '',
      href: publicGamePath(`/marketplace/sets/${row.slug}`, parsed.game || '') || `/marketplace/sets/${row.slug}`,
    })),
  };
}

async function handleCatalogOg(request, env, ctx, parsed) {
  const url = new URL(request.url);
  const force = url.searchParams.get('og') === '1' || url.searchParams.get('bot') === '1';
  const searchBot = isSearchEngineBot(request.headers.get('user-agent'));
  const site = siteOriginFromHost(url.hostname);
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(
    `${site}/__og/${OG_CACHE_VERSION}/catalog/${parsed.game || 'pokemon'}/${parsed.kind}/${parsed.language}/${parsed.slug || '_index'}`,
    { method: 'GET' },
  );
  if (cache && !force) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const headers = new Headers(hit.headers);
        headers.set('x-pokoin-og-cache', 'hit');
        return new Response(hit.body, { status: hit.status, headers });
      }
    } catch (_) {
      /* miss */
    }
  }
  if (searchBot && parsed.kind === 'eras' && parsed.slug
      && !TCG_ERA_ORDER.some((era) => eraId(era) === parsed.slug)) {
    return crawlerNotFound();
  }
  let extras = { name: '', links: [] };
  let lookupFailed = false;
  try {
    extras = await fetchCatalogExtras(parsed);
  } catch (_) {
    // A search crawler must not cache a thin page. ?og=1 on a browser keeps
    // the previous 200 fallback; preview bots never reach this handler.
    if (searchBot) return crawlerUnavailable();
    lookupFailed = true;
    extras = { name: '', links: [] };
  }
  if (extras?.notFound) {
    if (searchBot) return crawlerNotFound();
    lookupFailed = true;
    extras = { name: '', links: [] };
  }
  const seo = catalogSeo(parsed, { name: extras.name });
  const html = renderCatalogOgHtml(seo, extras.links, extras.image || '');
  const response = new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': `public, max-age=300, s-maxage=${OG_CACHE_TTL_SEC}`,
      'x-pokoin-og-cache': 'miss',
      'x-robots-tag': seo.robots || 'index, follow',
    },
  });
  if (cache?.put && ctx?.waitUntil && !lookupFailed) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {}));
  }
  return response;
}

export async function handleMarketplaceHubOgRequest(request, env, ctx) {
  try {
    return await handleHubOg(request, env, ctx);
  } catch (_) {
    return null;
  }
}

async function handleHubOg(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return null;
  }
  const bareHub = languageLessHubRedirectPath(url.pathname);
  if (bareHub) return crawlerRedirect(redirectLocation(url, bareHub));
  const force = url.searchParams.get('og') === '1' || url.searchParams.get('bot') === '1';
  const userAgent = request.headers.get('user-agent');
  // Search crawlers missing from the link-preview list (YandexBot) still enter.
  if (!isLinkPreviewBot(userAgent, force) && !isSearchEngineBot(userAgent)) {
    return null;
  }
  if (isSearchEngineBot(userAgent) && !force) {
    const target = hubRedirectPath(url.pathname);
    if (target) return crawlerRedirect(`${siteOriginFromHost(url.hostname)}${target}${url.search}`);
  }
  const catalog = parseCatalogPath(url.pathname);
  if (catalog && (isSearchEngineBot(userAgent) || force)) {
    return handleCatalogOg(request, env, ctx, catalog);
  }
  const parsed = parseHubPath(url.pathname);
  if (!parsed) {
    return null;
  }
  const search = isSearchEngineBot(userAgent) || force;
  const searchBot = isSearchEngineBot(userAgent);
  if (!search) {
    return null;
  }
  const site = siteOriginFromHost(url.hostname);
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(
    `${site}/__og/${OG_CACHE_VERSION}/hub/${parsed.language}/${parsed.kind}/${parsed.slug || '_index'}`,
    { method: 'GET' },
  );
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit && !force) {
      const headers = new Headers(hit.headers);
      headers.set('x-pokoin-og-cache', 'hit');
      return new Response(hit.body, { status: hit.status, headers });
    }
  }
  let cards = [];
  let lookupFailed = false;
  try {
    cards = await fetchHubCards(parsed);
  } catch (_) {
    if (searchBot) return crawlerUnavailable();
    lookupFailed = true;
    cards = [];
  }
  const unknownHub = Boolean(parsed.slug) && (parsed.kind === 'pokemon' || parsed.kind === 'rarities') && !cards.length;
  if (searchBot && unknownHub) return crawlerNotFound();
  const html = renderHubOgHtml(parsed, cards);
  const response = new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': `public, max-age=300, s-maxage=${OG_CACHE_TTL_SEC}`,
      'x-pokoin-og-cache': 'miss',
      'x-robots-tag': 'index, follow, max-image-preview:large',
    },
  });
  if (cache && ctx?.waitUntil && !lookupFailed && !unknownHub) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {}));
  }
  return response;
}
