import { onSettled } from 'solid-js';
import { publicApiUrl } from '@market/extension-auth-bridge.js';
import { WORKING_GIF_SRC, WORKING_MESSAGE } from '@market/working-page.js';

/** The origin-down page (market/src/components/WorkingOnIt.jsx): polls /api/healthz and reloads once the API answers. */
export default function WorkingOnIt() {
  onSettled(() => {
    document.title = `${WORKING_MESSAGE} · Pokoin`;
    const id = setInterval(async () => {
      try {
        const response = await fetch(publicApiUrl('/api/healthz'), {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        });
        if (response.ok) window.location.reload();
      } catch (_) {
        /* still down */
      }
    }, 20000);
    return () => clearInterval(id);
  });

  return (
    <main class="working-on-it" role="status" aria-live="polite">
      <img src={WORKING_GIF_SRC} alt="" width="160" height="160" />
      <h1>{WORKING_MESSAGE}</h1>
      <p>Pokoin</p>
    </main>
  );
}
