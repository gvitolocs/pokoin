import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { claimReferral } from '../api.js';
import { useAuth } from '../auth.jsx';
import {
  claimIsFinal,
  forgetReferralCode,
  pendingReferralCode,
  referralCodeFromLocation,
  rememberReferralCode,
} from '../referral.js';

/**
 * Invite & Earn plumbing, mounted once in the app shell: remember the code
 * from /join/<code> or ?ref=<code>, then claim it once the visitor is signed
 * in. The server decides whether the account is new enough to count.
 */
export default function ReferralClaimer() {
  const { pathname, search } = useLocation();
  const { ready, user, getBearer } = useAuth();
  const inFlight = useRef(false);

  useEffect(() => {
    const code = referralCodeFromLocation(pathname, search);
    if (code) rememberReferralCode(code);
  }, [pathname, search]);

  useEffect(() => {
    if (!ready || !user || inFlight.current) return;
    const code = pendingReferralCode();
    if (!code) return;
    inFlight.current = true;
    getBearer()
      .then((token) => claimReferral(token, code))
      .then(() => forgetReferralCode())
      .catch((error) => {
        if (claimIsFinal(error)) forgetReferralCode();
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, [ready, user, getBearer, pathname]);

  return null;
}
