import { useEffect, useRef, useState } from 'react';
import { fetchReferral } from './api.js';
import { useAuth } from './auth.jsx';
import { cleanReferralCode, readReferralCache, writeReferralCache } from './referral.js';

/**
 * Invite & Earn + ambassador progress for the signed-in account:
 * cached answer first (instant paint), then a fresh fetch.
 */
export function useReferral({ enabled = true } = {}) {
  const { signedIn, user, profile, getBearer } = useAuth();
  const uid = user?.uid || profile?.uid || '';
  const uidRef = useRef(uid);
  uidRef.current = uid;
  const [data, setData] = useState(() => (enabled ? readReferralCache(uid) : null));
  const [error, setError] = useState('');

  useEffect(() => {
    if (!enabled || !uid) return;
    setData((current) => current || readReferralCache(uid));
  }, [enabled, uid]);

  useEffect(() => {
    if (!enabled || !signedIn) return undefined;
    let cancelled = false;
    getBearer()
      .then((token) => fetchReferral(token))
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
        setError('');
        writeReferralCache(uidRef.current, payload);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || 'Invite & Earn is unreachable right now.');
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, signedIn, getBearer]);

  return {
    data,
    error,
    code: cleanReferralCode(data?.code || profile?.username),
    fresh: Boolean(data) && !error,
  };
}
