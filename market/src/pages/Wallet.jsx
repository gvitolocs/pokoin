import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import jsQR from 'jsqr';
import {
  fetchChainAddressActivity,
  formatPknNumber,
  requestPknWithdraw,
  searchRecipientUsernames,
  topUpAccountBalance,
  transferAccountBalance,
} from '../api.js';
import { useAuth } from '../auth.jsx';
import { authFrom } from '../punchouts.js';
import { fetchFirestoreDocument, fetchOwnedCollectionDocuments } from '../firestore-rest.js';
import { encodeQr, qrPath } from '../qr.js';
import {
  activityFromChainTx,
  activityFromLedgerRow,
  activityFromWalletRow,
  activityTimeLabel,
  mergeActivity,
  shortChainAddress,
} from '../wallet-activity.js';
import { buildReceiveQr, parseScannedQr, parseWalletSendLink } from '../wallet-qr.js';
import { sendPkn, switchToPokoin, useWallet } from '../wallet.jsx';
import {
  createMoneyRequest,
  newClientToken,
} from '../money-requests.js';

/** Bank wallet that funds account top-ups (same treasury as cardvault). */
const TREASURY_ADDRESS = '0xb4029F68E360280aa4Ad21D8aE5AD8896b8768B2';
const ACTIVITY_ROW_COUNT = 12;
const ACTIVITY_QUERY_LIMIT = 60;
const IS_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function Icon({ name, size = 22 }) {
  const paths = {
    topup: <path d="M12 21V9m0 0-4 4m4-4 4 4M4 3h16" />,
    withdraw: <path d="M12 3v12m0 0-4-4m4 4 4-4M4 21h16" />,
    send: <path d="M4 12 20 4l-4 16-4-6-8-2Z" />,
    receive: <path d="M20 12 4 20l4-16 4 6 8 2Z" />,
    swap: <path d="M4 8h13m0 0-3.5-3.5M17 8l-3.5 3.5M20 16H7m0 0 3.5 3.5M7 16l3.5-3.5" />,
    copy: <path d="M9 9h10v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9Zm-2 6H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" />,
    check: <path d="m4 12 5 5L20 6" />,
    link: <path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7L12.5 19" />,
    wallet: <path d="M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm13 4h4v4h-4a2 2 0 0 1 0-4Z" />,
    activity: <path d="M3 12h4l2.5-7 5 14 2.5-7H21" />,
    qr: (
      <>
        <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
        <path d="M9 9h2v2H9V9Zm4 0h2v2h-2V9Zm-4 4h2v2H9v-2Zm4 0h2v2h-2v-2Z" />
      </>
    ),
    camera: (
      <>
        <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7H7l1.6-2.2h6.8L17 7h2.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-9Z" />
        <circle cx="12" cy="12.6" r="3.4" />
      </>
    ),
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

function Presets({ balance, amounts, onPick }) {
  const max = Math.floor(Number(balance) || 0);
  const presets = (amounts || [1, 5, 10, max])
    .filter((amount, index, all) => amount > 0 && all.indexOf(amount) === index);
  if (!presets.length) {
    return null;
  }
  return (
    <div className="wallet-presets">
      {presets.map((amount) => (
        <button key={amount} type="button" onClick={() => onPick(String(amount))}>
          {!amounts && amount === max ? 'Max' : `${amount} PKN`}
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

const HERO_MODES = ['accounts', 'site', 'chain'];

export default function Wallet() {
  const navigate = useNavigate();
  const location = useLocation();
  const { address, balance, chainId, connect, disconnect } = useWallet();
  const { signedIn, user, profile, availablePkn, getBearer } = useAuth();
  const uid = profile?.uid || user?.uid || '';

  const [sheet, setSheet] = useState('');
  const [sendPrefill, setSendPrefill] = useState({ recipient: '', amount: '', fromQr: false });
  const [flash, setFlash] = useState('');
  const [error, setError] = useState('');
  const [linkedAddress, setLinkedAddress] = useState('');
  const [activity, setActivity] = useState([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [showAllActivity, setShowAllActivity] = useState(false);
  const [busy, setBusy] = useState(false);

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

  // Deep link from a receive QR / shared payment URL: open Send with the
  // recipient (and optional amount) already filled. Strip the query so a
  // refresh does not re-open the sheet.
  useEffect(() => {
    const parsed = parseWalletSendLink(`${location.pathname}${location.search}`);
    if (!parsed) return;
    setSendPrefill({
      recipient: parsed.recipient,
      amount: parsed.amountPkn || '',
      fromQr: true,
    });
    setSheet('send');
    navigate('/wallet', { replace: true });
  }, [location.pathname, location.search, navigate]);

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
    setSendPrefill({ recipient: '', amount: '', fromQr: false });
  }

  const actions = [
    { key: 'send', icon: 'send', label: 'Send', sheet: 'send' },
    { key: 'receive', icon: 'receive', label: 'Receive', sheet: 'receive' },
    { key: 'withdraw', icon: 'withdraw', label: 'Withdraw', sheet: 'withdraw' },
    { key: 'topup', icon: 'topup', label: 'Top up', sheet: 'topup' },
    { key: 'swap', icon: 'swap', label: 'Exchange', to: '/exchange' },
  ];

  const visibleActivity = showAllActivity ? activity : activity.slice(0, ACTIVITY_ROW_COUNT);

  return (
    <div className="page wallet-page">
      <section className="wallet-hero">
        <h1 className="wallet-title">Wallet</h1>
        <BalanceText value={total} />
        {chainAccount ? (
          <p className="wallet-hero-sources">
            Pokoin {formatPknNumber(availablePkn)} · PokoinPoS {formatPknNumber(balance, { maximumFractionDigits: 2 })}
          </p>
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
          <div className="wallet-empty">
            <span className="wallet-empty-icon loading"><Icon name="activity" size={22} /></span>
            <p className="wallet-empty-title">Loading activity…</p>
          </div>
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
          <div className="wallet-empty">
            <span className="wallet-empty-icon"><Icon name="activity" size={22} /></span>
            <p className="wallet-empty-title">No activity yet</p>
          </div>
        )}
      </section>

      <section className="wallet-card">
        <div className="wallet-card-head"><h2>Your wallets</h2></div>
        <div className="wallet-sources">
          <div className="wallet-source">
            <span className="wallet-source-icon gold"><Icon name="wallet" size={18} /></span>
            <span className="wallet-source-text">
              <span className="wallet-source-name">Pokoin balance</span>
              <span className="wallet-source-status">
                <span className={signedIn ? 'wallet-dot on' : 'wallet-dot'} />
                {signedIn ? (profile?.username || 'Signed in') : 'Not signed in'}
              </span>
            </span>
            <span className="wallet-source-end">
              <span className="wallet-source-amount">{formatPknNumber(availablePkn)} PKN</span>
              {!signedIn ? (
                <button className="wallet-source-link" type="button" onClick={requireSignIn}>Sign in</button>
              ) : null}
            </span>
          </div>
          <div className="wallet-source">
            <span className="wallet-source-icon chain"><Icon name="link" size={18} /></span>
            <span className="wallet-source-text">
              <span className="wallet-source-name">PokoinPoS</span>
              <span className="wallet-source-status">
                <span className={!address ? 'wallet-dot' : onPokoin ? 'wallet-dot on' : 'wallet-dot warn'} />
                {!address
                  ? 'Not connected'
                  : onPokoin ? shortChainAddress(address) : 'Wrong network'}
              </span>
            </span>
            <span className="wallet-source-end">
              {address ? (
                <>
                  <span className="wallet-source-amount">{formatPknNumber(balance, { maximumFractionDigits: 4 })} PKN</span>
                  {!onPokoin ? (
                    <button className="wallet-source-link" type="button" onClick={() => run(switchToPokoin)}>Switch network</button>
                  ) : (
                    <button className="wallet-source-link" type="button" onClick={() => run(disconnect)}>Disconnect</button>
                  )}
                </>
              ) : (
                <button className="wallet-source-cta" type="button" onClick={() => run(connect)}>Connect wallet</button>
              )}
            </span>
          </div>
        </div>
      </section>

      {sheet === 'send' ? (
        <SendSheet
          onClose={closeSheet}
          busy={busy}
          signedIn={signedIn}
          profile={profile}
          address={address}
          balance={balance}
          getBearer={getBearer}
          initialRecipient={sendPrefill.recipient}
          initialAmount={sendPrefill.amount}
          fromQr={sendPrefill.fromQr}
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
        <ReceiveSheet
          onClose={closeSheet}
          signedIn={signedIn}
          profile={profile}
          address={address}
          chainId={chainId}
          getBearer={getBearer}
          onConnect={() => run(connect)}
          onRequireSignIn={requireSignIn}
          onOpenConversation={(username) => navigate(`/messages/${encodeURIComponent(username)}`)}
        />
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
    </div>
  );
}

function SendSheet({
  onClose, busy, signedIn, profile, address, balance, getBearer,
  onConnect, onRequireSignIn, onTransfer, onChainSend,
  initialRecipient = '', initialAmount = '', fromQr = false,
}) {
  const [recipient, setRecipient] = useState(initialRecipient);
  const [amount, setAmount] = useState(initialAmount);
  const [search, setSearch] = useState({ status: 'idle', rows: [] });
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState('');
  const [scanned, setScanned] = useState(fromQr && initialRecipient ? initialRecipient : '');
  const videoRef = useRef(null);
  const toChain = IS_ADDRESS.test(recipient.trim());
  const query = recipient.trim().toLowerCase();
  const searchable = query.length >= 2 && !query.includes('@') && !IS_ADDRESS.test(query);

  // Camera + decode loop while the scanner is open. A decoded code only
  // PREFILLS the form — the transfer itself always waits for Send.
  useEffect(() => {
    if (!scanning) {
      return () => {};
    }
    let cancelled = false;
    let timer = 0;
    let stream = null;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let detector = null;
    if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
      try {
        detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch (_) {
        detector = null;
      }
    }
    setScanMsg('');
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
      } catch (_) {
        if (!cancelled) setScanMsg('Camera unavailable — allow camera access and try again.');
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        video.play().catch(() => {});
      }
      timer = setInterval(async () => {
        const el = videoRef.current;
        if (!el || el.readyState < 2) return;
        try {
          let text = '';
          if (detector) {
            const codes = await detector.detect(el);
            text = codes?.[0]?.rawValue || '';
          } else if (el.videoWidth && el.videoHeight) {
            canvas.width = el.videoWidth;
            canvas.height = el.videoHeight;
            ctx.drawImage(el, 0, 0);
            const code = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
            text = code?.data || '';
          }
          if (!text) return;
          const parsed = parseScannedQr(text);
          if (!parsed) {
            setScanMsg('Not a Pokoin payment code — keep the code inside the frame.');
            return;
          }
          setScanning(false);
          setRecipient(parsed.recipient);
          setAmount(parsed.amountPkn || '');
          setScanned(parsed.recipient);
          setScanMsg('');
        } catch (_) {
          // frame skipped — keep scanning
        }
      }, 180);
    })();
    return () => {
      cancelled = true;
      clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [scanning]);

  useEffect(() => {
    if (!searchable) {
      setSearch({ status: 'idle', rows: [] });
      return () => {};
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setSearch({ status: 'searching', rows: [] });
      getBearer()
        .then((token) => {
          if (cancelled) {
            return undefined;
          }
          if (!token) {
            setSearch({ status: 'signedout', rows: [] });
            return undefined;
          }
          return searchRecipientUsernames(query, token).then((data) => {
            if (cancelled) {
              return;
            }
            const rows = (data.usernames || []).slice(0, 6);
            setSearch({ status: rows.length ? 'results' : 'none', rows });
          });
        })
        .catch(() => {
          if (!cancelled) setSearch({ status: 'error', rows: [] });
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchable, query, getBearer]);

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

  if (scanning) {
    return (
      <Sheet title="Scan payment QR" onClose={() => { setScanning(false); onClose(); }}>
        <div className="wallet-scanner">
          <div className="wallet-scanner-frame">
            <video ref={videoRef} className="wallet-scanner-video" muted playsInline />
            <span className="wallet-scanner-corner tl" aria-hidden="true" />
            <span className="wallet-scanner-corner tr" aria-hidden="true" />
            <span className="wallet-scanner-corner bl" aria-hidden="true" />
            <span className="wallet-scanner-corner br" aria-hidden="true" />
          </div>
          <p className={scanMsg ? 'wallet-scanner-msg err' : 'wallet-scanner-msg'}>
            {scanMsg || 'Point the camera at a Pokoin payment code'}
          </p>
        </div>
        <button className="wallet-sheet-cta" type="button" onClick={() => setScanning(false)}>
          Cancel
        </button>
      </Sheet>
    );
  }

  return (
    <Sheet title="Send PKN" onClose={onClose}>
      <label className="sell-field">
        Recipient username or 0x address
        <span className="wallet-input-row">
          <input
            value={recipient}
            autoFocus
            onChange={(event) => setRecipient(event.target.value)}
            placeholder={profile?.username ? `e.g. ${profile.username}` : 'username or 0x…'}
          />
          <button
            className="wallet-cam"
            type="button"
            aria-label="Scan a payment QR code"
            onClick={(event) => {
              event.preventDefault();
              setScanned('');
              setScanning(true);
            }}
          >
            <Icon name="camera" size={18} />
          </button>
        </span>
      </label>
      {scanned ? (
        <p className="wallet-scan-ok">
          {amount
            ? `Sending to ${scanned} · ${amount} PKN loaded — confirm before Send.`
            : `Sending to ${scanned} — enter an amount, then Send.`}
        </p>
      ) : null}
      {search.status === 'results' ? (
        <div className="wallet-suggestions">
          {search.rows.map((name) => (
            <button key={name} type="button" onClick={() => setRecipient(name)}>{name}</button>
          ))}
        </div>
      ) : search.status === 'searching' ? (
        <p className="wallet-suggestions-note">Searching usernames…</p>
      ) : search.status === 'none' ? (
        <p className="wallet-suggestions-note">No matching usernames.</p>
      ) : search.status === 'signedout' || search.status === 'error' ? (
        <p className="wallet-suggestions-note">Sign in to search recipients.</p>
      ) : null}
      <label className="sell-field">
        Amount
        <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0" />
      </label>
      {toChain ? (
        <PercentRow
          onPick={(pct) => setAmount(
            ((Number(balance) || 0) * pct / 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, ''),
          )}
        />
      ) : (
        <Presets amounts={[2000, 5000, 10000]} onPick={setAmount} />
      )}
      <button className="wallet-sheet-cta" type="button" disabled={busy} onClick={submit}>
        {toChain && !address ? 'Connect to send' : 'Send'}
      </button>
    </Sheet>
  );
}

function ReceiveSheet({
  onClose, signedIn, profile, address, chainId, getBearer, onConnect, onRequireSignIn, onOpenConversation,
}) {
  const onPokoin = chainId === 26062026;
  const hasSite = Boolean(signedIn && profile?.username);
  const [kind, setKind] = useState(hasSite || !address ? 'site' : 'chain');
  const [amountOpen, setAmountOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [reqUser, setReqUser] = useState('');
  const [reqNote, setReqNote] = useState('');
  const [reqState, setReqState] = useState({ status: 'idle', message: '' });
  const cleanAmount = /^\d{1,9}$/.test(String(amount).trim()) ? String(Number(amount.trim())) : '';
  const effectiveKind = kind === 'chain' && address ? 'chain' : 'site';
  // Fall back to the plain code while the typed amount is incomplete.
  const payload = buildReceiveQr({
    kind: effectiveKind,
    username: profile?.username,
    address,
    amount: cleanAmount,
  }) || buildReceiveQr({ kind: effectiveKind, username: profile?.username, address });
  const qr = payload ? encodeQr(payload, { ecc: 'M' }) : null;
  const handle = effectiveKind === 'chain' ? address : (profile?.username || '');

  return (
    <Sheet title="Receive PKN" onClose={onClose}>
      <div className="wallet-qr-card">
        {qr ? (
          <>
            <svg
              viewBox={`0 0 ${qr.size + 8} ${qr.size + 8}`}
              className="wallet-qr-svg"
              role="img"
              aria-label="Payment QR code"
              shapeRendering="crispEdges"
            >
              <rect width={qr.size + 8} height={qr.size + 8} fill="#ffffff" />
              <path d={qrPath(qr)} fill="#171310" />
            </svg>
            {cleanAmount ? <span className="wallet-qr-requested">Requested · {cleanAmount} PKN</span> : null}
          </>
        ) : (
          <div className="wallet-qr-empty">
            <span className="wallet-qr-empty-icon"><Icon name="qr" size={26} /></span>
            <p className="wallet-qr-empty-title">
              {effectiveKind === 'chain' ? 'Connect a wallet for an on-chain code' : 'Sign in to get your receive code'}
            </p>
            {effectiveKind === 'chain' ? (
              <button className="wallet-source-cta" type="button" onClick={onConnect}>Connect wallet</button>
            ) : (
              <button className="wallet-source-cta" type="button" onClick={onRequireSignIn}>Sign in</button>
            )}
          </div>
        )}
      </div>

      {qr && handle ? (
        <CopyRow
          label={effectiveKind === 'chain' ? 'PokoinPoS address' : 'Pokoin username'}
          value={handle}
          mono={effectiveKind === 'chain'}
        />
      ) : null}

      <div className="wallet-segments">
        <button className={effectiveKind === 'site' ? 'on' : ''} type="button" disabled={!hasSite} onClick={() => setKind('site')}>
          Pokoin balance
        </button>
        <button
          className={effectiveKind === 'chain' ? 'on' : ''}
          type="button"
          disabled={!address}
          title={address ? '' : 'Connect a wallet first'}
          onClick={() => setKind('chain')}
        >
          PokoinPoS
        </button>
      </div>
      {!hasSite && !address ? (
        <p className="wallet-sheet-note">
          Sign in for a site-balance code, or connect a wallet for on-chain PKN.
        </p>
      ) : null}

      {amountOpen || cleanAmount ? (
        <div className="wallet-amount-row">
          <input
            inputMode="numeric"
            value={amount}
            autoFocus={amountOpen && !cleanAmount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="Requested amount (whole PKN)"
          />
          {cleanAmount ? (
            <button className="wallet-source-link" type="button" onClick={() => { setAmount(''); setAmountOpen(false); }}>
              Clear
            </button>
          ) : null}
        </div>
      ) : (
        <button className="wallet-amount-toggle" type="button" onClick={() => setAmountOpen(true)}>
          Request a specific amount
        </button>
      )}

      {effectiveKind === 'site' && hasSite && cleanAmount ? (
        <div className="wallet-request-box">
          <span className="wallet-field-label">Send this request straight to a user</span>
          <div className="wallet-request-fields">
            <input
              value={reqUser}
              onChange={(event) => setReqUser(event.target.value)}
              placeholder="Username"
              spellCheck={false}
            />
            <input
              value={reqNote}
              onChange={(event) => setReqNote(event.target.value)}
              placeholder="Note (optional)"
              maxLength={140}
            />
          </div>
          <button
            className="wallet-sheet-cta"
            type="button"
            disabled={reqState.status === 'busy' || !reqUser.trim()}
            onClick={async () => {
              setReqState({ status: 'busy', message: '' });
              try {
                const token = await getBearer();
                await createMoneyRequest({
                  recipientUsername: reqUser.trim(),
                  amountPkn: Number(cleanAmount),
                  note: reqNote,
                  clientToken: newClientToken(),
                }, token);
                setReqState({ status: 'done', message: reqUser.trim().toLowerCase() });
                setReqUser('');
                setReqNote('');
              } catch (err) {
                setReqState({ status: 'error', message: err.message || 'Request failed.' });
              }
            }}
          >
            {reqState.status === 'busy' ? 'Sending…' : `Request ${cleanAmount} PKN`}
          </button>
          {reqState.status === 'done' ? (
            <div className="wallet-request-sent">
              <p className="wallet-scan-ok">Request sent to @{reqState.message} in your conversation.</p>
              <button className="wallet-source-link" type="button" onClick={() => { onClose(); onOpenConversation(reqState.message); }}>
                View conversation
              </button>
            </div>
          ) : null}
          {reqState.status === 'error' ? <p className="wallet-scanner-msg err">{reqState.message}</p> : null}
        </div>
      ) : null}
      <p className="wallet-sheet-note">
        The code opens Send to your username
        {cleanAmount ? ` with ${cleanAmount} PKN filled in` : ''}
        {' '}— senders confirm before anything moves.
      </p>
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
        Move whole PKN from your connected wallet into your site account balance.
      </p>
      {!address ? (
        <button className="wallet-sheet-cta" type="button" onClick={() => { onClose(); onConnect(); }}>Connect wallet</button>
      ) : !signedIn ? (
        <button className="wallet-sheet-cta" type="button" onClick={onRequireSignIn}>Sign in to top up</button>
      ) : mismatch ? (
        <p className="wallet-sheet-note">
          Switch your wallet to the linked address ({shortChainAddress(linkedAddress)}) before topping up.
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
