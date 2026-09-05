/** Open Graph HTML for Discord / Slack / X when they hit a card URL.
 * SPA shell has no per-card meta; crawlers do not run React.
 */

export const OG_CACHE_TTL_SEC = 3600;
export const SITE = 'https://pokoin.com';
export const API_ORIGIN = 'https://api.pokoin.com';

const BOT_RE =
  /Discordbot|Twitterbot|Slackbot|LinkedInBot|facebookexternalhit|Facebot|WhatsApp|TelegramBot|SkypeUriPreview|Pinterest|Applebot|Googlebot|bingbot|Baiduspider|DuckDuckBot|Slack-ImgProxy|Embedly|Quora Link Preview|Showyoubot|outbrain|vkShare|W3C_Validator|redditbot|Iframely/i;

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

export function parseCardPath(pathname) {
  const match = String(pathname || '').match(CARD_PATH_RE);
  if (!match) {
    return null;
  }
  return { language: match[1].toLowerCase(), cardId: match[2] };
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

export function buildCardOgPayload(cardPage, { language = 'en', cardId, requestUrl } = {}) {
  const seo = cardPage?.seo || {};
  const card = cardPage?.card || {};
  const title =
    seo.title ||
    [card.name, card.set || card.set_name].filter(Boolean).join(' · ') ||
    `Card ${cardId} · Pokoin`;
  const description =
    seo.description ||
    [card.name, card.rarity, card.set || card.set_name].filter(Boolean).join(' · ') ||
    'Buy and sell Pokémon cards on Pokoin. Settle in PKN.';
  const image = absoluteUrl(
    seo.imageUrl ||
      card.heroImageUrl ||
      card.gridImageUrl ||
      card.imageUrl ||
      card.cdn_image_url ||
      card.tileImageUrl,
  );
  const path =
    seo.canonicalPath ||
    cardPage?.canonicalPath ||
    card.canonicalPath ||
    `/marketplace/${language}/cards/${cardId}`;
  const url = requestUrl || absoluteUrl(path);
  return { title, description, image, url, path, cardId: String(cardId || card.id || '') };
}

export function renderCardOgHtml(payload) {
  const title = escapeHtml(payload.title);
  const description = escapeHtml(payload.description);
  const image = escapeHtml(payload.image);
  const url = escapeHtml(payload.url);
  const path = escapeHtml(payload.path || '/marketplace');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <meta name="description" content="${description}" />
  <link rel="canonical" href="${url}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Pokoin" />
  <meta property="og:locale" content="en_US" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:url" content="${url}" />
  <meta property="og:image" content="${image}" />
  <meta property="og:image:alt" content="${title}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  <meta name="twitter:image" content="${image}" />
  <meta http-equiv="refresh" content="0;url=${path}" />
</head>
<body>
  <p><a href="${path}">${title}</a></p>
  <p>${description}</p>
  <img src="${image}" alt="${title}" width="400" height="560" />
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
  if (!isLinkPreviewBot(request.headers.get('user-agent'), force)) {
    return null;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return null;
  }
  const parsed = parseCardPath(url.pathname);
  if (!parsed) {
    return null;
  }

  const site = siteOriginFromHost(url.hostname);
  const game = apiGameFromHost(url.hostname);
  const cache = caches.default;
  const cacheKey = new Request(
    `${site}/__og/card/${game || 'pokemon'}/${parsed.language}/${parsed.cardId}`,
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

  const payload = buildCardOgPayload(page, {
    language: parsed.language,
    cardId: parsed.cardId,
    requestUrl: `${site}${url.pathname.replace(/\/$/, '')}`,
  });
  payload.image = absoluteUrl(
    page?.seo?.imageUrl ||
      page?.card?.heroImageUrl ||
      page?.card?.imageUrl ||
      '',
    site,
  );
  const html = renderCardOgHtml(payload);
  const response = new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': `public, max-age=300, s-maxage=${OG_CACHE_TTL_SEC}`,
      'x-pokoin-og-cache': 'miss',
      'x-robots-tag': 'noindex',
    },
  });
  if (ctx?.waitUntil) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}
