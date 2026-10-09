import { lazy } from 'solid-js';
import { createRouter, intentPreload } from '@solidjs/router';
import { gameBasename } from '@market/game.js';
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
export const Router = createRouter({
  base: gameBasename(),
  preloadLinks: intentPreload({ delay: 40 }),
  routes: [
    { path: '/', component: RedirectTo, info: { to: '/marketplace' } },
    { path: '/marketplace', component: Home },
    { path: '/marketplace/search', component: Search, preload: preloadSearch },
    { path: '*404', component: NotMigrated },
  ],
});

export const { paths } = Router;
