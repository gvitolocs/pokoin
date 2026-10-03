import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { COOKIE_BANNER_COPY, acceptCookieConsent, shouldShowCookieBanner } from '../cookie-consent.js';

/**
 * While open, the banner publishes its height as --cookie-banner-h so the
 * bottom-right chat button and panel sit above it instead of covering Accept.
 */
export default function CookieBanner() {
  const [open, setOpen] = useState(() => shouldShowCookieBanner());
  const ref = useRef(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!open || !node) return undefined;
    const root = document.documentElement;
    const sync = () => {
      root.style.setProperty('--cookie-banner-h', `${Math.ceil(node.getBoundingClientRect().height)}px`);
    };
    sync();
    // The copy wraps to more lines on a phone; follow the real height.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : null;
    observer?.observe(node);
    window.addEventListener('resize', sync);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', sync);
      root.style.removeProperty('--cookie-banner-h');
    };
  }, [open]);

  if (!open) {
    return null;
  }

  function accept() {
    acceptCookieConsent();
    setOpen(false);
  }

  return (
    <div ref={ref} className="cookie-banner" role="dialog" aria-label="Cookies">
      <p>
        {COOKIE_BANNER_COPY}
        {' '}
        <Link to="/privacy">Privacy</Link>
      </p>
      <button type="button" onClick={accept}>Accept</button>
    </div>
  );
}
