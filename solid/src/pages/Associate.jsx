import { createEffect, createSignal, For, Match, Show, Switch, untrack } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import { fetchAssociateSummary, formatPknNumber } from '@market/api.js';
import { MISSIONS, PERKS, applyMailto } from '@market/ambassador-program.js';
import { isFounderRole } from '@market/associate-roles.js';
import { REFERRAL_REWARD_PKN, inviteLink } from '@market/referral.js';
import '@market/associate.css';
import '@market/referral.css';
import { MissionGrid, TrainerCard } from '../components/AmbassadorProgress.jsx';
import { Alert, DeskPanel, EmptyDesk, PageHead } from '../components/Desk.jsx';
import FounderWelcome from '../components/FounderWelcome.jsx';
import SignedIn from '../components/SignedIn.jsx';
import { createReferral } from '../lib/referral.js';
import { getBearer, signedIn } from '../stores/auth.js';

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

function allowLayoutPreview(params) {
  // Explicit fixture layout only — never when reviewing live auth data.
  if (params.associatePreview === undefined) return false;
  if (import.meta.env.DEV) return true;
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1';
}

function progressPct(window) {
  if (!window?.daysTotal) return 0;
  return Math.min(100, Math.max(0, Math.round((window.daysElapsed / window.daysTotal) * 100)));
}

function moneyRange(pknValue, eurCents) {
  const parts = [];
  if (pknValue > 0) parts.push(pkn(pknValue));
  if (eurCents > 0) parts.push(eur(eurCents));
  return parts.length ? parts.join(' + ') : '—';
}

function DailyChart(props) {
  const amount = (row) => (props.currency === 'EUR' ? row.earningEurCents : row.earningPkn);
  const points = () => (props.daily || []).filter((row) => amount(row) > 0);
  const max = () => Math.max(...points().map(amount));
  return (
    <Show when={points().length} fallback={<p class="associate-chart-empty">No royalties yet — the desk fills in as qualifying sales land.</p>}>
      <div class="associate-chart" role="img" aria-label="Earnings by day">
        <For each={points()}>
          {(row) => (
            <span class="associate-chart-day" title={`${row.date} · ${props.currency === 'EUR' ? eur(amount(row)) : pkn(amount(row))}`}>
              <span class="associate-chart-bar" style={{ height: `${Math.max(6, Math.round((amount(row) / max()) * 100))}%` }} />
              <span class="associate-chart-label">{row.date.slice(8)}</span>
            </span>
          )}
        </For>
      </div>
    </Show>
  );
}

function Hero(props) {
  const earnings = () => props.data.earnings;
  const campaign = () => props.data.window;
  const headline = () => {
    const parts = [];
    if (earnings().earningPkn > 0) parts.push(pkn(earnings().earningPkn));
    if (earnings().earningEurCents > 0) parts.push(eur(earnings().earningEurCents));
    return parts.length ? parts.join(' + ') : '0 PKN';
  };
  return (
    <section class={['associate-hero', rolePresentation(props.data.associate.role).accent]}>
      <div class="associate-hero-main">
        <span class="associate-eyebrow">Earned so far</span>
        <strong class="associate-earning">{headline()}</strong>
        <span class="associate-earning-sub">
          {earnings().qualifyingOrders} qualifying sale{earnings().qualifyingOrders === 1 ? '' : 's'}
          {earnings().unverifiedOrders > 0 ? ` · ${earnings().unverifiedOrders} pending country check` : ''}
        </span>
      </div>
      <div class="associate-hero-window">
        <div class="associate-window-dates">
          <span>{shortDate(campaign().start)}</span>
          <span class="associate-window-arrow">→</span>
          <span>{shortDate(campaign().end)}</span>
        </div>
        <div class="associate-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPct(campaign())}>
          <span style={{ width: `${progressPct(campaign())}%` }} />
        </div>
        <span class="associate-window-note">
          Day {campaign().daysElapsed + 1} of {campaign().daysTotal}
          {' · '}
          {campaign().live ? `${campaign().daysRemaining} days left` : 'Campaign closed'}
        </span>
      </div>
    </section>
  );
}

function AssociatesOverview(props) {
  return (
    <DeskPanel flush title={`Associates overview · ${props.overview.length}`} class="associate-orders">
      <Show when={props.overview.length} fallback={<p class="page-lede associate-empty-orders">No associates on the roster yet.</p>}>
        <div class="associate-overview">
          <For each={props.overview}>
            {(row) => {
              const presentation = rolePresentation(row.associate.role);
              return (
                <article class="associate-overview-row">
                  <span class="associate-overview-who">
                    <strong>{row.associate.displayName || row.associate.email}</strong>
                    <span>
                      {row.associate.email}
                      {' · '}
                      {presentation.missions ? 'missions program' : `${row.associate.sharePct}% share`}
                      {' · '}
                      {row.associate.active ? 'active' : 'paused'}
                      {row.earnings.unverifiedOrders > 0 ? ` · ${row.earnings.unverifiedOrders} pending country check` : ''}
                    </span>
                  </span>
                  <span class={['associate-badge', presentation.accent]}>{presentation.badge}</span>
                  <Show
                    when={presentation.missions}
                    fallback={(
                      <span class="associate-overview-money">
                        <span>{row.earnings.qualifyingOrders} qualifying sale{row.earnings.qualifyingOrders === 1 ? '' : 's'}</span>
                        <strong>{moneyRange(row.earnings.earningPkn, row.earnings.earningEurCents)}</strong>
                      </span>
                    )}
                  >
                    <span class="associate-overview-money">
                      <span>Ambassador program</span>
                      <strong>{row.associate.city ? `City · ${row.associate.city}` : 'Missions & tiers'}</strong>
                    </span>
                  </Show>
                  <Show when={props.onView}>
                    <button type="button" class="btn ghost associate-overview-view" onClick={() => props.onView(row.associate.email)}>View desk</button>
                  </Show>
                </article>
              );
            }}
          </For>
        </div>
      </Show>
    </DeskPanel>
  );
}

/** Full-page view-as: the associate's own desk under a read-only banner. */
function AdminViewingView(props) {
  const presentation = () => rolePresentation(props.row.associate.role);
  return (
    <div class="page desk associate-page">
      <PageHead kicker="Pokoin Associates · Admin" title="Associates overview">
        <button type="button" class="btn ghost" onClick={() => props.onBack()}>Back to overview</button>
      </PageHead>
      <div class="associate-viewing-bar">
        <span>
          Viewing the desk <strong>{props.row.associate.displayName || props.row.associate.email}</strong> sees
          {' · '}
          {presentation().badge}
          {' · read-only'}
        </span>
        <button type="button" class="btn ghost" onClick={() => props.onBack()}>Back to overview</button>
      </div>
      <AssociateView data={props.row} viewingAs />
    </div>
  );
}

function AdminOverviewView(props) {
  return (
    <div class="page desk associate-page">
      <PageHead kicker="Pokoin Associates · Admin" title="Associates overview" />
      <AssociatesOverview overview={props.data.overview} onView={props.onView} />
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
function AmbassadorDesk(props) {
  const live = createReferral(() => !props.viewingAs && !props.preview);
  const referral = () => (props.preview ? PREVIEW_AMBASSADOR : live.data());
  const error = () => (props.preview || live.data() ? '' : live.error());
  const associate = () => props.data.associate;
  const founder = () => isFounderRole(associate().role);
  const progress = () => {
    const ambassador = referral()?.ambassador;
    if (ambassador) return { ...ambassador, founder: ambassador.founder || founder() };
    return {
      founder: founder(),
      tier: associate().city ? 'city' : 'ambassador',
      city: associate().city || '',
      completed: [],
      activatedReferrals: 0,
      referralTarget: 3,
      next: associate().city ? null : { tier: 'senior', missionsLeft: 5, referralsLeft: 10 },
      contributions: [],
    };
  };
  const link = () => inviteLink(referral()?.code);
  return (
    <div class={['page', 'desk', 'associate-page', 'amb-desk', { 'is-founder': founder() }]}>
      <Show
        when={founder()}
        fallback={(
          <PageHead kicker="Pokoin Associates · Ambassador" title="Your missions">
            <span class="associate-badge is-violet">Ambassador</span>
          </PageHead>
        )}
      >
        <FounderWelcome name={associate().displayName} since={associate().windowStart} />
      </Show>
      <Show when={!associate().active}><Alert>Your ambassador record is paused. Contact the Pokoin team to reactivate it.</Alert></Show>
      <Show when={props.viewingAs}><Alert>Mission progress is personal: the ambassador sees their own tier, missions and invites here.</Alert></Show>
      <Show when={error()}><Alert>{error()}</Alert></Show>
      <TrainerCard progress={progress()} username={referral()?.code || associate().displayName} />
      <DeskPanel title="Missions" class="associate-tile">
        <MissionGrid completed={progress().completed} activatedReferrals={progress().activatedReferrals} referralTarget={progress().referralTarget} />
      </DeskPanel>
      <div class="associate-grid">
        <DeskPanel title="Verified contributions" class="associate-tile">
          <Show
            when={progress().contributions?.length}
            fallback={<p class="page-lede">Nothing verified yet. Send links and details of what you did and the Pokoin team adds it here.</p>}
          >
            <ul class="associate-how">
              <For each={progress().contributions}>
                {(row) => (
                  <li>
                    <strong>{missionTitle(row.mission)}</strong>
                    {row.note ? ` · ${row.note}` : ''}
                    {row.verifiedAt ? ` · ${shortDate(row.verifiedAt)}` : ''}
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <a class="btn ghost" href={applyMailto(referral()?.code)}>Submit a mission</a>
        </DeskPanel>
        <DeskPanel title="Invite & Earn" class="associate-tile">
          <dl class="associate-facts">
            <div><dt>Invited</dt><dd>{referral()?.stats?.invited ?? '—'}</dd></div>
            <div><dt>Activated</dt><dd>{referral()?.stats?.activated ?? '—'}</dd></div>
            <div><dt>Earned</dt><dd>{referral() ? pkn(referral().stats.earnedPkn) : '—'}</dd></div>
          </dl>
          <p class="page-lede">
            {REFERRAL_REWARD_PKN} PKN for you and every collector you bring, after their first purchase or sale.
            <Show when={link()}> Your link: <strong>{link().replace('https://', '')}</strong></Show>
          </p>
          <Show when={!props.viewingAs}><a class="btn ghost" href="/invite">Open Invite &amp; Earn</a></Show>
        </DeskPanel>
      </div>
      <DeskPanel title="Your perks" class="associate-tile">
        <ul class="amb-perks">
          <For each={PERKS}>{(perk) => <li><strong>{perk.title}</strong><span>{perk.text}</span></li>}</For>
        </ul>
      </DeskPanel>
      <Show when={props.overview}><AssociatesOverview overview={props.overview} onView={props.onView} /></Show>
    </div>
  );
}

function AssociateView(props) {
  const presentation = () => rolePresentation(props.data.associate.role);
  const data = () => props.data;
  return (
    <Show
      when={!presentation().missions}
      fallback={<AmbassadorDesk data={props.data} overview={props.overview} onView={props.onView} viewingAs={props.viewingAs} preview={props.preview} />}
    >
      <div class="page desk associate-page">
        <PageHead kicker={presentation().kicker} title="Your earnings">
          <span class={['associate-badge', presentation().accent]}>{presentation().badge}</span>
        </PageHead>
        <Show when={!data().associate.active}>
          <Alert>Your associate record is paused — earnings are frozen until it is reactivated.</Alert>
        </Show>
        <Hero data={data()} />
        <div class="associate-grid">
          <DeskPanel title="The campaign" class="associate-tile">
            <dl class="associate-facts">
              <div><dt>Window</dt><dd>{fullDate(data().window.start)} → {fullDate(data().window.end)}</dd></div>
              <div><dt>Royalty pool</dt><dd>{data().associate.royaltyPct}% of the cards subtotal on every qualifying sale</dd></div>
              <div><dt>Your share</dt><dd>{data().associate.sharePct}% of the pool</dd></div>
              <div><dt>Rule</dt><dd>Italian seller → Italian buyer</dd></div>
            </dl>
            <ul class="associate-how">
              <For each={presentation().how}>{(line) => <li>{line}</li>}</For>
            </ul>
          </DeskPanel>
          <DeskPanel title="Earnings by day" class="associate-tile">
            <DailyChart daily={data().earnings.daily} currency={data().earnings.earningEurCents > 0 ? 'EUR' : 'PKN'} />
            <dl class="associate-facts">
              <div><dt>Gross volume</dt><dd>{moneyRange(data().earnings.grossPkn, data().earnings.grossEurCents)}</dd></div>
              <div><dt>Royalty pool</dt><dd>{moneyRange(data().earnings.royaltyPkn, data().earnings.royaltyEurCents)}</dd></div>
            </dl>
          </DeskPanel>
        </div>
        <DeskPanel
          flush
          title={`Qualifying orders${data().earnings.orders.length ? ` · ${data().earnings.qualifyingOrders}` : ''}`}
          class="associate-orders"
        >
          <Show
            when={data().earnings.orders.length}
            fallback={(
              <p class="page-lede associate-empty-orders">
                No qualifying sales yet. Every Italian-domestic order that lands while the campaign is live shows up here with your cut.
              </p>
            )}
          >
            <div class="associate-order-list">
              <For each={data().earnings.orders}>
                {(row) => (
                  <article class="associate-order">
                    <span class="associate-order-main">
                      <strong>{row.date}</strong>
                      <span class="associate-order-meta">
                        {row.orderId.slice(0, 12)} · {row.buyer} · {row.sellers} seller{row.sellers === 1 ? '' : 's'}
                      </span>
                    </span>
                    <span class="associate-order-money">
                      <span>sale {row.currency === 'EUR' ? eur(row.gross) : pkn(row.gross)}</span>
                      <span>royalty {row.currency === 'EUR' ? eur(row.royalty) : pkn(row.royalty)}</span>
                      <strong>you {row.currency === 'EUR' ? eur(row.earning) : pkn(row.earning)}</strong>
                    </span>
                  </article>
                )}
              </For>
            </div>
          </Show>
        </DeskPanel>
        <Show when={props.overview}><AssociatesOverview overview={props.overview} onView={props.onView} /></Show>
      </div>
    </Show>
  );
}

function PreviewDesk(props) {
  const [viewingEmail, setViewingEmail] = createSignal('');
  const role = () => props.params.role;
  if (untrack(role) === 'admin') {
    const fixtureOverview = [
      { associate: PREVIEW_FIXTURE.associate, window: PREVIEW_FIXTURE.window, earnings: PREVIEW_FIXTURE.earnings },
      {
        associate: { ...PREVIEW_FIXTURE.associate, email: 'apciliberti@gmail.com', role: 'founder_ambassador', displayName: 'Andrea Paolo' },
        window: PREVIEW_FIXTURE.window,
        earnings: { ...PREVIEW_FIXTURE.earnings, qualifyingOrders: 2, earningPkn: 21.3, earningEurCents: 612 },
      },
    ];
    const viewing = () => fixtureOverview.find((row) => row.associate.email === viewingEmail());
    return (
      <Show when={viewing()} fallback={<AdminOverviewView data={{ admin: true, overview: fixtureOverview }} onView={setViewingEmail} />}>
        {(row) => <AdminViewingView row={row()} onBack={() => setViewingEmail('')} />}
      </Show>
    );
  }
  const fixture = () => ({
    ...PREVIEW_FIXTURE,
    associate: {
      ...PREVIEW_FIXTURE.associate,
      ...(ROLES[role()] && role() !== 'associate' ? { role: role() } : {}),
      ...(isFounderRole(role()) ? { displayName: 'Andrea Paolo' } : {}),
    },
  });
  return <AssociateView data={fixture()} preview />;
}

function AssociateDesk() {
  const [data, setData] = createSignal(null);
  const [notAssociate, setNotAssociate] = createSignal(false);
  const [error, setError] = createSignal('');
  const [viewingEmail, setViewingEmail] = createSignal('');

  createEffect(signedIn, (on) => {
    if (!on) return undefined;
    let cancelled = false;
    setData(null);
    setNotAssociate(false);
    setError('');
    getBearer()
      .then((token) => fetchAssociateSummary(token))
      .then((payload) => {
        if (!cancelled) setData(() => payload);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err?.statusCode === 403 || /associate/i.test(String(err?.message || ''))) setNotAssociate(true);
        else setError(err?.message || 'The associate desk is unreachable right now.');
      });
    return () => {
      cancelled = true;
    };
  });

  const viewing = () => (viewingEmail() && data()?.overview
    ? data().overview.find((row) => row.associate.email === viewingEmail())
    : null);

  return (
    <Switch>
      <Match when={notAssociate()}>
        <div class="page desk">
          <PageHead kicker="Pokoin Associates" title="Associate desk" />
          <EmptyDesk
            title="This desk is by invitation"
            lede="Pokoin Associates is a partner program. If you were promised a desk here, contact admin@pokoin.com to be added to the roster, then reload."
          >
            <a class="btn ghost" href="mailto:admin@pokoin.com?subject=Pokoin%20Associates">Contact admin@pokoin.com</a>
            <a class="btn" href="/marketplace">Back to the marketplace</a>
          </EmptyDesk>
        </div>
      </Match>
      <Match when={error()}>
        <div class="page desk">
          <PageHead kicker="Pokoin Associates" title="Associate desk" />
          <Alert>{error()}</Alert>
        </div>
      </Match>
      <Match when={!data()}>
        <div class="page desk associate-page">
          <PageHead kicker="Pokoin Associates" title="Your earnings" />
          <DeskPanel title="Loading your desk"><div class="skeleton-line" /><div class="skeleton-line" /></DeskPanel>
        </div>
      </Match>
      <Match when={data().admin && data().overview && viewing()}>
        <AdminViewingView row={viewing()} onBack={() => setViewingEmail('')} />
      </Match>
      <Match when={data().admin && data().overview && !data().associate}>
        <AdminOverviewView data={data()} onView={setViewingEmail} />
      </Match>
      <Match when={data().admin && data().overview}>
        <AssociateView data={data()} overview={data().overview} onView={setViewingEmail} />
      </Match>
      <Match when={true}>
        <AssociateView data={data()} />
      </Match>
    </Switch>
  );
}

/** /associate. `?associatePreview` (dev/localhost) shows fixtures. */
export default function Associate() {
  const [params] = useSearchParams();
  document.title = 'Associate · Pokoin';
  return (
    <Show when={!allowLayoutPreview(params)} fallback={<PreviewDesk params={params} />}>
      <SignedIn from="/associate">
        <AssociateDesk />
      </SignedIn>
    </Show>
  );
}
