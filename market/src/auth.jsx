import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged } from 'firebase/auth';
import { doc, getFirestore, onSnapshot } from 'firebase/firestore';

/** Same public web config as Flutter `DefaultFirebaseOptions.web`. */
const firebaseApp = initializeApp({
  apiKey: 'AIzaSyDlbKXeR0R3aAATZtCG6dhEPUw39DhXQpU',
  authDomain: 'pokoin.firebaseapp.com',
  projectId: 'pokoin',
  storageBucket: 'pokoin.firebasestorage.app',
  messagingSenderId: '36941064114',
  appId: '1:36941064114:web:e6ca84f2723df9ee71e6ab',
});

export const firebaseAuth = getAuth(firebaseApp);
export const firestore = getFirestore(firebaseApp);

export function sellerNameOf(user) {
  if (!user) {
    return 'Pokoin seller';
  }
  return user.displayName || user.email || 'Pokoin seller';
}

export async function getBearer(forceRefresh = false) {
  const user = firebaseAuth.currentUser;
  if (!user) {
    return '';
  }
  return user.getIdToken(forceRefresh);
}

function readDate(value) {
  if (!value) {
    return null;
  }
  if (typeof value.toDate === 'function') {
    return value.toDate();
  }
  if (typeof value.seconds === 'number') {
    return new Date(value.seconds * 1000);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function profileFrom(data = {}, uid = '') {
  const role = String(data.role || '').trim().toLowerCase();
  const roles = Array.isArray(data.roles) ? data.roles.map((row) => String(row).toLowerCase()) : [];
  const admin = data.admin === true || data.isAdmin === true || role === 'admin' || roles.includes('admin');
  const silverUntil = readDate(data.silverUntil);
  const silver = admin || role === 'silver' || (silverUntil && silverUntil.getTime() > Date.now());
  return {
    uid,
    username: data.username || '',
    role: data.role || '',
    admin,
    silver,
    silverUntil,
  };
}

const AuthContext = createContext({
  user: null,
  ready: false,
  signedIn: false,
  sellerName: 'Pokoin seller',
  profile: null,
  availablePkn: 0,
  admin: false,
  silver: false,
  getBearer,
});

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [profile, setProfile] = useState(null);
  const [availablePkn, setAvailablePkn] = useState(0);

  useEffect(() => onAuthStateChanged(firebaseAuth, (next) => {
    setUser(next);
    setReady(true);
    if (!next) {
      setProfile(null);
      setAvailablePkn(0);
    }
  }), []);

  useEffect(() => {
    if (!user?.uid) {
      return undefined;
    }
    const unsubUser = onSnapshot(doc(firestore, 'users', user.uid), (snap) => {
      setProfile(profileFrom(snap.data() || {}, user.uid));
    }, () => setProfile(profileFrom({}, user.uid)));
    const unsubBal = onSnapshot(doc(firestore, 'balances', user.uid), (snap) => {
      setAvailablePkn(Number(snap.data()?.availablePkn || 0));
    }, () => setAvailablePkn(0));
    return () => {
      unsubUser();
      unsubBal();
    };
  }, [user?.uid]);

  const value = useMemo(() => ({
    user,
    ready,
    signedIn: Boolean(user),
    sellerName: sellerNameOf(user),
    profile,
    availablePkn,
    admin: Boolean(profile?.admin),
    silver: Boolean(profile?.silver),
    getBearer,
  }), [user, ready, profile, availablePkn]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
