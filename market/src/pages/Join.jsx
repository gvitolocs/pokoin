import { useEffect } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { REFERRAL_CLAIM_WINDOW_DAYS, REFERRAL_REWARD_PKN, cleanReferralCode, rememberReferralCode } from '../referral.js';
import { brandSrc } from '../brand-assets.js';
import '../referral.css';

/** pokoin.com/join/<username> — the landing an invite link opens. */
export default function Join() {
  const { code: raw } = useParams();
  const code = cleanReferralCode(raw);
  const { ready, user } = useAuth();

  useEffect(() => {
    document.title = code ? `@${code} invited you · Pokoin` : 'Join Pokoin';
    if (code) rememberReferralCode(code);
  }, [code]);

  // Signed in already: ReferralClaimer claims the code; show the invite desk.
  if (ready && user) return <Navigate to="/invite" replace />;

  return (
    <div className="page referral-page">
      <section className="referral-hero is-join">
        <div className="referral-hero-copy">
          <p className="referral-kicker">Invite &amp; Earn</p>
          <h1>{code ? <>@{code} invited you to Pokoin</> : 'Join Pokoin'}</h1>
          <p className="referral-lede">
            Create your account, then make your first purchase or your first sale.
            You both get <strong>{REFERRAL_REWARD_PKN} PKN</strong>.
          </p>
          <div className="referral-cta-row">
            <Link className="btn" to={`/auth?mode=signup&from=${encodeURIComponent('/invite')}`}>Create your account</Link>
            <Link className="btn ghost" to="/marketplace">Browse the marketplace</Link>
          </div>
          <p className="referral-fine">
            Works for accounts created in the next {REFERRAL_CLAIM_WINDOW_DAYS} days that have not bought or sold on Pokoin yet.
          </p>
        </div>
        <img className="referral-hero-art" src={brandSrc('pokoin-mascot.svg')} alt="" aria-hidden="true" />
      </section>
    </div>
  );
}
