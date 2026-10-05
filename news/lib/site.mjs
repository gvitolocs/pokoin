// Site-wide constants for the Pokoin News renderer (W2).
// Values that must be filled before launch are kept explicit and may be null;
// null values are never rendered.

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
];
