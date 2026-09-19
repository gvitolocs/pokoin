import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchChainAddressActivity,
  fetchSwapPools,
  fetchSwapQuote,
  fetchWpknQuote,
  formatPknNumber,
  requestPknWithdraw,
  requestWpknExchange,
  requestWpknQuote,
  searchRecipientUsernames,
  topUpAccountBalance,
  transferAccountBalance,
} from '../api.js';
import { useAuth } from '../auth.jsx';
import { authFrom } from '../punchouts.js';
import { fetchFirestoreDocument, fetchOwnedCollectionDocuments } from '../firestore-rest.js';
import {
  activityFromChainTx,
  activityFromLedgerRow,
  activityFromWalletRow,
  activityTimeLabel,
  mergeActivity,
  shortChainAddress,
} from '../wallet-activity.js';
import {
  POKOIN_RPC,
  poolIdFor,
  sendPkn,
  sendSwapTransaction,
  switchToPokoin,
  useWallet,
} from '../wallet.jsx';

/** Bank wallet that funds account top-ups (same treasury as cardvault). */
const TREASURY_ADDRESS = '0xb4029F68E360280aa4Ad21D8aE5AD8896b8768B2';
const ACTIVITY_ROW_COUNT = 12;
const ACTIVITY_QUERY_LIMIT = 60;
const IS_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function Icon({ name, size = 22 }) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14" />,
    topup: <path d="M12 21V9m0 0-4 4m4-4 4 4M4 3h16" />,
    withdraw: <path d="M12 3v12m0 0-4-4m4 4 4-4M4 21h16" />,
    send: <path d="M4 12 20 4l-4 16-4-6-8-2Z" />,
    receive: <path d="M20 12 4 20l4-16 4 6 8 2Z" />,
    swap: <path d="M4 8h13m0 0-3.5-3.5M17 8l-3.5 3.5M20 16H7m0 0 3.5 3.5M7 16l3.5-3.5" />,
    more: <path d="M6 12h.01M12 12h.01M18 12h.01" />,
    copy: <path d="M9 9h10v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9Zm-2 6H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" />,
    check: <path d="m4 12 5 5L20 6" />,
    link: <path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7L12.5 19" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || null}
    </svg>
  );
}

function BalanceText({ value }) {
  const [whole, frac = ''] = formatPknNumber(value, { maximumFractionDigits: 2 }).split('.');
  return (
    <span className="wallet-balance">
      {whole}
      <span className="wallet-balance-frac">.{(frac || '0').padEnd(2, '0')}</span>
      <span className="wallet-balance-cur">PKN</span>
    </span>
  );
}

function Sheet({ title, onClose, children }) {
  useEffect(() => {
    function onKey(event) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="wallet-sheet-backdrop" onClick={onClose}>
      <div
        className="wallet-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="wallet-sheet-grab" aria-hidden="true" />
        <div className="wallet-sheet-head">
          <h2>{title}</h2>
          <button className="wallet-sheet-close" type="button" aria-label="Close" onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function CopyRow({ label, value, mono = true }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch (_) {
      const area = document.createElement('textarea');
      area.value = value;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }
  return (
    <button className="wallet-copy-row" type="button" onClick={copy}>
      <span className="wallet-copy-text">
        <span className="wallet-copy-label">{label}</span>
        <span className={mono ? 'wallet-copy-value mono' : 'wallet-copy-value'}>{value}</span>
      </span>
      <span className={copied ? 'wallet-copy-action on' : 'wallet-copy-action'}>
        <Icon name={copied ? 'check' : 'copy'} size={18} />
      </span>
    </button>
  );
}

function Presets({ balance, onPick }) {
  const max = Math.floor(Number(balance) || 0);
  const presets = [1, 5, 10, max].filter((amount, index, all) => amount > 0 && all.indexOf(amount) === index);
  if (!presets.length) {
    return null;
  }
  return (
    <div className="wallet-presets">
      {presets.map((amount) => (
        <button key={amount} type="button" onClick={() => onPick(String(amount))}>
          {amount === max ? 'Max' : `${amount} PKN`}
        </button>
      ))}
    </div>
  );
}

function PercentRow({ onPick }) {
  return (
    <div className="wallet-presets">
      {[25, 50, 100].map((pct) => (
        <button key={pct} type="button" onClick={() => onPick(pct)}>{pct}%</button>
      ))}
    </div>
  );
}

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

const HERO_MODES = ['accounts', 'site', 'chain'];

export default function Wallet() {
  const { address, balance, chainId, connect, disconnect } = useWallet();
  const { signedIn, user, profile, availablePkn, getBearer } = useAuth();
  const uid = profile?.uid || user?.uid || '';

  const [mode, setMode] = useState('accounts');
  const [sheet, setSheet] = useState('');
  const [flash, setFlash] = useState('');
  const [error, setError] = useState('');
  const [linkedAddress, setLinkedAddress] = useState('');
  const [activity, setActivity] = useState([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [showAllActivity, setShowAllActivity] = useState(false);

  const [busy, setBusy] = useState(false);

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

  const refreshActivity = useCallback(async () => {
    setActivityLoading(true);
    const groups = await Promise.allSettled([
      (async () => {
        const token = await getBearer();
        const rows = await fetchOwnedCollectionDocuments('ledger_entries', uid, token);
        return rows.map(activityFromLedgerRow);
      })(),
      (async () => {
        const token = await getBearer();
        const rows = await fetchOwnedCollectionDocuments('wallet_activity', uid, token);
        return rows.map(activityFromWalletRow);
      })(),
      (async () => {
        if (!address) return [];
        const txs = await fetchChainAddressActivity(address, { limit: ACTIVITY_QUERY_LIMIT });
        return txs.map((tx) => activityFromChainTx(tx, address));
      })(),
    ]);
    setActivity(mergeActivity(
      groups.map((row) => (row.status === 'fulfilled' ? row.value : [])),
      { limit: ACTIVITY_QUERY_LIMIT },
    ));
    setActivityLoading(false);
  }, [address, getBearer, uid]);

  useEffect(() => {
    document.title = 'Wallet · Pokoin';
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

  useEffect(() => {
    if (!uid) {
      setLinkedAddress('');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const token = await getBearer();
        const doc = await fetchFirestoreDocument('users', uid, token);
        if (!cancelled) {
          setLinkedAddress(String(doc.walletAddress || '').trim().toLowerCase());
        }
      } catch (_) {
        if (!cancelled) setLinkedAddress('');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [uid, getBearer]);

  useEffect(() => {
    refreshActivity();
  }, [refreshActivity]);

  const onPokoin = chainId === 26062026;
  const chainAccount = address ? {
    detail: onPokoin ? shortChainAddress(address) : 'Wrong network',
    balance,
  } : null;
  const total = availablePkn + (chainAccount ? balance : 0);

  const hero = useMemo(() => {
    if (mode === 'site') {
      return { label: 'Pokoin balance', value: availablePkn };
    }
    if (mode === 'chain') {
      return { label: 'PokoinPoS', value: balance };
    }
    return { label: 'Total balance', value: total };
  }, [mode, availablePkn, balance, total]);

  function cycleMode() {
    const next = HERO_MODES[(HERO_MODES.indexOf(mode) + 1) % HERO_MODES.length];
    setMode(next === 'chain' && !address ? 'accounts' : next);
  }

  function requireSignIn() {
    window.location.href = authFrom('/wallet');
  }

  async function run(task, { okMessage = '' } = {}) {
    setBusy(true);
    setError('');
    setFlash('');
    try {
      await task();
      if (okMessage) setFlash(okMessage);
      refreshActivity();
      return true;
    } catch (err) {
      setError(err.message || 'Something went wrong.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  function closeSheet() {
    setSheet('');
  }

  const actions = [
    { key: 'add', icon: 'plus', label: 'Add money', to: '/buy' },
    { key: 'topup', icon: 'topup', label: 'Top up', sheet: 'topup' },
    { key: 'withdraw', icon: 'withdraw', label: 'Withdraw', sheet: 'withdraw' },
    { key: 'send', icon: 'send', label: 'Send', sheet: 'send' },
    { key: 'receive', icon: 'receive', label: 'Receive', sheet: 'receive' },
    { key: 'swap', icon: 'swap', label: 'Swap', sheet: 'swap' },
    { key: 'more', icon: 'more', label: 'More', sheet: 'more' },
  ];

  const visibleActivity = showAllActivity ? activity : activity.slice(0, ACTIVITY_ROW_COUNT);

  return (
    <div className="page wallet-page">
      <section className="wallet-hero">
        <div className="wallet-hero-kicker">Wallet</div>
        <div className="wallet-hero-label">{hero.label}</div>
        <BalanceText value={hero.value} />
        <button className="wallet-accounts-pill" type="button" onClick={cycleMode}>
          Accounts
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {mode === 'accounts' && total > 0 ? (
          <p className="wallet-hero-sub">
            {formatPknNumber(availablePkn)} site{chainAccount ? ` · ${formatPknNumber(balance, { maximumFractionDigits: 4 })} chain` : ''}
          </p>
        ) : null}
        {mode === 'chain' ? (
          address ? (
            <p className="wallet-hero-sub mono">
              {onPokoin ? shortChainAddress(address) : 'Switch MetaMask to PokoinPoS'}
            </p>
          ) : (
            <button className="wallet-hero-connect" type="button" onClick={() => run(connect)}>Connect MetaMask</button>
          )
        ) : null}
        {flash ? <p className="wallet-flash">{flash}</p> : null}
        {error ? <p className="wallet-error">{error}</p> : null}
      </section>

      <nav className="wallet-actions" aria-label="Wallet actions">
        {actions.map((action) => {
          const inner = (
            <>
              <span className="wallet-action-circle"><Icon name={action.icon} /></span>
              <span className="wallet-action-label">{action.label}</span>
            </>
          );
          return action.to ? (
            <Link className="wallet-action" key={action.key} to={action.to}>{inner}</Link>
          ) : (
            <button className="wallet-action" key={action.key} type="button" onClick={() => setSheet(action.sheet)}>
              {inner}
            </button>
          );
        })}
      </nav>

      <section className="wallet-card">
        <div className="wallet-card-head">
          <h2>Activity</h2>
          {activity.length > ACTIVITY_ROW_COUNT ? (
            <button className="wallet-see-all" type="button" onClick={() => setShowAllActivity((value) => !value)}>
              {showAllActivity ? 'Show less' : 'See all'}
            </button>
          ) : null}
        </div>
        {activityLoading && !activity.length ? (
          <p className="wallet-empty">Loading activity…</p>
        ) : visibleActivity.length ? (
          <ul className="wallet-activity">
            {visibleActivity.map((item) => (
              <li key={item.key} className="wallet-activity-row">
                <span className={item.kind === 'inbound' ? 'wallet-activity-icon in' : 'wallet-activity-icon out'}>
                  <Icon name={item.kind === 'inbound' ? 'receive' : 'send'} size={17} />
                </span>
                <span className="wallet-activity-text">
                  <span className="wallet-activity-title">{item.title}</span>
                  <span className="wallet-activity-time">
                    {activityTimeLabel(item.at) || item.blockLabel}
                    {item.detail && !item.detail.includes('0x') ? ` · ${item.detail}` : ''}
                  </span>
                </span>
                {item.amountPkn != null && item.amountPkn !== 0 ? (
                  <span className={item.amountPkn > 0 ? 'wallet-activity-amount in' : 'wallet-activity-amount'}>
                    {item.amountPkn > 0 ? '+' : '−'}{formatPknNumber(Math.abs(item.amountPkn))} PKN
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="wallet-empty">
            {signedIn
              ? 'No activity yet. Add money, send PKN, or swap to see it here.'
              : 'Sign in to see your account activity.'}
          </p>
        )}
      </section>

      <section className="wallet-card">
        <div className="wallet-card-head"><h2>Accounts</h2></div>
        <div className="wallet-accounts">
          <button className="wallet-account-row" type="button" onClick={() => setMode('site')}>
            <span className="wallet-account-icon pk"><Icon name="topup" size={18} /></span>
            <span className="wallet-activity-text">
              <span className="wallet-activity-title">Pokoin balance</span>
              <span className="wallet-activity-time">{profile?.username || (signedIn ? 'Site account' : 'Sign in to activate')}</span>
            </span>
            <span className="wallet-account-amount">{formatPknNumber(availablePkn)} PKN</span>
          </button>
          <button className="wallet-account-row" type="button" onClick={() => setMode('chain')}>
            <span className="wallet-account-icon chain"><Icon name="link" size={18} /></span>
            <span className="wallet-activity-text">
              <span className="wallet-activity-title">PokoinPoS</span>
              <span className="wallet-activity-time">{chainAccount ? chainAccount.detail : 'Connect MetaMask'}</span>
            </span>
            <span className="wallet-account-amount">
              {chainAccount ? `${formatPknNumber(balance, { maximumFractionDigits: 4 })} PKN` : '—'}
            </span>
          </button>
        </div>
      </section>

      <div className="wallet-tools">
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
                  setFlash(`Swap sent · ${shortChainAddress(hash)}`);
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

      {sheet === 'send' ? (
        <SendSheet
          onClose={closeSheet}
          busy={busy}
          signedIn={signedIn}
          profile={profile}
          address={address}
          balance={balance}
          getBearer={getBearer}
          onConnect={() => run(connect)}
          onRequireSignIn={requireSignIn}
          onTransfer={(recipient, amount) => run(async () => {
            const token = await getBearer();
            await transferAccountBalance({ recipientUsername: recipient, amountPkn: Math.round(Number(amount)) }, token);
          }, { okMessage: `Sent ${Math.round(Number(amount))} PKN to ${recipient}.` })}
          onChainSend={(to, amount) => run(async () => {
            const hash = await sendPkn({ from: address, to, amount });
            setFlash(`Sent on-chain · ${shortChainAddress(hash)}`);
          })}
        />
      ) : null}

      {sheet === 'receive' ? (
        <Sheet title="Receive PKN" onClose={closeSheet}>
          <p className="wallet-sheet-lede">
            Share your Pokoin username for site balance transfers
            {address ? ', or your 0x address for on-chain PKN.' : '.'}
          </p>
          {signedIn && profile?.username ? (
            <CopyRow label="Pokoin username" value={profile.username} mono={false} />
          ) : (
            <p className="wallet-sheet-note">Sign in to receive by username.</p>
          )}
          {address ? <CopyRow label="PokoinPoS address" value={address} /> : null}
        </Sheet>
      ) : null}

      {sheet === 'withdraw' ? (
        <WithdrawSheet
          onClose={closeSheet}
          busy={busy}
          signedIn={signedIn}
          availablePkn={availablePkn}
          payoutAddress={linkedAddress || address}
          onRequireSignIn={requireSignIn}
          onWithdraw={(to, amount) => run(async () => {
            const token = await getBearer();
            const result = await requestPknWithdraw({ toAddress: to, amountPkn: Math.round(Number(amount)) }, token);
            setFlash(result.payoutTxHash
              ? 'Withdraw sent from the bank wallet.'
              : result.warning || 'Withdraw request created for manual bank payout.');
          })}
        />
      ) : null}

      {sheet === 'topup' ? (
        <TopUpSheet
          onClose={closeSheet}
          busy={busy}
          signedIn={signedIn}
          address={address}
          linkedAddress={linkedAddress}
          chainBalance={balance}
          onConnect={() => run(connect)}
          onRequireSignIn={requireSignIn}
          onTopUp={(amount) => run(async () => {
            const hash = await sendPkn({ from: address, to: TREASURY_ADDRESS, amount });
            const token = await getBearer();
            await topUpAccountBalance({ amountPkn: Math.round(Number(amount)), fundingTxHash: hash }, token);
          }, { okMessage: 'Account balance topped up.' })}
        />
      ) : null}

      {sheet === 'swap' ? (
        <Sheet title="Swap" onClose={closeSheet}>
          <p className="wallet-sheet-lede">Exchange tools live below your activity feed.</p>
          <button
            className="wallet-sheet-cta"
            type="button"
            onClick={() => {
              closeSheet();
              document.querySelector('.wallet-tools')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
          >
            Open swap tools
          </button>
        </Sheet>
      ) : null}

      {sheet === 'more' ? (
        <Sheet title="More" onClose={closeSheet}>
          <div className="wallet-more">
            <a href="https://explorer.pokoin.com" target="_blank" rel="noreferrer">Block explorer</a>
            <Link to="/buy" onClick={closeSheet}>Buy PKN</Link>
            <Link to="/nft" onClick={closeSheet}>NFT</Link>
            <Link to="/profile" onClick={closeSheet}>Profile</Link>
            <button type="button" onClick={() => run(switchToPokoin)}>Add Pokoin network</button>
            {address ? (
              <button type="button" className="danger" onClick={() => { disconnect(); closeSheet(); }}>Disconnect MetaMask</button>
            ) : (
              <button type="button" onClick={() => { run(connect); closeSheet(); }}>Connect MetaMask</button>
            )}
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}

function SendSheet({
  onClose, busy, signedIn, profile, address, balance, getBearer,
  onConnect, onRequireSignIn, onTransfer, onChainSend,
}) {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);
  const toChain = IS_ADDRESS.test(recipient.trim());

  useEffect(() => {
    const query = recipient.trim().toLowerCase();
    if (query.length < 2 || query.includes('@') || IS_ADDRESS.test(query)) {
      setSuggestions([]);
      setSearching(false);
      return () => {};
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setSearching(true);
      getBearer()
        .then((token) => searchRecipientUsernames(query, token))
        .then((data) => {
          if (!cancelled) setSuggestions((data.usernames || []).slice(0, 6));
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [recipient, getBearer]);

  function submit() {
    const to = recipient.trim();
    const value = String(amount || '').trim();
    if (!to || !(Number(value) > 0)) {
      return;
    }
    onClose();
    if (toChain) {
      if (!address) {
        onConnect();
        return;
      }
      onChainSend(to, value);
      return;
    }
    if (!signedIn) {
      onRequireSignIn();
      return;
    }
    if (!/^[a-zA-Z0-9]{3,32}$/.test(to)) {
      return;
    }
    onTransfer(to, value);
  }

  return (
    <Sheet title="Send PKN" onClose={onClose}>
      <p className="wallet-sheet-lede">
        Pokoin username sends from your site balance
        {address ? '; a 0x address sends from your connected MetaMask wallet.' : '.'}
      </p>
      <label className="sell-field">
        Recipient username or 0x address
        <input
          value={recipient}
          autoFocus
          onChange={(event) => setRecipient(event.target.value)}
          placeholder={profile?.username ? `e.g. ${profile.username}` : 'username or 0x…'}
        />
      </label>
      {searching || suggestions.length ? (
        <div className="wallet-suggestions">
          {suggestions.map((name) => (
            <button key={name} type="button" onClick={() => setRecipient(name)}>{name}</button>
          ))}
        </div>
      ) : null}
      <label className="sell-field">
        Amount{toChain ? '' : ' (whole PKN)'}
        <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0" />
      </label>
      {toChain ? (
        <PercentRow
          onPick={(pct) => setAmount(
            ((Number(balance) || 0) * pct / 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, ''),
          )}
        />
      ) : (
        <Presets onPick={setAmount} />
      )}
      <button className="wallet-sheet-cta" type="button" disabled={busy} onClick={submit}>
        {toChain && !address ? 'Connect to send' : 'Send'}
      </button>
    </Sheet>
  );
}

function WithdrawSheet({
  onClose, busy, signedIn, availablePkn, payoutAddress, onRequireSignIn, onWithdraw,
}) {
  const [amount, setAmount] = useState('');
  const max = Math.floor(Number(availablePkn) || 0);
  return (
    <Sheet title="Withdraw PKN" onClose={onClose}>
      <p className="wallet-sheet-lede">Whole PKN payout from your site balance to your linked wallet.</p>
      {payoutAddress ? (
        <p className="wallet-sheet-note mono">{shortChainAddress(payoutAddress)}</p>
      ) : (
        <p className="wallet-sheet-note">Link or connect a wallet to set your payout address.</p>
      )}
      <label className="sell-field">
        Amount — available {formatPknNumber(max)} PKN
        <input inputMode="numeric" value={amount} autoFocus onChange={(event) => setAmount(event.target.value)} placeholder="0" />
      </label>
      <Presets balance={max} onPick={setAmount} />
      <button
        className="wallet-sheet-cta"
        type="button"
        disabled={busy}
        onClick={() => {
          if (!signedIn) {
            onRequireSignIn();
            return;
          }
          const value = Math.round(Number(amount) || 0);
          if (!payoutAddress || !IS_ADDRESS.test(payoutAddress) || value <= 0 || value > max) {
            return;
          }
          onClose();
          onWithdraw(payoutAddress, String(value));
        }}
      >
        {signedIn ? 'Withdraw' : 'Sign in to withdraw'}
      </button>
    </Sheet>
  );
}

function TopUpSheet({
  onClose, busy, signedIn, address, linkedAddress, chainBalance, onConnect, onRequireSignIn, onTopUp,
}) {
  const [amount, setAmount] = useState('');
  const mismatch = address && linkedAddress && address.toLowerCase() !== linkedAddress;
  return (
    <Sheet title="Top up account balance" onClose={onClose}>
      <p className="wallet-sheet-lede">
        Move whole PKN from your connected MetaMask wallet into your site account balance.
      </p>
      {!address ? (
        <button className="wallet-sheet-cta" type="button" onClick={() => { onClose(); onConnect(); }}>Connect MetaMask</button>
      ) : !signedIn ? (
        <button className="wallet-sheet-cta" type="button" onClick={onRequireSignIn}>Sign in to top up</button>
      ) : mismatch ? (
        <p className="wallet-sheet-note">
          Switch MetaMask to your linked wallet ({shortChainAddress(linkedAddress)}) before topping up.
        </p>
      ) : (
        <>
          <label className="sell-field">
            Amount — chain {formatPknNumber(chainBalance, { maximumFractionDigits: 4 })} PKN
            <input inputMode="numeric" value={amount} autoFocus onChange={(event) => setAmount(event.target.value)} placeholder="0" />
          </label>
          <Presets balance={chainBalance} onPick={setAmount} />
          <button
            className="wallet-sheet-cta"
            type="button"
            disabled={busy}
            onClick={() => {
              const value = Math.round(Number(amount) || 0);
              if (value <= 0 || value > Number(chainBalance)) {
                return;
              }
              onClose();
              onTopUp(String(value));
            }}
          >
            Top up
          </button>
        </>
      )}
    </Sheet>
  );
}
