/** Always charged. */
export const CHECKOUT_COMMISSION_RATE = 0.03;
/** Optional cover if the parcel is lost. Off unless the buyer adds it. */
export const CHECKOUT_INSURANCE_RATE = 0.05;
/** A lost parcel is covered for this share of the card subtotal. */
export const INSURANCE_COVERAGE_RATE = 0.8;

function money(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export function insuranceCoveragePkn(subtotalPkn) {
  return money(Math.max(0, Number(subtotalPkn) || 0) * INSURANCE_COVERAGE_RATE);
}

/**
 * Site PKN spent as a card-checkout discount: 2 PKN per euro-cent, and the
 * card charge keeps a 50-cent floor. Nothing is taken until the buyer opts in.
 */
export function pknBalanceVoucher({ availablePkn = 0, eligiblePkn = 0, chargeEurCents = 0 } = {}) {
  const pool = Math.min(
    Math.max(0, Number(availablePkn) || 0),
    Math.max(0, Math.trunc(Number(eligiblePkn) || 0)),
  );
  const cap = Math.max(0, Math.round(Number(chargeEurCents) || 0) - 50);
  const eurCents = Math.max(0, Math.min(Math.floor(pool / 2), cap));
  return { eurCents, pkn: eurCents * 2 };
}

export function checkoutFees(subtotalPkn, { insurance = false, shippingPkn = 0 } = {}) {
  const subtotal = Math.max(0, Number(subtotalPkn) || 0);
  const commissionPkn = money(subtotal * CHECKOUT_COMMISSION_RATE);
  const insurancePkn = insurance ? money(subtotal * CHECKOUT_INSURANCE_RATE) : 0;
  const shipping = money(Math.max(0, Number(shippingPkn) || 0));
  const taxPkn = money(commissionPkn + insurancePkn);
  return {
    commissionPkn,
    insurancePkn,
    shippingPkn: shipping,
    taxPkn,
    coveragePkn: insuranceCoveragePkn(subtotal),
    totalPkn: money(subtotal + taxPkn + shipping),
  };
}
