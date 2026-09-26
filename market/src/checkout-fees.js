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
