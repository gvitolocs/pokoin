import { createEffect, createMemo, createSignal, For, onSettled, Show } from 'solid-js';
import { useLocation, useNavigate } from '@solidjs/router';
import { createPknCheckout } from '@market/api.js';
import { formatPknNumber } from '@market/pkn.js';
import { PKN_PACKAGE_RATE, PKN_PACKAGES, buyReturnPath, pknPackageAmount } from '@market/pkn-packages.js';
import { authFrom } from '@market/punchouts.js';
import { Alert, DeskPanel, Metric, MetricGrid, PageHead } from '../components/Desk.jsx';
import { availablePkn } from '../stores/account.js';
import { getBearer, signedIn } from '../stores/auth.js';

/** /buy: fixed Stripe PKN packages, credited to site balance. */
export default function Buy() {
  const navigate = useNavigate();
  const location = useLocation();
  const [selected, setSelected] = createSignal(PKN_PACKAGES[1]);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [error, setError] = createSignal('');

  const sessionId = () => new URLSearchParams(location.search).get('session_id') || '';
  const preview = createMemo(() => pknPackageAmount(selected()));

  onSettled(() => {
    document.title = 'Buy PKN · Pokoin';
  });

  // Stripe sent the buyer back: confirm that session against the site balance.
  createEffect(
    () => (signedIn() ? sessionId() : ''),
    (id) => {
      if (!id) return undefined;
      let cancelled = false;
      setMessage('Confirming Stripe payment…');
      getBearer()
        .then((token) => createPknCheckout({ checkoutSessionId: id }, token))
        .then((data) => {
          if (cancelled) return;
          setMessage(`Payment confirmed. ${data.amountPkn || 'PKN'} added to site balance.`);
          setError('');
        })
        .catch((err) => {
          if (!cancelled) setError(err.message || 'Payment confirmation failed.');
        });
      return () => {
        cancelled = true;
      };
    },
  );

  async function pay() {
    if (!signedIn()) {
      navigate(authFrom(buyReturnPath(sessionId())));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const token = await getBearer();
      const data = await createPknCheckout({
        pknAmount: preview(),
        fiatCents: selected().fiatCents,
        lookupKey: selected().lookupKey,
      }, token);
      if (!data?.url) {
        throw new Error('Stripe did not return a checkout URL.');
      }
      window.location.href = data.url;
    } catch (err) {
      setError(err.message || 'Checkout failed.');
      setBusy(false);
    }
  }

  return (
    <div class="page desk">
      <PageHead
        kicker="PKN"
        title="Buy PKN"
        lede={`Fixed packages at 1 PKN = ${PKN_PACKAGE_RATE} USDT. Credits site balance after Stripe, not chain PKN.`}
      >
        <a class="btn ghost" href="/wallet">Wallet</a>
      </PageHead>
      <MetricGrid>
        <Metric value={formatPknNumber(availablePkn())} label="Site PKN" />
        <Metric value={formatPknNumber(preview())} label={`${selected().label} package`} />
        <Metric value={`€${(selected().fiatCents / 100).toFixed(2)}`} label="Card charge" />
      </MetricGrid>
      <Show when={sessionId() && !signedIn()}>
        <p class="desk-ok">Stripe returned a session. Sign in to confirm it against site balance.</p>
      </Show>
      <Show when={message()}><p class="desk-ok">{message()}</p></Show>
      <Alert>{error()}</Alert>
      <DeskPanel
        title="Packages"
        actions={(
          <button class="btn" type="button" disabled={busy()} onClick={pay}>
            {busy() ? 'Opening Stripe…' : (signedIn() ? 'Pay with card' : 'Sign in to buy')}
          </button>
        )}
      >
        <div class="pkg-grid">
          <For each={PKN_PACKAGES}>
            {(item) => (
              <button
                type="button"
                class={['pkg-card', { on: selected().lookupKey === item.lookupKey }]}
                onClick={() => setSelected(() => item)}
              >
                <strong>{item.label}</strong>
                <span>{formatPknNumber(pknPackageAmount(item))} PKN</span>
                <em>€{(item.fiatCents / 100).toFixed(2)}</em>
              </button>
            )}
          </For>
        </div>
      </DeskPanel>
    </div>
  );
}
