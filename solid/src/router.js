import { lazy } from 'solid-js';
import { createRouter } from '@solidjs/router';
import { fetchCard, warmupCard } from '@market/api.js';
import { realPublicCardId } from '@market/card-stub.js';
import { gameBasename } from '@market/game.js';
import { peekHandoffCard } from './lib/card-handoff.js';
import { localIntentPreload, localViewportPreload, prefetchAfterDesk } from './lib/local-prefetch.js';
import Home from './pages/Home.jsx';
import NotMigrated from './pages/NotMigrated.jsx';
import RedirectTo from './pages/RedirectTo.jsx';
import { preloadSearch } from './lib/search-preload.js';

const Search = lazy(() => import('./pages/Search.jsx'));

/**
 * Migrated routes only. Every other URL renders NotMigrated, which hands the
 * page to the React UI (same URL) once the boot switch exists; see
 * docs/frontend-perf/PLAN.md "Coexistence". Home stays eager — it is the
 * landing; every other page is its own chunk.
 *
 * Preloading (lib/local-prefetch.js): intent (hover 60 ms / focus / touchstart)
 * warms the route chunk and puts the page's data in the local store before the
 * click; the first visible tiles and a desk's related cards prefetch at idle.
 */
const Card = lazy(() => import('./pages/Card.jsx'));
const Versions = lazy(() => import('./pages/Versions.jsx'));

/**
 * Card desk data: an explicit route preload (intent "preload") warms the page,
 * listings and hero scan like React's tile warmup; a navigation starts the
 * card-page request while the desk chunk loads, and the desk adopts it
 * (fetchCard dedupes in-flight requests). Once it lands, the desk's related
 * cards and its set prefetch at idle.
 */
function preloadCard({ params, intent }) {
  const id = realPublicCardId(params.cardId);
  if (!id) return;
  const lang = params.lang || 'en';
  if (intent === 'preload') {
    warmupCard(peekHandoffCard(id) || { id }, { lang, listings: true });
    return;
  }
  fetchCard(id, { lang, slug: params.slug || '' }).then((page) => prefetchAfterDesk(page, { lang })).catch(() => {});
}

export const Router = createRouter({
  base: gameBasename(),
  preloadLinks: [localIntentPreload(), localViewportPreload()],
  routes: [
    { path: '/', component: RedirectTo, info: { to: '/marketplace' } },
    { path: '/marketplace', component: Home },
    { path: '/marketplace/search', component: Search, preload: preloadSearch },
    { path: '/marketplace/:lang/cards/:cardId/:slug/versions', component: Versions },
    { path: '/marketplace/:lang/cards/:cardId/versions', component: Versions },
    { path: '/marketplace/:lang/cards/:cardId/:slug?', component: Card, preload: preloadCard },
    { path: '*404', component: NotMigrated },
  ],
});

export const { paths } = Router;
