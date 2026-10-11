import { For } from 'solid-js';
import { useLocation } from '@solidjs/router';
import tests from '@market/../public/review/tests.json';

/** Bottom strip linking every test board. */
export default function TestDock() {
  const location = useLocation();
  const here = () => location.pathname.replace(/\/+$/, '') || '/';
  return (
    <nav class="test-dock" aria-label="Previous tests">
      <For each={tests.tests}>
        {(entry) => (
          <a href={entry.path} class={{ on: here() === entry.path }}>
            <strong>{entry.label}</strong>
            <span>{entry.note}</span>
            <time datetime={entry.date}>{entry.date}</time>
          </a>
        )}
      </For>
    </nav>
  );
}
