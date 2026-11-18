import { createSignal, For, onSettled, Show } from 'solid-js';
import {
  fetchSwapPools,
  fetchSwapQuote,
  fetchWpknQuote,
  formatPknNumber,
  requestWpknExchange,
  requestWpknQuote,
} from '@market/api.js';
import { authFrom } from '@market/punchouts.js';
import { POKOIN_RPC, poolIdFor, sendSwapTransaction, swapPoolsOf } from '@market/wallet-tx.js';
import { getBearer, signedIn } from '../stores/auth.js';
import { connectWallet, startWallet, walletAddress } from '../stores/wallet.js';

/** /exchange: WPKN exchange and PokoinSwap. */
export default function Exchange() {
  const [busy, setBusy] = createSignal(false);
  const [flash, setFlash] = createSignal('');
  const [error, setError] = createSignal('');

  // WPKN exchange (site PKN ↔ wrapped PKN).
  const [wpknDirection, setWpknDirection] = createSignal('pkn_to_wpkn');
  const [wpknAmount, setWpknAmount] = createSignal('100');
  const [wpknQuote, setWpknQuote] = createSignal(null);

  // AMM swap against live pools.
  const [pools, setPools] = createSignal([]);
  const [asset, setAsset] = createSignal('WPKN');
  const [fromPkn, setFromPkn] = createSignal(true);
  const [amountIn, setAmountIn] = createSignal('100');
  const [ammQuote, setAmmQuote] = createSignal(null);

  onSettled(() => {
    document.title = 'Exchange · Pokoin';
    startWallet();
    let cancelled = false;
    fetchSwapPools()
      .then((data) => {
        if (cancelled) return;
        const next = swapPoolsOf(data);
        setPools(() => next);
        if (next[0]?.asset) setAsset(next[0].asset);
      })
      .catch(() => setPools(() => swapPoolsOf({})));
    return () => {
      cancelled = true;
    };
  });

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

  const poolId = () => pools().find((row) => row.asset === asset())?.id || poolIdFor(asset());

  return (
    <div class="page wallet-page">
      <section class="wallet-hero">
        <h1 class="wallet-title">Exchange</h1>
        <p class="wallet-hero-sources">Swap site PKN, WPKN, and PokoinPoS assets</p>
        <Show when={flash()}><p class="wallet-flash">{flash()}</p></Show>
        <Show when={error()}><p class="wallet-error">{error()}</p></Show>
        <a class="wallet-back" href="/wallet">Back to wallet</a>
      </section>

      <div class="exchange-grid">
        <section class="wallet-card">
          <div class="wallet-card-head">
            <h2>WPKN exchange</h2>
            <span class="wallet-card-tag">site PKN ↔ WPKN</span>
          </div>
          <p class="wallet-card-lede">Needs a signed-in session and a receiving address.</p>
          <label class="sell-field">
            Direction
            <select value={wpknDirection()} onChange={(event) => setWpknDirection(event.target.value)}>
              <option value="pkn_to_wpkn">Site PKN → WPKN</option>
              <option value="wpkn_to_pkn">WPKN → site PKN</option>
            </select>
          </label>
          <label class="sell-field">
            Amount
            <input inputMode="numeric" value={wpknAmount()} onInput={(event) => setWpknAmount(event.target.value)} />
          </label>
          <div class="wallet-tool-actions">
            <button
              class="btn ghost"
              type="button"
              onClick={() => run(async () => {
                const data = await fetchWpknQuote({
                  direction: wpknDirection(),
                  amountIn: Math.round(Number(wpknAmount()) || 0),
                });
                setWpknQuote(() => data);
              })}
            >
              Quote
            </button>
            <button
              class="btn"
              type="button"
              disabled={busy()}
              onClick={() => {
                if (!signedIn()) {
                  requireSignIn();
                  return;
                }
                if (!walletAddress()) {
                  run(connectWallet);
                  return;
                }
                run(async () => {
                  const token = await getBearer();
                  const quoted = await requestWpknQuote({
                    direction: wpknDirection(),
                    amountIn: Math.round(Number(wpknAmount()) || 0),
                  }, token);
                  const quoteId = quoted.quoteId || quoted.id || wpknQuote()?.quoteId;
                  if (!quoteId) {
                    throw new Error('WPKN quote did not return an id.');
                  }
                  const result = await requestWpknExchange({ quoteId, direction: wpknDirection(), toAddress: walletAddress() }, token);
                  setFlash(result.status || result.message || 'Exchange requested.');
                });
              }}
            >
              {signedIn() ? 'Request exchange' : 'Sign in to exchange'}
            </button>
          </div>
          <Show when={wpknQuote()}>
            {(quote) => (
              <p class="wallet-quote">
                Quote {formatPknNumber(quote().amountOut || quote().out || 0)}
                {quote().quoteId ? ` · ${quote().quoteId}` : ''}
              </p>
            )}
          </Show>
        </section>

        <section class="wallet-card">
          <div class="wallet-card-head">
            <h2>PokoinSwap</h2>
            <span class="wallet-card-tag">AMM · 0.5% min-out</span>
          </div>
          <p class="wallet-card-lede">{POKOIN_RPC.replace('https://', '')} · integer amounts against live pools.</p>
          <label class="sell-field">
            Pair
            <select value={asset()} onChange={(event) => { setAsset(event.target.value); setAmmQuote(null); }}>
              <For each={pools()}>
                {(row) => <option value={row.asset}>{row.asset} / PKN</option>}
              </For>
            </select>
          </label>
          <label class="sell-field">
            Direction
            <select
              value={fromPkn() ? 'pkn' : 'out'}
              onChange={(event) => { setFromPkn(event.target.value === 'pkn'); setAmmQuote(null); }}
            >
              <option value="pkn">PKN → {asset()}</option>
              <option value="out">{asset()} → PKN</option>
            </select>
          </label>
          <label class="sell-field">
            Amount in
            <input inputMode="numeric" value={amountIn()} onInput={(event) => { setAmountIn(event.target.value); setAmmQuote(null); }} />
          </label>
          <div class="wallet-tool-actions">
            <button
              class="btn ghost"
              type="button"
              onClick={() => run(async () => {
                const data = await fetchSwapQuote({
                  pool: poolId(),
                  assetIn: fromPkn() ? 'PKN' : asset(),
                  amountIn: Math.round(Number(amountIn()) || 0),
                });
                setAmmQuote(() => data);
              })}
            >
              Quote
            </button>
            <button
              class="btn"
              type="button"
              disabled={busy()}
              onClick={() => {
                if (!walletAddress()) {
                  run(connectWallet);
                  return;
                }
                run(async () => {
                  const pool = poolId();
                  const assetIn = fromPkn() ? 'PKN' : asset();
                  const assetOut = fromPkn() ? asset() : 'PKN';
                  const latest = ammQuote() || await fetchSwapQuote({
                    pool,
                    assetIn,
                    amountIn: Math.round(Number(amountIn()) || 0),
                  });
                  setAmmQuote(() => latest);
                  const hash = await sendSwapTransaction({
                    from: walletAddress(),
                    quote: latest,
                    poolId: pool,
                    assetIn,
                    assetOut,
                    amountIn: Math.round(Number(amountIn()) || 0),
                  });
                  setFlash(`Swap sent · ${hash ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : ''}`);
                });
              }}
            >
              {walletAddress() ? 'Swap' : 'Connect and swap'}
            </button>
          </div>
          <Show when={ammQuote()}>
            {(quote) => (
              <p class="wallet-quote">
                Out {formatPknNumber(quote().amountOut || 0)} {quote().assetOut || (fromPkn() ? asset() : 'PKN')}
                {quote().price ? ` · ${quote().price}` : ''}
              </p>
            )}
          </Show>
        </section>
      </div>
    </div>
  );
}
