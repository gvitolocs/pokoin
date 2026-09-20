const { marketplaceQuery } = require('../server/_marketplace_db');
const { verifyBearerToken } = require('../server/_firebase');

function linkedListingPredicate() {
  return `
    (
      lower(coalesce(source, '')) = 'cardtrader'
      or lower(coalesce(source, '')) like 'cardtrader%'
      or lower(coalesce(source_listing_id, '')) like '%cardtrader%'
      or lower(coalesce(source_listing_id, '')) like '%cardtrader.com%'
      or lower(coalesce(source_listing_id, '')) like 'ct:%'
    )
  `;
}

async function refreshTouchedCards(cardIds) {
  const uniqueIds = [...new Set(cardIds.map((id) => String(id || '').trim()).filter(Boolean))];
  for (const cardId of uniqueIds) {
    await marketplaceQuery(
      'select public.refresh_marketplace_blueprint_price_summary($1)',
      [cardId],
    ).catch((error) => {
      console.error('cardtrader clean price summary refresh failed', error);
    });
  }
}

async function cleanLinkedListingsForSeller(uid) {
  const result = await marketplaceQuery(
    `
      update public.marketplace_user_listings
      set
        status = 'inactive',
        updated_at = now()
      where seller_uid = $1
        and status <> 'inactive'
        and ${linkedListingPredicate()}
      returning id, card_id, source, source_listing_id
    `,
    [uid],
  );
  await refreshTouchedCards(result.rows.map((row) => row.card_id));
  return {
    cleanedCount: result.rowCount || 0,
    listingIds: result.rows.map((row) => row.id).filter(Boolean),
    cardIds: [...new Set(result.rows.map((row) => row.card_id).filter(Boolean))],
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const decoded = await verifyBearerToken(req);
    const result = await cleanLinkedListingsForSeller(decoded.uid);
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error('cardtrader-clean-listings failed', {
      code: error.code || '',
      statusCode: error.statusCode || 500,
      message: error.message,
    });
    return res.status(error.statusCode || 500).json({
      error: error.message || 'CardTrader linked listing cleanup failed.',
      code: error.code,
    });
  }
};

module.exports._test = {
  cleanLinkedListingsForSeller,
  linkedListingPredicate,
};
