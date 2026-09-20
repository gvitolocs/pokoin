const { getFirebaseAdmin, verifyBearerToken } = require('../server/_firebase');
const { readIntegrationDoc, safeStatusFromDoc } = require('./_cardtrader_integration');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const decoded = await verifyBearerToken(req);
    const firestore = getFirebaseAdmin().firestore();
    const doc = await readIntegrationDoc(firestore, decoded.uid);
    return res.status(200).json({ ok: true, status: safeStatusFromDoc(doc) });
  } catch (error) {
    console.error('cardtrader-status failed', {
      code: error.code || '',
      statusCode: error.statusCode || 500,
      message: error.message,
    });
    return res.status(error.statusCode || 500).json({
      error: error.message || 'CardTrader status failed.',
      code: error.code,
    });
  }
};
