import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchSwapPools,
  fetchSwapQuote,
  fetchWpknQuote,
  requestWpknExchange,
  requestWpknQuote,
} from '../api.js';
import { useAuth } from '../auth.jsx';
import { authFrom } from '../punchouts.js';
import {
  POKOIN_CHAIN_ID,
  POKOIN_RPC,
  poolIdFor,
  sendPkn,
  sendSwapTransaction,
  shortAddress,
  useWallet,
} from '../wallet.jsx';
import { Alert, DeskPanel, Metric, MetricGrid, PageHead } from '../components/Desk.jsx';

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
    return {
      id: id || poolIdFor(asset),
      asset: asset || '',
    };
  }).filter((row) => row.asset);
  if (!mapped.some((row) => row.asset === 'WPKN')) {
    mapped.push({ id: poolIdFor('WPKN'), asset: 'WPKN' });
  }
  return mapped;
}

export default function Wallet() {
  const { address, balance, chainId, connect, disconnect } = useWallet();
  const { signedIn, getBearer, availablePkn } = useAuth();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pools, setPools] = useState([]);
  const [asset, setAsset] = useState('WPKN');
  const [fromPkn, setFromPkn] = useState(true);
  const [amountIn, setAmountIn] = useState('100');
  const [quote, setQuote] = useState(null);
  const [txHash, setTxHash] = useState('');
  const [wpknDirection, setWpknDirection] = useState('pkn_to_wpkn');
  const [wpknAmount, setWpknAmount] = useState('100');
  const [wpknQuote, setWpknQuote] = useState(null);
  const [wpknMsg, setWpknMsg] = useState('');
  const [sendTo, setSendTo] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  const [sendHash, setSendHash] = useState('');

  useEffect(() => {
    document.title = 'Wallet · Pokoin';
    let cancelled = false;
    fetchSwapPools()
      .then((data) => {
        if (cancelled) return;
        const next = poolsOf(data);
        setPools(next);
        if (next[0]?.asset) setAsset(next[0].asset);
      })
      .catch((err) => {
        if (!cancelled) {
          setPools(poolsOf({}));
          setError(err.message || 'Swap pools unavailable.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onPokoin = chainId === POKOIN_CHAIN_ID;
  const poolId = useMemo(() => {
    return pools.find((row) => row.asset === asset)?.id || poolIdFor(asset);
  }, [pools, asset]);
  const assetIn = fromPkn ? 'PKN' : asset;
  const assetOut = fromPkn ? asset : 'PKN';

  async function onConnect() {
    setBusy(true);
    setError('');
    try {
      await connect();
    } catch (err) {
      setError(err.message || 'Wallet connect failed.');
    } finally {
      setBusy(false);
    }
  }

  async function quoteAmm() {
    setError('');
    setQuote(null);
    try {
      const data = await fetchSwapQuote({
        pool: poolId,
        assetIn,
        amountIn: Math.round(Number(amountIn) || 0),
      });
      setQuote(data);
    } catch (err) {
      setError(err.message || 'Quote failed.');
    }
  }

  async function swapAmm() {
    if (!address) {
      await onConnect();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const latest = quote || await fetchSwapQuote({
        pool: poolId,
        assetIn,
        amountIn: Math.round(Number(amountIn) || 0),
      });
      setQuote(latest);
      const hash = await sendSwapTransaction({
        from: address,
        quote: latest,
        poolId,
        assetIn,
        assetOut,
        amountIn: Math.round(Number(amountIn) || 0),
      });
      setTxHash(hash);
    } catch (err) {
      setError(err.message || 'Swap failed.');
    } finally {
      setBusy(false);
    }
  }

  async function quoteWpkn() {
    setError('');
    setWpknMsg('');
    try {
      const data = await fetchWpknQuote({
        direction: wpknDirection,
        amountIn: Math.round(Number(wpknAmount) || 0),
      });
      setWpknQuote(data);
    } catch (err) {
      setError(err.message || 'WPKN quote failed.');
    }
  }

  async function requestWpkn() {
    if (!signedIn) {
      window.location.href = authFrom('/wallet');
      return;
    }
    if (!address) {
      await onConnect();
      return;
    }
    setBusy(true);
    setError('');
    setWpknMsg('');
    try {
      const token = await getBearer();
      const quoted = await requestWpknQuote({
        direction: wpknDirection,
        amountIn: Math.round(Number(wpknAmount) || 0),
      }, token);
      const quoteId = quoted.quoteId || quoted.id || wpknQuote?.quoteId;
      if (!quoteId) {
        throw new Error('WPKN quote did not return an id.');
      }
      const result = await requestWpknExchange({
        quoteId,
        direction: wpknDirection,
        toAddress: address,
      }, token);
      setWpknMsg(result.status || result.message || 'Exchange requested.');
      setWpknQuote(quoted);
    } catch (err) {
      setError(err.message || 'WPKN exchange failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page desk">
      <PageHead
        kicker="Network"
        title="Wallet"
        lede={`PokoinPoS ${POKOIN_CHAIN_ID}. ${POKOIN_RPC.replace('https://', '')}. Send is chain PKN; site balance is separate.`}
      >
        {address ? (
          <button className="btn ghost" type="button" onClick={disconnect}>Disconnect</button>
        ) : (
          <button className="btn" type="button" disabled={busy} onClick={onConnect}>
            {busy ? 'Connecting…' : 'Connect MetaMask'}
          </button>
        )}
        <Link className="btn ghost" to="/buy">Buy PKN</Link>
        <a className="btn ghost" href="https://explorer.pokoin.com">Explorer</a>
      </PageHead>

      <MetricGrid>
        <Metric value={address ? shortAddress(address) : '—'} label="Account" hint={address ? 'Connected' : 'Not connected'} />
        <Metric value={balance ? balance.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '0'} label="Chain PKN" />
        <Metric value={availablePkn.toLocaleString()} label="Site PKN" />
        <Metric value={chainId || '—'} label={onPokoin || !chainId ? 'Chain' : 'Wrong chain'} />
      </MetricGrid>
      <Alert>{error}</Alert>
      {txHash ? (
        <p className="desk-ok">
          Swap sent.{' '}
          <a href={`https://explorer.pokoin.com/tx/${txHash}`} target="_blank" rel="noreferrer">{shortAddress(txHash)}</a>
        </p>
      ) : null}

      <div className="wallet-desk">
        <DeskPanel
          title="Send PKN"
          actions={(
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={async () => {
                if (!address) {
                  await onConnect();
                  return;
                }
                setBusy(true);
                setError('');
                try {
                  const hash = await sendPkn({ from: address, to: sendTo, amount: sendAmount });
                  setSendHash(hash);
                } catch (err) {
                  setError(err.message || 'Send failed.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              {address ? 'Send' : 'Connect and send'}
            </button>
          )}
        >
          <p className="page-lede">Native chain transfer from the connected account. Not site balance.</p>
          <label className="sell-field">
            To
            <input value={sendTo} onChange={(event) => setSendTo(event.target.value)} placeholder="0x…" />
          </label>
          <label className="sell-field">
            Amount
            <input inputMode="decimal" value={sendAmount} onChange={(event) => setSendAmount(event.target.value)} />
          </label>
          {sendHash ? (
            <p className="page-lede">
              Sent.{' '}
              <a href={`https://explorer.pokoin.com/tx/${sendHash}`} target="_blank" rel="noreferrer">{shortAddress(sendHash)}</a>
            </p>
          ) : null}
        </DeskPanel>

        <div>
          <DeskPanel
            title="AMM swap"
            actions={(
              <>
                <button className="btn ghost" type="button" onClick={quoteAmm}>Quote</button>
                <button className="btn" type="button" disabled={busy} onClick={swapAmm}>
                  {address ? 'Swap' : 'Connect and swap'}
                </button>
              </>
            )}
          >
            <p className="page-lede">Integer amountIn against live pools. 0.5% min-out except WPKN.</p>
            <label className="sell-field">
              Pair
              <select value={asset} onChange={(event) => setAsset(event.target.value)}>
                {pools.map((row) => (
                  <option key={row.id || row.asset} value={row.asset}>{row.asset} / PKN</option>
                ))}
              </select>
            </label>
            <label className="sell-field">
              Direction
              <select value={fromPkn ? 'pkn' : 'out'} onChange={(event) => setFromPkn(event.target.value === 'pkn')}>
                <option value="pkn">PKN → {asset}</option>
                <option value="out">{asset} → PKN</option>
              </select>
            </label>
            <label className="sell-field">
              Amount in
              <input inputMode="numeric" value={amountIn} onChange={(event) => setAmountIn(event.target.value)} />
            </label>
            {quote ? (
              <p className="page-lede">
                Out {Number(quote.amountOut || 0).toLocaleString()} {quote.assetOut || assetOut}
                {quote.price ? ` · ${quote.price}` : ''}
              </p>
            ) : null}
          </DeskPanel>

          <DeskPanel
            title="WPKN"
            actions={(
              <>
                <button className="btn ghost" type="button" onClick={quoteWpkn}>Public quote</button>
                <button className="btn" type="button" disabled={busy} onClick={requestWpkn}>
                  {signedIn ? 'Request exchange' : 'Sign in to exchange'}
                </button>
              </>
            )}
          >
            <p className="page-lede">Site PKN ↔ wrapped PKN. Needs a signed-in session and a receiving address.</p>
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
            {wpknQuote ? (
              <p className="page-lede">
                Quote {Number(wpknQuote.amountOut || wpknQuote.out || 0).toLocaleString()}
                {wpknQuote.quoteId ? ` · ${wpknQuote.quoteId}` : ''}
              </p>
            ) : null}
            {wpknMsg ? <p className="page-lede">{wpknMsg}</p> : null}
          </DeskPanel>
        </div>
      </div>
    </div>
  );
}
