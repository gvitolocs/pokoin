// Site-wide constants for the Pokoin News renderer (W2).
// Values that must be filled before launch are kept explicit and may be null;
// null values are never rendered.
import { readFileSync } from 'node:fs';

export const SITE = {
  baseUrl: 'https://pokoin.com',
  publicationName: 'Pokoin News',
  language: 'en',
  logoUrl: 'https://pokoin.com/pokoin-512.png',
  logoWidth: 512,
  logoHeight: 512,
  publisher: {
    name: 'Pokoin',
    url: 'https://pokoin.com',
    email: 'contact@pokoin.com',
    legalName: null,
    address: null,
  },
  fontUrl: '/home/satoshi.woff2',
  // Reader comments (GET/POST /api/news-comments); moderated before display.
  commentsApi: 'https://api.pokoin.com/api/news-comments',
  // Admin-only reading stats (GET /api/news-stats) behind /news/dashboard.
  statsApi: 'https://api.pokoin.com/api/news-stats',
  sameAs: ['https://t.me/pokoincards'],
};

export const STATIC_PAGES = [
  { slug: 'about', title: 'About Pokoin News', file: 'about.html' },
  { slug: 'editorial-policy', title: 'Editorial Policy', file: 'editorial-policy.html' },
  { slug: 'corrections', title: 'Corrections Policy', file: 'corrections.html' },
  { slug: 'methodology', title: 'Sources & Methodology', file: 'methodology.html' },
  { slug: 'contact', title: 'Contact', file: 'contact.html' },
];

export const RESERVED_SLUGS = [
  'latest',
  'sets',
  'cards',
  'market',
  'competitive',
  'collectors',
  'fact-check',
  'analysis',
  'industry',
  'authors',
  'about',
  'editorial-policy',
  'corrections',
  'methodology',
  'contact',
  'rss',
  'sitemap',
  'assets',
  'media',
  'page',
  'tags',
  'desk',
  'dashboard',
];

const FALLBACK_MANIFEST_URL = new URL('../assets/art/manifest.json', import.meta.url);
let fallbackManifest;

function loadFallbackManifest() {
  if (fallbackManifest === undefined) {
    try {
      fallbackManifest = JSON.parse(readFileSync(FALLBACK_MANIFEST_URL, 'utf8'));
    } catch {
      fallbackManifest = null;
    }
  }
  return fallbackManifest;
}

// Branded fallback hero for a section, from news/assets/art/manifest.json.
// Returns null when the manifest is missing so callers fall back gracefully.
export function fallbackHero(section) {
  const manifest = loadFallbackManifest();
  if (!manifest) return null;
  const entry = manifest[section] || manifest.industry;
  return entry ? JSON.parse(JSON.stringify(entry)) : null;
}

