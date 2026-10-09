import { onSettled } from 'solid-js';
import { useLocation } from '@solidjs/router';
import { classicHandoff, hasBootSwitch } from '../lib/ui-switch.js';

/**
 * A route the Solid UI does not own yet. With the boot switch present the
 * page reloads into the React UI at the same URL; standalone (local preview)
 * it says so instead of looping.
 */
export default function NotMigrated() {
  const location = useLocation();
  const handing = hasBootSwitch();
  onSettled(() => {
    if (handing) classicHandoff();
  });
  return (
    <div class="page desk" style={{ padding: '2.5rem 1.25rem', color: 'var(--muted)' }} role="status">
      {handing ? 'Opening Pokoin…' : `${location.pathname} is not in the Solid UI yet.`}
    </div>
  );
}
