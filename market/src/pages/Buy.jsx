import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { createPknCheckout } from '../api.js';
import { useAuth } from '../auth.jsx';
import { authFrom } from '../punchouts.js';
import { Alert, DeskPanel, Metric, MetricGrid, PageHead } from '../components/Desk.jsx';
import { PKN_USDT_PRICE } from '../pkn.js';

const RATE = PKN_USDT_PRICE;
const PACKAGES = [
  { label: 'Starter', fiatCents: 500, lookupKey: 'pkn_starter_1000_pkn_500_eur' },
  { label: 'Collector', fiatCents: 2500, lookupKey: 'pkn_collector_5000_pkn_2500_eur' },
  { label: 'Validator', fiatCents: 10000, lookupKey: 'pkn_validator_20000_pkn_10000_eur' },
];

function pknAmount(item) {
  return Math.round(item.fiatCents / 100 / RATE);
}

export default function Buy() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { signedIn, getBearer, availablePkn } = useAuth();
  const [selected, setSelected] = useState(PACKAGES[1]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const sessionId = params.get('session_id') || '';
  const from = sessionId ? `/buy?session_id=${encodeURIComponent(sessionId)}` : '/buy';

  useEffect(() => {
    document.title = 'Buy PKN · Pokoin';
  }, []);

  useEffect(() => {
    if (!sessionId || !signedIn) {
      return undefined;
    }
    let cancelled = false;
    setMessage('Confirming Stripe payment…');
    getBearer()
      .then((token) => createPknCheckout({ checkoutSessionId: sessionId }, token))
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
  }, [sessionId, signedIn, getBearer]);

  const preview = useMemo(() => pknAmount(selected), [selected]);

  async function pay() {
    if (!signedIn) {
      navigate(authFrom(from));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const token = await getBearer();
      const data = await createPknCheckout({
        pknAmount: preview,
        fiatCents: selected.fiatCents,
        lookupKey: selected.lookupKey,
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
    <div className="page desk">
      <PageHead
        kicker="PKN"
        title="Buy PKN"
        lede={`Fixed packages at 1 PKN = ${RATE} USDT. Credits site balance after Stripe, not chain PKN.`}
      >
        <Link className="btn ghost" to="/wallet">Wallet</Link>
      </PageHead>
      <MetricGrid>
        <Metric value={availablePkn.toLocaleString()} label="Site PKN" />
        <Metric value={preview.toLocaleString()} label={`${selected.label} package`} />
        <Metric value={`€${(selected.fiatCents / 100).toFixed(2)}`} label="Card charge" />
      </MetricGrid>
      {sessionId && !signedIn ? <p className="desk-ok">Stripe returned a session. Sign in to confirm it against site balance.</p> : null}
      {message ? <p className="desk-ok">{message}</p> : null}
      <Alert>{error}</Alert>
      <DeskPanel
        title="Packages"
        actions={(
          <button className="btn" type="button" disabled={busy} onClick={pay}>
            {busy ? 'Opening Stripe…' : (signedIn ? 'Pay with card' : 'Sign in to buy')}
          </button>
        )}
      >
        <div className="pkg-grid">
          {PACKAGES.map((item) => (
            <button
              key={item.lookupKey}
              type="button"
              className={`pkg-card ${selected.lookupKey === item.lookupKey ? 'on' : ''}`}
              onClick={() => setSelected(item)}
            >
              <strong>{item.label}</strong>
              <span>{pknAmount(item).toLocaleString()} PKN</span>
              <em>€{(item.fiatCents / 100).toFixed(2)}</em>
            </button>
          ))}
        </div>
      </DeskPanel>
    </div>
  );
}
