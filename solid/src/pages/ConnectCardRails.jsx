import { createEffect, createSignal, Match, onSettled, Show, Switch } from 'solid-js';
import { useLocation, useNavigate } from '@solidjs/router';
import { cardRailsAuthorize } from '@market/api.js';
import {
  cardRailsAuthFrom,
  cardRailsCancelUrl,
  cardRailsRedirectUrl,
  isCardRailsParamsValid,
} from '@market/cardrails-connect.js';
import AuthLink from '../components/AuthLink.jsx';
import { authConfirmed, authUid, authUser, getBearer, loadAuth } from '../stores/auth.js';

/**
 * /connect/cardrails (market/src/cardrails-connect.js): "Sign in with Pokoin"
 * for the Card Rails apps. The app opens this page in the system browser with
 * ?state=&code_challenge=&code_challenge_method=S256; the signed-in user taps
 * Continua (the tap is the consent) and the one-time code deep-links back to
 * cardrails://auth/pokoin. No auto-continue, and an invalid request never
 * redirects anywhere. A signed-out visitor goes straight to the Pokoin
 * sign-in screen and comes back here afterwards.
 */
export default function ConnectCardRails() {
  const location = useLocation();
  const here = () => `${location.pathname}${location.search}`;
  const params = () => new URLSearchParams(location.search);
  const valid = () => isCardRailsParamsValid(params());

  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [redirected, setRedirected] = createSignal(false);
  const [target, setTarget] = createSignal('');
  const navigate = useNavigate();
  document.title = 'Accedi a Card Rails · Pokoin';
  loadAuth().catch(() => {});

  // Signed out: the Pokoin sign-in screen itself, not a card asking for it.
  createEffect(
    () => valid() && authConfirmed() && !authUid(),
    (out) => {
      if (out) navigate(cardRailsAuthFrom(here()), { replace: true });
    },
  );

  onSettled(() => {
    const el = document.createElement('meta');
    el.setAttribute('name', 'robots');
    el.setAttribute('data-pokoin-cardrails', '1');
    el.setAttribute('content', 'noindex, nofollow');
    document.head.querySelector('meta[name="robots"][data-pokoin-cardrails="1"]')?.remove();
    document.head.appendChild(el);
  });

  const email = () => String(authUser()?.email || '');
  const lede = () => (email()
    ? `Card Rails userà il tuo account Pokoin ${email()} per farti accedere e mostrerà le carte che vendi su Pokoin nel suo inventario.`
    : 'Card Rails userà il tuo account Pokoin per farti accedere e mostrerà le carte che vendi su Pokoin nel suo inventario.');

  async function continua(event) {
    event?.preventDefault?.();
    if (busy() || redirected()) return;
    setBusy(true);
    setError('');
    try {
      const bearer = await getBearer();
      if (!bearer) throw new Error('Accedi a Pokoin e riprova.');
      const data = await cardRailsAuthorize(bearer, {
        state: params().get('state') || '',
        code_challenge: params().get('code_challenge') || '',
        code_challenge_method: params().get('code_challenge_method') || '',
      });
      const target = String(data?.redirect || cardRailsRedirectUrl(data?.code, params().get('state') || ''));
      setTarget(target);
      setRedirected(true);
      window.location.assign(target);
    } catch (err) {
      // The API answers machine codes (invalid_request, rate_limited); the
      // card shows one fixed retryable message instead.
      console.warn('cardrails authorize failed', err);
      setError('La connessione a Card Rails non è riuscita. Riprova.');
    } finally {
      setBusy(false);
    }
  }

  function annulla() {
    if (busy() || redirected()) return;
    window.location.assign(cardRailsCancelUrl(params().get('state') || ''));
  }

  return (
    <div class="page desk">
      <main class="desk-panel" style={{ 'max-width': `${28 * 16}px`, margin: '2rem auto' }}>
        <div class="desk-body">
          <Switch>
            <Match when={!valid()}>
              <h1>Richiesta non valida</h1>
              <p>Apri di nuovo Card Rails e riparti da lì: questa pagina funziona solo dal collegamento dell'app.</p>
            </Match>
            <Match when={!authConfirmed()}>
              <h1>Accedi a Card Rails</h1>
              <p>Verifica della sessione…</p>
            </Match>
            <Match when={!authUid()}>
              <h1>Accedi a Card Rails</h1>
              <p>Accedi a Pokoin per continuare in Card Rails.</p>
              <p>
                <AuthLink class="btn" to={cardRailsAuthFrom(here())}>Accedi</AuthLink>
              </p>
            </Match>
            <Match when={redirected()}>
              <h1>Accedi a Card Rails</h1>
              <p>Torna all'app Card Rails.</p>
              {/* Some browsers drop an app link that is not a direct tap. */}
              <Show when={target()}>
                <p><a class="btn" href={target()}>Apri Card Rails</a></p>
              </Show>
            </Match>
            <Match when={true}>
              <h1>Accedi a Card Rails</h1>
              <p>{lede()}</p>
              <Show when={error()}>
                <p role="alert" style={{ color: '#b42318' }}>{error()}</p>
              </Show>
              <form style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '0.5rem' }} onSubmit={continua}>
                <button type="submit" class="btn" disabled={busy() || redirected()}>
                  {busy() ? 'Un momento…' : 'Continua'}
                </button>
                <button type="button" class="btn ghost" disabled={busy() || redirected()} onClick={annulla}>
                  Annulla
                </button>
              </form>
            </Match>
          </Switch>
        </div>
      </main>
    </div>
  );
}
