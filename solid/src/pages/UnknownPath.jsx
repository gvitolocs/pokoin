import { onSettled } from 'solid-js';
import { useLocation } from '@solidjs/router';
import { useGameNavigate } from '../lib/game-navigate.js';
import { gameBasename } from '@market/game.js';
import { shortlinkCardPath } from '@market/shortlink.js';

/**
 * Any path no route matches (React UnknownPath): a numeric short link
 * (/806390, /806390/slug) opens its card, everything else the marketplace.
 * The router keeps a game prefix in pathname; navigate adds it back.
 */
export default function UnknownPath() {
  const location = useLocation();
  const navigate = useGameNavigate();
  onSettled(() => {
    const path = location.pathname.slice(gameBasename().length) || '/';
    navigate(`${shortlinkCardPath(path) || '/marketplace'}`, { replace: true });
  });
  return (
    <div class="page desk" style={{ padding: '2.5rem 1.25rem', color: 'var(--muted)' }} role="status">
      Opening Pokoin…
    </div>
  );
}
