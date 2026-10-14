import { createEffect, Show } from 'solid-js';
import { useNavigate, useParams } from '@solidjs/router';
import { brandSrc } from '@market/brand-assets.js';
import { REFERRAL_CLAIM_WINDOW_DAYS, REFERRAL_REWARD_PKN, cleanReferralCode, rememberReferralCode } from '@market/referral.js';
import '@market/referral.css';
import AuthLink from '../components/AuthLink.jsx';
import { authConfirmed, authUser, loadAuth } from '../stores/auth.js';

/** pokoin.com/join/<username> — the landing an invite link opens. */
export default function Join() {
  const params = useParams();
  const navigate = useNavigate();
  const code = () => cleanReferralCode(params.code);
  loadAuth().catch(() => {});

  createEffect(code, (value) => {
    document.title = value ? `@${value} invited you · Pokoin` : 'Join Pokoin';
    if (value) rememberReferralCode(value);
  });
  // Signed in already: the referral claimer claims the code; show the invite desk.
  createEffect(
    () => authConfirmed() && Boolean(authUser()),
    (inside) => {
      if (inside) navigate('/invite', { replace: true });
    },
  );

  return (
    <div class="page referral-page">
      <section class="referral-hero is-join">
        <div class="referral-hero-copy">
          <p class="referral-kicker">Invite &amp; Earn</p>
          <h1><Show when={code()} fallback="Join Pokoin">@{code()} invited you to Pokoin</Show></h1>
          <p class="referral-lede">
            Create your account, then make your first purchase or your first sale.
            You both get <strong>{REFERRAL_REWARD_PKN} PKN</strong>.
          </p>
          <div class="referral-cta-row">
            <AuthLink class="btn" to={`/auth?mode=signup&from=${encodeURIComponent('/invite')}`}>Create your account</AuthLink>
            <a class="btn ghost" href="/marketplace">Browse the marketplace</a>
          </div>
          <p class="referral-fine">
            Works for accounts created in the next {REFERRAL_CLAIM_WINDOW_DAYS} days that have not bought or sold on Pokoin yet.
          </p>
        </div>
        <img class="referral-hero-art" src={brandSrc('pokoin-mascot.svg')} alt="" aria-hidden="true" />
      </section>
    </div>
  );
}
