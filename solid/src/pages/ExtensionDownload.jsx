import { createSignal, Match, Show, Switch } from 'solid-js';
import { unlockSilver } from '@market/api.js';
import { fetchExtensionZip, saveBlob } from '@market/extension-download.js';
import { authFrom } from '@market/punchouts.js';
import { SILVER_PRICE_PKN } from '@market/silver.js';
import AuthLink from '../components/AuthLink.jsx';
import { accountProfile, accountSilver, refreshAccount } from '../stores/account.js';
import { authConfirmed, getBearer, loadAuth, signedIn } from '../stores/auth.js';

/**
 * /extension and /extension.zip: the Pokoin Chrome extension, Silver only.
 * Signed out → Sign in; signed in without Silver → Silver only + unlock;
 * Silver → Download. The page only hides the button: GET
 * /api/extension-download checks the token and Silver itself (401 / 403),
 * and the zip is never a static file.
 */
export default function ExtensionDownload() {
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  // A server answer wins over the cached profile (e.g. Silver expired).
  const [denied, setDenied] = createSignal('');
  document.title = 'Chrome extension · Pokoin';
  loadAuth().catch(() => {});
  refreshAccount();

  const from = authFrom('/extension');
  const state = () => {
    if (!authConfirmed() && !signedIn()) return 'checking';
    if (!signedIn() || denied() === 'signed-out') return 'signed-out';
    if (!accountProfile()) return 'checking';
    if (!accountSilver() || denied() === 'not-silver') return 'not-silver';
    return 'silver';
  };

  async function download() {
    setBusy(true);
    setMessage('');
    try {
      const token = await getBearer();
      const { blob, name } = await fetchExtensionZip(token);
      saveBlob(blob, name);
      setMessage(`Downloaded ${name}. Unzip it, then load it in chrome://extensions with Developer mode → Load unpacked.`);
    } catch (err) {
      if (err.state === 'signed-out' || err.state === 'not-silver') setDenied(err.state);
      else if (err.state === 'unpublished') setMessage('The extension download is not published yet.');
      else setMessage(err.message || 'Download failed.');
    } finally {
      setBusy(false);
    }
  }

  async function unlock() {
    setBusy(true);
    setMessage('');
    try {
      const token = await getBearer();
      const data = await unlockSilver(token);
      setDenied('');
      setMessage(data.silverUntil ? `Silver until ${data.silverUntil}` : 'Silver unlocked.');
      await refreshAccount();
    } catch (err) {
      setMessage(err.message || 'Unlock failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="page desk">
      <main class="desk-panel extension-download" style={{ 'max-width': `${28 * 16}px`, margin: '2rem auto' }}>
        <div class="desk-body">
          <h1>Pokoin Chrome extension</h1>
          <p class="muted">Card matches on Vinted, eBay, CardTrader and Cardmarket listings. For Pokoin Silver members.</p>
          <Switch>
            <Match when={state() === 'checking'}><p>Checking Pokoin session…</p></Match>
            <Match when={state() === 'signed-out'}>
              <p>Sign in with your Pokoin Silver account to download the extension.</p>
              <p><AuthLink class="btn" to={from}>Sign in</AuthLink></p>
            </Match>
            <Match when={state() === 'not-silver'}>
              <p><strong>Silver only.</strong> The extension download is for Pokoin Silver members.</p>
              <p>
                <button class="btn" type="button" disabled={busy()} onClick={unlock}>
                  {busy() ? 'Unlocking…' : `Get Silver · ${SILVER_PRICE_PKN} PKN`}
                </button>
              </p>
            </Match>
            <Match when={state() === 'silver'}>
              <p>
                <button class="btn" type="button" disabled={busy()} onClick={download}>
                  {busy() ? 'Downloading…' : 'Download extension (.zip)'}
                </button>
              </p>
            </Match>
          </Switch>
          <Show when={message()}><p class="muted">{message()}</p></Show>
        </div>
      </main>
    </div>
  );
}
