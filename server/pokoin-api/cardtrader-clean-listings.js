'use strict';

/**
 * POST /api/cardtrader-clean-listings
 *
 * Modes:
 * - default / scope=linked: soft-hide CardTrader-linked listings (legacy cleanup)
 * - scope=all + confirm="DELETE ALL LISTINGS": hard-delete every listing for this
 *   seller across marketplace games, plus CardTrader product links, so Sync can
 *   re-import from CardTrader instead of alreadyLinked no-ops.
 */

const path = require('path');

const WIPE_CONFIRM = 'DELETE ALL LISTINGS';

function requireHelper(name) {
  try {
    return require(path.join(__dirname, '..', 'server', name));
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return require(`./${name}`);
  }
}

function marketplaceWriteQuery(...args) {
  return requireHelper('_marketplace_db').marketplaceWriteQuery(...args);
}

function verifyBearerToken(...args) {
  return requireHelper('_firebase').verifyBearerToken(...args);
}

function marketplaceGame() {
  return requireHelper('_marketplace_game');
}

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
  for (const cardId of uniqueIds.slice(0, 200)) {
    await marketplaceWriteQuery(
      'select public.refresh_marketplace_blueprint_price_summary($1)',
      [cardId],
    ).catch((error) => {
      console.error('cardtrader clean price summary refresh failed', error);
    });
  }
}

async function cleanLinkedListingsForSeller(uid) {
  const result = await marketplaceWriteQuery(
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

async function wipeGameInventory(uid) {
  let linksRemoved = 0;
  try {
    const links = await marketplaceWriteQuery(
      `
        delete from public.marketplace_cardtrader_product_links
        where seller_uid = $1
      `,
      [uid],
    );
    linksRemoved = links.rowCount || 0;
  } catch (error) {
    // Non-pokemon game DBs may not have the links table.
    if (error.code !== '42P01') throw error;
  }

  let assetsRemoved = 0;
  try {
    const assets = await marketplaceWriteQuery(
      `
        delete from public.marketplace_cardtrader_1dr_assets
        where seller_uid = $1
      `,
      [uid],
    );
    assetsRemoved = assets.rowCount || 0;
  } catch (error) {
    if (error.code !== '42P01') throw error;
  }

  const listings = await marketplaceWriteQuery(
    `
      delete from public.marketplace_user_listings
      where seller_uid = $1
      returning id, card_id
    `,
    [uid],
  );
  const rows = listings.rows || [];
  return {
    listingsRemoved: rows.length,
    linksRemoved,
    assetsRemoved,
    cardIds: [...new Set(rows.map((row) => row.card_id).filter(Boolean))],
  };
}

/** Hard-delete every listing for this seller in every configured marketplace game. */
async function wipeAllListingsForSeller(uid) {
  const { GAMES, runWithGame } = marketplaceGame();
  const games = Object.keys(GAMES || { pokemon: true });
  const byGame = {};
  let listingsRemoved = 0;
  let linksRemoved = 0;
  let assetsRemoved = 0;
  const cardIds = new Set();

  for (const gameId of games) {
    try {
      const result = await runWithGame(gameId, () => wipeGameInventory(uid));
      byGame[gameId] = result;
      listingsRemoved += result.listingsRemoved;
      linksRemoved += result.linksRemoved;
      assetsRemoved += result.assetsRemoved;
      for (const id of result.cardIds) cardIds.add(id);
    } catch (error) {
      // Skip games with no writer URL / schema — still wipe the ones that work.
      byGame[gameId] = {
        skipped: true,
        error: error.message || String(error),
      };
    }
  }

  // Best-effort price refresh on pokemon only (cap).
  await runWithGame('pokemon', () => refreshTouchedCards([...cardIds]));

  return {
    listingsRemoved,
    linksRemoved,
    assetsRemoved,
    games: byGame,
    cardIds: [...cardIds].slice(0, 50),
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
    const body = req.body || {};
    const scope = String(body.scope || body.mode || 'linked').trim().toLowerCase();

    if (scope === 'all' || scope === 'wipe' || scope === 'delete_all') {
      const confirm = String(body.confirm || '').trim();
      if (confirm !== WIPE_CONFIRM) {
        return res.status(400).json({
          error: `Type ${WIPE_CONFIRM} to delete your entire Pokoin inventory across all TCGs.`,
          code: 'confirm_required',
          confirmPhrase: WIPE_CONFIRM,
        });
      }
      const result = await wipeAllListingsForSeller(decoded.uid);
      return res.status(200).json({
        ok: true,
        scope: 'all',
        confirmPhrase: WIPE_CONFIRM,
        ...result,
      });
    }

    const result = await cleanLinkedListingsForSeller(decoded.uid);
    return res.status(200).json({ ok: true, scope: 'linked', ...result });
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

module.exports.WIPE_CONFIRM = WIPE_CONFIRM;
module.exports._test = {
  cleanLinkedListingsForSeller,
  linkedListingPredicate,
  wipeAllListingsForSeller,
  WIPE_CONFIRM,
};
