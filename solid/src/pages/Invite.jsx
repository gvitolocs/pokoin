import { createSignal, For, Show } from 'solid-js';
import { formatPknNumber } from '@market/api.js';
import {
  INVITE_STATUS_LABEL,
  REFERRAL_CLAIM_WINDOW_DAYS,
  REFERRAL_REWARD_PKN,
  inviteLink,
} from '@market/referral.js';
import '@market/referral.css';
import { Alert, DeskPanel } from '../components/Desk.jsx';
import SignedIn from '../components/SignedIn.jsx';
import { createReferral } from '../lib/referral.js';
import { signedIn } from '../stores/auth.js';

const STEPS = [
  { title: 'Share your link', text: 'Send pokoin.com/join/you to a friend who collects.' },
  { title: 'They join', text: `They create a Pokoin account within ${REFERRAL_CLAIM_WINDOW_DAYS} days of opening it.` },
  { title: 'First deal', text: 'They complete their first purchase or first sale.' },
  { title: `+${REFERRAL_REWARD_PKN} PKN each`, text: 'Pokoin pays you both, straight into your site balance.' },
];

function shortDate(iso) {
  const parsed = new Date(iso || '');
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function ShareLink(props) {
  const [copied, setCopied] = createSignal(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (_) {
      setCopied(false);
    }
  };
  const share = async () => {
    try {
      await navigator.share({ title: 'Join me on Pokoin', text: `Join Pokoin with my link — we both get ${REFERRAL_REWARD_PKN} PKN.`, url: props.link });
    } catch (_) {
      // Share sheet dismissed.
    }
  };
  return (
    <div class="referral-link">
      <input readOnly value={props.link} aria-label="Your invite link" onFocus={(event) => event.target.select()} />
      <button type="button" class="btn" onClick={copy}>{copied() ? 'Copied' : 'Copy link'}</button>
      <Show when={typeof navigator !== 'undefined' && navigator.share}>
        <button type="button" class="btn ghost" onClick={share}>Share</button>
      </Show>
    </div>
  );
}

function InviteDesk() {
  const { data, error, code } = createReferral(signedIn);
  const link = () => inviteLink(code());
  const stats = () => data()?.stats || { invited: 0, pending: 0, activated: 0, earnedPkn: 0 };

  return (
    <div class="page referral-page">
      <section class="referral-hero">
        <div class="referral-hero-copy">
          <p class="referral-kicker">Invite &amp; Earn</p>
          <h1>Bring a collector. You both get {REFERRAL_REWARD_PKN} PKN.</h1>
          <p class="referral-lede">
            When someone joins with your link and completes a first purchase or a first sale,
            Pokoin pays {REFERRAL_REWARD_PKN} PKN to each of you.
          </p>
          <Show when={error() && !data()}><Alert>{error()}</Alert></Show>
          <Show when={!link() && !data() && !error()}><div class="referral-link is-loading"><div class="skeleton-line" /></div></Show>
          <Show when={link()}><ShareLink link={link()} /></Show>
          <Show when={data() && !link()}>
            <Alert>
              Your invite link is your Pokoin username. <a href="/profile">Pick a username on your profile</a> to get one.
            </Alert>
          </Show>
        </div>
        <dl class="referral-stats">
          <div><dt>Invited</dt><dd>{stats().invited}</dd></div>
          <div><dt>Activated</dt><dd>{stats().activated}</dd></div>
          <div><dt>Earned</dt><dd>{formatPknNumber(stats().earnedPkn)} <small>PKN</small></dd></div>
        </dl>
      </section>

      <Show when={data()?.referredBy}>
        {(by) => (
          <p class="referral-banner">
            You joined with @{by().username}&rsquo;s link.{' '}
            {by().status === 'rewarded'
              ? `You both received ${REFERRAL_REWARD_PKN} PKN.`
              : `Make your first purchase or sale and you both get ${REFERRAL_REWARD_PKN} PKN.`}
          </p>
        )}
      </Show>

      <ol class="referral-steps">
        <For each={STEPS}>
          {(step, index) => (
            <li>
              <span class="referral-step-n">{index() + 1}</span>
              <strong>{step.title}</strong>
              <span>{step.text}</span>
            </li>
          )}
        </For>
      </ol>

      <DeskPanel flush title={`Your invites${stats().invited ? ` · ${stats().invited}` : ''}`} class="referral-list-panel">
        <Show
          when={data()?.invited?.length}
          fallback={<p class="page-lede referral-empty">No invites yet. Share your link — invites show up here as soon as someone joins.</p>}
        >
          <ul class="referral-list">
            <For each={data().invited}>
              {(row) => (
                <li class={`is-${row.status}`}>
                  <span class="referral-list-who">
                    <strong>@{row.username || 'collector'}</strong>
                    <span>
                      Joined {shortDate(row.claimedAt)}
                      {row.rewardedAt ? ` · first ${row.kind === 'sale' ? 'sale' : 'purchase'} ${shortDate(row.rewardedAt)}` : ''}
                    </span>
                  </span>
                  <span class="referral-list-status">{INVITE_STATUS_LABEL[row.status] || row.status}</span>
                  <strong class="referral-list-earned">{row.earnedPkn ? `+${formatPknNumber(row.earnedPkn)} PKN` : '—'}</strong>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </DeskPanel>

      <section class="referral-ambassador-cta">
        <div>
          <strong>Want to do more for the community?</strong>
          <span>Become a Pokoin Ambassador: complete missions, level up, unlock perks.</span>
        </div>
        <a class="btn ghost" href="/ambassadorprogram">Ambassador program</a>
      </section>

      <p class="referral-fine">
        Rules: the invited account must be new (created within {REFERRAL_CLAIM_WINDOW_DAYS} days) and must not have bought or sold before.
        Orders between you and the person you invited do not count. Rewards are paid once per invited collector,
        from the Pokoin treasury, and appear in your balance and ledger.
      </p>
    </div>
  );
}

/** /invite (market/src/pages/Invite.jsx). The session hint paints before Firebase answers. */
export default function Invite() {
  document.title = 'Invite & Earn · Pokoin';
  return (
    <SignedIn early from="/invite">
      <InviteDesk />
    </SignedIn>
  );
}
