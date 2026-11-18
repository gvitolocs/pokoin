import { For } from 'solid-js';
import { useLocation } from '@solidjs/router';
import { gameHref } from '@market/game.js';

const LINKS = [
  { to: '/marketplace/explore', label: 'Explore', match: (path) => path.startsWith('/marketplace/explore') },
  { to: '/marketplace/portfolio', label: 'Portfolio', match: (path) => path.startsWith('/marketplace/portfolio') },
];

/** Explore / Portfolio tabs. */
export default function DumpNav() {
  const location = useLocation();
  return (
    <nav class="comp-tabs" aria-label="Market holdings">
      <For each={LINKS}>
        {(row) => <a class={row.match(location.pathname) ? 'on' : undefined} href={gameHref(row.to)}>{row.label}</a>}
      </For>
    </nav>
  );
}
