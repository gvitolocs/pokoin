import { createSignal, Match, onSettled, Show, Switch } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import {
  cardtraderPublicUrl,
  ebayHref,
  fetchCardmarketRedirect,
  fetchCardtraderRedirect,
  fetchClientCountry,
  fetchTcgplayerRedirect,
  tcgplayerSearchHref,
  unlockSilver,
  vintedHref,
} from '@market/api.js';
import { game } from '@market/game.js';
import { cardmarketSearchUrl } from '@market/identity.js';
import { authAnchorRel, authFrom } from '@market/punchouts.js';
import { SILVER_PRICE_PKN } from '@market/silver.js';
import { authReady, getBearer, signedIn } from '../../stores/auth.js';
import { profile } from '../../stores/session.js';

/**
 * Silver off-site pills, or the unlock prompt (market/src/pages/Card.jsx
 * SilverHead). Silver comes from the cached session profile.
 */
export default function SilverHead(props) {
  const navigate = useNavigate();
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  let country = '';

  onSettled(() => {
    let live = true;
    fetchClientCountry().then((code) => {
      if (live) country = code;
    });
    return () => {
      live = false;
    };
  });

  const silver = () => Boolean(profile()?.silver);

  async function unlock() {
    if (!signedIn()) {
      navigate(authFrom(props.fromPath));
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const token = await getBearer();
      const data = await unlockSilver(token);
      setMessage(data.silverUntil ? `Silver until ${data.silverUntil}` : 'Silver unlocked.');
    } catch (err) {
      setMessage(err.message || 'Unlock failed.');
    } finally {
      setBusy(false);
    }
  }

  function openOffsite(url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  async function openCardtrader() {
    setMessage('');
    try {
      const url = cardtraderPublicUrl(props.card) || await fetchCardtraderRedirect(props.card);
      if (!url) throw new Error('CardTrader did not return a URL.');
      openOffsite(url);
    } catch (err) {
      setMessage(err.message || 'CardTrader unavailable.');
    }
  }

  async function openCardmarket() {
    setMessage('');
    try {
      const url = await fetchCardmarketRedirect(props.card).catch(() => '') || cardmarketSearchUrl(props.card, game().id);
      if (!url) throw new Error('Cardmarket did not return a URL.');
      openOffsite(url);
    } catch (err) {
      setMessage(err.message || 'Cardmarket unavailable.');
    }
  }

  function openVinted() {
    setMessage('');
    const url = vintedHref(props.card, undefined, country);
    if (!url || /search_text=?$/.test(url)) {
      setMessage('Vinted search is empty.');
      return;
    }
    openOffsite(url);
  }

  function openEbay() {
    setMessage('');
    const url = ebayHref(props.card, undefined, country);
    if (!url || /_nkw=?$/.test(url)) {
      setMessage('eBay search is empty.');
      return;
    }
    openOffsite(url);
  }

  async function openTcgplayer() {
    setMessage('');
    try {
      const url = await fetchTcgplayerRedirect(props.card);
      if (!url) throw new Error('No TCGplayer product for this card.');
      openOffsite(url);
    } catch (err) {
      const fallback = tcgplayerSearchHref(props.card);
      if (fallback && !/[?&]q=?$/.test(fallback)) {
        openOffsite(fallback);
        return;
      }
      setMessage(err.message || 'TCGplayer unavailable.');
    }
  }

  const note = () => <Show when={message()}><p class="muted silver-note">{message()}</p></Show>;

  return (
    <Switch
      fallback={(
        <div class="silver-tools is-locked">
          <Show
            when={signedIn()}
            fallback={(
              <a class="silver-link" href={authFrom(props.fromPath)} rel={authAnchorRel(authFrom(props.fromPath)) || undefined}>
                Sign in to unlock
              </a>
            )}
          >
            <button class="silver-link" type="button" disabled={busy()} onClick={unlock}>
              {busy() ? 'Unlocking…' : `Unlock Silver · ${SILVER_PRICE_PKN} PKN`}
            </button>
          </Show>
          {note()}
        </div>
      )}
    >
      <Match when={silver()}>
        <div class="silver-tools">
          <div class="silver-pills">
            <button class="silver-pill is-ct" type="button" onClick={openCardtrader}>CT</button>
            <button class="silver-pill is-cm" type="button" onClick={openCardmarket}>CM</button>
            <button class="silver-pill is-tp" type="button" onClick={openTcgplayer} aria-label="TCGplayer">TP</button>
            <button class="silver-pill is-vt" type="button" onClick={openVinted}>VT</button>
            <button class="silver-pill is-eb" type="button" onClick={openEbay} aria-label="Search eBay">
              <span class="eb-e">E</span><span class="eb-b">B</span>
            </button>
          </div>
          {note()}
        </div>
      </Match>
      <Match when={!authReady() || (signedIn() && !profile())}>
        <div class="silver-tools is-pending" aria-hidden="true" />
      </Match>
    </Switch>
  );
}
