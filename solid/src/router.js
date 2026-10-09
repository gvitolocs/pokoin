import { lazy } from 'solid-js';
import { createRouter, intentPreload } from '@solidjs/router';
import { fetchCard, warmupCard } from '@market/api.js';
import { realPublicCardId } from '@market/card-stub.js';
import { gameBasename } from '@market/game.js';
import { peekHandoffCard } from './lib/card-handoff.js';
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
 * Preloading: intent (hover 40 ms / focus / touchstart) warms the route chunk
 * and runs its `preload` so the desk request is in flight before the click.
 */
const Card = lazy(() => import('./pages/Card.jsx'));
const Versions = lazy(() => import('./pages/Versions.jsx'));

/**
 * Card desk data: a hovered/focused tile (intent "preload") warms the page,
 * listings and hero scan like React's tile warmup; a navigation starts the
 * card-page request while the desk chunk loads, and the desk adopts it
 * (fetchCard dedupes in-flight requests).
 */
function preloadCard({ params, intent }) {
  const id = realPublicCardId(params.cardId);
  if (!id) return;
  const lang = params.lang || 'en';
  if (intent === 'preload') {
    warmupCard(peekHandoffCard(id) || { id }, { lang, listings: true });
    return;
  }
  fetchCard(id, { lang, slug: params.slug || '' }).catch(() => {});
}

export const Router = createRouter({
  base: gameBasename(),
  preloadLinks: intentPreload({ delay: 40 }),
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
