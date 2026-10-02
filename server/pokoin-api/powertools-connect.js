'use strict';

const { getFirebaseAdmin, verifyBearerToken } = require('../server/_firebase');
const { readIntegrationDoc } = require('./_cardtrader_integration');
const {
  cleanSessionToken,
  disconnectPowerTools,
  fetchPowerToolsUser,
  loginThrottle,
  loginWithPassword,
  readPowerToolsDoc,
  recordFailedLogin,
  safePowerToolsStatus,
  storePowerToolsSession,
} = require('./_powertools_session');

/** Does the Power Tools account mirror the same CardTrader seller Pokoin is connected to? */
async function cardTraderMatch(firestore, uid, account) {
  try {
    const doc = await readIntegrationDoc(firestore, uid);
    const data = doc?.exists ? doc.data() || {} : {};
    const pokoinCtUser = String(data.enabled === true ? data.metadata?.user?.id ?? '' : '').trim();
    const ptCtUser = String(account?.cardtraderUserId || '').trim();
    if (!pokoinCtUser || !ptCtUser) return null;
    return pokoinCtUser === ptCtUser;
  } catch (_) {
    return null;
  }
}

async function status(firestore, uid) {
  const doc = await readPowerToolsDoc(firestore, uid);
  const result = safePowerToolsStatus(doc);
  return {
    ...result,
    cardtraderMatch: result.connected ? await cardTraderMatch(firestore, uid, result.account) : null,
  };
}

/**
 * POST { email, password } signs in like the Power Tools web app; POST { session }
 * accepts a pasted jwt cookie (Google / two-factor accounts). Either way only the
 * validated session is stored.
 */
async function connect(body, uid, { admin, firestore, fetchImpl } = {}) {
  const options = fetchImpl ? { fetchImpl } : {};
  const usingPassword = body?.session == null || String(body.session).trim() === '';
  let jwt;
  if (usingPassword) {
    const doc = await readPowerToolsDoc(firestore, uid);
    const throttle = loginThrottle(doc?.exists ? doc.data() || {} : {});
    if (throttle.blocked) {
      const error = new Error('Too many Power Tools sign-in attempts. Try again in an hour.');
      error.statusCode = 429;
      error.code = 'powertools_login_throttled';
      throw error;
    }
    try {
      jwt = await loginWithPassword({ email: body?.email, password: body?.password }, options);
    } catch (error) {
      if (error.code === 'powertools_invalid_credentials') {
        await recordFailedLogin(firestore, uid, throttle.next);
      }
      throw error;
    }
  } else {
    jwt = cleanSessionToken(body.session);
  }
  let account;
  try {
    account = await fetchPowerToolsUser(jwt, options);
  } catch (error) {
    if (error.code === 'powertools_session_expired') {
      error.statusCode = 401;
      error.message = 'Power Tools did not accept that session.';
    }
    throw error;
  }
  await storePowerToolsSession({ admin, firestore, uid, jwt, account });
  return status(firestore, uid);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const decoded = await verifyBearerToken(req);
    const admin = getFirebaseAdmin();
    const firestore = admin.firestore();

    if (req.method === 'GET') {
      return res.status(200).json({ ok: true, status: await status(firestore, decoded.uid) });
    }
    if (req.method === 'POST') {
      const result = await connect(req.body || {}, decoded.uid, { admin, firestore });
      console.log('powertools-connect', { uid: decoded.uid, cardtraderMatch: result.cardtraderMatch });
      return res.status(200).json({ ok: true, status: result });
    }
    if (req.method === 'DELETE') {
      await disconnectPowerTools({ admin, firestore, uid: decoded.uid });
      return res.status(200).json({ ok: true, status: await status(firestore, decoded.uid) });
    }
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (error) {
    // Never log the request body: it carries the Power Tools password or session.
    console.error('powertools-connect failed', {
      code: error.code || '',
      statusCode: error.statusCode || 500,
      message: error.message,
    });
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Power Tools connection failed.',
      code: error.code,
    });
  }
};

module.exports._test = { cardTraderMatch, connect, status };
