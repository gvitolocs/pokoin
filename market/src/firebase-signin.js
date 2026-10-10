// Sign-in calls for the Solid /auth page. firebase/auth resolves from market/
// (solid/ has no firebase dependency), so the page imports them through here.
export {
  GoogleAuthProvider,
  getRedirectResult,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
} from 'firebase/auth';
export { firebaseAuth } from './firebase-client.js';
