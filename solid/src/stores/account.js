import { createEffect, createSignal } from 'solid-js';
import { profileFromSession, writeAuthSession } from '@market/auth-session.js';
import { whenIdle } from '../lib/idle.js';
import { authUser, getBearer, signedIn } from './auth.js';
import { authSession, refreshSession } from './session.js';

/**
 * Who is signed in, for the header (avatar, PKN chip, menu account card):
 * the React AuthProvider's profile + availablePkn and WalletProvider's
 * balance. First paint reads the cached session (`pokoin.auth.session`);
 * after it, one REST read of users/{uid} + balances/{uid}
 * (market/src/firestore-rest.js — the same read React's extension desk
 * uses) refreshes them without the Firestore SDK, and again whenever the
 * tab comes back. The fresh values are persisted to the session like React.
 * The readers (REST, profile shaping, wallet RPC) load with that first read.
 */
const [live, setLive] = createSignal(null);
const [chainBalance, setChainBalance] = createSignal(0);

/** market/src/wallet-chain.js WALLET_ADDRESS_KEY, read without loading that module. */
function savedWalletAddress() {
  try {
    return localStorage.getItem('pokoin.walletAddress') || '';
  } catch (_) {
    return '';
  }
}

function currentUid() {
  return String(authUser()?.uid || authSession()?.uid || '');
}

/** useAuth().profile: the users/{uid} doc once read, else the session hint. */
export function accountProfile() {
  if (!signedIn()) return null;
  const doc = live();
  const uid = currentUid();
  if (doc && doc.uid === uid) return doc.profile;
  return profileFromSession(authSession());
}

/** useAuth().availablePkn. */
export function availablePkn() {
  const doc = live();
  if (doc && doc.uid === currentUid()) return doc.availablePkn;
  return Number(authSession()?.availablePkn) || 0;
}

export const accountAdmin = () => Boolean(accountProfile()?.admin);
export const accountSilver = () => Boolean(accountProfile()?.silver);

/** Chrome's chip: the member's spendable Site PKN; signed out, a connected wallet's balance. */
export function pknAmount() {
  if (signedIn()) {
    const pkn = availablePkn();
    if (Number.isFinite(pkn)) return pkn;
  }
  const balance = chainBalance();
  return Number.isFinite(balance) ? balance : 0;
}

let reading = null;
async function readAccount() {
  const token = await getBearer().catch(() => '');
  const uid = currentUid();
  if (!token || !uid || !signedIn()) return;
  const [{ fetchDeskUserDocuments }, { profileFrom }] = await Promise.all([
    import('@market/firestore-rest.js'),
    import('@market/auth-profile.js'),
  ]);
  const docs = await fetchDeskUserDocuments(uid, token);
  if (uid !== currentUid()) return;
  const profile = profileFrom(docs.user || {}, uid);
  const pkn = Number(docs.balance?.availablePkn || 0);
  setLive({ uid, profile, availablePkn: pkn });
  writeAuthSession({
    uid,
    signedIn: true,
    admin: profile.admin,
    silver: profile.silver,
    silverUntil: profile.silverUntil,
    availablePkn: pkn,
    photoUrl: profile.photoUrl,
  });
  refreshSession();
}

export function refreshAccount() {
  if (!reading) {
    reading = readAccount().catch(() => {}).finally(() => {
      reading = null;
    });
  }
  return reading;
}

/**
 * Call once from the app shell (needs an owner). Signed in: read the account
 * after the first paint and on every return to the tab (listener only while
 * signed in). Signed out with a connected wallet: read its chain balance.
 */
export function watchAccount() {
  createEffect(signedIn, (on) => {
    if (!on) {
      setLive(null);
      let live = true;
      const cancel = whenIdle(async () => {
        // The wallet module (and its RPC) loads only for a browser that connected one.
        if (!savedWalletAddress()) {
          setChainBalance(0);
          return;
        }
        const { fetchWalletBalance, readWalletAddress } = await import('@market/wallet-chain.js');
        const address = readWalletAddress().toLowerCase();
        const balance = address ? await fetchWalletBalance(address).then((next) => next.balance, () => 0) : 0;
        if (live) setChainBalance(balance);
      });
      return () => {
        live = false;
        cancel();
      };
    }
    const cancel = whenIdle(() => refreshAccount());
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshAccount();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancel();
      document.removeEventListener('visibilitychange', onVisible);
    };
  });
}
