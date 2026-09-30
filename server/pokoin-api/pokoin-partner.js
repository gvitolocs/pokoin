'use strict';

/**
 * Pokoin Partner — API contract for the future store app (intake / bag / handoff).
 *
 * Public:
 *   GET  ?action=directory   placeholder / live partner stores for /flex
 *   GET  ?action=contract    machine-readable action list for the Partner app
 *
 * Partner-authenticated (coming soon — today returns coming_soon):
 *   POST ?action=intake       seller drops a packed parcel (QR)
 *   POST ?action=bag         add parcel into outbound shared Flex bag
 *   POST ?action=receive-hub inbound shared bag arrives at destination store
 *   POST ?action=handoff     buyer picks up packet (QR / code)
 *   GET  ?action=pending     parcels waiting at this store
 *
 * Auth later: partner device token / Firebase custom claim `pokoinPartnerStoreId`.
 * Deploy with checkout EUR overlay (scripts/deploy-checkout-eur-api.sh).
 */

const PLACEHOLDER_STORES = [
  {
    id: 'milan-ace',
    name: 'Ace Hobby',
    city: 'Milan',
    country: 'Italy',
    countryCode: 'IT',
    role: 'drop-off + pick-up',
    status: 'placeholder',
  },
  {
    id: 'berlin-deck',
    name: 'Deck & Dice',
    city: 'Berlin',
    country: 'Germany',
    countryCode: 'DE',
    role: 'drop-off + pick-up',
    status: 'placeholder',
  },
  {
    id: 'lisbon-cardforge',
    name: 'Cardforge',
    city: 'Lisbon',
    country: 'Portugal',
    countryCode: 'PT',
    role: 'drop-off + pick-up',
    status: 'placeholder',
  },
  {
    id: 'copenhagen-tabletop',
    name: 'Tabletop North',
    city: 'Copenhagen',
    country: 'Denmark',
    countryCode: 'DK',
    role: 'pick-up',
    status: 'placeholder',
  },
];

const PARTNER_ACTIONS = [
  {
    action: 'directory',
    method: 'GET',
    auth: 'public',
    purpose: 'List partner stores for pokoin.com/flex and checkout Flex picker.',
  },
  {
    action: 'contract',
    method: 'GET',
    auth: 'public',
    purpose: 'Describe Partner app endpoints and QR payload shapes.',
  },
  {
    action: 'intake',
    method: 'POST',
    auth: 'partner',
    purpose: 'Scan seller drop-off QR; accept an already-packed seller parcel into the store (shop does not pack cards).',
    body: ['storeId', 'parcelQr', 'orderId?'],
  },
  {
    action: 'bag',
    method: 'POST',
    auth: 'partner',
    purpose: 'Load accepted parcels into the shared Pokoin bag (~20 kg target) bound for the sorting center.',
    body: ['storeId', 'bagId', 'parcelIds'],
  },
  {
    action: 'receive-hub',
    method: 'POST',
    auth: 'partner',
    purpose: 'Receive sorted packets from the Pokoin sorting center for local buyer pickup.',
    body: ['storeId', 'bagQr'],
  },
  {
    action: 'handoff',
    method: 'POST',
    auth: 'partner',
    purpose: 'Scan buyer pickup QR/code; release only that packet.',
    body: ['storeId', 'pickupQr'],
  },
  {
    action: 'pending',
    method: 'GET',
    auth: 'partner',
    purpose: 'Parcels at this store awaiting pickup or awaiting outbound bag.',
    query: ['storeId'],
  },
];

function cleanAction(value) {
  return String(value || '').trim().toLowerCase().slice(0, 40);
}

function comingSoon(action) {
  return {
    ok: false,
    code: 'coming_soon',
    action,
    message: 'Pokoin Partner app mutations are not live yet. Directory and contract are public.',
  };
}

function partnerContract() {
  return {
    ok: true,
    product: 'pokoin_flex',
    partnerApp: 'pokoin-partner',
    status: 'scaffolding',
    vision: {
      summary: 'Seller packs in Flex equipment → partner drop-off → shared ~20 kg Pokoin bag → Pokoin sorting center → partner pickup or home. Cheaper than solo shipping; fewer half-empty parcels.',
      not: 'Not CardTrader Zero door-to-warehouse alone: fill the paid weight bracket with many seller packs before the trunk moves.',
      environment: 'Fewer packets on the road; less shipping overall.',
      equipment: 'Sturdy Flex boxes padded on the inside for high-quality travel.',
    },
    bag: {
      targetKg: 20,
      filler: 'partner_store',
      destination: 'pokoin_sorting_center',
      lastMile: ['flex_partner_pickup', 'home'],
      parcelEquipment: {
        kind: 'pokoin_flex_box',
        shell: 'sturdy',
        interior: 'padded',
        purpose: 'high_quality_travel',
      },
    },
    qr: {
      sellerIntake: { type: 'pokoin.flex.intake', fields: ['orderId', 'sellerUid', 'exp'] },
      buyerPickup: { type: 'pokoin.flex.handoff', fields: ['orderId', 'buyerUid', 'code', 'exp'] },
      sharedBag: { type: 'pokoin.flex.bag', fields: ['bagId', 'routeId', 'fromStoreId', 'toStoreId'] },
    },
    actions: PARTNER_ACTIONS,
  };
}

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, `https://${req.headers.host || 'pokoin.com'}`);
    const action = cleanAction(url.searchParams.get('action') || req.body?.action || 'directory');

    if (req.method === 'GET' && (action === 'directory' || action === '')) {
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.status(200).json({
        ok: true,
        status: 'placeholder',
        product: 'pokoin_flex',
        stores: PLACEHOLDER_STORES,
        note: 'Placeholder shops for layout. Live partners replace this list at Flex launch.',
      });
    }

    if (req.method === 'GET' && action === 'contract') {
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.status(200).json(partnerContract());
    }

    if (req.method === 'GET' && action === 'pending') {
      return res.status(501).json(comingSoon('pending'));
    }

    if (req.method === 'POST' && ['intake', 'bag', 'receive-hub', 'handoff'].includes(action)) {
      return res.status(501).json(comingSoon(action));
    }

    return res.status(400).json({
      ok: false,
      error: `Unknown pokoin-partner action: ${action || '(empty)'}`,
      actions: PARTNER_ACTIONS.map((row) => row.action),
    });
  } catch (error) {
    console.error('pokoin-partner', error);
    return res.status(error.statusCode || 500).json({
      ok: false,
      error: error.message || 'Partner API failed.',
    });
  }
};

module.exports._test = {
  PLACEHOLDER_STORES,
  PARTNER_ACTIONS,
  partnerContract,
  comingSoon,
  cleanAction,
};
