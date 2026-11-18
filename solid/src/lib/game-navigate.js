import { useLocation, useNavigate } from '@solidjs/router';
import { gameHref } from '@market/game.js';
import { crossGameFullLoad } from './yield-nav.js';

/**
 * `useNavigate` with the game slug put back on.
 *
 * The router base is empty, so a bare `/marketplace/...` would drop the slug.
 * String targets that start with `/` (not `//`) go through `gameHref`. A
 * different game's page that is not the marketplace home is a full document
 * load, the same as a game-picker click off the home. Function, composed and
 * relative targets pass through untouched.
 */
export function useGameNavigate() {
  const navigate = useNavigate();
  const location = useLocation();
  return (to, options) => {
    const { gamePath, ...rest } = options || {};
    if (typeof to !== 'string' || to[0] !== '/' || to[1] === '/') return navigate(to, rest);
    // gamePath: the caller already built a public URL (the game picker's
    // `/marketplace` is Pokémon, not "the current game's home").
    const target = gamePath ? to : gameHref(to);
    if (crossGameFullLoad(location.pathname, target)) {
      window.location.assign(target);
      return undefined;
    }
    return navigate(target, rest);
  };
}
