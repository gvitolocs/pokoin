import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXTENSION_ZIP_FALLBACK_NAME,
  extensionDownloadFailure,
  extensionZipName,
  fetchExtensionZip,
} from './extension-download.js';

test('zip name comes from Content-Disposition, else the fallback', () => {
  assert.equal(extensionZipName('attachment; filename="pokoin-extension-12.0.72.zip"'), 'pokoin-extension-12.0.72.zip');
  assert.equal(extensionZipName('attachment; filename=pokoin-extension-1.2.3.zip'), 'pokoin-extension-1.2.3.zip');
  assert.equal(extensionZipName(null), EXTENSION_ZIP_FALLBACK_NAME);
  assert.equal(extensionZipName('attachment; filename="../../etc/passwd"'), EXTENSION_ZIP_FALLBACK_NAME);
});

test('server statuses map to the gated page states', () => {
  assert.equal(extensionDownloadFailure(401), 'signed-out');
  assert.equal(extensionDownloadFailure(403), 'not-silver');
  assert.equal(extensionDownloadFailure(404), 'unpublished');
  assert.equal(extensionDownloadFailure(502), 'error');
});

test('the download sends the bearer to api.pokoin.com and never caches', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-disposition', 'attachment; filename="pokoin-extension-12.0.72.zip"']]),
      blob: async () => 'zip-bytes',
    };
  };
  const result = await fetchExtensionZip('tok', fetchImpl);
  assert.equal(calls[0].url, 'https://api.pokoin.com/api/extension-download');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.deepEqual(result, { blob: 'zip-bytes', name: 'pokoin-extension-12.0.72.zip' });
});

test('a 403 rejects with the not-silver state', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, headers: new Map() });
  await assert.rejects(fetchExtensionZip('tok', fetchImpl), (error) => error.state === 'not-silver' && error.status === 403);
});
