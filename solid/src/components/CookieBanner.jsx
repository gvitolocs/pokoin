import { createEffect, createSignal, Show } from 'solid-js';
import { COOKIE_BANNER_COPY, COOKIE_CONSENT_ESSENTIAL, acceptCookieConsent, shouldShowCookieBanner } from '@market/cookie-consent.js';
import AppLink from './AppLink.jsx';

/**
 * Cookie notice. While open it
 * publishes its height as --cookie-banner-h so the bottom-right chat button
 * and panel sit above it instead of covering Accept; the observer and resize
 * listener exist only while it is open.
 */
export default function CookieBanner() {
  const [open, setOpen] = createSignal(shouldShowCookieBanner());
  const [node, setNode] = createSignal(null);

  createEffect(
    () => (open() ? node() : null),
    (el) => {
      if (!el) return undefined;
      const root = document.documentElement;
      const sync = () => {
        root.style.setProperty('--cookie-banner-h', `${Math.ceil(el.getBoundingClientRect().height)}px`);
      };
      sync();
      // The copy wraps to more lines on a phone; follow the real height.
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : null;
      observer?.observe(el);
      window.addEventListener('resize', sync);
      return () => {
        observer?.disconnect();
        window.removeEventListener('resize', sync);
        root.style.removeProperty('--cookie-banner-h');
      };
    },
  );

  return (
    <Show when={open()}>
      <div ref={setNode} class="cookie-banner" role="dialog" aria-label="Cookies">
        <p>
          {COOKIE_BANNER_COPY}
          {' '}
          <AppLink to="/privacy">Privacy</AppLink>
        </p>
        <div class="cookie-actions">
          {/* A real choice: essential-only keeps sign-in and cart, and skips Google's store badge. */}
          <button
            type="button"
            class="cookie-essential"
            onClick={() => {
              acceptCookieConsent(undefined, COOKIE_CONSENT_ESSENTIAL);
              setOpen(false);
            }}
          >
            Essential only
          </button>
          <button
            type="button"
            onClick={() => {
              acceptCookieConsent();
              setOpen(false);
              import('@market/google-reviews.js').then(({ showReviewsBadge }) => showReviewsBadge()).catch(() => {});
            }}
          >
            Accept all
          </button>
        </div>
      </div>
    </Show>
  );
}
