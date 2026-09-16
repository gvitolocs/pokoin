import { fetchOriginOrWorking } from './working-page.js';

/** Hide Cloudflare 1033 / tunnel copy on api.pokoin.com when the Pi is unreachable. */
export default {
  async fetch(request) {
    return fetchOriginOrWorking(request);
  },
};
