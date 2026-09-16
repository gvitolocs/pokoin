/** HTML for Discord / Slack / X and for search-engine crawlers on card URLs.
 * SPA shell has no per-card meta; crawlers do not run React.
 */

import { realPublicCardId, rewriteLeftoverCatalogImage } from './public-card-id.js';

export { realPublicCardId } from './public-card-id.js';

export const OG_CACHE_TTL_SEC = 3600;
export const OG_CACHE_VERSION = 'v5';
export const SITE = 'https://pokoin.com';
export const API_ORIGIN = 'https://api.pokoin.com';

const BOT_RE =
  /Discordbot|Twitterbot|Slackbot|LinkedInBot|facebookexternalhit|Facebot|WhatsApp|TelegramBot|SkypeUriPreview|Pinterest|Applebot|Googlebot|Google-InspectionTool|bingbot|Baiduspider|DuckDuckBot|Slack-ImgProxy|Embedly|Quora Link Preview|Showyoubot|outbrain|vkShare|W3C_Validator|redditbot|Iframely/i;

const SEARCH_BOT_RE =
  /Googlebot|Google-InspectionTool|bingbot|DuckDuckBot|Baiduspider|YandexBot|Applebot/i;

const CARD_PATH_RE =
  /^\/marketplace\/([a-z]{2}(?:-[a-z]{2})?)\/cards\/(\d+)(?:\/[^/?#]*)?\/?$/i;

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
  return { language: match[1].toLowerCase(), cardId: realPublicCardId(match[2]) };
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
} = {}) {
  const seo = cardPage?.seo || {};
  const card = cardPage?.card || {};
  const title =
    seo.title ||
    [card.name, card.set || card.set_name].filter(Boolean).join(' · ') ||
    `Card ${cardId} · Pokoin`;
  const description = includeDescription ? String(seo.description || '') : '';
  const image = absoluteUrl(
    rewriteLeftoverCatalogImage(
      seo.imageUrl ||
        card.heroImageUrl ||
        card.gridImageUrl ||
        card.imageUrl ||
        card.cdn_image_url ||
        card.tileImageUrl,
      cardId || card.id,
    ),
  );
  const path =
    seo.canonicalPath ||
    cardPage?.canonicalPath ||
    card.canonicalPath ||
    `/marketplace/${language}/cards/${cardId}`;
  const url = requestUrl || absoluteUrl(path);
  const setName = String(card.set || card.set_name || '').trim();
  const artist = String(card.artist || card.illustrator || cardPage?.artist?.name || '').trim();
  const cheapest = Array.isArray(cardPage?.cheapest) ? cardPage.cheapest[0] : cardPage?.cheapest;
  const pricePkn = Number(cheapest?.pricePkn || card.price || card.lowest_price_pkn || 0);
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
    pricePkn: Number.isFinite(pricePkn) && pricePkn > 0 ? pricePkn : 0,
    setHref: setName ? `/marketplace/sets/${setSlug(setName)}` : '',
    artistHref: artist ? `/marketplace/${language}/artists/${artistSlug(artist)}` : '',
    neighbors,
  };
}

function productJsonLd(payload) {
  const offer = payload.pricePkn
    ? {
      '@type': 'Offer',
      priceCurrency: 'PKN',
      price: payload.pricePkn,
      availability: 'https://schema.org/InStock',
    }
    : {
      '@type': 'Offer',
      priceCurrency: 'PKN',
      availability: 'https://schema.org/OutOfStock',
    };
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: payload.name || payload.title,
    description: payload.description || payload.title,
    image: payload.image,
    sku: payload.cardId,
    brand: { '@type': 'Brand', name: 'Pokémon TCG' },
    url: payload.url,
    offers: offer,
  };
}

export function renderCardOgHtml(payload) {
  const title = escapeHtml(payload.title);
  const description = escapeHtml(payload.description);
  const image = escapeHtml(payload.image);
  const url = escapeHtml(payload.url);
  const path = escapeHtml(payload.path || '/marketplace');
  const h1 = escapeHtml(payload.name || payload.title);
  const imageAlt = escapeHtml([payload.name, payload.setName, payload.number, 'Pokemon card'].filter(Boolean).join(' ') || payload.title);
  const imageType = /\.webp(?:$|\?)/i.test(payload.image || '')
    ? 'image/webp'
    : /\.png(?:$|\?)/i.test(payload.image || '')
      ? 'image/png'
      : 'image/jpeg';
  const descriptionMeta = description
    ? `\n  <meta name="description" content="${description}" />\n  <meta property="og:description" content="${description}" />\n  <meta name="twitter:description" content="${description}" />`
    : '';
  const crumbs = [
    '<a href="/marketplace">Marketplace</a>',
    payload.setHref ? `<a href="${escapeHtml(payload.setHref)}">${escapeHtml(payload.setName)}</a>` : '',
    payload.artistHref ? `<a href="${escapeHtml(payload.artistHref)}">${escapeHtml(payload.artist)}</a>` : '',
  ].filter(Boolean).join(' / ');
  const neighborLinks = (payload.neighbors || []).slice(0, 8).map((row) => {
    const id = String(row.id || row.card_id || '');
    const name = escapeHtml(row.name || id);
    const href = escapeHtml(row.canonicalPath || row.canonical_path || `/marketplace/${payload.language || 'en'}/cards/${id}`);
    return `<li><a href="${href}">${name}</a></li>`;
  }).join('');
  const jsonLd = payload.name
    ? `\n  <script type="application/ld+json">${JSON.stringify(productJsonLd(payload)).replace(/</g, '\\u003c')}</script>`
    : '';
  const descriptionBody = description ? `\n  <p>${description}</p>` : '';
  const extra = payload.name
    ? `\n  <h1>${h1}</h1>\n  <nav>${crumbs}</nav>${descriptionBody}${neighborLinks ? `\n  <ul>${neighborLinks}</ul>` : ''}`
    : `\n  <p><a href="${path}">${title}</a></p>${descriptionBody}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>${descriptionMeta}
  <link rel="canonical" href="${url}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Pokoin" />
  <meta property="og:locale" content="en_US" />
  <meta property="og:title" content="${title}" />
  <meta property="og:url" content="${url}" />
  <meta property="og:image" content="${image}" />
  <meta property="og:image:secure_url" content="${image}" />
  <meta property="og:image:type" content="${imageType}" />
  <meta property="og:image:alt" content="${title}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:image" content="${image}" />${jsonLd}
</head>
<body>${extra}
  <img src="${image}" alt="${imageAlt}" width="400" height="560" />
</body>
</html>`;
}

async function fetchCardPage(cardId, language, game = '') {
  const params = new URLSearchParams({
    cardId: String(cardId),
    language: String(language || 'en'),
    includeOffers: '0',
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
  const game = apiGameFromHost(url.hostname);
  const cache = caches.default;
  const cacheKey = new Request(
    `${site}/__og/${OG_CACHE_VERSION}/card/${game || 'pokemon'}/${parsed.language}/${parsed.cardId}/${search ? 'search' : 'social'}`,
    { method: 'GET' },
  );
  const hit = await cache.match(cacheKey);
  if (hit && !force) {
    const headers = new Headers(hit.headers);
    headers.set('x-pokoin-og-cache', 'hit');
    return new Response(hit.body, { status: hit.status, headers });
  }

  let page;
  try {
    page = await fetchCardPage(parsed.cardId, parsed.language, game);
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
  });
  payload.image = absoluteUrl(
    rewriteLeftoverCatalogImage(
      page?.seo?.imageUrl ||
        page?.card?.heroImageUrl ||
        page?.card?.imageUrl ||
        '',
      parsed.cardId,
    ),
    site,
  );
  const html = renderCardOgHtml(payload);
  const response = new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': `public, max-age=300, s-maxage=${OG_CACHE_TTL_SEC}`,
      'x-pokoin-og-cache': 'miss',
      'x-robots-tag': search ? 'index, follow' : 'noindex',
    },
  });
  if (ctx?.waitUntil) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}
