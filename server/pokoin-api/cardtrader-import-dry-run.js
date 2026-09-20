const { getFirebaseAdmin, verifyBearerToken } = require('../server/_firebase');
const { fetchProductsExport, importDryRunSummary } = require('./_cardtrader_client');
const { decryptIntegrationToken } = require('./_cardtrader_integration');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const decoded = await verifyBearerToken(req);
    const firestore = getFirebaseAdmin().firestore();
    const token = await decryptIntegrationToken(firestore, decoded.uid);
    const products = await fetchProductsExport(token);
    return res.status(200).json({
      ok: true,
      dryRun: true,
      summary: importDryRunSummary(products),
    });
  } catch (error) {
    console.error('cardtrader-import-dry-run failed', {
      code: error.code || '',
      statusCode: error.statusCode || 500,
      message: error.message,
    });
    return res.status(error.statusCode || 500).json({
      error: error.message || 'CardTrader import dry-run failed.',
      code: error.code,
    });
  }
};
