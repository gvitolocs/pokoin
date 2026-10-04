'use strict';

/**
 * Authenticated (chat) / public (listing) proxy for pokoin-user-photos in R2.
 *
 * Public r2.dev access is disabled. Chat photos require a signed-in user;
 * unauthenticated browser GETs redirect to /auth. Listing photos stay readable
 * without auth so marketplace desks keep working.
 */

const PHOTO_BUCKET = process.env.R2_USER_PHOTOS_BUCKET || 'pokoin-user-photos';
const AUTH_ORIGIN = String(process.env.POKOIN_PUBLIC_ORIGIN || 'https://pokoin.com').replace(/\/+$/, '');

let s3Client = null;

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function verifyBearerToken(...args) {
  return require('../server/_firebase').verifyBearerToken(...args);
}

function photoClient() {
  if (s3Client) return s3Client;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    throw httpError(500, 'Photo storage is not configured.');
  }
  const { S3Client } = require('@aws-sdk/client-s3');
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${account}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return s3Client;
}

/** @returns {{ kind: 'chat'|'listing', uid: string, id: string, key: string } | null} */
function parsePhotoKey(rawPath) {
  const text = String(rawPath || '').trim().replace(/^\/+/, '');
  const match = text.match(/^user-photos\/(chat|listing)\/([A-Za-z0-9]{8,128})\/([0-9a-f]{12,64})\.jpg$/i);
  if (!match) return null;
  return {
    kind: match[1].toLowerCase(),
    uid: match[2],
    id: match[3].toLowerCase(),
    key: `user-photos/${match[1].toLowerCase()}/${match[2]}/${match[3].toLowerCase()}.jpg`,
  };
}

function wantsHtml(req) {
  const accept = String(req.headers?.accept || '');
  return accept.includes('text/html');
}

function authRedirect(req) {
  const host = String(req.headers?.host || 'api.pokoin.com');
  const proto = String(req.headers?.['x-forwarded-proto'] || 'https');
  const path = String(req.url || '/api/user-photos');
  const next = `${proto}://${host}${path.startsWith('/') ? path : `/${path}`}`;
  const from = `/messages?photo=${encodeURIComponent(next)}`;
  return `${AUTH_ORIGIN}/auth?from=${encodeURIComponent(from)}`;
}

async function readObject(key) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const result = await photoClient().send(new GetObjectCommand({
    Bucket: PHOTO_BUCKET,
    Key: key,
  }));
  const chunks = [];
  for await (const chunk of result.Body) chunks.push(chunk);
  return {
    bytes: Buffer.concat(chunks),
    contentType: result.ContentType || 'image/jpeg',
  };
}

async function optionalUser(req) {
  try {
    return await verifyBearerToken(req);
  } catch (_) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', AUTH_ORIGIN);
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization');
      return res.status(204).end();
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET, OPTIONS');
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    const url = new URL(req.url, `https://${req.headers.host || 'api.pokoin.com'}`);
    const fromParts = [
      url.searchParams.get('kind'),
      url.searchParams.get('uid'),
      url.searchParams.get('file'),
    ].every(Boolean)
      ? `user-photos/${url.searchParams.get('kind')}/${url.searchParams.get('uid')}/${String(url.searchParams.get('file')).replace(/\.jpg$/i, '')}.jpg`
      : '';
    const fromQuery = url.searchParams.get('key') || url.searchParams.get('path') || fromParts;
    const fromPath = url.pathname.replace(/^\/api\/user-photos\/?/i, 'user-photos/');
    const parsed = parsePhotoKey(fromQuery || fromPath);
    if (!parsed) {
      return res.status(404).json({ error: 'Photo not found.' });
    }

    if (parsed.kind === 'chat') {
      const user = await optionalUser(req);
      if (!user?.uid) {
        if (wantsHtml(req) || !req.headers.authorization) {
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Location', authRedirect(req));
          return res.status(302).end();
        }
        return res.status(401).json({ error: 'Sign in to view this photo.' });
      }
    }

    const object = await readObject(parsed.key);
    res.setHeader('Content-Type', object.contentType);
    res.setHeader('Cache-Control', parsed.kind === 'chat'
      ? 'private, max-age=300'
      : 'public, max-age=86400, stale-while-revalidate=604800');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (parsed.kind === 'chat') {
      res.setHeader('Access-Control-Allow-Origin', AUTH_ORIGIN);
      res.setHeader('Vary', 'Authorization');
    }
    return res.status(200).end(object.bytes);
  } catch (error) {
    const status = error.statusCode || (error?.$metadata?.httpStatusCode === 404 ? 404 : 500);
    if (status === 404) return res.status(404).json({ error: 'Photo not found.' });
    console.error('user-photos failed', error?.message || error);
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      error: error.message || 'Photo failed.',
    });
  }
};

module.exports._test = {
  parsePhotoKey,
  authRedirect,
  wantsHtml,
};
