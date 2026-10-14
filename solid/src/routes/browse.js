import { lazy } from 'solid-js';
import RedirectTo from '../pages/RedirectTo.jsx';

/**
 * Public browse pages: catalog hubs, set desks, artists, product aisles, shops,
 * the competitive snapshot, the site map and the static site pages. Same URLs
 * as market/src/App.jsx; every page is its own chunk.
 */
const Sets = lazy(() => import('../pages/Sets.jsx'));
const Era = lazy(() => import('../pages/Era.jsx'));
const Expansion = lazy(() => import('../pages/Expansion.jsx'));
const PokemonHub = lazy(() => import('../pages/PokemonHub.jsx'));
const RarityHub = lazy(() => import('../pages/RarityHub.jsx'));
const LanguageHub = lazy(() => import('../pages/LanguageHub.jsx'));
const Guides = lazy(() => import('../pages/Guides.jsx'));
const Products = lazy(() => import('../pages/Products.jsx'));
const Watchlist = lazy(() => import('../pages/Watchlist.jsx'));
const Explore = lazy(() => import('../pages/Explore.jsx'));
const Artist = lazy(() => import('../pages/Artist.jsx'));
const Seller = lazy(() => import('../pages/Seller.jsx'));
const Site = lazy(() => import('../pages/Site.jsx'));
const SiteMap = lazy(() => import('../pages/SiteMap.jsx'));
const Competitive = lazy(() => import('../pages/Competitive.jsx'));
const CompetitiveTournaments = lazy(() => import('../pages/CompetitiveTournaments.jsx'));
const CompetitiveDecks = lazy(() => import('../pages/CompetitiveDecks.jsx'));
const CompetitiveDecklist = lazy(() => import('../pages/CompetitiveDecklist.jsx'));
const CompetitivePlayers = lazy(() => import('../pages/CompetitivePlayers.jsx'));
const CompetitiveCards = lazy(() => import('../pages/CompetitiveCards.jsx'));

export default [
  { path: '/marketplace/explore', component: Explore },
  { path: '/marketplace/watchlist', component: Watchlist },
  { path: '/favorites', component: Watchlist },
  { path: '/product', component: RedirectTo, info: { to: '/product/box' } },
  { path: '/product/:kind', component: Products },
  { path: '/marketplace/competitive', component: Competitive },
  { path: '/marketplace/competitive/tournaments/:id?', component: CompetitiveTournaments },
  { path: '/marketplace/competitive/decks/:deckId?', component: CompetitiveDecks },
  { path: '/marketplace/competitive/decklists/:decklistId', component: CompetitiveDecklist },
  { path: '/marketplace/competitive/players/:playerId?', component: CompetitivePlayers },
  { path: '/marketplace/competitive/cards/:cardId?', component: CompetitiveCards },
  { path: '/marketplace/sets', component: Sets },
  { path: '/marketplace/eras/:eraId?', component: Era },
  { path: '/marketplace/sets/:slug', component: Expansion },
  { path: '/marketplace/:lang/artists/:artistSlug?', component: Artist },
  { path: '/marketplace/:lang/users/:username', component: Seller },
  { path: '/marketplace/:lang/pokemon/:slug?', component: PokemonHub },
  { path: '/marketplace/:lang/rarities/:slug?', component: RarityHub },
  { path: '/marketplace/:lang/languages/:slug?', component: LanguageHub },
  { path: '/marketplace/:lang/guides/:slug?', component: Guides },
  { path: '/docs', component: Site },
  { path: '/contact', component: Site },
  { path: '/privacy', component: Site },
  { path: '/earn', component: Site },
  { path: '/whitepaper', component: Site },
  { path: '/health', component: Site },
  { path: '/sitemap', component: SiteMap },
];
