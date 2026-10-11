import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { createPknCheckout } from '../api.js';
import { useAuth } from '../auth.jsx';
import { authFrom } from '../punchouts.js';
import { Alert, DeskPanel, Metric, MetricGrid, PageHead } from '../components/Desk.jsx';
import { formatPknNumber } from '../pkn.js';
import { PKN_PACKAGE_RATE, PKN_PACKAGES, buyReturnPath, pknPackageAmount } from '../pkn-packages.js';

const RATE = PKN_PACKAGE_RATE;
const PACKAGES = PKN_PACKAGES;
const pknAmount = pknPackageAmount;

export default function Buy() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { signedIn, getBearer, availablePkn } = useAuth();
  const [selected, setSelected] = useState(PACKAGES[1]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const sessionId = params.get('session_id') || '';
  const from = buyReturnPath(sessionId);

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
        <Metric value={formatPknNumber(availablePkn)} label="Site PKN" />
        <Metric value={formatPknNumber(preview)} label={`${selected.label} package`} />
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
              <span>{formatPknNumber(pknAmount(item))} PKN</span>
              <em>€{(item.fiatCents / 100).toFixed(2)}</em>
            </button>
          ))}
        </div>
      </DeskPanel>
    </div>
  );
}
