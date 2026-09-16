/** CardTrader-style buyer protection, in Pokoin language. Physical checkout only. */

export const PROTECTION_PATH = '/protection';
export const PROTECTION_TITLE = "You're protected when you buy on Pokoin";
export const NO_SHIP_GUARANTEE =
  'If a seller does not ship within 7 days, we return your PKN from escrow.';
export const ESCROW_LINE = 'Funds released only after delivery confirmed.';
export const ASSET_COVERAGE_LINE = '100% coverage on your assets';
export const DISPUTE_REPLY = '48 hours';
export const DISPUTE_DECISION = '5 business days';
export const SHIP_DAYS = 7;

export const PROTECTION_PILLARS = [
  {
    title: 'PKN escrow',
    body: 'Checkout takes site PKN from the buyer and holds it. The seller is not paid until you confirm the card arrived.',
  },
  {
    title: 'Seller does not ship',
    body: NO_SHIP_GUARANTEE,
  },
  {
    title: 'Disputes',
    body: `Report a problem from Orders. First reply within ${DISPUTE_REPLY}. Decision within ${DISPUTE_DECISION}. contact@pokoin.com.`,
  },
];
