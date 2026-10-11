import { createEffect, createMemo, createSignal, For, Match, onSettled, Show, Switch, untrack } from 'solid-js';
import { useLocation, useNavigate } from '@solidjs/router';
import {
  ensureUsername,
  formatPknNumber,
  requestPknWithdraw,
  topUpAccountBalance,
  transferAccountBalance,
} from '@market/api.js';
import { fetchFirestoreDocument } from '@market/firestore-rest.js';
import { createMoneyRequest, newClientToken } from '@market/money-requests.js';
import { authFrom } from '@market/punchouts.js';
import { encodeQr, qrPath } from '@market/qr.js';
import { counterpartiesFromActivity, mergeUsernameSuggestions } from '@market/recipient-suggest.js';
import { activityTimeLabel, shortChainAddress } from '@market/wallet-activity.js';
import {
  ACTIVITY_ROW_COUNT,
  IS_ADDRESS,
  RECIPIENT_SEARCH_DELAY_MS,
  TREASURY_ADDRESS,
  cachedActivityRows,
  loadWalletActivity,
  recipientQuery,
  searchRecipients,
  startQrScanner,
} from '@market/wallet-feed.js';
import { buildReceiveQr, parseWalletSendLink } from '@market/wallet-qr.js';
import { POKOIN_CHAIN_ID, sendPkn, switchToPokoin } from '@market/wallet-tx.js';
import { accountProfile, availablePkn, refreshAccount } from '../stores/account.js';
import { authUser, getBearer, signedIn } from '../stores/auth.js';
import { authSession } from '../stores/session.js';
import {
  connectWallet,
  disconnectWallet,
  startWallet,
  walletAddress,
  walletBalance,
  walletChainId,
} from '../stores/wallet.js';

const ICON_PATHS = {
  topup: () => <path d="M12 21V9m0 0-4 4m4-4 4 4M4 3h16" />,
  withdraw: () => <path d="M12 3v12m0 0-4-4m4 4 4-4M4 21h16" />,
  send: () => <path d="M4 12 20 4l-4 16-4-6-8-2Z" />,
  receive: () => <path d="M20 12 4 20l4-16 4 6 8 2Z" />,
  swap: () => <path d="M4 8h13m0 0-3.5-3.5M17 8l-3.5 3.5M20 16H7m0 0 3.5 3.5M7 16l3.5-3.5" />,
  copy: () => <path d="M9 9h10v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9Zm-2 6H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" />,
  check: () => <path d="m4 12 5 5L20 6" />,
  link: () => <path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7L12.5 19" />,
  wallet: () => <path d="M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm13 4h4v4h-4a2 2 0 0 1 0-4Z" />,
  activity: () => <path d="M3 12h4l2.5-7 5 14 2.5-7H21" />,
  qr: () => (
    <>
      <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
      <path d="M9 9h2v2H9V9Zm4 0h2v2h-2V9Zm-4 4h2v2H9v-2Zm4 0h2v2h-2v-2Z" />
    </>
  ),
  camera: () => (
    <>
      <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7H7l1.6-2.2h6.8L17 7h2.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-9Z" />
      <circle cx="12" cy="12.6" r="3.4" />
    </>
  ),
};

function Icon(props) {
  return (
    <svg
      width={props.size ?? 22}
      height={props.size ?? 22}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[props.name]?.() || null}
    </svg>
  );
}

/** React autoFocus: focus the element once it is in the page. */
function focusOnMount(el) {
  queueMicrotask(() => el.focus());
}

function BalanceText(props) {
  const parts = () => formatPknNumber(props.value, { maximumFractionDigits: 2 }).split('.');
  return (
    <span class="wallet-balance">
      {parts()[0]}
      <span class="wallet-balance-frac">.{(parts()[1] || '0').padEnd(2, '0')}</span>
      <span class="wallet-balance-cur">PKN</span>
    </span>
  );
}

function Sheet(props) {
  onSettled(() => {
    function onKey(event) {
      if (event.key === 'Escape') props.onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
  return (
    <div class="wallet-sheet-backdrop" onClick={() => props.onClose()}>
      <div
        class="wallet-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onClick={(event) => event.stopPropagation()}
      >
        <div class="wallet-sheet-grab" aria-hidden="true" />
        <div class="wallet-sheet-head">
          <h2>{props.title}</h2>
          <button class="wallet-sheet-close" type="button" aria-label="Close" onClick={() => props.onClose()}>×</button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

function CopyRow(props) {
  const [copied, setCopied] = createSignal(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(props.value);
    } catch (_) {
      const area = document.createElement('textarea');
      area.value = props.value;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }
  return (
    <button class="wallet-copy-row" type="button" onClick={copy}>
      <span class="wallet-copy-text">
        <span class="wallet-copy-label">{props.label}</span>
        <span class={props.mono ?? true ? 'wallet-copy-value mono' : 'wallet-copy-value'}>{props.value}</span>
      </span>
      <span class={copied() ? 'wallet-copy-action on' : 'wallet-copy-action'}>
        <Icon name={copied() ? 'check' : 'copy'} size={18} />
      </span>
    </button>
  );
}

function Presets(props) {
  const max = () => Math.floor(Number(props.balance) || 0);
  const presets = () => (props.amounts || [1, 5, 10, max()])
    .filter((amount, index, all) => amount > 0 && all.indexOf(amount) === index);
  return (
    <Show when={presets().length}>
      <div class="wallet-presets">
        <For each={presets()}>
          {(amount) => (
            <button type="button" onClick={() => props.onPick(String(amount))}>
              {!props.amounts && amount === max() ? 'Max' : `${amount} PKN`}
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}

function PercentRow(props) {
  return (
    <div class="wallet-presets">
      <For each={[25, 50, 100]}>
        {(pct) => <button type="button" onClick={() => props.onPick(pct)}>{pct}%</button>}
      </For>
    </div>
  );
}

/**
 * Username suggestions for a recipient field (React useRecipientSuggestions):
 * recent counterparties first, then the server username search (debounced).
 * `value`, `recentActivity` and `selfUsername` are accessors.
 */
function createRecipientSuggestions({ value, recentActivity, selfUsername }) {
  const [search, setSearch] = createSignal({ status: 'idle', rows: [] });
  const parsed = createMemo(() => recipientQuery(value()));
  const localNames = createMemo(() => counterpartiesFromActivity(recentActivity()));
  const suggestions = createMemo(() => mergeUsernameSuggestions({
    query: parsed().query,
    local: localNames(),
    remote: search().rows,
    selfUsername: selfUsername(),
    limit: 6,
  }));

  createEffect(
    () => {
      const { query, compactQuery, searchable } = parsed();
      return searchable ? `${query}\n${compactQuery}` : '';
    },
    (key) => {
      if (!key) {
        setSearch({ status: 'idle', rows: [] });
        return undefined;
      }
      const { query, compactQuery } = untrack(parsed);
      let cancelled = false;
      const timer = setTimeout(() => {
        setSearch((prev) => ({ status: 'searching', rows: prev.rows }));
        getBearer()
          .then((token) => (cancelled ? null : searchRecipients({ query, compactQuery }, token)))
          .then((next) => {
            if (!cancelled && next) setSearch(next);
          })
          .catch(() => {
            if (!cancelled) setSearch({ status: 'error', rows: [] });
          });
      }, RECIPIENT_SEARCH_DELAY_MS);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    },
  );

  return {
    suggestions,
    searchable: () => parsed().searchable,
    status: () => search().status,
    clear: () => setSearch({ status: 'idle', rows: [] }),
  };
}

function RecipientSuggestions(props) {
  const rows = () => props.suggest.suggestions();
  return (
    <Switch>
      <Match when={rows().length}>
        <div class="wallet-suggestions" role="listbox" aria-label="Matching usernames">
          <For each={rows()}>
            {(row) => (
              <button
                type="button"
                role="option"
                onClick={() => {
                  props.onPick(row.username);
                  props.suggest.clear();
                }}
              >
                <Show when={row.displayName} fallback={<>@{row.username}</>}>
                  <span class="wallet-suggest-name">{row.displayName}</span>
                  <span class="wallet-suggest-handle">@{row.username}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Match>
      <Match when={!props.suggest.searchable()}>{null}</Match>
      <Match when={props.suggest.status() === 'searching'}>
        <p class="wallet-suggestions-note">Searching usernames…</p>
      </Match>
      <Match when={props.suggest.status() === 'none'}>
        <p class="wallet-suggestions-note">{props.noneNote}</p>
      </Match>
      <Match when={props.suggest.status() === 'signedout' || props.suggest.status() === 'error'}>
        <p class="wallet-suggestions-note">Sign in to search recipients.</p>
      </Match>
    </Switch>
  );
}

function SendSheet(props) {
  const [recipient, setRecipient] = createSignal(untrack(() => props.initialRecipient || ''));
  const [amount, setAmount] = createSignal(untrack(() => props.initialAmount || ''));
  const [scanning, setScanning] = createSignal(false);
  const [scanMsg, setScanMsg] = createSignal('');
  const [scanned, setScanned] = createSignal(untrack(() => (props.fromQr && props.initialRecipient ? props.initialRecipient : '')));
  let video;
  const toChain = () => IS_ADDRESS.test(recipient().trim());
  const suggest = createRecipientSuggestions({
    value: recipient,
    recentActivity: () => props.recentActivity || [],
    selfUsername: () => props.profile?.username || '',
  });

  // Camera + decode loop while the scanner is open.
  createEffect(scanning, (on) => {
    if (!on) return undefined;
    return startQrScanner({
      getVideo: () => video,
      onMessage: setScanMsg,
      onScan: (parsed) => {
        setScanning(false);
        setRecipient(parsed.recipient);
        setAmount(parsed.amountPkn || '');
        setScanned(parsed.recipient);
        setScanMsg('');
      },
    });
  });

  function submit() {
    const to = recipient().trim();
    const value = String(amount() || '').trim();
    if (!to || !(Number(value) > 0)) {
      return;
    }
    props.onClose();
    if (toChain()) {
      if (!props.address) {
        props.onConnect();
        return;
      }
      props.onChainSend(to, value);
      return;
    }
    if (!props.signedIn) {
      props.onRequireSignIn();
      return;
    }
    if (!/^[a-zA-Z0-9]{3,32}$/.test(to)) {
      return;
    }
    props.onTransfer(to, value);
  }

  return (
    <Show
      when={!scanning()}
      fallback={(
        <Sheet title="Scan payment QR" onClose={() => { setScanning(false); props.onClose(); }}>
          <div class="wallet-scanner">
            <div class="wallet-scanner-frame">
              <video ref={(el) => { video = el; }} class="wallet-scanner-video" muted playsinline />
              <span class="wallet-scanner-corner tl" aria-hidden="true" />
              <span class="wallet-scanner-corner tr" aria-hidden="true" />
              <span class="wallet-scanner-corner bl" aria-hidden="true" />
              <span class="wallet-scanner-corner br" aria-hidden="true" />
            </div>
            <p class={scanMsg() ? 'wallet-scanner-msg err' : 'wallet-scanner-msg'}>
              {scanMsg() || 'Point the camera at a Pokoin payment code'}
            </p>
          </div>
          <button class="wallet-sheet-cta" type="button" onClick={() => setScanning(false)}>
            Cancel
          </button>
        </Sheet>
      )}
    >
      <Sheet title="Send PKN" onClose={props.onClose}>
        <label class="sell-field">
          Recipient username or 0x address
          <span class="wallet-input-row">
            <input
              ref={focusOnMount}
              value={recipient()}
              onInput={(event) => setRecipient(event.target.value)}
              placeholder={props.profile?.username ? `e.g. ${props.profile.username}` : 'username or 0x…'}
            />
            <button
              class="wallet-cam"
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
        <Show when={scanned()}>
          <p class="wallet-scan-ok">
            {amount()
              ? `Sending to ${scanned()} · ${amount()} PKN loaded — confirm before Send.`
              : `Sending to ${scanned()} — enter an amount, then Send.`}
          </p>
        </Show>
        <RecipientSuggestions
          suggest={suggest}
          onPick={setRecipient}
          noneNote="No matching usernames — you can still send if you know the exact handle."
        />
        <label class="sell-field">
          Amount
          <input inputMode="decimal" value={amount()} onInput={(event) => setAmount(event.target.value)} placeholder="0" />
        </label>
        <Show
          when={toChain()}
          fallback={<Presets amounts={[2000, 5000, 10000]} onPick={setAmount} />}
        >
          <PercentRow
            onPick={(pct) => setAmount(
              ((Number(props.balance) || 0) * pct / 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, ''),
            )}
          />
        </Show>
        <button class="wallet-sheet-cta" type="button" disabled={props.busy} onClick={submit}>
          {toChain() && !props.address ? 'Connect to send' : 'Send'}
        </button>
      </Sheet>
    </Show>
  );
}

function ReceiveSheet(props) {
  // The profile field can hold a name the `usernames` registry never got (or
  // none at all). Ask the server for the registered handle — it repairs or
  // assigns one — so the code always resolves to this account.
  const [siteName, setSiteName] = createSignal('');
  const [siteNameState, setSiteNameState] = createSignal(untrack(() => (props.signedIn ? 'loading' : 'idle')));
  createEffect(() => props.signedIn, (on) => {
    if (!on) {
      setSiteNameState('idle');
      return undefined;
    }
    let live = true;
    setSiteNameState('loading');
    (async () => {
      try {
        const token = await getBearer();
        if (!token) throw new Error('signed out');
        const result = await ensureUsername(token);
        if (!live) return;
        const name = String(result?.username || '').trim().toLowerCase();
        setSiteName(name);
        setSiteNameState(name ? 'ready' : 'error');
        // React patched the profile username in place; here the account re-reads it.
        if (name) refreshAccount();
      } catch (_) {
        if (live) setSiteNameState('error');
      }
    })();
    return () => {
      live = false;
    };
  });
  const hasSite = () => Boolean(props.signedIn && siteName());
  const [kind, setKind] = createSignal(untrack(() => (props.signedIn || !props.address ? 'site' : 'chain')));
  const [amountOpen, setAmountOpen] = createSignal(false);
  const [amount, setAmount] = createSignal('');
  const [reqUser, setReqUser] = createSignal('');
  const reqSuggest = createRecipientSuggestions({
    value: reqUser,
    recentActivity: () => props.recentActivity || [],
    selfUsername: () => props.profile?.username || '',
  });
  const [reqNote, setReqNote] = createSignal('');
  const [reqState, setReqState] = createSignal({ status: 'idle', message: '' });
  const cleanAmount = () => (/^\d{1,9}$/.test(String(amount()).trim()) ? String(Number(amount().trim())) : '');
  const effectiveKind = () => (kind() === 'chain' && props.address ? 'chain' : 'site');
  // Fall back to the plain code while the typed amount is incomplete.
  const payload = () => buildReceiveQr({
    kind: effectiveKind(),
    username: siteName(),
    address: props.address,
    amount: cleanAmount(),
  }) || buildReceiveQr({ kind: effectiveKind(), username: siteName(), address: props.address });
  const qr = createMemo(() => (payload() ? encodeQr(payload(), { ecc: 'M' }) : null));
  const handle = () => (effectiveKind() === 'chain' ? props.address : siteName());

  async function sendRequest() {
    setReqState({ status: 'busy', message: '' });
    try {
      const token = await getBearer();
      await createMoneyRequest({
        recipientUsername: reqUser().trim(),
        amountPkn: Number(cleanAmount()),
        note: reqNote(),
        clientToken: newClientToken(),
      }, token);
      setReqState({ status: 'done', message: reqUser().trim().toLowerCase() });
      setReqUser('');
      setReqNote('');
    } catch (err) {
      setReqState({ status: 'error', message: err.message || 'Request failed.' });
    }
  }

  return (
    <Sheet title="Receive PKN" onClose={props.onClose}>
      <div class="wallet-qr-card">
        <Show
          when={qr()}
          fallback={(
            <div class="wallet-qr-empty">
              <span class="wallet-qr-empty-icon"><Icon name="qr" size={26} /></span>
              <p class="wallet-qr-empty-title">
                {effectiveKind() === 'chain'
                  ? 'Connect a wallet for an on-chain code'
                  : siteNameState() === 'loading'
                    ? 'Preparing your receive code…'
                    : siteNameState() === 'error'
                      ? 'Could not load your username. Try again in a moment.'
                      : 'Sign in to get your receive code'}
              </p>
              <Switch>
                <Match when={effectiveKind() === 'chain'}>
                  <button class="wallet-source-cta" type="button" onClick={() => props.onConnect()}>Connect wallet</button>
                </Match>
                <Match when={siteNameState() === 'idle'}>
                  <button class="wallet-source-cta" type="button" onClick={() => props.onRequireSignIn()}>Sign in</button>
                </Match>
              </Switch>
            </div>
          )}
        >
          {(code) => (
            <>
              <svg
                viewBox={`0 0 ${code().size + 8} ${code().size + 8}`}
                class="wallet-qr-svg"
                role="img"
                aria-label="Payment QR code"
                shape-rendering="crispEdges"
              >
                <rect width={code().size + 8} height={code().size + 8} fill="#ffffff" />
                <path d={qrPath(code())} fill="#171310" />
              </svg>
              <Show when={cleanAmount()}>
                <span class="wallet-qr-requested">Requested · {cleanAmount()} PKN</span>
              </Show>
            </>
          )}
        </Show>
      </div>

      <Show when={qr() && handle()}>
        <CopyRow
          label={effectiveKind() === 'chain' ? 'PokoinPoS address' : 'Pokoin username'}
          value={handle()}
          mono={effectiveKind() === 'chain'}
        />
      </Show>

      <div class="wallet-segments">
        <button class={effectiveKind() === 'site' ? 'on' : ''} type="button" disabled={!hasSite()} onClick={() => setKind('site')}>
          Pokoin balance
        </button>
        <button
          class={effectiveKind() === 'chain' ? 'on' : ''}
          type="button"
          disabled={!props.address}
          title={props.address ? '' : 'Connect a wallet first'}
          onClick={() => setKind('chain')}
        >
          PokoinPoS
        </button>
      </div>
      <Show when={!hasSite() && !props.address}>
        <p class="wallet-sheet-note">
          Sign in for a site-balance code, or connect a wallet for on-chain PKN.
        </p>
      </Show>

      <Show
        when={amountOpen() || cleanAmount()}
        fallback={(
          <button class="wallet-amount-toggle" type="button" onClick={() => setAmountOpen(true)}>
            Request a specific amount
          </button>
        )}
      >
        <div class="wallet-amount-row">
          <input
            ref={(el) => {
              if (untrack(() => amountOpen() && !cleanAmount())) focusOnMount(el);
            }}
            inputMode="numeric"
            value={amount()}
            onInput={(event) => setAmount(event.target.value)}
            placeholder="Requested amount (whole PKN)"
          />
          <Show when={cleanAmount()}>
            <button class="wallet-source-link" type="button" onClick={() => { setAmount(''); setAmountOpen(false); }}>
              Clear
            </button>
          </Show>
        </div>
      </Show>

      <Show when={effectiveKind() === 'site' && hasSite() && cleanAmount()}>
        <div class="wallet-request-box">
          <span class="wallet-field-label">Send this request straight to a user</span>
          <div class="wallet-request-fields">
            <input
              value={reqUser()}
              onInput={(event) => setReqUser(event.target.value)}
              placeholder="Username"
              spellcheck={false}
              autocomplete="off"
            />
            <RecipientSuggestions
              suggest={reqSuggest}
              onPick={setReqUser}
              noneNote="No matching usernames — check the handle."
            />
            <input
              value={reqNote()}
              onInput={(event) => setReqNote(event.target.value)}
              placeholder="Note (optional)"
              maxLength={140}
            />
          </div>
          <button
            class="wallet-sheet-cta"
            type="button"
            disabled={reqState().status === 'busy' || !reqUser().trim()}
            onClick={sendRequest}
          >
            {reqState().status === 'busy' ? 'Sending…' : `Request ${cleanAmount()} PKN`}
          </button>
          <Show when={reqState().status === 'done'}>
            <div class="wallet-request-sent">
              <p class="wallet-scan-ok">Request sent to @{reqState().message} in your conversation.</p>
              <button
                class="wallet-source-link"
                type="button"
                onClick={() => {
                  const name = reqState().message;
                  props.onClose();
                  props.onOpenConversation(name);
                }}
              >
                View conversation
              </button>
            </div>
          </Show>
          <Show when={reqState().status === 'error'}>
            <p class="wallet-scanner-msg err">{reqState().message}</p>
          </Show>
        </div>
      </Show>
      <p class="wallet-sheet-note">
        The code opens Send to your username
        {cleanAmount() ? ` with ${cleanAmount()} PKN filled in` : ''}
        {' '}— senders confirm before anything moves.
      </p>
    </Sheet>
  );
}

function WithdrawSheet(props) {
  const [amount, setAmount] = createSignal('');
  const max = () => Math.floor(Number(props.availablePkn) || 0);
  return (
    <Sheet title="Withdraw PKN" onClose={props.onClose}>
      <p class="wallet-sheet-lede">Whole PKN payout from your site balance to your linked wallet.</p>
      <Show
        when={props.payoutAddress}
        fallback={<p class="wallet-sheet-note">Link or connect a wallet to set your payout address.</p>}
      >
        <p class="wallet-sheet-note mono">{shortChainAddress(props.payoutAddress)}</p>
      </Show>
      <label class="sell-field">
        Amount — available {formatPknNumber(max())} PKN
        <input ref={focusOnMount} inputMode="numeric" value={amount()} onInput={(event) => setAmount(event.target.value)} placeholder="0" />
      </label>
      <Presets balance={max()} onPick={setAmount} />
      <button
        class="wallet-sheet-cta"
        type="button"
        disabled={props.busy}
        onClick={() => {
          if (!props.signedIn) {
            props.onRequireSignIn();
            return;
          }
          const value = Math.round(Number(amount()) || 0);
          if (!props.payoutAddress || !IS_ADDRESS.test(props.payoutAddress) || value <= 0 || value > max()) {
            return;
          }
          const to = props.payoutAddress;
          props.onClose();
          props.onWithdraw(to, String(value));
        }}
      >
        {props.signedIn ? 'Withdraw' : 'Sign in to withdraw'}
      </button>
    </Sheet>
  );
}

function TopUpSheet(props) {
  const [amount, setAmount] = createSignal('');
  const mismatch = () => props.address && props.linkedAddress && props.address.toLowerCase() !== props.linkedAddress;
  return (
    <Sheet title="Top up account balance" onClose={props.onClose}>
      <p class="wallet-sheet-lede">
        Move whole PKN from your connected wallet into your site account balance.
      </p>
      <Switch
        fallback={(
          <>
            <label class="sell-field">
              Amount — chain {formatPknNumber(props.chainBalance, { maximumFractionDigits: 4 })} PKN
              <input ref={focusOnMount} inputMode="numeric" value={amount()} onInput={(event) => setAmount(event.target.value)} placeholder="0" />
            </label>
            <Presets balance={props.chainBalance} onPick={setAmount} />
            <button
              class="wallet-sheet-cta"
              type="button"
              disabled={props.busy}
              onClick={() => {
                const value = Math.round(Number(amount()) || 0);
                if (value <= 0 || value > Number(props.chainBalance)) {
                  return;
                }
                props.onClose();
                props.onTopUp(String(value));
              }}
            >
              Top up
            </button>
          </>
        )}
      >
        <Match when={!props.address}>
          <button class="wallet-sheet-cta" type="button" onClick={() => { props.onClose(); props.onConnect(); }}>Connect wallet</button>
        </Match>
        <Match when={!props.signedIn}>
          <button class="wallet-sheet-cta" type="button" onClick={() => props.onRequireSignIn()}>Sign in to top up</button>
        </Match>
        <Match when={mismatch()}>
          <p class="wallet-sheet-note">
            Switch your wallet to the linked address ({shortChainAddress(props.linkedAddress)}) before topping up.
          </p>
        </Match>
      </Switch>
    </Sheet>
  );
}

const ACTIONS = [
  { key: 'send', icon: 'send', label: 'Send', sheet: 'send' },
  { key: 'receive', icon: 'receive', label: 'Receive', sheet: 'receive' },
  { key: 'withdraw', icon: 'withdraw', label: 'Withdraw', sheet: 'withdraw' },
  { key: 'topup', icon: 'topup', label: 'Top up', sheet: 'topup' },
  { key: 'swap', icon: 'swap', label: 'Exchange', to: '/exchange' },
];

/** /wallet: site balance + PokoinPoS, activity and the money sheets. */
export default function Wallet() {
  const navigate = useNavigate();
  const location = useLocation();
  const uid = () => (signedIn() ? String(accountProfile()?.uid || authUser()?.uid || authSession()?.uid || '') : '');
  const address = walletAddress;
  const balance = walletBalance;

  const [sheet, setSheet] = createSignal('');
  const [sendPrefill, setSendPrefill] = createSignal({ recipient: '', amount: '', fromQr: false });
  const [flash, setFlash] = createSignal('');
  const [error, setError] = createSignal('');
  const [linkedAddress, setLinkedAddress] = createSignal('');
  const [activity, setActivity] = createSignal([]);
  const [activityLoading, setActivityLoading] = createSignal(false);
  const [showAllActivity, setShowAllActivity] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  onSettled(() => {
    document.title = 'Wallet · Pokoin';
    startWallet();
  });

  async function refreshActivity({ force = false } = {}) {
    const id = untrack(uid);
    const chain = untrack(address);
    if (!id) {
      setActivity([]);
      setActivityLoading(false);
      return;
    }
    try {
      const next = await loadWalletActivity({ uid: id, address: chain, getBearer, force, onLoading: setActivityLoading });
      if (next && id === untrack(uid)) setActivity(() => next);
    } finally {
      setActivityLoading(false);
    }
  }

  // Instant paint from the cached feed, then refresh, per uid + chain address.
  createEffect(
    () => `${uid()}\n${address()}`,
    () => {
      const id = untrack(uid);
      if (!id) {
        setActivity([]);
        return;
      }
      const rows = cachedActivityRows(id, untrack(address));
      if (rows) setActivity(() => rows);
      refreshActivity();
    },
  );

  // Deep link from a receive QR / shared payment URL: open Send prefilled,
  // then strip the query so a refresh does not re-open the sheet.
  createEffect(
    () => `${location.pathname}${location.search}`,
    (url) => {
      const parsed = parseWalletSendLink(url);
      if (!parsed) return;
      setSendPrefill({ recipient: parsed.recipient, amount: parsed.amountPkn || '', fromQr: true });
      setSheet('send');
      navigate('/wallet', { replace: true });
    },
  );

  createEffect(uid, (id) => {
    if (!id) {
      setLinkedAddress('');
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const token = await getBearer();
        const doc = await fetchFirestoreDocument('users', id, token);
        if (!cancelled) setLinkedAddress(String(doc.walletAddress || '').trim().toLowerCase());
      } catch (_) {
        if (!cancelled) setLinkedAddress('');
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  const onPokoin = () => walletChainId() === POKOIN_CHAIN_ID;
  const total = () => availablePkn() + (address() ? balance() : 0);

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
      refreshActivity({ force: true });
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

  const visibleActivity = () => (showAllActivity() ? activity() : activity().slice(0, ACTIVITY_ROW_COUNT));

  return (
    <div class="page wallet-page">
      <section class="wallet-hero">
        <h1 class="wallet-title">Wallet</h1>
        <BalanceText value={total()} />
        <Show when={address()}>
          <p class="wallet-hero-sources">
            Pokoin {formatPknNumber(availablePkn())} · PokoinPoS {formatPknNumber(balance(), { maximumFractionDigits: 2 })}
          </p>
        </Show>
        <Show when={flash()}><p class="wallet-flash">{flash()}</p></Show>
        <Show when={error()}><p class="wallet-error">{error()}</p></Show>
      </section>

      <nav class="wallet-actions" aria-label="Wallet actions">
        <For each={ACTIONS}>
          {(action) => (
            <Show
              when={action.to}
              fallback={(
                <button class="wallet-action" type="button" onClick={() => setSheet(action.sheet)}>
                  <span class="wallet-action-circle"><Icon name={action.icon} /></span>
                  <span class="wallet-action-label">{action.label}</span>
                </button>
              )}
            >
              <a class="wallet-action" href={action.to}>
                <span class="wallet-action-circle"><Icon name={action.icon} /></span>
                <span class="wallet-action-label">{action.label}</span>
              </a>
            </Show>
          )}
        </For>
      </nav>

      <section class="wallet-card">
        <div class="wallet-card-head">
          <h2>Activity</h2>
          <Show when={activity().length > ACTIVITY_ROW_COUNT}>
            <button class="wallet-see-all" type="button" onClick={() => setShowAllActivity((value) => !value)}>
              {showAllActivity() ? 'Show less' : 'See all'}
            </button>
          </Show>
        </div>
        <Switch
          fallback={(
            <div class="wallet-empty">
              <span class="wallet-empty-icon"><Icon name="activity" size={22} /></span>
              <p class="wallet-empty-title">No activity yet</p>
            </div>
          )}
        >
          <Match when={activityLoading() && !activity().length}>
            <div class="wallet-empty">
              <span class="wallet-empty-icon loading"><Icon name="activity" size={22} /></span>
              <p class="wallet-empty-title">Loading activity…</p>
            </div>
          </Match>
          <Match when={visibleActivity().length}>
            <ul class="wallet-activity">
              <For each={visibleActivity()}>
                {(item) => (
                  <li class="wallet-activity-row">
                    <span class={item.kind === 'inbound' ? 'wallet-activity-icon in' : 'wallet-activity-icon out'}>
                      <Icon name={item.kind === 'inbound' ? 'receive' : 'send'} size={17} />
                    </span>
                    <span class="wallet-activity-text">
                      <span class="wallet-activity-title">{item.title}</span>
                      <span class="wallet-activity-time">
                        {activityTimeLabel(item.at) || item.blockLabel}
                        {item.detail && !item.detail.includes('0x') ? ` · ${item.detail}` : ''}
                      </span>
                    </span>
                    <Show when={item.amountPkn != null && item.amountPkn !== 0}>
                      <span class={item.amountPkn > 0 ? 'wallet-activity-amount in' : 'wallet-activity-amount'}>
                        {item.amountPkn > 0 ? '+' : '−'}{formatPknNumber(Math.abs(item.amountPkn))} PKN
                      </span>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Match>
        </Switch>
      </section>

      <section class="wallet-card">
        <div class="wallet-card-head"><h2>Your wallets</h2></div>
        <div class="wallet-sources">
          <div class="wallet-source">
            <span class="wallet-source-icon gold"><Icon name="wallet" size={18} /></span>
            <span class="wallet-source-text">
              <span class="wallet-source-name">Pokoin balance</span>
              <span class="wallet-source-status">
                <span class={signedIn() ? 'wallet-dot on' : 'wallet-dot'} />
                {signedIn() ? (accountProfile()?.username || 'Signed in') : 'Not signed in'}
              </span>
            </span>
            <span class="wallet-source-end">
              <span class="wallet-source-amount">{formatPknNumber(availablePkn())} PKN</span>
              <Show when={!signedIn()}>
                <button class="wallet-source-link" type="button" onClick={requireSignIn}>Sign in</button>
              </Show>
            </span>
          </div>
          <div class="wallet-source">
            <span class="wallet-source-icon chain"><Icon name="link" size={18} /></span>
            <span class="wallet-source-text">
              <span class="wallet-source-name">PokoinPoS</span>
              <span class="wallet-source-status">
                <span class={!address() ? 'wallet-dot' : onPokoin() ? 'wallet-dot on' : 'wallet-dot warn'} />
                {!address()
                  ? 'Not connected'
                  : onPokoin() ? shortChainAddress(address()) : 'Wrong network'}
              </span>
            </span>
            <span class="wallet-source-end">
              <Show
                when={address()}
                fallback={<button class="wallet-source-cta" type="button" onClick={() => run(connectWallet)}>Connect wallet</button>}
              >
                <span class="wallet-source-amount">{formatPknNumber(balance(), { maximumFractionDigits: 4 })} PKN</span>
                <Show
                  when={onPokoin()}
                  fallback={<button class="wallet-source-link" type="button" onClick={() => run(switchToPokoin)}>Switch network</button>}
                >
                  <button class="wallet-source-link" type="button" onClick={() => run(disconnectWallet)}>Disconnect</button>
                </Show>
              </Show>
            </span>
          </div>
        </div>
      </section>

      <Switch>
        <Match when={sheet() === 'send'}>
          <SendSheet
            onClose={closeSheet}
            busy={busy()}
            signedIn={signedIn()}
            profile={accountProfile()}
            address={address()}
            balance={balance()}
            recentActivity={activity()}
            initialRecipient={sendPrefill().recipient}
            initialAmount={sendPrefill().amount}
            fromQr={sendPrefill().fromQr}
            onConnect={() => run(connectWallet)}
            onRequireSignIn={requireSignIn}
            onTransfer={(recipient, amount) => run(async () => {
              const token = await getBearer();
              await transferAccountBalance({ recipientUsername: recipient, amountPkn: Math.round(Number(amount)) }, token);
            }, { okMessage: `Sent ${Math.round(Number(amount))} PKN to ${recipient}.` })}
            onChainSend={(to, amount) => run(async () => {
              const hash = await sendPkn({ from: untrack(address), to, amount });
              setFlash(`Sent on-chain · ${shortChainAddress(hash)}`);
            })}
          />
        </Match>
        <Match when={sheet() === 'receive'}>
          <ReceiveSheet
            onClose={closeSheet}
            signedIn={signedIn()}
            address={address()}
            chainId={walletChainId()}
            profile={accountProfile()}
            recentActivity={activity()}
            onConnect={() => run(connectWallet)}
            onRequireSignIn={requireSignIn}
            onOpenConversation={(username) => navigate(`/messages/${encodeURIComponent(username)}`)}
          />
        </Match>
        <Match when={sheet() === 'withdraw'}>
          <WithdrawSheet
            onClose={closeSheet}
            busy={busy()}
            signedIn={signedIn()}
            availablePkn={availablePkn()}
            payoutAddress={linkedAddress() || address()}
            onRequireSignIn={requireSignIn}
            onWithdraw={(to, amount) => run(async () => {
              const token = await getBearer();
              const result = await requestPknWithdraw({ toAddress: to, amountPkn: Math.round(Number(amount)) }, token);
              setFlash(result.payoutTxHash
                ? 'Withdraw sent from the bank wallet.'
                : result.warning || 'Withdraw request created for manual bank payout.');
            })}
          />
        </Match>
        <Match when={sheet() === 'topup'}>
          <TopUpSheet
            onClose={closeSheet}
            busy={busy()}
            signedIn={signedIn()}
            address={address()}
            linkedAddress={linkedAddress()}
            chainBalance={balance()}
            onConnect={() => run(connectWallet)}
            onRequireSignIn={requireSignIn}
            onTopUp={(amount) => run(async () => {
              const hash = await sendPkn({ from: untrack(address), to: TREASURY_ADDRESS, amount });
              const token = await getBearer();
              await topUpAccountBalance({ amountPkn: Math.round(Number(amount)), fundingTxHash: hash }, token);
            }, { okMessage: 'Account balance topped up.' })}
          />
        </Match>
      </Switch>
    </div>
  );
}
