import { For, Show } from 'solid-js';
import {
  AMBASSADOR_CONTACT,
  AMBASSADOR_MISSIONS_TO_UNLOCK,
  COMPARISON,
  PERKS,
  applyMailto,
} from '@market/ambassador-program.js';
import { brandSrc } from '@market/brand-assets.js';
import { COLLECTOR_PROGRESS, REFERRAL_REWARD_PKN } from '@market/referral.js';
import '@market/referral.css';
import { MissionGrid, TierLadder, TrainerCard } from '../components/AmbassadorProgress.jsx';
import AuthLink from '../components/AuthLink.jsx';
import { createReferral } from '../lib/referral.js';
import { signedIn } from '../stores/auth.js';

/** pokoin.com/ambassadorprogram — public; signed-in visitors see their progress (market/src/pages/AmbassadorProgram.jsx). */
export default function AmbassadorProgram() {
  const { data, code } = createReferral(signedIn);
  document.title = 'Ambassador program · Pokoin';

  // Signed in: the trainer card paints at once (cached or Collector), then refreshes.
  const progress = () => data()?.ambassador || (signedIn() ? COLLECTOR_PROGRESS : null);

  return (
    <div class="page referral-page amb-page">
      <section class="referral-hero is-ambassador">
        <div class="referral-hero-copy">
          <p class="referral-kicker">Pokoin Ambassador program</p>
          <h1>Level up the Pokoin community.</h1>
          <p class="referral-lede">
            Ambassadors are the collectors who make Pokoin better: they bring people in, make content,
            report what is broken, help sellers start and run events. Complete {AMBASSADOR_MISSIONS_TO_UNLOCK} missions to unlock the badge.
          </p>
          <div class="referral-cta-row">
            <a class="btn" href={applyMailto(code())}>Apply to be an Ambassador</a>
            <Show
              when={signedIn()}
              fallback={<AuthLink class="btn ghost" to="/auth?from=%2Fambassadorprogram">Sign in to track progress</AuthLink>}
            >
              <a class="btn ghost" href="/invite">Your invite link</a>
            </Show>
          </div>
        </div>
        <img class="referral-hero-art" src={brandSrc('pokoin-mascot.svg')} alt="" aria-hidden="true" />
      </section>

      <Show when={progress()}>{(value) => <TrainerCard progress={value()} username={code()} />}</Show>

      <section class="amb-section">
        <h2>Three ways to grow with Pokoin</h2>
        <div class="amb-compare" role="table" aria-label="Referral, Ambassador and Distributor compared">
          <div class="amb-compare-row is-head" role="row">
            <span role="columnheader" />
            <span role="columnheader">Invite &amp; Earn</span>
            <span role="columnheader" class="is-amb">Ambassador</span>
            <span role="columnheader">Distributor</span>
          </div>
          <For each={COMPARISON}>
            {(row) => (
              <div class="amb-compare-row" role="row">
                <span role="rowheader">{row.label}</span>
                <span role="cell">{row.referral}</span>
                <span role="cell" class="is-amb">{row.ambassador}</span>
                <span role="cell">{row.distributor}</span>
              </div>
            )}
          </For>
        </div>
        <p class="referral-fine">
          Invite &amp; Earn is open to everyone: {REFERRAL_REWARD_PKN} PKN for you and your friend after their first purchase or sale.
          Distributors are commercial partners by agreement.
        </p>
      </section>

      <section class="amb-section">
        <h2>Missions</h2>
        <p class="amb-section-lede">Complete any {AMBASSADOR_MISSIONS_TO_UNLOCK} to become an Ambassador. The Pokoin team verifies each one; referrals count themselves.</p>
        <MissionGrid
          completed={progress() ? progress().completed : null}
          activatedReferrals={progress()?.activatedReferrals || 0}
          referralTarget={progress()?.referralTarget || 3}
        />
      </section>

      <Show when={!progress()}>
        <section class="amb-section">
          <h2>Your path</h2>
          <TierLadder tier="collector" />
        </section>
      </Show>

      <section class="amb-section">
        <h2>Perks</h2>
        <ul class="amb-perks">
          <For each={PERKS}>
            {(perk) => (
              <li>
                <strong>{perk.title}</strong>
                <span>{perk.text}</span>
              </li>
            )}
          </For>
        </ul>
      </section>

      <section class="referral-ambassador-cta">
        <div>
          <strong>Done a mission already?</strong>
          <span>Send the link or details to {AMBASSADOR_CONTACT} and we will verify it on your progress.</span>
        </div>
        <a class="btn" href={applyMailto(code())}>Contact {AMBASSADOR_CONTACT}</a>
      </section>
    </div>
  );
}
