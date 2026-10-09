import { createEffect } from 'solid-js';
import { claimReferral } from '@market/api.js';
import {
  claimIsFinal,
  forgetReferralCode,
  pendingReferralCode,
  referralCodeFromLocation,
  rememberReferralCode,
} from '@market/referral.js';
import { authUser, getBearer } from '../stores/auth.js';

/**
 * Invite & Earn plumbing (market/src/components/ReferralClaimer.jsx), set up
 * once by the app shell: remember the code from /join/<code> or ?ref=<code>,
 * then claim it once Firebase confirms a signed-in visitor. The server decides
 * whether the account is new enough to count.
 */
export function watchReferralClaims(location) {
  let inFlight = false;
  createEffect(
    () => [location.pathname, location.search],
    ([pathname, search]) => {
      const code = referralCodeFromLocation(pathname, search);
      if (code) rememberReferralCode(code);
    },
  );
  createEffect(
    () => [authUser(), location.pathname],
    ([user]) => {
      if (!user || inFlight) return;
      const code = pendingReferralCode();
      if (!code) return;
      inFlight = true;
      getBearer()
        .then((token) => claimReferral(token, code))
        .then(() => forgetReferralCode())
        .catch((error) => {
          if (claimIsFinal(error)) forgetReferralCode();
        })
        .finally(() => {
          inFlight = false;
        });
    },
  );
}
