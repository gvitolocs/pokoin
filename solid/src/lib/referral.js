import { createEffect, createSignal } from 'solid-js';
import { fetchReferral } from '@market/api.js';
import { cleanReferralCode, readReferralCache, writeReferralCache } from '@market/referral.js';
import { accountProfile } from '../stores/account.js';
import { authUid, getBearer, signedIn } from '../stores/auth.js';
import { authSession } from '../stores/session.js';

/**
 * Invite & Earn + ambassador progress for the signed-in account
 * (market/src/use-referral.js): cached answer first (instant paint), then a
 * fresh fetch. `enabled` is an accessor.
 */
export function createReferral(enabled = () => true) {
  const uid = () => authUid() || accountProfile()?.uid || authSession()?.uid || '';
  const [data, setData] = createSignal(null);
  const [error, setError] = createSignal('');

  createEffect(
    () => (enabled() ? uid() : ''),
    (id) => {
      if (id && !data()) setData(() => readReferralCache(id));
    },
  );

  createEffect(
    () => enabled() && signedIn(),
    (on) => {
      if (!on) return undefined;
      let cancelled = false;
      getBearer()
        .then((token) => fetchReferral(token))
        .then((payload) => {
          if (cancelled) return;
          setData(() => payload);
          setError('');
          writeReferralCache(uid(), payload);
        })
        .catch((err) => {
          if (!cancelled) setError(err?.message || 'Invite & Earn is unreachable right now.');
        });
      return () => {
        cancelled = true;
      };
    },
  );

  return {
    data,
    error,
    code: () => cleanReferralCode(data()?.code || accountProfile()?.username),
  };
}
