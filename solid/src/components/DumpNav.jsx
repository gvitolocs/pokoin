import { For } from 'solid-js';
import { useLocation } from '@solidjs/router';

const LINKS = [
  { to: '/marketplace/explore', label: 'Explore', match: (path) => path.startsWith('/marketplace/explore') },
  { to: '/marketplace/portfolio', label: 'Portfolio', match: (path) => path.startsWith('/marketplace/portfolio') },
];

/** Explore / Portfolio tabs (market/src/components/DumpNav.jsx). */
export default function DumpNav() {
  const location = useLocation();
  return (
    <nav class="comp-tabs" aria-label="Market holdings">
      <For each={LINKS}>
        {(row) => <a class={row.match(location.pathname) ? 'on' : undefined} href={row.to}>{row.label}</a>}
      </For>
    </nav>
  );
}
