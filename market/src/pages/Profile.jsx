import { Suspense, lazy, useEffect, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { firebaseAuth, getBearer, useAuth } from '../auth.jsx';
import { loadFirestore } from '../firebase-client.js';
import { endActiveScanSessionForSignOut } from '../scan-api.js';
import { accountHeading, accountLede } from '../auth-session.js';
import { useWallet, shortAddress } from '../wallet.jsx';
import { fetchCollectionSummary, fetchSellerListings } from '../api.js';
import { DeskPanel, EmptyDesk, Metric, MetricGrid, PageHead, SessionWait } from '../components/Desk.jsx';
import { PknPayoutToggle, ShipFromCountrySelect, StripeConnectButton } from '../components/SellerShippingSettings.jsx';
import { publishSellerSettings, useSellerCurrency } from '../use-seller-currency.js';
import { sellerListCurrency } from '../seller-currency.js';
import CardTraderConnectPanel, { CT_TOKEN_DOCS } from '../components/CardTraderConnectPanel.jsx';
import TelegramConnectPanel from '../components/TelegramConnectPanel.jsx';
import WipeAllInventory from '../components/WipeAllInventory.jsx';
import { formatPknNumber } from '../pkn.js';
import { sellerHref } from '../listing-meta.js';
import { DASHBOARD_HOME } from '../punchouts.js';
import { liveInventoryListings, summarizeLiveInventory } from '../inventory-listings.js';
import {
  portfolioTilesFromSummary,
  readPortfolioTilesCache,
  writePortfolioTilesCache,
} from '../portfolio-tiles-cache.js';
import { orderActivity, sellerSetupSteps, timeAgo } from '../profile-overview.js';
import Avatar from '../components/Avatar.jsx';
import UsernameEditor from '../components/UsernameEditor.jsx';
import DisplayNameEditor from '../components/DisplayNameEditor.jsx';

// The cropper (react-easy-crop) loads only when someone edits their photo.
const AvatarEditor = lazy(() => import('../components/AvatarEditor.jsx'));

const LISTINGS_LIMIT = 200;

const ICON = {
  watchlist: 'M12 21.35 10.55 20C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
  stock: 'M20 2H4c-1 0-2 .9-2 2v3.01c0 .72.43 1.34 1 1.69V20c0 1.1 1.1 2 2 2h14c.9 0 2-.9 2-2V8.7c.57-.35 1-.97 1-1.69V4c0-1.1-1-2-2-2zm-5 12H9v-2h6v2zm5-7H4V4l16-.02V7z',
  store: 'M20 4H4v2h16V4zm1 10v-2l-1-5H4l-1 5v2h1v6h10v-6h4v6h2v-6h1zm-9 4H6v-4h6v4z',
  sheet: 'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm1 9h-4V3.5L18.5 11H15zM8 13h8v2H8v-2zm0 4h8v2H8v-2z',
  dashboard: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
  orders: 'M18 17H6v-2h12v2zm0-4H6v-2h12v2zm0-4H6V7h12v2zM3 22l1.5-1.5L6 22l1.5-1.5L9 22l1.5-1.5L12 22l1.5-1.5L15 22l1.5-1.5L18 22l1.5-1.5L21 22V2l-1.5 1.5L18 2l-1.5 1.5L15 2l-1.5 1.5L12 2l-1.5 1.5L9 2 7.5 3.5 6 2 4.5 3.5 3 2v20z',
  wallet: 'M21 18v1c0 1.1-.9 2-2 2H5c-1.11 0-2-.9-2-2V5c0-1.1.89-2 2-2h14c1.1 0 2 .9 2 2v1h-9c-1.11 0-2 .9-2 2v8c0 1.1.89 2 2 2h9zm-9-2h10V8H12v8zm4-2.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z',
  buy: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z',
  collection: 'M22 16V4c0-1.1-.9-2-2-2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2zm-11-4 2.03 2.71L16 11l4 5H8l3-4zM2 6v14c0 1.1.9 2 2 2h14v-2H4V6H2z',
  messages: 'M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z',
  forum: 'M21 6h-2v9H6v2c0 .55.45 1 1 1h11l4 4V7c0-.55-.45-1-1-1zm-4 6V3c0-.55-.45-1-1-1H3c-.55 0-1 .45-1 1v14l4-4h10c.55 0 1-.45 1-1z',
  admin: 'M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z',
  sold: 'M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z',
  bought: 'M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z',
  invite: 'M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
  ambassador: 'M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
  check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
};

function Icon({ name, size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path fill="currentColor" d={ICON[name]} />
    </svg>
  );
}

function money({ currency, amount }) {
  return currency === 'EUR' ? `€${(amount / 100).toFixed(2)}` : `${formatPknNumber(amount)} PKN`;
}

/**
 * Cards owned + live listings, painted from the dashboard tile cache first.
 * `listedCapped` means the listing fetch hit its limit, so the count is a floor.
 */
function usePortfolioTiles(uid) {
  const [owned, setOwned] = useState(null);
  const [listed, setListed] = useState(null);
  const [listedCapped, setListedCapped] = useState(false);

  useEffect(() => {
    if (!uid) return undefined;
    let cancelled = false;
    const cached = readPortfolioTilesCache(uid);
    // A cache row written by a listings-only patch has ownedCards 0 by default,
    // so only trust owned counts from a row that also has a summary behind it.
    setOwned(cached?.uniqueItems || cached?.ownedCards ? cached.ownedCards : null);
    setListed(cached?.listed && !cached.listed.failed ? cached.listed : null);
    getBearer()
      .then((token) => fetchCollectionSummary(token))
      .then((data) => {
        if (cancelled) return;
        const next = portfolioTilesFromSummary(data);
        writePortfolioTilesCache(uid, next);
        setOwned(next.ownedCards);
      })
      .catch(() => {});
    getBearer()
      .then((token) => fetchSellerListings(uid, token, { limit: LISTINGS_LIMIT }))
      .then((data) => {
        if (cancelled) return;
        const rows = data.listings || data.items || [];
        const summary = summarizeLiveInventory(liveInventoryListings(rows));
        writePortfolioTilesCache(uid, { listed: summary });
        setListed(summary);
        setListedCapped(rows.length >= LISTINGS_LIMIT);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [uid]);

  return { owned, listed, listedCapped };
}

/** Bought + sold orders, live — the same two queries as /orders. */
function useOrderRows(uid) {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    if (!uid) return undefined;
    let bought = null;
    let sold = null;
    const emit = () => {
      if (bought && sold) setRows([...bought, ...sold]);
    };
    const toRows = (snap) => snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    let cancelled = false;
    let unsubBuy = null;
    let unsubSell = null;
    loadFirestore().then(({ firestore, collection, onSnapshot, query, where }) => {
      if (cancelled) return;
      unsubBuy = onSnapshot(
        query(collection(firestore, 'orders'), where('uid', '==', uid)),
        (snap) => { bought = toRows(snap); emit(); },
        () => { bought = bought || []; emit(); },
      );
      unsubSell = onSnapshot(
        query(collection(firestore, 'orders'), where('sellerUids', 'array-contains', uid)),
        (snap) => { sold = toRows(snap); emit(); },
        () => { sold = sold || []; emit(); },
      );
    }, () => {
      if (cancelled) return;
      bought = bought || [];
      sold = sold || [];
      emit();
    });
    return () => {
      cancelled = true;
      unsubBuy?.();
      unsubSell?.();
    };
  }, [uid]);

  return rows;
}

function SetupRow({ step, title, meta, action, children, open }) {
  const state = step.loading ? 'loading' : step.done ? 'done' : step.started ? 'started' : 'todo';
  return (
    <li className={`setup-row is-${state}`}>
      <div className="setup-row-main">
        <span className="setup-mark" aria-hidden="true">
          {step.done ? <Icon name="check" size={14} /> : null}
        </span>
        <span className="setup-text">
          <strong>{title}</strong>
          <span className="setup-meta">{step.loading ? 'Checking…' : meta}</span>
        </span>
        <span className="setup-action">{action}</span>
      </div>
      {children ? <div className="setup-row-body" hidden={!open}>{children}</div> : null}
    </li>
  );
}

function QuickTile({ to, href, icon, title, meta, badge }) {
  const inner = (
    <>
      <span className="quick-icon"><Icon name={icon} /></span>
      <span className="quick-text">
        <strong>{title}</strong>
        <span>{meta}</span>
      </span>
      {badge ? <span className="quick-badge">{badge}</span> : null}
    </>
  );
  return href
    ? <a className="quick-tile" href={href}>{inner}</a>
    : <Link className="quick-tile" to={to}>{inner}</Link>;
}

export default function Profile() {
  const location = useLocation();
  const { user, ready, signedIn, availablePkn, silver, admin, profile } = useAuth();
  const { address, balance } = useWallet();
  const [editing, setEditing] = useState(false);
  const [toast, setToast] = useState('');
  const [shipFromCountry, setShipFromCountry] = useState(null);
  const [stripeStatus, setStripeStatus] = useState(null);
  const [cardTrader, setCardTrader] = useState(null);
  const [setupError, setSetupError] = useState('');
  const [ctOpen, setCtOpen] = useState(false);
  const [dangerMessage, setDangerMessage] = useState('');
  const [dangerError, setDangerError] = useState('');
  const { settings: loadedSellerSettings, failed: sellerSettingsFailed } = useSellerCurrency();
  const [sellerSettingsPatch, setSellerSettingsPatch] = useState(null);
  const uid = profile?.uid || user?.uid || '';
  const tiles = usePortfolioTiles(signedIn ? uid : '');
  const orderRows = useOrderRows(signedIn ? uid : '');

  useEffect(() => {
    document.title = 'Profile · Pokoin';
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(''), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  if (!ready) return <SessionWait />;
  if (!signedIn) {
    return <Navigate to={`/auth?from=${encodeURIComponent(location.pathname || '/profile')}`} replace />;
  }

  const name = accountHeading(user, profile);
  const photoUrl = profile?.photoUrl || '';
  const silverUntil = profile?.silverUntil
    ? (profile.silverUntil.toISOString?.().slice(0, 10) || profile.silverUntil)
    : '';
  const shopHref = profile?.username ? sellerHref({ sellerUsername: profile.username }) : '';

  const sellerSettings = loadedSellerSettings || sellerSettingsPatch
    ? { ...(loadedSellerSettings || {}), ...(sellerSettingsPatch || {}) }
    : null;
  function onPknChoice(patch) {
    const merged = { ...(sellerSettings || {}), ...patch };
    setSellerSettingsPatch((current) => ({ ...(current || {}), ...patch }));
    publishSellerSettings(merged);
  }
  const setup = sellerSetupSteps({ shipFromCountry, stripe: stripeStatus, cardTrader });
  const step = Object.fromEntries(setup.steps.map((row) => [row.key, row]));
  const activity = orderRows ? orderActivity(orderRows, uid) : null;
  const listedCount = tiles.listed ? `${tiles.listed.listings}${tiles.listedCapped ? '+' : ''}` : '—';
  const ctUser = cardTrader?.metadata?.user?.username || cardTrader?.metadata?.seller?.name || '';
  const ctOneDayReady = cardTrader?.metadata?.oneDayReady === true || cardTrader?.syncSummary?.mode === 'one_day_ready';
  // Unknown after a failed load = the default (PKN on); the switch still saves.
  const acceptsPkn = sellerSettings ? sellerSettings.acceptsPkn !== false : (sellerSettingsFailed ? true : null);
  const localCurrency = sellerListCurrency({ acceptsPkn: false, shipFromCountry });
  const pknMeta = acceptsPkn == null
    ? 'Checking…'
    : acceptsPkn
      ? 'Buyers can pay you with site PKN or by card.'
      : `Card payments only — your prices show in ${localCurrency}.${stripeStatus?.ready ? '' : ' Connect Stripe to get paid.'}`;
  const stripeMeta = stripeStatus?.ready
    ? 'Payouts ready for EUR sales.'
    : step.stripe.started
      ? 'Onboarding started — finish it on Stripe.'
      : shipFromCountry
        ? 'Connect Stripe to receive EUR sales.'
        : 'Choose a ship-from country first.';

  return (
    <div className="page desk profile-page">
      <section className="profile-hero">
        <PageHead
          kicker="Account"
          title={(
            <span className="profile-title-row">
              <DisplayNameEditor onSaved={setToast} />
              {silver ? (
                <span className="profile-silver-chip" title={silverUntil ? `Silver until ${silverUntil}` : 'Silver'}>
                  Silver{silverUntil ? ` · until ${silverUntil}` : ''}
                </span>
              ) : null}
              {admin ? <span className="profile-role-chip">Admin</span> : null}
            </span>
          )}
          meta={<UsernameEditor onSaved={setToast} />}
          lede={accountLede(user)}
          leading={(
            <button
              className="profile-avatar-button"
              type="button"
              onClick={() => setEditing(true)}
              aria-label={photoUrl ? 'Change profile photo' : 'Add a profile photo'}
              title={photoUrl ? 'Change profile photo' : 'Add a profile photo'}
            >
              <Avatar src={photoUrl} seed={uid} name={name} size={88} silver={silver} />
              <span className="profile-avatar-badge" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 3 7.2 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9Zm3 5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Zm0 2a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z" /></svg>
              </span>
            </button>
          )}
        >
          {shopHref ? <Link className="btn ghost" to={shopHref}>View shop</Link> : null}
        </PageHead>
        <MetricGrid>
          <Metric value={tiles.owned ?? '—'} label="Cards owned" />
          <Metric value={listedCount} label="Live listings" />
          <Metric value={formatPknNumber(availablePkn)} label="Site PKN" />
          <Metric
            value={balance ? balance.toFixed(2) : '0'}
            label="Chain PKN"
            hint={address ? shortAddress(address) : 'No wallet linked'}
          />
        </MetricGrid>
      </section>
      {toast ? <p className="profile-toast" role="status">{toast}</p> : null}
      {editing ? (
        <Suspense fallback={null}>
          <AvatarEditor
            open
            onClose={() => setEditing(false)}
            onSaved={setToast}
            name={name}
            seed={uid}
            photoUrl={photoUrl}
          />
        </Suspense>
      ) : null}

      <div className="profile-split">
        <DeskPanel
          title="Seller setup"
          className="profile-setup"
          extra={<span className="setup-count">{setup.done} / {setup.total} complete</span>}
        >
          <div
            className="setup-progress"
            role="progressbar"
            aria-label="Seller setup"
            aria-valuemin={0}
            aria-valuemax={setup.total}
            aria-valuenow={setup.done}
          >
            <span style={{ width: `${Math.round((100 * setup.done) / setup.total)}%` }} />
          </div>
          <ol className="setup-list">
            <SetupRow
              step={step.country}
              title="Ship-from country"
              meta={shipFromCountry
                ? 'Used on your listings and for EUR shipping rates.'
                : 'Required before your first physical listing.'}
              action={(
                <ShipFromCountrySelect
                  value={shipFromCountry || ''}
                  onChange={(next) => {
                    setShipFromCountry(next);
                    // Opted-out sellers price in this country's currency.
                    if (sellerSettings && next) publishSellerSettings({ ...sellerSettings, shipFromCountry: next });
                  }}
                  onLoaded={setShipFromCountry}
                  onError={setSetupError}
                />
              )}
            />
            <SetupRow
              step={step.stripe}
              title="Stripe payouts"
              meta={stripeMeta}
              action={(
                <StripeConnectButton
                  disabled={!shipFromCountry}
                  shipFromCountry={shipFromCountry || ''}
                  onCountrySaved={setShipFromCountry}
                  onError={setSetupError}
                  onStatus={setStripeStatus}
                />
              )}
            />
            <SetupRow
              step={{ done: acceptsPkn != null, loading: acceptsPkn == null }}
              title="Get paid in PKN"
              meta={pknMeta}
              action={(
                <PknPayoutToggle
                  acceptsPkn={acceptsPkn}
                  onChange={onPknChoice}
                  onError={setSetupError}
                />
              )}
            />
            <SetupRow
              step={step.cardtrader}
              title="CardTrader"
              meta={cardTrader?.connected
                ? `Connected${ctUser ? ` as ${ctUser}` : ''}${ctOneDayReady ? ' · 1-Day Ready' : ''}.`
                : 'Optional — import your CardTrader stock and list there from Scan.'}
              open={ctOpen}
              action={(
                <button
                  type="button"
                  className={cardTrader?.connected || ctOpen ? 'btn ghost' : 'btn btn-cardtrader'}
                  aria-expanded={ctOpen}
                  onClick={() => {
                    // Connect sends the seller to CardTrader for their API token
                    // and opens the paste field here for when they come back.
                    if (!ctOpen && !cardTrader?.connected) {
                      window.open(CT_TOKEN_DOCS, '_blank', 'noopener,noreferrer');
                    }
                    setCtOpen((open) => !open);
                  }}
                >
                  {ctOpen ? 'Close' : cardTrader?.connected ? 'Manage' : 'Connect'}
                </button>
              )}
            >
              <CardTraderConnectPanel onStatus={setCardTrader} showWipe={false} />
            </SetupRow>
          </ol>
          {setupError ? <p className="setup-error" role="alert">{setupError}</p> : null}
        </DeskPanel>

        <DeskPanel title="Poko on Telegram & Discord" className="profile-poko">
          <TelegramConnectPanel />
        </DeskPanel>
      </div>

      <div className="profile-split">
        <DeskPanel
          title="Recent activity"
          flush
          extra={activity?.total ? <Link to="/orders">View all</Link> : null}
        >
          {!activity ? (
            <p className="activity-wait">Loading orders…</p>
          ) : activity.recent.length ? (
            <ul className="activity-list">
              {activity.recent.map((row) => (
                <li key={row.id}>
                  <Link className="activity-row" to="/orders">
                    <span className={`activity-icon is-${row.role}`}><Icon name={row.role} size={16} /></span>
                    <span className="activity-main">
                      <strong>{row.role === 'sold' ? 'Sold' : 'Bought'} {row.title}</strong>
                      <span className={`activity-status tone-${row.status.tone}`}>
                        {row.status.label} · {money(row.money)}
                      </span>
                    </span>
                    <time className="activity-when" dateTime={row.at ? new Date(row.at).toISOString() : undefined}>
                      {timeAgo(row.at)}
                    </time>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyDesk nested title="No orders yet" lede="Cards you buy or sell on Pokoin show up here.">
              <Link className="btn" to="/marketplace">Browse the marketplace</Link>
            </EmptyDesk>
          )}
        </DeskPanel>

        <DeskPanel title="Selling snapshot" className="profile-snapshot">
          <dl className="snapshot-list">
            <div>
              <dt>Live listings</dt>
              <dd>{listedCount}</dd>
            </div>
            <div className={activity?.toShip ? 'is-alert' : ''}>
              <dt>Orders to ship</dt>
              <dd>{activity ? activity.toShip : '—'}</dd>
            </div>
            <div>
              <dt>Sales · 30 days</dt>
              <dd>
                {activity ? activity.sales30d : '—'}
                {activity && (activity.salesEurCents30d || activity.salesPkn30d) ? (
                  <span className="snapshot-sub">
                    {[
                      activity.salesEurCents30d ? money({ currency: 'EUR', amount: activity.salesEurCents30d }) : '',
                      activity.salesPkn30d ? money({ currency: 'PKN', amount: activity.salesPkn30d }) : '',
                    ].filter(Boolean).join(' · ')}
                  </span>
                ) : null}
              </dd>
            </div>
          </dl>
          <a className="btn ghost snapshot-cta" href={DASHBOARD_HOME}>Open seller dashboard</a>
        </DeskPanel>
      </div>

      <DeskPanel title="Quick access" className="profile-quick">
        <nav className="quick-grid" aria-label="Quick access">
          <QuickTile to="/marketplace/watchlist" icon="watchlist" title="Watchlist" meta="Saved on this browser" />
          <QuickTile to="/stock" icon="stock" title="Stock" meta="Inventory · sold · bought" />
          <QuickTile to="/mypokoin" icon="store" title="MyPokoin" meta="Your seller listings" />
          <QuickTile to="/mypokoin/spreadsheet" icon="sheet" title="Sell via spreadsheet" meta="Upload an excel or csv file" />
          <QuickTile href={DASHBOARD_HOME} icon="dashboard" title="Dashboard" meta="Portfolio & sales" />
          <QuickTile
            to="/orders"
            icon="orders"
            title="Orders"
            meta="Bought & sold"
            badge={activity?.toShip ? `${activity.toShip} to ship` : ''}
          />
          <QuickTile to="/wallet" icon="wallet" title="Wallet" meta="Send, swap, WPKN" />
          <QuickTile to="/buy" icon="buy" title="Buy PKN" meta="Top up site balance" />
          <QuickTile to="/mypokoin/collection" icon="collection" title="Collection" meta="MyPokoin · physical + NFT" />
          <QuickTile to="/messages" icon="messages" title="Messages" meta="Chats & Poko" />
          <QuickTile to="/forum" icon="forum" title="Forum" meta="Community" />
          <QuickTile to="/invite" icon="invite" title="Invite & Earn" meta="20 PKN for you and a friend" />
          <QuickTile to="/ambassadorprogram" icon="ambassador" title="Ambassador" meta="Missions, tiers, perks" />
          {admin ? <QuickTile to="/admin" icon="admin" title="Admin" meta="Expansion logos" /> : null}
        </nav>
      </DeskPanel>

      <DeskPanel title="Account" className="profile-account">
        <div className="account-row">
          <span>
            {user?.email ? <>Signed in as <strong>{user.email}</strong></> : 'Signed in'}
          </span>
          <button
            className="btn ghost"
            type="button"
            onClick={async () => {
              await endActiveScanSessionForSignOut(getBearer);
              await signOut(firebaseAuth);
            }}
          >
            Sign out
          </button>
        </div>
      </DeskPanel>

      <section className="danger-zone" aria-labelledby="danger-zone-title">
        <h2 id="danger-zone-title">Danger zone</h2>
        <div className="danger-row">
          <div>
            <strong>Delete all Pokoin listings</strong>
            <p>
              Removes every listing on your account across all TCGs, including CardTrader links.
              Your CardTrader stock itself is untouched.
            </p>
          </div>
          <WipeAllInventory
            onError={(text) => {
              setDangerError(text || '');
              if (text) setDangerMessage('');
            }}
            onMessage={(text) => {
              setDangerMessage(text || '');
              setDangerError('');
            }}
          />
        </div>
        {dangerMessage ? <p className="ct-connect-ok">{dangerMessage}</p> : null}
        {dangerError ? <p className="ct-connect-err">{dangerError}</p> : null}
      </section>
    </div>
  );
}
