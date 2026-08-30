import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged } from 'firebase/auth';

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

const AuthContext = createContext({
  user: null,
  ready: false,
  signedIn: false,
  sellerName: 'Pokoin seller',
  getBearer,
});

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => onAuthStateChanged(firebaseAuth, (next) => {
    setUser(next);
    setReady(true);
  }), []);

  const value = useMemo(() => ({
    user,
    ready,
    signedIn: Boolean(user),
    sellerName: sellerNameOf(user),
    getBearer,
  }), [user, ready]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
