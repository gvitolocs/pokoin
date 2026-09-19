import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchSwapPools,
  fetchSwapQuote,
  fetchWpknQuote,
  formatPknNumber,
  requestWpknExchange,
  requestWpknQuote,
} from '../api.js';
import { useAuth } from '../auth.jsx';
import { authFrom } from '../punchouts.js';
import { POKOIN_RPC, poolIdFor, sendSwapTransaction, useWallet } from '../wallet.jsx';

function poolsOf(data) {
  const rows = Array.isArray(data) ? data : (data?.pools || data?.items || []);
  const mapped = rows.map((row) => {
    const id = String(row.id || row.poolId || row.pool_id || '');
    let asset = String(row.otherAsset || row.asset || row.quote || row.assetB || '').toUpperCase();
    if (!asset && id) {
      asset = id.replace(/^PKN-/, '').replace(/-PKN$/, '').toUpperCase();
    }
    if (asset === 'PKN') {
      asset = '';
    }
    return { id: id || poolIdFor(asset), asset: asset || '' };
  }).filter((row) => row.asset);
  if (!mapped.some((row) => row.asset === 'WPKN')) {
    mapped.push({ id: poolIdFor('WPKN'), asset: 'WPKN' });
  }
  return mapped;
}

export default function Exchange() {
  const { address, connect } = useWallet();
  const { signedIn, getBearer } = useAuth();

  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  const [error, setError] = useState('');

  // WPKN exchange (site PKN ↔ wrapped PKN).
  const [wpknDirection, setWpknDirection] = useState('pkn_to_wpkn');
  const [wpknAmount, setWpknAmount] = useState('100');
  const [wpknQuote, setWpknQuote] = useState(null);

  // AMM swap against live pools.
  const [pools, setPools] = useState([]);
  const [asset, setAsset] = useState('WPKN');
  const [fromPkn, setFromPkn] = useState(true);
  const [amountIn, setAmountIn] = useState('100');
  const [ammQuote, setAmmQuote] = useState(null);

  useEffect(() => {
    document.title = 'Exchange · Pokoin';
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchSwapPools()
      .then((data) => {
        if (cancelled) return;
        const next = poolsOf(data);
        setPools(next);
        if (next[0]?.asset) setAsset(next[0].asset);
      })
      .catch(() => setPools(poolsOf({})));
    return () => {
      cancelled = true;
    };
  }, []);

  async function run(task, { okMessage = '' } = {}) {
    setBusy(true);
    setError('');
    setFlash('');
    try {
      await task();
      if (okMessage) setFlash(okMessage);
      return true;
    } catch (err) {
      setError(err.message || 'Something went wrong.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  function requireSignIn() {
    window.location.href = authFrom('/exchange');
  }

  return (
    <div className="page wallet-page">
      <section className="wallet-hero">
        <h1 className="wallet-title">Exchange</h1>
        <p className="wallet-hero-sources">Swap site PKN, WPKN, and PokoinPoS assets</p>
        {flash ? <p className="wallet-flash">{flash}</p> : null}
        {error ? <p className="wallet-error">{error}</p> : null}
        <Link className="wallet-back" to="/wallet">Back to wallet</Link>
      </section>

      <div className="exchange-grid">
        <section className="wallet-card">
          <div className="wallet-card-head">
            <h2>WPKN exchange</h2>
            <span className="wallet-card-tag">site PKN ↔ WPKN</span>
          </div>
          <p className="wallet-card-lede">Needs a signed-in session and a receiving address.</p>
          <label className="sell-field">
            Direction
            <select value={wpknDirection} onChange={(event) => setWpknDirection(event.target.value)}>
              <option value="pkn_to_wpkn">Site PKN → WPKN</option>
              <option value="wpkn_to_pkn">WPKN → site PKN</option>
            </select>
          </label>
          <label className="sell-field">
            Amount
            <input inputMode="numeric" value={wpknAmount} onChange={(event) => setWpknAmount(event.target.value)} />
          </label>
          <div className="wallet-tool-actions">
            <button
              className="btn ghost"
              type="button"
              onClick={() => run(async () => {
                const data = await fetchWpknQuote({
                  direction: wpknDirection,
                  amountIn: Math.round(Number(wpknAmount) || 0),
                });
                setWpknQuote(data);
              })}
            >
              Quote
            </button>
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={() => {
                if (!signedIn) {
                  requireSignIn();
                  return;
                }
                if (!address) {
                  run(connect);
                  return;
                }
                run(async () => {
                  const token = await getBearer();
                  const quoted = await requestWpknQuote({
                    direction: wpknDirection,
                    amountIn: Math.round(Number(wpknAmount) || 0),
                  }, token);
                  const quoteId = quoted.quoteId || quoted.id || wpknQuote?.quoteId;
                  if (!quoteId) {
                    throw new Error('WPKN quote did not return an id.');
                  }
                  const result = await requestWpknExchange({ quoteId, direction: wpknDirection, toAddress: address }, token);
                  setFlash(result.status || result.message || 'Exchange requested.');
                });
              }}
            >
              {signedIn ? 'Request exchange' : 'Sign in to exchange'}
            </button>
          </div>
          {wpknQuote ? (
            <p className="wallet-quote">
              Quote {formatPknNumber(wpknQuote.amountOut || wpknQuote.out || 0)}
              {wpknQuote.quoteId ? ` · ${wpknQuote.quoteId}` : ''}
            </p>
          ) : null}
        </section>

        <section className="wallet-card">
          <div className="wallet-card-head">
            <h2>PokoinSwap</h2>
            <span className="wallet-card-tag">AMM · 0.5% min-out</span>
          </div>
          <p className="wallet-card-lede">{POKOIN_RPC.replace('https://', '')} · integer amounts against live pools.</p>
          <label className="sell-field">
            Pair
            <select value={asset} onChange={(event) => { setAsset(event.target.value); setAmmQuote(null); }}>
              {pools.map((row) => (
                <option key={row.id || row.asset} value={row.asset}>{row.asset} / PKN</option>
              ))}
            </select>
          </label>
          <label className="sell-field">
            Direction
            <select
              value={fromPkn ? 'pkn' : 'out'}
              onChange={(event) => { setFromPkn(event.target.value === 'pkn'); setAmmQuote(null); }}
            >
              <option value="pkn">PKN → {asset}</option>
              <option value="out">{asset} → PKN</option>
            </select>
          </label>
          <label className="sell-field">
            Amount in
            <input inputMode="numeric" value={amountIn} onChange={(event) => { setAmountIn(event.target.value); setAmmQuote(null); }} />
          </label>
          <div className="wallet-tool-actions">
            <button
              className="btn ghost"
              type="button"
              onClick={() => run(async () => {
                const poolId = pools.find((row) => row.asset === asset)?.id || poolIdFor(asset);
                const data = await fetchSwapQuote({
                  pool: poolId,
                  assetIn: fromPkn ? 'PKN' : asset,
                  amountIn: Math.round(Number(amountIn) || 0),
                });
                setAmmQuote(data);
              })}
            >
              Quote
            </button>
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={() => {
                if (!address) {
                  run(connect);
                  return;
                }
                run(async () => {
                  const poolId = pools.find((row) => row.asset === asset)?.id || poolIdFor(asset);
                  const assetIn = fromPkn ? 'PKN' : asset;
                  const assetOut = fromPkn ? asset : 'PKN';
                  const latest = ammQuote || await fetchSwapQuote({
                    pool: poolId,
                    assetIn,
                    amountIn: Math.round(Number(amountIn) || 0),
                  });
                  setAmmQuote(latest);
                  const hash = await sendSwapTransaction({
                    from: address,
                    quote: latest,
                    poolId,
                    assetIn,
                    assetOut,
                    amountIn: Math.round(Number(amountIn) || 0),
                  });
                  setFlash(`Swap sent · ${hash ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : ''}`);
                });
              }}
            >
              {address ? 'Swap' : 'Connect and swap'}
            </button>
          </div>
          {ammQuote ? (
            <p className="wallet-quote">
              Out {formatPknNumber(ammQuote.amountOut || 0)} {ammQuote.assetOut || (fromPkn ? asset : 'PKN')}
              {ammQuote.price ? ` · ${ammQuote.price}` : ''}
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
