/** Search-engine HTML for Pokémon / rarity / language / guide hubs. */

import {
  API_ORIGIN,
  OG_CACHE_TTL_SEC,
  OG_CACHE_VERSION,
  isLinkPreviewBot,
  isSearchEngineBot,
  siteOriginFromHost,
} from './marketplace-card-og.js';

const HUB_RE =
  /^\/marketplace\/([a-z]{2}(?:-[a-z]{2})?)\/(pokemon|rarities|languages|guides)(?:\/([^/?#]+))?\/?$/i;

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

export function renderHubOgHtml(parsed, cards = []) {
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
  <meta property="og:url" content="https://pokoin.com${path}" />
</head>
<body>
  <nav><a href="/marketplace">Marketplace</a> / <a href="${indexHref}">${escapeHtml(parsed.kind)}</a></nav>
  <h1>${heading}</h1>
  <p>${description}</p>
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
  const response = await fetch(`${API_ORIGIN}/api/marketplace-search-page?${params}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'pokoin-origin-og/1' },
  });
  if (!response.ok) {
    return [];
  }
  const data = await response.json();
  return data.cards || [];
}

export async function handleMarketplaceHubOgRequest(request, env, ctx) {
  const url = new URL(request.url);
  const force = url.searchParams.get('og') === '1' || url.searchParams.get('bot') === '1';
  const userAgent = request.headers.get('user-agent');
  if (!isLinkPreviewBot(userAgent, force)) {
    return null;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return null;
  }
  const parsed = parseHubPath(url.pathname);
  if (!parsed) {
    return null;
  }
  const search = isSearchEngineBot(userAgent) || force;
  if (!search) {
    return null;
  }
  const site = siteOriginFromHost(url.hostname);
  const cache = caches.default;
  const cacheKey = new Request(
    `${site}/__og/${OG_CACHE_VERSION}/hub/${parsed.language}/${parsed.kind}/${parsed.slug || '_index'}`,
    { method: 'GET' },
  );
  const hit = await cache.match(cacheKey);
  if (hit && !force) {
    const headers = new Headers(hit.headers);
    headers.set('x-pokoin-og-cache', 'hit');
    return new Response(hit.body, { status: hit.status, headers });
  }
  let cards = [];
  try {
    cards = await fetchHubCards(parsed);
  } catch (_) {
    cards = [];
  }
  const html = renderHubOgHtml(parsed, cards);
  const response = new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': `public, max-age=300, s-maxage=${OG_CACHE_TTL_SEC}`,
      'x-pokoin-og-cache': 'miss',
      'x-robots-tag': 'index, follow',
    },
  });
  if (ctx?.waitUntil) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}
