import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import {
  AMBASSADOR_CONTACT,
  AMBASSADOR_MISSIONS_TO_UNLOCK,
  COMPARISON,
  PERKS,
  applyMailto,
} from '../ambassador-program.js';
import { COLLECTOR_PROGRESS, REFERRAL_REWARD_PKN } from '../referral.js';
import { useReferral } from '../use-referral.js';
import { MissionGrid, TierLadder, TrainerCard } from '../components/AmbassadorProgress.jsx';
import { brandSrc } from '../brand-assets.js';
import '../referral.css';

/** pokoin.com/ambassadorprogram — public; signed-in visitors see their progress. */
export default function AmbassadorProgram() {
  const { signedIn } = useAuth();
  const { data, code } = useReferral({ enabled: signedIn });

  useEffect(() => {
    document.title = 'Ambassador program · Pokoin';
  }, []);

  // Signed in: the trainer card paints at once (cached or Collector), then refreshes.
  const progress = data?.ambassador || (signedIn ? COLLECTOR_PROGRESS : null);

  return (
    <div className="page referral-page amb-page">
      <section className="referral-hero is-ambassador">
        <div className="referral-hero-copy">
          <p className="referral-kicker">Pokoin Ambassador program</p>
          <h1>Level up the Pokoin community.</h1>
          <p className="referral-lede">
            Ambassadors are the collectors who make Pokoin better: they bring people in, make content,
            report what is broken, help sellers start and run events. Complete {AMBASSADOR_MISSIONS_TO_UNLOCK} missions to unlock the badge.
          </p>
          <div className="referral-cta-row">
            <a className="btn" href={applyMailto(code)}>Apply to be an Ambassador</a>
            {signedIn ? <Link className="btn ghost" to="/invite">Your invite link</Link> : <Link className="btn ghost" to="/auth?from=%2Fambassadorprogram">Sign in to track progress</Link>}
          </div>
        </div>
        <img className="referral-hero-art" src={brandSrc('pokoin-mascot.svg')} alt="" aria-hidden="true" />
      </section>

      {progress ? <TrainerCard progress={progress} username={code} /> : null}

      <section className="amb-section">
        <h2>Three ways to grow with Pokoin</h2>
        <div className="amb-compare" role="table" aria-label="Referral, Ambassador and Distributor compared">
          <div className="amb-compare-row is-head" role="row">
            <span role="columnheader" />
            <span role="columnheader">Invite &amp; Earn</span>
            <span role="columnheader" className="is-amb">Ambassador</span>
            <span role="columnheader">Distributor</span>
          </div>
          {COMPARISON.map((row) => (
            <div className="amb-compare-row" role="row" key={row.label}>
              <span role="rowheader">{row.label}</span>
              <span role="cell">{row.referral}</span>
              <span role="cell" className="is-amb">{row.ambassador}</span>
              <span role="cell">{row.distributor}</span>
            </div>
          ))}
        </div>
        <p className="referral-fine">
          Invite &amp; Earn is open to everyone: {REFERRAL_REWARD_PKN} PKN for you and your friend after their first purchase or sale.
          Distributors are commercial partners by agreement.
        </p>
      </section>

      <section className="amb-section">
        <h2>Missions</h2>
        <p className="amb-section-lede">Complete any {AMBASSADOR_MISSIONS_TO_UNLOCK} to become an Ambassador. The Pokoin team verifies each one; referrals count themselves.</p>
        <MissionGrid
          completed={progress ? progress.completed : null}
          activatedReferrals={progress?.activatedReferrals || 0}
          referralTarget={progress?.referralTarget || 3}
        />
      </section>

      {!progress ? (
        <section className="amb-section">
          <h2>Your path</h2>
          <TierLadder tier="collector" />
        </section>
      ) : null}

      <section className="amb-section">
        <h2>Perks</h2>
        <ul className="amb-perks">
          {PERKS.map((perk) => (
            <li key={perk.title}>
              <strong>{perk.title}</strong>
              <span>{perk.text}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="referral-ambassador-cta">
        <div>
          <strong>Done a mission already?</strong>
          <span>Send the link or details to {AMBASSADOR_CONTACT} and we will verify it on your progress.</span>
        </div>
        <a className="btn" href={applyMailto(code)}>Contact {AMBASSADOR_CONTACT}</a>
      </section>
    </div>
  );
}
