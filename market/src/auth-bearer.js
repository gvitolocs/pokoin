// Bearer-token seam for framework-free modules (recents.js, …). The React auth
// layer registers its implementation at load, so the shared core never imports
// auth.jsx or Firebase. With no provider there is no session: ''.

let provider = null;

export function setBearerProvider(fn) {
  provider = typeof fn === 'function' ? fn : null;
}

export async function getBearer(forceRefresh = false) {
  if (!provider) {
    return '';
  }
  return provider(forceRefresh);
}
