// pokoin.com/extension (and /extension.zip): the Chrome extension download.
// The zip is served only by GET /api/extension-download on api.pokoin.com,
// which checks the Firebase ID token and Silver itself (401 / 403). This
// module only fetches it with the bearer and hands the blob to the browser.

import { publicApiUrl } from './extension-auth-bridge.js';

export const EXTENSION_DOWNLOAD_PATH = '/api/extension-download';
export const EXTENSION_ZIP_FALLBACK_NAME = 'pokoin-extension.zip';

/** `attachment; filename="pokoin-extension-12.0.72.zip"` → that name; a safe default otherwise. */
export function extensionZipName(disposition) {
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(String(disposition || ''));
  const name = match ? decodeURIComponent(match[1]).trim() : '';
  return /^[\w.-]+\.zip$/i.test(name) ? name : EXTENSION_ZIP_FALLBACK_NAME;
}

/** The page state for a failed download response. */
export function extensionDownloadFailure(status) {
  if (status === 401) return 'signed-out';
  if (status === 403) return 'not-silver';
  if (status === 404) return 'unpublished';
  return 'error';
}

/**
 * Fetch the zip with the bearer token. Resolves `{ blob, name }`, or throws
 * an Error whose `state` is extensionDownloadFailure(status).
 */
export async function fetchExtensionZip(token, fetchImpl = fetch) {
  const response = await fetchImpl(publicApiUrl(EXTENSION_DOWNLOAD_PATH), {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!response.ok) {
    const error = new Error(`Download failed (${response.status})`);
    error.status = response.status;
    error.state = extensionDownloadFailure(response.status);
    throw error;
  }
  const blob = await response.blob();
  return { blob, name: extensionZipName(response.headers.get('content-disposition')) };
}

/** Save a blob through a temporary object-URL anchor. */
export function saveBlob(blob, name, doc = document) {
  const url = URL.createObjectURL(blob);
  const anchor = doc.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  doc.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
