import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHead, DeskPanel } from '../components/Desk.jsx';
import { readAuthSession } from '../auth-session.js';

const STORAGE_KEY = 'pokoin.email.preferences';

const DEFAULTS = {
  transactional: true,
  productUpdates: true,
  marketing: false,
};

function readPrefs() {
  try {
    const raw = JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
    return {
      transactional: true,
      productUpdates: raw.productUpdates !== false,
      marketing: raw.marketing === true,
    };
  } catch (_) {
    return { ...DEFAULTS };
  }
}

function writePrefs(prefs) {
  try {
    globalThis.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        transactional: true,
        productUpdates: prefs.productUpdates !== false,
        marketing: prefs.marketing === true,
        updatedAt: new Date().toISOString(),
        uid: readAuthSession()?.uid || null,
      }),
    );
  } catch (_) {
    /* private mode / quota */
  }
}

function ToggleRow({ id, title, body, checked, disabled, onChange }) {
  return (
    <label className="email-pref-row" htmlFor={id}>
      <span className="email-pref-copy">
        <strong>{title}</strong>
        <span>{body}</span>
      </span>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

export default function EmailPreferences() {
  const session = useMemo(() => readAuthSession(), []);
  const [prefs, setPrefs] = useState(readPrefs);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    document.title = 'Email preferences · Pokoin';
  }, []);

  function save(next) {
    setPrefs(next);
    writePrefs(next);
    setSaved(true);
    globalThis.setTimeout(() => setSaved(false), 2500);
  }

  return (
    <div className="page desk email-preferences-page">
      <PageHead
        kicker="Account"
        title="Email preferences"
        lede="Choose which Pokoin emails you want. Transactional mail about your account, orders, and security always stays on."
      />

      <DeskPanel title="What we send">
        <div className="email-pref-list">
          <ToggleRow
            id="pref-transactional"
            title="Account and order mail"
            body="Verification, welcome, escrow, shipping, disputes, and security alerts. Required to run Card Reserve safely."
            checked
            disabled
            onChange={() => {}}
          />
          <ToggleRow
            id="pref-product"
            title="Product updates"
            body="Occasional notes about marketplace features, buyer protection, wallet, and Scan."
            checked={prefs.productUpdates}
            onChange={(productUpdates) => save({ ...prefs, productUpdates })}
          />
          <ToggleRow
            id="pref-marketing"
            title="Offers and news"
            body="Optional promotions and collector news. Off by default."
            checked={prefs.marketing}
            onChange={(marketing) => save({ ...prefs, marketing })}
          />
        </div>
        <p className="page-lede email-pref-status" role="status">
          {saved ? 'Preferences saved on this device.' : session?.uid
            ? 'Saved in this browser for your signed-in session.'
            : 'Saved in this browser. Sign in on Profile so we can keep the same choices across devices later.'}
        </p>
      </DeskPanel>

      <DeskPanel title="Need help?">
        <p className="page-lede">
          For access, deletion, or other privacy requests, email{' '}
          <a href="mailto:contact@pokoin.com">contact@pokoin.com</a>
          {' '}or read the{' '}
          <Link to="/privacy">Privacy Policy</Link>.
        </p>
        <p>
          <Link className="btn" to="/profile">Profile</Link>
          {' '}
          <Link className="btn ghost" to="/privacy">Privacy</Link>
        </p>
      </DeskPanel>
    </div>
  );
}
