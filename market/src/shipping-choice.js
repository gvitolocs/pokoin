/** Cart, /shipping and checkout share the buyer's delivery country, shipping service and balance-discount tick. */

const INSURANCE_KEY = 'pokoin.cart.insurance';
const SERVICE_KEY = 'pokoin.cart.shipping';
const DISCOUNT_KEY = 'pokoin.cart.pknDiscount';
const COUNTRY_KEY = 'pokoin.cart.shipTo';
const PARCELS_KEY = 'pokoin.cart.parcelShipping';

function read(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch (_) {
    return '';
  }
}

function write(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch (_) {
    /* private mode */
  }
}

/** Letter rates or a live Packlink service id (`packlink:22131`). */
export function isShippingServiceId(value) {
  const id = String(value || '');
  return id === 'tracked' || id === 'untracked' || /^packlink:\d+$/.test(id);
}

/**
 * Services checkout can book: the letter rates. Live Packlink rates are quotes
 * only (nothing buys their labels), so a parcel never ships on one.
 */
export function isBookableShippingService(value) {
  const id = String(value || '');
  return id === 'tracked' || id === 'untracked';
}

export function readShippingService() {
  const value = read(SERVICE_KEY);
  return isShippingServiceId(value) ? value : '';
}

export function writeShippingService(id) {
  write(SERVICE_KEY, isShippingServiceId(id) ? id : '');
}

export function readInsurance() {
  return read(INSURANCE_KEY) === '1';
}

export function writeInsurance(on) {
  write(INSURANCE_KEY, on ? '1' : '');
}

export function readPknDiscount() {
  return read(DISCOUNT_KEY) === '1';
}

export function writePknDiscount(on) {
  write(DISCOUNT_KEY, on ? '1' : '');
}

/**
 * Delivery country picked in the cart ('' = profile / saved address / browser
 * country). Kept for this tab's session only: a pick from an earlier visit
 * must not outrank the profile country the next time the cart opens.
 */
export function readShippingCountry() {
  let value = '';
  try {
    localStorage.removeItem(COUNTRY_KEY); // older builds kept the pick forever
    value = sessionStorage.getItem(COUNTRY_KEY) || '';
  } catch (_) {
    value = '';
  }
  value = value.toUpperCase();
  return /^[A-Z]{2}$/.test(value) ? value : '';
}

export function writeShippingCountry(code) {
  const value = String(code || '').toUpperCase();
  try {
    if (/^[A-Z]{2}$/.test(value)) sessionStorage.setItem(COUNTRY_KEY, value);
    else sessionStorage.removeItem(COUNTRY_KEY);
  } catch (_) {
    /* private mode */
  }
}

/** Service picked per seller parcel ({ parcelKey: serviceId }), this tab's session only. */
export function readParcelServices() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(PARCELS_KEY) || '{}');
    const out = {};
    for (const [key, id] of Object.entries(parsed || {})) {
      if (key && isBookableShippingService(id)) out[key] = id;
    }
    return out;
  } catch (_) {
    return {};
  }
}

export function writeParcelServices(parcels) {
  const clean = {};
  for (const [key, id] of Object.entries(parcels || {})) {
    if (key && isBookableShippingService(id)) clean[key] = id;
  }
  try {
    if (Object.keys(clean).length) sessionStorage.setItem(PARCELS_KEY, JSON.stringify(clean));
    else sessionStorage.removeItem(PARCELS_KEY);
  } catch (_) {
    /* private mode */
  }
}
