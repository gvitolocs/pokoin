// Firebase app + auth for the web SPA. Firestore (with re2js and webchannel,
// ~430 KB) is never imported statically: loadFirestore() pulls it on first use
// so it stays off the entry chunk.

import { initializeApp } from 'firebase/app';
import { getAuth, initializeAuth, inMemoryPersistence } from 'firebase/auth';
import { framedByChromeExtension } from './extension-auth-bridge.js';

/**
 * Sign-in stays on pokoin.firebaseapp.com. pokoin.com is static files and does
 * not proxy /__/auth. The app origin remains an authorized Firebase domain.
 */
const FIRST_PARTY_AUTH_HOSTS = new Set();

function firebaseAuthDomain() {
  const host = typeof window === 'undefined' ? '' : String(window.location.hostname || '').toLowerCase();
  return FIRST_PARTY_AUTH_HOSTS.has(host) ? host : 'pokoin.firebaseapp.com';
}

/** Same public web config as Flutter `DefaultFirebaseOptions.web`, except authDomain. */
export const firebaseApp = initializeApp({
  apiKey: 'AIzaSyDlbKXeR0R3aAATZtCG6dhEPUw39DhXQpU',
  authDomain: firebaseAuthDomain(),
  projectId: 'pokoin',
  storageBucket: 'pokoin.firebasestorage.app',
  messagingSenderId: '36941064114',
  appId: '1:36941064114:web:e6ca84f2723df9ee71e6ab',
});

function createFirebaseAuth(app) {
  if (typeof window !== 'undefined' && framedByChromeExtension()) {
    try {
      return initializeAuth(app, { persistence: inMemoryPersistence });
    } catch (_) {
      return getAuth(app);
    }
  }
  return getAuth(app);
}

export const firebaseAuth = createFirebaseAuth(firebaseApp);

let firestoreModule = null;

/**
 * The Firestore instance plus the SDK functions the app uses, from one
 * memoised dynamic import. A failed chunk load is forgotten so the next call
 * retries.
 */
export function loadFirestore() {
  if (!firestoreModule) {
    firestoreModule = import('firebase/firestore').then(
      ({ collection, doc, getDocs, getFirestore, onSnapshot, query, where }) => ({
        firestore: getFirestore(firebaseApp),
        collection,
        doc,
        getDocs,
        onSnapshot,
        query,
        where,
      }),
      (err) => {
        firestoreModule = null;
        throw err;
      },
    );
  }
  return firestoreModule;
}
