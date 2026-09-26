import { PKN_USDT_PRICE } from './pkn.js';

/** Always charged. The old 8% line was this plus optional insurance. */
export const CHECKOUT_COMMISSION_RATE = 0.03;
/** Optional cover if the parcel is lost. Off unless the buyer adds it. */
export const CHECKOUT_INSURANCE_RATE = 0.05;
export const INSURANCE_CAP_USD = 50;

/** $50 at 1 PKN = 0.005 USDT. */
export function insuranceCoveragePkn() {
  return INSURANCE_CAP_USD / PKN_USDT_PRICE;
}

function money(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
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
    coveragePkn: insuranceCoveragePkn(),
    totalPkn: money(subtotal + taxPkn + shipping),
  };
}
