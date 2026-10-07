/**
 * Google Customer Reviews opt-in for the order confirmation.
 *
 * Google's snippet must be injected from JS: the site CSP allows
 * https://apis.google.com in script-src but has no 'unsafe-inline', so an
 * inline <script> block would be blocked. Nothing here changes the CSP.
 *
 * Docs: https://support.google.com/merchants/answer/7106244
 */

/** Pokoin's Google Merchant Center id (integration for the pokoin.com store). */
export const GCR_MERCHANT_ID = 5869935257;

/** The platform.js URL Google asks for; the onload callback name is global. */
export const GCR_SCRIPT_SRC = 'https://apis.google.com/js/platform.js?onload=__pokoinRenderGcrOptIn';

const DAY_MS = 24 * 60 * 60 * 1000;

function orderedAtMs(value) {
  if (value == null) return Date.now();
  if (typeof value === 'number') return Number.isFinite(value) ? value : Date.now();
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? Date.now() : ms;
  }
  if (typeof value === 'object') {
    if (typeof value.toMillis === 'function') {
      try {
        const ms = Number(value.toMillis());
        if (Number.isFinite(ms)) return ms;
      } catch {
        return Date.now();
      }
    }
    if (typeof value.seconds === 'number' && Number.isFinite(value.seconds)) {
      return value.seconds * 1000;
    }
  }
  return Date.now();
}

/**
 * Google wants a concrete YYYY-MM-DD. Domestic parcels (every seller ships
 * from the buyer's own country) estimate 7 days; anything cross-border — or an
 * order with no shipment data yet — estimates 14 days. UTC, so the date never
 * depends on the visitor's timezone.
 */
export function estimatedDeliveryDate({ orderedAt, shipments = [], toCountry } = {}) {
  const base = orderedAtMs(orderedAt);
  const to = String(toCountry || '').trim().toUpperCase();
  const list = Array.isArray(shipments) ? shipments : [];
  const domestic = Boolean(to)
    && list.length > 0
    && list.every((row) => String(row?.fromCountry || '').trim().toUpperCase() === to);
  const days = domestic ? 7 : 14;
  return new Date(base + days * DAY_MS).toISOString().slice(0, 10);
}

function countryCode(value) {
  return String(value || '').trim().toUpperCase();
}

/**
 * The exact payload for gapi.surveyoptin.render. Returns null when a field
 * Google requires is missing or malformed, so callers can skip the dialog.
 * `products` / GTIN are omitted: trading cards have no GTIN.
 */
export function optInFields({ orderId, email, deliveryCountry, estimatedDelivery } = {}) {
  const id = String(orderId || '').trim();
  if (!id) return null;
  const mail = String(email || '').trim();
  if (!mail.includes('@')) return null;
  const country = countryCode(deliveryCountry);
  if (!/^[A-Z]{2}$/.test(country)) return null;
  const date = String(estimatedDelivery || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return {
    merchant_id: GCR_MERCHANT_ID,
    order_id: id,
    email: mail,
    delivery_country: country,
    estimated_delivery_date: date,
  };
}

/** sessionStorage flag so one order never opens the dialog twice. */
export function gcrStorageKey(orderId) {
  return `pokoin.gcr.${String(orderId || '').trim()}`;
}

/**
 * Inject (once) the platform.js loader and arm the surveyoptin render for one
 * order. Returns true when this call owned the opt-in, false when the fields
 * were invalid or the order had already been shown in this session.
 *
 * Script tag only — an inline snippet would be blocked by script-src.
 */
export function showReviewsOptIn(fields, { win = window, doc = document, storage = sessionStorage } = {}) {
  if (!fields) return false;
  const key = gcrStorageKey(fields.order_id);
  try {
    if (storage.getItem(key)) return false;
    storage.setItem(key, '1');
  } catch {
    // Private mode / blocked storage: still show the opt-in this once.
  }

  win.__pokoinRenderGcrOptIn = () => {
    if (!win.gapi || typeof win.gapi.load !== 'function') return;
    win.gapi.load('surveyoptin', () => {
      win.gapi.surveyoptin.render(fields);
    });
  };

  const existing = typeof doc.querySelector === 'function'
    ? doc.querySelector(`script[src="${GCR_SCRIPT_SRC}"]`)
    : null;
  if (existing) {
    // platform.js is already on the page. When it has loaded, render now;
    // otherwise its onload calls the (re)defined global by itself.
    if (win.gapi && typeof win.gapi.load === 'function') win.__pokoinRenderGcrOptIn();
    return true;
  }

  const script = doc.createElement('script');
  script.async = true;
  script.defer = true;
  script.src = GCR_SCRIPT_SRC;
  doc.head.appendChild(script);
  return true;
}

/** Google's store widget (formerly the Customer Reviews badge) loader. */
export const GCR_BADGE_SRC = 'https://www.gstatic.com/shopping/merchant/merchantwidget.js';
export const GCR_BADGE_SCRIPT_ID = 'merchantWidgetScript';

function insideFrame(win) {
  try {
    return win.top !== win;
  } catch {
    return true; // cross-origin parent: we are framed
  }
}

/**
 * Show Google's store rating badge on every page. Bottom-left on desktop:
 * the chat button owns bottom-right (Google centres the badge on mobile).
 * Skipped inside frames (extension side panel, embeds). Injected from JS for
 * the same CSP reason as the opt-in; www.gstatic.com is already in script-src.
 */
export function showReviewsBadge({ win = window, doc = document } = {}) {
  if (insideFrame(win)) return false;
  if (typeof doc.getElementById === 'function' && doc.getElementById(GCR_BADGE_SCRIPT_ID)) return false;
  const script = doc.createElement('script');
  script.id = GCR_BADGE_SCRIPT_ID;
  script.defer = true;
  script.src = GCR_BADGE_SRC;
  script.addEventListener('load', () => {
    if (!win.merchantwidget || typeof win.merchantwidget.start !== 'function') return;
    win.merchantwidget.start({ merchant_id: GCR_MERCHANT_ID, position: 'LEFT_BOTTOM' });
  });
  doc.head.appendChild(script);
  return true;
}

