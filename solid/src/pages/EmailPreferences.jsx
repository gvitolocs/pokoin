import { createSignal } from 'solid-js';
import { readAuthSession } from '@market/auth-session.js';
import { DeskPanel, PageHead } from '../components/Desk.jsx';

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

function ToggleRow(props) {
  return (
    <label class="email-pref-row" for={props.id}>
      <span class="email-pref-copy">
        <strong>{props.title}</strong>
        <span>{props.body}</span>
      </span>
      <input
        id={props.id}
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange?.(event.target.checked)}
      />
    </label>
  );
}

/** /email-preferences (market/src/pages/EmailPreferences.jsx): per-browser choices. */
export default function EmailPreferences() {
  const session = readAuthSession();
  const [prefs, setPrefs] = createSignal(readPrefs());
  const [saved, setSaved] = createSignal(false);
  document.title = 'Email preferences · Pokoin';

  function save(next) {
    setPrefs(next);
    writePrefs(next);
    setSaved(true);
    globalThis.setTimeout(() => setSaved(false), 2500);
  }

  return (
    <div class="page desk email-preferences-page">
      <PageHead
        kicker="Account"
        title="Email preferences"
        lede="Choose which Pokoin emails you want. Transactional mail about your account, orders, and security always stays on."
      />

      <DeskPanel title="What we send">
        <div class="email-pref-list">
          <ToggleRow
            id="pref-transactional"
            title="Account and order mail"
            body="Verification, welcome, escrow, shipping, disputes, and security alerts. Required to run Card Reserve safely."
            checked
            disabled
          />
          <ToggleRow
            id="pref-product"
            title="Product updates"
            body="Occasional notes about marketplace features, buyer protection, wallet, and Scan."
            checked={prefs().productUpdates}
            onChange={(productUpdates) => save({ ...prefs(), productUpdates })}
          />
          <ToggleRow
            id="pref-marketing"
            title="Offers and news"
            body="Optional promotions and collector news. Off by default."
            checked={prefs().marketing}
            onChange={(marketing) => save({ ...prefs(), marketing })}
          />
        </div>
        <p class="page-lede email-pref-status" role="status">
          {saved() ? 'Preferences saved on this device.' : session?.uid
            ? 'Saved in this browser for your signed-in session.'
            : 'Saved in this browser. Sign in on Profile so we can keep the same choices across devices later.'}
        </p>
      </DeskPanel>

      <DeskPanel title="Need help?">
        <p class="page-lede">
          For access, deletion, or other privacy requests, email{' '}
          <a href="mailto:contact@pokoin.com">contact@pokoin.com</a>
          {' '}or read the{' '}
          <a href="/privacy">Privacy Policy</a>.
        </p>
        <p>
          <a class="btn" href="/profile">Profile</a>
          {' '}
          <a class="btn ghost" href="/privacy">Privacy</a>
        </p>
      </DeskPanel>
    </div>
  );
}
