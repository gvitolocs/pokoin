import { onSettled, Show } from 'solid-js';
import { useLocation } from '@solidjs/router';
import { useGameNavigate } from '../lib/game-navigate.js';
import { gameBasename, gameHref } from '@market/game.js';
import { shortlinkCardPath } from '@market/shortlink.js';
import { EmptyDesk } from '../components/Desk.jsx';

/**
 * Any path no route matches (React UnknownPath): a numeric short link
 * (/806390, /806390/slug) opens its card. Anything else says the page does
 * not exist and offers search and the marketplace, instead of silently
 * landing on /marketplace (a mistyped or stale link looked like a redirect bug).
 * The router keeps a game prefix in pathname; navigate adds it back.
 */
export default function UnknownPath() {
  const location = useLocation();
  const navigate = useGameNavigate();
  const path = () => location.pathname.slice(gameBasename().length) || '/';
  const shortlink = () => shortlinkCardPath(path());
  onSettled(() => {
    if (shortlink()) navigate(shortlink(), { replace: true });
  });
  return (
    <Show
      when={!shortlink()}
      fallback={(
        <div class="page desk" style={{ padding: '2.5rem 1.25rem', color: 'var(--muted)' }} role="status">
          Opening Pokoin…
        </div>
      )}
    >
      <div class="page desk">
        <EmptyDesk title="Page not found" lede={`Nothing lives at ${path()}. Search for a card or browse the marketplace.`}>
          <a class="btn" href={gameHref('/marketplace/search')}>Search cards</a>
          <a class="btn ghost" href={gameHref('/marketplace')}>Go to the marketplace</a>
        </EmptyDesk>
      </div>
    </Show>
  );
}
