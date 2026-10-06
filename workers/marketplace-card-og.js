/** HTML for Discord / Slack / X and for search-engine crawlers on card URLs.
 * SPA shell has no per-card meta; crawlers do not run React.
 */

import { realPublicCardId, rewriteLeftoverCatalogImage } from './public-card-id.js';
import { crawlableCardImage } from '../scripts/card-sitemap.mjs';
import {
  aggregateLabel,
  cardCanonicalUrl,
  productStructuredData,
  purchasableOffers,
} from '../market/src/google-commerce.js';
import { publicGamePath, tcgBrandName } from '../market/src/game.js';
import { currencyFromSearch, moneyFromPkn } from '../market/src/pkn.js';

export { realPublicCardId } from './public-card-id.js';

export const OG_CACHE_TTL_SEC = 3600;
export const OG_SEARCH_CACHE_TTL_SEC = 120;
/** Bump when card JSON-LD, canonical URLs, or the crawlable scan URL change. */
export const OG_CACHE_VERSION = 'v10';
export const SITE = 'https://pokoin.com';
export const API_ORIGIN = 'https://api.pokoin.com';

/** UTC YYYY-MM-DD of the crawlable price snapshot (OG cache TTL is 1h). */
export function utcSnapshotDate(daysAhead = 0) {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

const BOT_RE =
  /Discordbot|Twitterbot|Slackbot|LinkedInBot|facebookexternalhit|Facebot|WhatsApp|TelegramBot|SkypeUriPreview|Pinterest|Applebot|Googlebot|Google-InspectionTool|Storebot-Google|AdsBot-Google|bingbot|Baiduspider|DuckDuckBot|Slack-ImgProxy|Embedly|Quora Link Preview|Showyoubot|outbrain|vkShare|W3C_Validator|redditbot|Iframely/i;

const SEARCH_BOT_RE =
  /Googlebot|Google-InspectionTool|Storebot-Google|AdsBot-Google|bingbot|DuckDuckBot|Baiduspider|YandexBot|Applebot/i;

const CARD_PATH_RE =
  /^\/(?:([a-z0-9-]+)\/)?marketplace\/([a-z]{2}(?:-[a-z]{2})?)\/cards\/(\d+)(?:\/[^/?#]*)?\/?$/i;

const GAME_SLUGS = {
  'one-piece': 'one_piece',
  riftbound: 'riftbound',
  magic: 'magic',
  yugioh: 'yugioh',
  lorcana: 'lorcana',
  'flesh-and-blood': 'flesh_and_blood',
  digimon: 'digimon',
  'dragon-ball-super': 'dragon_ball_super',
  vanguard: 'vanguard',
  'star-wars': 'star_wars',
  'union-arena': 'union_arena',
  gundam: 'gundam',
  sorcery: 'sorcery',
  palworld: 'palworld',
  cyberpunk: 'cyberpunk',
  'weiss-schwarz': 'weiss_schwarz',
  'final-fantasy': 'final_fantasy',
  'force-of-will': 'force_of_will',
  'world-of-warcraft': 'world_of_warcraft',
  'battle-spirits-saga': 'battle_spirits_saga',
  'star-wars-destiny': 'star_wars_destiny',
  'dragon-born': 'dragon_born',
  'my-little-pony': 'my_little_pony',
  'the-spoils': 'the_spoils',
};

export function siteOriginFromHost(hostname) {
  const host = String(hostname || '').toLowerCase().split(':')[0];
  if (host === 'onepiece.pokoin.com') {
    return 'https://onepiece.pokoin.com';
  }
  if (host === 'riftbound.pokoin.com') {
    return 'https://riftbound.pokoin.com';
  }
  return SITE;
}

export function apiGameFromHost(hostname) {
  const host = String(hostname || '').toLowerCase().split(':')[0];
  if (host === 'onepiece.pokoin.com') {
    return 'one_piece';
  }
  if (host === 'riftbound.pokoin.com') {
    return 'riftbound';
  }
  return '';
}

export function isLinkPreviewBot(userAgent, force = false) {
  if (force) {
    return true;
  }
  return BOT_RE.test(String(userAgent || ''));
}

export function isSearchEngineBot(userAgent) {
  return SEARCH_BOT_RE.test(String(userAgent || ''));
}

export function parseCardPath(pathname) {
  const match = String(pathname || '').match(CARD_PATH_RE);
  if (!match) {
    return null;
  }
  const slug = match[1] ? match[1].toLowerCase() : '';
  if (slug && !GAME_SLUGS[slug]) {
    return null;
  }
  return {
    language: match[2].toLowerCase(),
    cardId: realPublicCardId(match[3]),
    game: slug ? GAME_SLUGS[slug] : '',
  };
}

export function absoluteUrl(pathOrUrl, origin = SITE) {
  const raw = String(pathOrUrl || '').trim();
  if (!raw) {
    return `${origin}/pokoin-512.png`;
  }
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  return `${origin.replace(/\/$/, '')}${path}`;
}

/** Scan URL Google can fetch. Empty, the site logo, and the missing-card coin are not a card photo. */
export function cardOgImageUrl(imageUrl, cardId, origin = SITE) {
  const raw = String(imageUrl || '').trim();
  if (!raw || /pokoin-512\.png(?:$|\?)/i.test(raw) || /missing-card\.webp(?:$|\?)/i.test(raw)) {
    return '';
  }
  return crawlableCardImage(absoluteUrl(
    rewriteLeftoverCatalogImage(raw, cardId),
    origin,
  ));
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setSlug(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);
}

function artistSlug(name) {
  return setSlug(name);
}

export function buildCardOgPayload(cardPage, {
  language = 'en',
  cardId,
  requestUrl,
  includeDescription = false,
  game = '',
} = {}) {
  const seo = cardPage?.seo || {};
  const card = cardPage?.card || {};
  const title =
    seo.title ||
    [card.name, card.set || card.set_name].filter(Boolean).join(' · ') ||
    `Card ${cardId} · Pokoin`;
  const description = includeDescription ? String(seo.description || '') : '';
  const image = cardOgImageUrl(
    seo.imageUrl ||
      card.heroImageUrl ||
      card.gridImageUrl ||
      card.imageUrl ||
      card.cdn_image_url ||
      card.tileImageUrl,
    cardId || card.id,
  );
  const rawPath =
    seo.canonicalPath ||
    cardPage?.canonicalPath ||
    card.canonicalPath ||
    `/marketplace/${language}/cards/${cardId}`;
  const path = publicGamePath(rawPath, game) || rawPath;
  const url = requestUrl || absoluteUrl(path);
  const setName = String(card.set || card.set_name || '').trim();
  const artist = String(card.artist || card.illustrator || cardPage?.artist?.name || '').trim();
  const cheapest = Array.isArray(cardPage?.cheapest) ? cardPage.cheapest[0] : cardPage?.cheapest;
  const referencePkn = Number(cheapest?.pricePkn || 0);
  const offers = purchasableOffers(cardPage?.offers || []);
  const neighbors = [
    ...(cardPage?.neighbors?.prev || []),
    ...(cardPage?.neighbors?.next || []),
  ].filter((row) => row?.id || row?.card_id);
  return {
    title,
    description,
    image,
    url,
    path,
    cardId: String(cardId || card.id || ''),
    name: card.name || '',
    setName,
    number: String(card.number || card.card_number || '').trim(),
    artist,
    language,
    pricePkn: 0,
    referencePkn: Number.isFinite(referencePkn) && referencePkn > 0 ? referencePkn : 0,
    offers,
    currency: '',
    listingId: '',
    snapshotDate: utcSnapshotDate(),
    priceValidUntil: utcSnapshotDate(7),
    setHref: setName ? `/marketplace/sets/${setSlug(setName)}` : '',
    artistHref: artist ? `/marketplace/${language}/artists/${artistSlug(artist)}` : '',
    neighbors,
    game,
  };
}

function productJsonLd(payload) {
  const card = {
    id: payload.cardId,
    name: payload.name || payload.title,
    set: payload.setName,
    number: payload.number,
    artist: payload.artist,
    canonicalPath: payload.path,
    heroImageUrl: payload.image,
    game: payload.game,
  };
  const data = productStructuredData(card, {
    offers: payload.offers,
    currency: payload.currency,
    listingId: payload.listingId,
    referencePkn: payload.referencePkn,
    origin: SITE,
    game: payload.game,
  });
  data.dateModified = payload.snapshotDate;
  if (payload.description) data.description = payload.description;
  if (data.offers && payload.priceValidUntil) {
    data.offers.priceValidUntil = payload.priceValidUntil;
  }
  return data;
}

export function renderCardOgHtml(payload) {
  const title = escapeHtml(payload.title);
  const description = escapeHtml(payload.description);
  const image = escapeHtml(payload.image);
  const canonical = escapeHtml(cardCanonicalUrl({
    canonicalPath: payload.path,
    cardId: payload.cardId,
    origin: SITE,
    game: payload.game,
  }));
  const url = canonical;
  const path = escapeHtml(payload.path || '/marketplace');
  const h1 = escapeHtml(payload.name || payload.title);
  const cardLabel = payload.game ? `${tcgBrandName(payload.game)} card` : 'Pokemon card';
  const imageAlt = escapeHtml([payload.name, payload.setName, payload.number, cardLabel].filter(Boolean).join(' ') || payload.title);
  const hrefFor = (path) => escapeHtml(publicGamePath(path, payload.game) || path || '');
  const imageType = /\.webp(?:$|\?)/i.test(payload.image || '')
    ? 'image/webp'
    : /\.png(?:$|\?)/i.test(payload.image || '')
      ? 'image/png'
      : 'image/jpeg';
  const descriptionMeta = description
    ? `\n  <meta name="description" content="${description}" />\n  <meta property="og:description" content="${description}" />\n  <meta name="twitter:description" content="${description}" />`
    : '';
  const imageMeta = image
    ? `\n  <meta property="og:image" content="${image}" />\n  <meta property="og:image:secure_url" content="${image}" />\n  <meta property="og:image:type" content="${imageType}" />\n  <meta property="og:image:alt" content="${imageAlt}" />\n  <meta name="twitter:image" content="${image}" />`
    : '';
  const figure = image
    ? `\n  <img src="${image}" alt="${imageAlt}" width="630" height="880" />`
    : '';
  const crumbs = [
    `<a href="${hrefFor('/marketplace')}">Marketplace</a>`,
    payload.setHref ? `<a href="${hrefFor(payload.setHref)}">${escapeHtml(payload.setName)}</a>` : '',
    payload.artistHref ? `<a href="${hrefFor(payload.artistHref)}">${escapeHtml(payload.artist)}</a>` : '',
  ].filter(Boolean).join(' / ');
  const neighborLinks = (payload.neighbors || []).slice(0, 8).map((row) => {
    const id = String(row.id || row.card_id || '');
    const name = escapeHtml(row.name || id);
    const href = hrefFor(row.canonicalPath || row.canonical_path || `/marketplace/${payload.language || 'en'}/cards/${id}`);
    return `<li><a href="${href}">${name}</a></li>`;
  }).join('');
  const jsonLd = payload.name
    ? `\n  <script type="application/ld+json">${JSON.stringify(productJsonLd(payload)).replace(/</g, '\\u003c')}</script>`
    : '';
  const descriptionBody = description ? `\n  <p>${description}</p>` : '';
  const offerLabel = aggregateLabel(
    { name: payload.name },
    payload.offers,
    payload.currency,
  );
  const marketMoney = payload.referencePkn
    ? moneyFromPkn(payload.referencePkn, payload.currency || 'EUR')
    : null;
  const snapshotLine = offerLabel
    ? `\n  <p>In stock · ${escapeHtml(offerLabel)} · price snapshot ${escapeHtml(payload.snapshotDate)} · live prices on <a href="${SITE}">Pokoin</a></p>`
    : marketMoney && marketMoney.currency !== 'PKN' && payload.currency
      ? `\n  <p>Out of stock · minimum ${escapeHtml(marketMoney.amount)} ${escapeHtml(marketMoney.currency)} · price snapshot ${escapeHtml(payload.snapshotDate)}</p>`
      : payload.referencePkn
        ? `\n  <p>Market reference ${payload.referencePkn} PKN · price snapshot ${escapeHtml(payload.snapshotDate)} · not a Pokoin offer</p>`
        : `\n  <p>No Pokoin listing is currently for sale. Catalog prices stay on <a href="${SITE}">Pokoin</a>.</p>`;
  const robotsMeta = payload.indexable
    ? '\n  <meta name="robots" content="index, follow, max-image-preview:large" />'
    : '';
  const extra = payload.name
    ? `\n  <h1>${h1}</h1>${figure}\n  <nav>${crumbs}</nav>${descriptionBody}${snapshotLine}${neighborLinks ? `\n  <ul>${neighborLinks}</ul>` : ''}`
    : `\n  <p><a href="${path}">${title}</a></p>${figure}${descriptionBody}${snapshotLine}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>${descriptionMeta}
  <link rel="canonical" href="${canonical}" />
  <link rel="icon" type="image/png" sizes="48x48" href="https://pokoin.com/favicon-48x48.png" />${robotsMeta}
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Pokoin" />
  <meta property="og:locale" content="en_US" />
  <meta property="og:title" content="${title}" />
  <meta property="og:url" content="${url}" />${imageMeta}
  <meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}" />
  <meta name="twitter:title" content="${title}" />${jsonLd}
</head>
<body>${extra}
</body>
</html>`;
}

async function fetchCardPage(cardId, language, game = '', { includeOffers = false } = {}) {
  const params = new URLSearchParams({
    cardId: String(cardId),
    language: String(language || 'en'),
    includeOffers: includeOffers ? '1' : '0',
  });
  if (game) {
    params.set('game', game);
  }
  const response = await fetch(`${API_ORIGIN}/api/marketplace-card-page?${params}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'pokoin-origin-og/1' },
  });
  if (!response.ok) {
    throw new Error(`card-page ${response.status}`);
  }
  return response.json();
}

export async function handleMarketplaceCardOgRequest(request, env, ctx) {
  const url = new URL(request.url);
  const force = url.searchParams.get('og') === '1' || url.searchParams.get('bot') === '1';
  const userAgent = request.headers.get('user-agent');
  if (!isLinkPreviewBot(userAgent, force)) {
    return null;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return null;
  }
  const parsed = parseCardPath(url.pathname);
  if (!parsed) {
    return null;
  }

  const search = isSearchEngineBot(userAgent) && !force;
  const site = siteOriginFromHost(url.hostname);
  const game = parsed.game || apiGameFromHost(url.hostname);
  const cache = globalThis.caches?.default;
  const currency = currencyFromSearch(url.search) || (search ? 'EUR' : '');
  const listingId = String(url.searchParams.get('listing') || '').replace(/[^\w-]/g, '').slice(0, 80);
  const cacheKey = new Request(
    `${site}/__og/${OG_CACHE_VERSION}/card/${game || 'pokemon'}/${parsed.language}/${parsed.cardId}/${search ? 'search' : 'social'}/${currency || 'none'}/${listingId || 'card'}`,
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

  let page;
  try {
    page = await fetchCardPage(parsed.cardId, parsed.language, game, { includeOffers: search });
  } catch (_) {
    return null;
  }
  if (!page?.card && !page?.seo) {
    return null;
  }

  const remappedPath = url.pathname.replace(/\/$/, '').replace(/\/cards\/\d+/, `/cards/${parsed.cardId}`);
  const payload = buildCardOgPayload(page, {
    language: parsed.language,
    cardId: parsed.cardId,
    requestUrl: `${site}${remappedPath}`,
    includeDescription: search,
    game,
  });
  payload.currency = currency;
  payload.listingId = listingId;
  payload.indexable = search;
  payload.image = cardOgImageUrl(
    page?.seo?.imageUrl ||
      page?.card?.heroImageUrl ||
      page?.card?.imageUrl ||
      '',
    parsed.cardId,
    site,
  );
  const html = renderCardOgHtml(payload);
  const response = new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': `public, max-age=60, s-maxage=${search ? OG_SEARCH_CACHE_TTL_SEC : OG_CACHE_TTL_SEC}`,
      'x-pokoin-og-cache': 'miss',
      'x-robots-tag': search ? 'index, follow, max-image-preview:large' : 'noindex',
    },
  });
  if (cache && ctx?.waitUntil) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}
