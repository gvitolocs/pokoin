import { readAuthToken } from '@market/auth-session.js';
import { realPublicCardId } from '@market/card-id.js';
import { publicApiUrl } from '@market/extension-auth-bridge.js';
import { cdnFetchUrl, homepageDerivativeUrl, ownCatalogImage, preferFullImage } from '@market/image-urls.js';
import { BINDER_SLOTS, binderPage, clearBinderCache, writeBinderCache } from '@market/landing-binder.js';

/**
 * The binder's network read, loaded at idle for signed-in visitors only.
 *
 * The token is the SPA's mirrored ID token cookie (`pokoin.auth.token`) when
 * it is still fresh and belongs to this uid. Otherwise Firebase Auth loads
 * (never on the first paint) and its own user decides: a token for them, or
 * nobody signed in on this origin.
 */
async function firebaseToken() {
  const { firebaseAuth } = await import('@market/firebase-client.js');
  await firebaseAuth.authStateReady?.();
  const user = firebaseAuth.currentUser;
  return user ? user.getIdToken() : '';
}

/** The tile picture: the homepage derivative, with the full scan as its fallback. */
export function binderImage(row) {
  const id = realPublicCardId(row?.cardId || row?.blueprintId || '');
  const full = cdnFetchUrl(ownCatalogImage(
    { id, name: row?.cardName || row?.name || '' },
    preferFullImage(row?.cardImageUrl || row?.imageUrl || row?.heroImageUrl || ''),
  ));
  return { src: cdnFetchUrl(homepageDerivativeUrl(full)) || full, full };
}

/** The card desk, as the desk route spells it without a canonical slug. */
export function binderHref(row) {
  const id = realPublicCardId(row?.cardId || row?.blueprintId || '');
  return /^\d+$/.test(id) ? `/marketplace/en/cards/${id}` : '';
}

/**
 * `{ kind: 'page', page }`, `{ kind: 'empty' }`, `{ kind: 'signed-out' }`, or
 * `{ kind: 'error' }`. A page is stored for the uid the API answered for (the
 * verified bearer's), never the one the caller assumed.
 */
export async function syncBinder(uid, { fetchImpl = globalThis.fetch, mintToken = firebaseToken } = {}) {
  const read = (token) => fetchImpl(publicApiUrl(`/api/marketplace-collection?limit=${BINDER_SLOTS}`), {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  });
  const mirrored = readAuthToken();
  let token = mirrored && mirrored.uid === uid ? mirrored.token : '';
  let response = token ? await read(token) : null;
  // No usable mirrored token, or the API refused it: ask Firebase itself.
  if (!response || response.status === 401) {
    token = await mintToken();
    if (!token) {
      clearBinderCache();
      return { kind: 'signed-out' };
    }
    response = await read(token);
  }
  if (!response.ok) return { kind: 'error' };
  const page = binderPage(await response.json(), { image: binderImage, href: binderHref });
  if (!page) return { kind: 'error' };
  if (!page.cards.length) {
    clearBinderCache();
    return { kind: 'empty' };
  }
  writeBinderCache(page);
  return { kind: 'page', page };
}
