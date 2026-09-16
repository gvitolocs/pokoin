import { useEffect } from 'react';
import { publicApiUrl } from '../extension-auth-bridge.js';
import { WORKING_GIF_SRC, WORKING_MESSAGE } from '../working-page.js';

export default function WorkingOnIt() {
  useEffect(() => {
    document.title = `${WORKING_MESSAGE} · Pokoin`;
    const id = setInterval(async () => {
      try {
        const response = await fetch(publicApiUrl('/api/healthz'), {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        });
        if (response.ok) {
          window.location.reload();
        }
      } catch (_) {
        /* still down */
      }
    }, 20000);
    return () => clearInterval(id);
  }, []);

  return (
    <main className="working-on-it" role="status" aria-live="polite">
      <img src={WORKING_GIF_SRC} alt="" width="160" height="160" />
      <h1>{WORKING_MESSAGE}</h1>
      <p>Pokoin</p>
    </main>
  );
}
