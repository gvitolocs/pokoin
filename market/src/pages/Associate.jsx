import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { fetchAssociateSummary, formatPknNumber } from '../api.js';
import { useReferral } from '../use-referral.js';
import { useAuth } from '../auth.jsx';
import { authFrom } from '../punchouts.js';
import { Alert, DeskPanel, EmptyDesk, PageHead, SessionWait } from '../components/Desk.jsx';
import { MissionGrid, TrainerCard } from '../components/AmbassadorProgress.jsx';
import FounderWelcome from '../components/FounderWelcome.jsx';
import { isFounderRole } from '../associate-roles.js';
import { MISSIONS, PERKS, applyMailto } from '../ambassador-program.js';
import { REFERRAL_REWARD_PKN, inviteLink } from '../referral.js';
import '../associate.css';
import '../referral.css';

const CAMPAIGN_START = '2026-09-29T00:00:00Z';
const CAMPAIGN_END = '2026-10-31T23:59:59Z';

/** Dev/local layout fixtures — never presented as live production data. */
const PREVIEW_FIXTURE = {
  associate: {
    email: 'gianlonji@gmail.com',
    role: 'distributor',
    displayName: 'Gianlonji',
    sharePct: 100,
    royaltyPct: 3,
    windowStart: CAMPAIGN_START,
    windowEnd: CAMPAIGN_END,
    active: true,
  },
  window: { start: CAMPAIGN_START, end: CAMPAIGN_END, daysTotal: 33, daysElapsed: 3, daysRemaining: 30, live: true },
  earnings: {
    qualifyingOrders: 4,
    unverifiedOrders: 1,
    grossPkn: 2680,
    royaltyPkn: 80.4,
    earningPkn: 80.4,
    grossEurCents: 58200,
    royaltyEurCents: 1746,
    earningEurCents: 1746,
    daily: [
      { date: '2026-09-29', orders: 1, earningPkn: 21.3, earningEurCents: 612 },
      { date: '2026-09-30', orders: 0, earningPkn: 0, earningEurCents: 0 },
      { date: '2026-10-01', orders: 2, earningPkn: 34.5, earningEurCents: 834 },
      { date: '2026-10-02', orders: 1, earningPkn: 24.6, earningEurCents: 300 },
    ],
    orders: [
      { orderId: 'ord_9f2ab34c11dd', date: '2026-10-02', buyer: 'm*****@gmail.com', sellers: 1, currency: 'EUR', gross: 10000, royalty: 300, earning: 300 },
      { orderId: 'ord_51c9e0a77b20', date: '2026-10-01', buyer: 'l*****@gmail.com', sellers: 2, currency: 'PKN', gross: 1150, royalty: 34.5, earning: 34.5 },
      { orderId: 'ord_c0447e91aa03', date: '2026-10-01', buyer: 'g*****@gmail.com', sellers: 1, currency: 'EUR', gross: 17200, royalty: 516, earning: 516 },
      { orderId: 'ord_77bd1f5290ec', date: '2026-09-29', buyer: 's*****@gmail.com', sellers: 1, currency: 'PKN', gross: 1530, royalty: 45.9, earning: 45.9 },
    ],
  },
};

function eur(cents) {
  return `€${((Number(cents) || 0) / 100).toFixed(2)}`;
}

function pkn(value) {
  return `${formatPknNumber(value, { maximumFractionDigits: 2 })} PKN`;
}

function shortDate(iso) {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fullDate(iso) {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * Per-role desk presentation. The API owns the numbers and the terms row by
 * row; this map only owns how each role's desk reads and feels.
 */
const ROLES = {
  distributor: {
    badge: 'Distributor',
    kicker: 'Pokoin Associates · Distributor',
    tagline: 'Your desk tracks every royalty earned on sales made by Italian sellers to Italian buyers. You take 100% of the pool through the end of October.',
    accent: 'is-gold',
    how: [
      'A sale qualifies when the seller ships from Italy and the buyer ships to Italy.',
      'The pool is the 3% Pokoin checkout royalty on the cards subtotal.',
      'Your share of the pool: 100%, paid on every qualifying order in the window.',
    ],
  },
  // Ambassadors are mission-based (AmbassadorDesk), not a royalty deal.
  ambassador: {
    badge: 'Ambassador',
    kicker: 'Pokoin Associates · Ambassador',
    tagline: 'Your desk tracks your missions, tier and perks in the Pokoin Ambassador program.',
    accent: 'is-violet',
    missions: true,
    how: [],
  },
  // Pokoin's first ambassador: same program, one-off title, personal welcome.
  founder_ambassador: {
    badge: 'Founder Ambassador',
    kicker: 'Pokoin Associates · Founder Ambassador',
    tagline: 'The first Ambassador of the Pokoin program.',
    accent: 'is-founder',
    missions: true,
    founder: true,
    how: [],
  },
  associate: {
    badge: 'Associate',
    kicker: 'Pokoin Associates',
    tagline: 'Your desk tracks the royalties your associate deal earns, live.',
    accent: 'is-gold',
    how: [
      'A sale qualifies when the seller ships from Italy and the buyer ships to Italy.',
      'The pool is the 3% Pokoin checkout royalty on the cards subtotal.',
    ],
  },
};

function rolePresentation(role) {
  return ROLES[role] || ROLES.associate;
}

function allowLayoutPreview(searchParams) {
  // Explicit fixture layout only — never when reviewing live auth data.
  if (!searchParams.has('associatePreview')) return false;
  if (import.meta.env.DEV) return true;
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1';
}

function progressPct(window) {
  if (!window?.daysTotal) return 0;
  return Math.min(100, Math.max(0, Math.round((window.daysElapsed / window.daysTotal) * 100)));
}

function DailyChart({ daily, currency }) {
  const points = (daily || []).filter((row) => (currency === 'EUR' ? row.earningEurCents : row.earningPkn) > 0);
  if (!points.length) {
    return <p className="associate-chart-empty">No royalties yet — the desk fills in as qualifying sales land.</p>;
  }
  const max = Math.max(...points.map((row) => (currency === 'EUR' ? row.earningEurCents : row.earningPkn)));
  return (
    <div className="associate-chart" role="img" aria-label="Earnings by day">
      {points.map((row) => {
        const value = currency === 'EUR' ? row.earningEurCents : row.earningPkn;
        return (
          <span className="associate-chart-day" key={row.date} title={`${row.date} · ${currency === 'EUR' ? eur(value) : pkn(value)}`}>
            <span className="associate-chart-bar" style={{ height: `${Math.max(6, Math.round((value / max) * 100))}%` }} />
            <span className="associate-chart-label">{row.date.slice(8)}</span>
          </span>
        );
      })}
    </div>
  );
}

function Hero({ data }) {
  const { earnings, window: campaign, associate } = data;
  const earningParts = [];
  if (earnings.earningPkn > 0) earningParts.push(pkn(earnings.earningPkn));
  if (earnings.earningEurCents > 0) earningParts.push(eur(earnings.earningEurCents));
  const headline = earningParts.length ? earningParts.join(' + ') : '0 PKN';
  return (
    <section className={`associate-hero ${rolePresentation(associate.role).accent}`}>
      <div className="associate-hero-main">
        <span className="associate-eyebrow">Earned so far</span>
        <strong className="associate-earning">{headline}</strong>
        <span className="associate-earning-sub">
          {earnings.qualifyingOrders} qualifying sale{earnings.qualifyingOrders === 1 ? '' : 's'}
          {earnings.unverifiedOrders > 0 ? ` · ${earnings.unverifiedOrders} pending country check` : ''}
        </span>
      </div>
      <div className="associate-hero-window">
        <div className="associate-window-dates">
          <span>{shortDate(campaign.start)}</span>
          <span className="associate-window-arrow">→</span>
          <span>{shortDate(campaign.end)}</span>
        </div>
        <div className="associate-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPct(campaign)}>
          <span style={{ width: `${progressPct(campaign)}%` }} />
        </div>
        <span className="associate-window-note">
          Day {campaign.daysElapsed + 1} of {campaign.daysTotal}
          {' · '}
          {campaign.live ? `${campaign.daysRemaining} days left` : 'Campaign closed'}
        </span>
      </div>
    </section>
  );
}

function AssociatesOverview({ overview, onView }) {
  return (
    <DeskPanel flush title={`Associates overview · ${overview.length}`} className="associate-orders">
      {overview.length ? (
        <div className="associate-overview">
          {overview.map((row) => (
            <article className="associate-overview-row" key={row.associate.email}>
              <span className="associate-overview-who">
                <strong>{row.associate.displayName || row.associate.email}</strong>
                <span>
                  {row.associate.email}
                  {' · '}
                  {rolePresentation(row.associate.role).missions ? 'missions program' : `${row.associate.sharePct}% share`}
                  {' · '}
                  {row.associate.active ? 'active' : 'paused'}
                  {row.earnings.unverifiedOrders > 0 ? ` · ${row.earnings.unverifiedOrders} pending country check` : ''}
                </span>
              </span>
              <span className={`associate-badge ${rolePresentation(row.associate.role).accent}`}>
                {rolePresentation(row.associate.role).badge}
              </span>
              {rolePresentation(row.associate.role).missions ? (
                <span className="associate-overview-money">
                  <span>Ambassador program</span>
                  <strong>{row.associate.city ? `City · ${row.associate.city}` : 'Missions & tiers'}</strong>
                </span>
              ) : (
                <span className="associate-overview-money">
                  <span>{row.earnings.qualifyingOrders} qualifying sale{row.earnings.qualifyingOrders === 1 ? '' : 's'}</span>
                  <strong>{moneyRange(row.earnings.earningPkn, row.earnings.earningEurCents)}</strong>
                </span>
              )}
              {onView ? (
                <button
                  type="button"
                  className="btn ghost associate-overview-view"
                  onClick={() => onView(row.associate.email)}
                >
                  View desk
                </button>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <p className="page-lede associate-empty-orders">No associates on the roster yet.</p>
      )}
    </DeskPanel>
  );
}

/** Admin "view as": the clicked associate's desk, exactly as they see it. */
function AdminAssociateArea({ overview, onView }) {
  return <AssociatesOverview overview={overview} onView={onView} />;
}

/** Full-page view-as: the associate's own desk under a read-only banner. */
function AdminViewingView({ row, onBack }) {
  const presentation = rolePresentation(row.associate.role);
  return (
    <div className="page desk associate-page">
      <PageHead kicker="Pokoin Associates · Admin" title="Associates overview">
        <button type="button" className="btn ghost" onClick={onBack}>Back to overview</button>
      </PageHead>
      <div className="associate-viewing-bar">
        <span>
          Viewing the desk <strong>{row.associate.displayName || row.associate.email}</strong> sees
          {' · '}
          {presentation.badge}
          {' · read-only'}
        </span>
        <button type="button" className="btn ghost" onClick={onBack}>Back to overview</button>
      </div>
      <AssociateView data={row} viewingAs />
    </div>
  );
}

function AdminOverviewView({ data, onView }) {
  return (
    <div className="page desk associate-page">
      <PageHead kicker="Pokoin Associates · Admin" title="Associates overview" />
      <AdminAssociateArea overview={data.overview} onView={onView} />
    </div>
  );
}

const PREVIEW_AMBASSADOR = {
  code: 'apciliberti',
  stats: { invited: 4, pending: 2, activated: 2, earnedPkn: 40 },
  ambassador: {
    tier: 'ambassador',
    city: '',
    completed: ['content', 'bug_report', 'feedback'],
    activatedReferrals: 2,
    referralTarget: 3,
    onRoster: true,
    next: { tier: 'senior', missionsLeft: 2, referralsLeft: 8 },
    contributions: [
      { mission: 'content', note: 'Pull video on TikTok', link: '', verifiedAt: '2026-09-30T10:00:00Z' },
      { mission: 'bug_report', note: 'Wrong Japanese set name on a card desk', link: '', verifiedAt: '2026-10-01T10:00:00Z' },
      { mission: 'feedback', note: 'Checkout shipping choices write-up', link: '', verifiedAt: '2026-10-02T10:00:00Z' },
    ],
  },
};

function missionTitle(key) {
  return MISSIONS.find((row) => row.key === key)?.title || key;
}

/**
 * Ambassador desk: the Ambassador program (missions → tiers → perks), not a
 * royalty desk. Progress is the signed-in ambassador's own
 * (/api/marketplace-referral); admin view-as shows the roster record only.
 */
function AmbassadorDesk({ data, overview = null, onView = null, viewingAs = false, preview = false }) {
  const live = useReferral({ enabled: !viewingAs && !preview });
  const referral = preview ? PREVIEW_AMBASSADOR : live.data;
  const error = preview || live.data ? '' : live.error;

  const founder = isFounderRole(data.associate.role);
  const fallback = {
    founder,
    tier: data.associate.city ? 'city' : 'ambassador',
    city: data.associate.city || '',
    completed: [],
    activatedReferrals: 0,
    referralTarget: 3,
    next: data.associate.city ? null : { tier: 'senior', missionsLeft: 5, referralsLeft: 10 },
    contributions: [],
  };
  const progress = referral?.ambassador ? { ...referral.ambassador, founder: referral.ambassador.founder || founder } : fallback;
  const link = inviteLink(referral?.code);
  return (
    <div className={`page desk associate-page amb-desk${founder ? ' is-founder' : ''}`}>
      {founder ? (
        <FounderWelcome name={data.associate.displayName} since={data.associate.windowStart} />
      ) : (
        <PageHead kicker="Pokoin Associates · Ambassador" title="Your missions">
          <span className="associate-badge is-violet">Ambassador</span>
        </PageHead>
      )}
      {!data.associate.active ? <Alert>Your ambassador record is paused. Contact the Pokoin team to reactivate it.</Alert> : null}
      {viewingAs ? <Alert>Mission progress is personal: the ambassador sees their own tier, missions and invites here.</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      <TrainerCard progress={progress} username={referral?.code || data.associate.displayName} />
      <DeskPanel title="Missions" className="associate-tile">
        <MissionGrid
          completed={progress.completed}
          activatedReferrals={progress.activatedReferrals}
          referralTarget={progress.referralTarget}
        />
      </DeskPanel>
      <div className="associate-grid">
        <DeskPanel title="Verified contributions" className="associate-tile">
          {progress.contributions?.length ? (
            <ul className="associate-how">
              {progress.contributions.map((row) => (
                <li key={`${row.mission}-${row.verifiedAt}`}>
                  <strong>{missionTitle(row.mission)}</strong>
                  {row.note ? ` · ${row.note}` : ''}
                  {row.verifiedAt ? ` · ${shortDate(row.verifiedAt)}` : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p className="page-lede">Nothing verified yet. Send links and details of what you did and the Pokoin team adds it here.</p>
          )}
          <a className="btn ghost" href={applyMailto(referral?.code)}>Submit a mission</a>
        </DeskPanel>
        <DeskPanel title="Invite & Earn" className="associate-tile">
          <dl className="associate-facts">
            <div><dt>Invited</dt><dd>{referral?.stats?.invited ?? '—'}</dd></div>
            <div><dt>Activated</dt><dd>{referral?.stats?.activated ?? '—'}</dd></div>
            <div><dt>Earned</dt><dd>{referral ? pkn(referral.stats.earnedPkn) : '—'}</dd></div>
          </dl>
          <p className="page-lede">
            {REFERRAL_REWARD_PKN} PKN for you and every collector you bring, after their first purchase or sale.
            {link ? <> Your link: <strong>{link.replace('https://', '')}</strong></> : null}
          </p>
          {viewingAs ? null : <Link className="btn ghost" to="/invite">Open Invite &amp; Earn</Link>}
        </DeskPanel>
      </div>
      <DeskPanel title="Your perks" className="associate-tile">
        <ul className="amb-perks">
          {PERKS.map((perk) => (
            <li key={perk.title}><strong>{perk.title}</strong><span>{perk.text}</span></li>
          ))}
        </ul>
      </DeskPanel>
      {overview ? <AdminAssociateArea overview={overview} onView={onView} /> : null}
    </div>
  );
}

function AssociateView({ data, overview = null, onView = null, viewingAs = false, preview = false }) {
  const presentation = rolePresentation(data.associate.role);
  if (presentation.missions) {
    return <AmbassadorDesk data={data} overview={overview} onView={onView} viewingAs={viewingAs} preview={preview} />;
  }
  return (
    <div className="page desk associate-page">
      <PageHead kicker={presentation.kicker} title="Your earnings">
        <span className={`associate-badge ${presentation.accent}`}>{presentation.badge}</span>
      </PageHead>
      {!data.associate.active ? (
        <Alert>Your associate record is paused — earnings are frozen until it is reactivated.</Alert>
      ) : null}
      <Hero data={data} />
      <div className="associate-grid">
        <DeskPanel title="The campaign" className="associate-tile">
          <dl className="associate-facts">
            <div>
              <dt>Window</dt>
              <dd>{fullDate(data.window.start)} → {fullDate(data.window.end)}</dd>
            </div>
            <div>
              <dt>Royalty pool</dt>
              <dd>{data.associate.royaltyPct}% of the cards subtotal on every qualifying sale</dd>
            </div>
            <div>
              <dt>Your share</dt>
              <dd>{data.associate.sharePct}% of the pool</dd>
            </div>
            <div>
              <dt>Rule</dt>
              <dd>Italian seller → Italian buyer</dd>
            </div>
          </dl>
          <ul className="associate-how">
            {presentation.how.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </DeskPanel>
        <DeskPanel title="Earnings by day" className="associate-tile">
          <DailyChart daily={data.earnings.daily} currency={data.earnings.earningEurCents > 0 ? 'EUR' : 'PKN'} />
          <dl className="associate-facts">
            <div>
              <dt>Gross volume</dt>
              <dd>{moneyRange(data.earnings.grossPkn, data.earnings.grossEurCents)}</dd>
            </div>
            <div>
              <dt>Royalty pool</dt>
              <dd>{moneyRange(data.earnings.royaltyPkn, data.earnings.royaltyEurCents)}</dd>
            </div>
          </dl>
        </DeskPanel>
      </div>
      <DeskPanel
        flush
        title={`Qualifying orders${data.earnings.orders.length ? ` · ${data.earnings.qualifyingOrders}` : ''}`}
        className="associate-orders"
      >
        {data.earnings.orders.length ? (
          <div className="associate-order-list">
            {data.earnings.orders.map((row) => (
              <article className="associate-order" key={row.orderId}>
                <span className="associate-order-main">
                  <strong>{row.date}</strong>
                  <span className="associate-order-meta">
                    {row.orderId.slice(0, 12)} · {row.buyer} · {row.sellers} seller{row.sellers === 1 ? '' : 's'}
                  </span>
                </span>
                <span className="associate-order-money">
                  <span>sale {row.currency === 'EUR' ? eur(row.gross) : pkn(row.gross)}</span>
                  <span>royalty {row.currency === 'EUR' ? eur(row.royalty) : pkn(row.royalty)}</span>
                  <strong>you {row.currency === 'EUR' ? eur(row.earning) : pkn(row.earning)}</strong>
                </span>
              </article>
            ))}
          </div>
        ) : (
          <p className="page-lede associate-empty-orders">
            No qualifying sales yet. Every Italian-domestic order that lands while the campaign is live shows up here with your cut.
          </p>
        )}
      </DeskPanel>
      {overview ? <AdminAssociateArea overview={overview} onView={onView} /> : null}
    </div>
  );
}

function moneyRange(pknValue, eurCents) {
  const parts = [];
  if (pknValue > 0) parts.push(pkn(pknValue));
  if (eurCents > 0) parts.push(eur(eurCents));
  return parts.length ? parts.join(' + ') : '—';
}

export default function Associate() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const preview = allowLayoutPreview(searchParams);
  const { ready, signedIn, getBearer } = useAuth();
  const [data, setData] = useState(null);
  const [notAssociate, setNotAssociate] = useState(false);
  const [error, setError] = useState('');
  const [viewingEmail, setViewingEmail] = useState('');

  useEffect(() => {
    document.title = 'Associate · Pokoin';
  }, []);

  useEffect(() => {
    if (!signedIn) return undefined;
    let cancelled = false;
    setData(null);
    setNotAssociate(false);
    setError('');
    getBearer()
      .then((token) => fetchAssociateSummary(token))
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err?.statusCode === 403 || /associate/i.test(String(err?.message || ''))) {
          setNotAssociate(true);
        } else {
          setError(err?.message || 'The associate desk is unreachable right now.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, getBearer]);

  if (preview) {
    if (searchParams.get('role') === 'admin') {
      const fixtureOverview = [
        { associate: PREVIEW_FIXTURE.associate, window: PREVIEW_FIXTURE.window, earnings: PREVIEW_FIXTURE.earnings },
        {
          associate: { ...PREVIEW_FIXTURE.associate, email: 'apciliberti@gmail.com', role: 'founder_ambassador', displayName: 'Andrea Paolo' },
          window: PREVIEW_FIXTURE.window,
          earnings: { ...PREVIEW_FIXTURE.earnings, qualifyingOrders: 2, earningPkn: 21.3, earningEurCents: 612 },
        },
      ];
      const viewing = fixtureOverview.find((row) => row.associate.email === viewingEmail);
      if (viewing) {
        return <AdminViewingView row={viewing} onBack={() => setViewingEmail('')} />;
      }
      return <AdminOverviewView data={{ admin: true, overview: fixtureOverview }} onView={setViewingEmail} />;
    }
    const fixture = {
      ...PREVIEW_FIXTURE,
      associate: {
        ...PREVIEW_FIXTURE.associate,
        ...(ROLES[searchParams.get('role')] && searchParams.get('role') !== 'associate'
          ? { role: searchParams.get('role') }
          : {}),
        ...(isFounderRole(searchParams.get('role')) ? { displayName: 'Andrea Paolo' } : {}),
      },
    };
    return <AssociateView data={fixture} preview />;
  }

  if (!ready) return <SessionWait />;
  if (!signedIn) {
    return <Navigate to={authFrom(location.pathname || '/associate')} replace />;
  }
  if (notAssociate) {
    return (
      <div className="page desk">
        <PageHead kicker="Pokoin Associates" title="Associate desk" />
        <EmptyDesk
          title="This desk is by invitation"
          lede="Pokoin Associates is a partner program. If you were promised a desk here, contact admin@pokoin.com to be added to the roster, then reload."
        >
          <a className="btn ghost" href="mailto:admin@pokoin.com?subject=Pokoin%20Associates">Contact admin@pokoin.com</a>
          <Link className="btn" to="/marketplace">Back to the marketplace</Link>
        </EmptyDesk>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page desk">
        <PageHead kicker="Pokoin Associates" title="Associate desk" />
        <Alert>{error}</Alert>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="page desk associate-page">
        <PageHead kicker="Pokoin Associates" title="Your earnings" />
        <DeskPanel title="Loading your desk"><div className="skeleton-line" /><div className="skeleton-line" /></DeskPanel>
      </div>
    );
  }
  if (data.admin && data.overview) {
    const viewing = viewingEmail
      ? data.overview.find((row) => row.associate.email === viewingEmail)
      : null;
    if (viewing) {
      return <AdminViewingView row={viewing} onBack={() => setViewingEmail('')} />;
    }
    if (!data.associate) {
      return <AdminOverviewView data={data} onView={setViewingEmail} />;
    }
    return <AssociateView data={data} overview={data.overview} onView={setViewingEmail} />;
  }
  return <AssociateView data={data} />;
}
