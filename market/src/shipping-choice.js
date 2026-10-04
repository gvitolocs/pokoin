/** Cart, /shipping and checkout share the buyer's delivery country, shipping service and balance-discount tick. */

const SERVICE_KEY = 'pokoin.cart.shipping';
const DISCOUNT_KEY = 'pokoin.cart.pknDiscount';
const COUNTRY_KEY = 'pokoin.cart.shipTo';

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

export function readShippingService() {
  const value = read(SERVICE_KEY);
  return isShippingServiceId(value) ? value : '';
}

export function writeShippingService(id) {
  write(SERVICE_KEY, isShippingServiceId(id) ? id : '');
}

export function readPknDiscount() {
  return read(DISCOUNT_KEY) === '1';
}

export function writePknDiscount(on) {
  write(DISCOUNT_KEY, on ? '1' : '');
}

/** Delivery country picked in the cart ('' = saved address / browser country). */
export function readShippingCountry() {
  const value = read(COUNTRY_KEY).toUpperCase();
  return /^[A-Z]{2}$/.test(value) ? value : '';
}

export function writeShippingCountry(code) {
  const value = String(code || '').toUpperCase();
  write(COUNTRY_KEY, /^[A-Z]{2}$/.test(value) ? value : '');
}
