import { useState } from 'react';
import { Link } from 'react-router-dom';
import { COOKIE_BANNER_COPY, acceptCookieConsent, shouldShowCookieBanner } from '../cookie-consent.js';

export default function CookieBanner() {
  const [open, setOpen] = useState(() => shouldShowCookieBanner());
  if (!open) {
    return null;
  }

  function accept() {
    acceptCookieConsent();
    setOpen(false);
  }

  return (
    <div className="cookie-banner" role="dialog" aria-label="Cookies">
      <p>
        {COOKIE_BANNER_COPY}
        {' '}
        <Link to="/privacy">Privacy</Link>
      </p>
      <button type="button" onClick={accept}>Accept</button>
    </div>
  );
}
