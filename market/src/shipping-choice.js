/** Cart and checkout share the buyer's shipping service and balance-discount tick. */

const SERVICE_KEY = 'pokoin.cart.shipping';
const DISCOUNT_KEY = 'pokoin.cart.pknDiscount';

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

export function readShippingService() {
  const value = read(SERVICE_KEY);
  return value === 'tracked' || value === 'untracked' ? value : '';
}

export function writeShippingService(id) {
  write(SERVICE_KEY, id === 'tracked' || id === 'untracked' ? id : '');
}

export function readPknDiscount() {
  return read(DISCOUNT_KEY) === '1';
}

export function writePknDiscount(on) {
  write(DISCOUNT_KEY, on ? '1' : '');
}
