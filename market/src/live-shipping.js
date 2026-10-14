// Live Packlink + letter rates for each ticked seller parcel: the rules behind
// useLiveShipping() (React) and the Solid cart/shipping pages. No framework.

import { fetchShippingOptions } from './api.js';
import { orderServices, parcelEstimate, parcelServices, tierRoom } from './cart-shipping.js';
import { cheapestServiceId, eurCentsFromPkn, isUntrackedService, untrackedAllowed } from './shipping-quote.js';

export function shippingIso(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && code !== 'EU' ? code : '';
}

/** Seller groups with ticked rows and a known ship-from country. */
export function tickedShippingGroups(groups) {
  return (groups || []).filter((group) => group.selectedCount > 0 && shippingIso(group.sellerCountry));
}

/** Changes only when a parcel the quote depends on changes. */
export function liveShippingKey(ticked, country) {
  return `${shippingIso(country)}#${(ticked || []).map((group) => `${group.key}:${group.selectedCount}:${group.sellerCountry}`).join('|')}`;
}

/** Seeded rate table services for these parcels (shown until the live rates land). */
export function seedShippingServices(ticked, to) {
  return orderServices(ticked, shippingIso(to));
}

/**
 * One GET /api/shipping-options per parcel. Resolves to a Map of group key →
 * options (an aborted parcel is left out; a failed one is an empty list).
 */
export async function fetchLiveShipping(ticked, to, signal) {
  const country = shippingIso(to);
  const rows = await Promise.all((ticked || []).map(async (group) => {
    try {
      const data = await fetchShippingOptions({
        fromCountry: group.sellerCountry,
        toCountry: country,
        cards: group.selectedCount,
        signal,
      });
      return [group.key, Array.isArray(data?.options) ? data.options : []];
    } catch (error) {
      if (error?.name === 'AbortError') return [group.key, null];
      return [group.key, []];
    }
  }));
  const next = new Map();
  for (const [key, options] of rows) {
    if (options) next.set(key, options);
  }
  return next;
}

export function shippingAllowsUntracked(subtotalPkn) {
  return untrackedAllowed(eurCentsFromPkn(subtotalPkn));
}

/** Every service offered for these parcels, complete ones first, then cheapest. */
export function liveShippingServices({ liveByKey, seedServices, ticked, allowUntracked }) {
  let rows = seedServices;
  if (liveByKey.size) {
    const byId = new Map();
    for (const group of ticked) {
      const options = liveByKey.get(group.key);
      if (!options?.length) continue;
      for (const option of options) {
        const row = byId.get(option.id) || {
          id: option.id,
          label: option.label || option.serviceName || option.id,
          carrier: option.carrier || '',
          tracked: option.tracked !== false,
          source: option.source || '',
          cents: 0,
          parcels: 0,
        };
        row.cents += Number(option.amountCents) || 0;
        row.parcels += 1;
        byId.set(option.id, row);
      }
    }
    if (byId.size) {
      rows = [...byId.values()]
        .map((row) => ({ ...row, complete: row.parcels === ticked.length }))
        .sort((a, b) => Number(b.complete) - Number(a.complete) || a.cents - b.cents);
    }
  }
  return allowUntracked ? rows : rows.filter((row) => !isUntrackedService(row));
}

/** The picked service if it is offered, else the cheapest bookable one. */
export function activeShippingService(services, service, allowUntracked) {
  return services.some((row) => row.id === service)
    ? service
    : cheapestServiceId(services, { allowUntracked });
}

/** Letter rates read like the parcel header ("Untracked letter (Poste Italiane)"); Packlink keeps its service name. */
function parcelOptionLabel(row) {
  if (row.id === 'tracked' || row.id === 'untracked') {
    const kind = row.tracked !== false ? 'Tracked' : 'Untracked letter';
    return row.carrier ? `${kind} (${row.carrier})` : kind;
  }
  return row.label || row.serviceName || (row.tracked !== false ? 'Tracked' : 'Untracked letter');
}

function parcelOption(row) {
  return {
    id: row.id,
    label: parcelOptionLabel(row),
    amountCents: Number(row.amountCents) || 0,
    tracked: row.tracked !== false,
    serviceName: row.serviceName || '',
    carrier: row.carrier || '',
    packageTier: row.packageTier || '',
  };
}

/**
 * The services one seller's parcel can use on its own lane (seller country →
 * buyer), cheapest first: live Packlink + letter rates once they land, the
 * seeded table before that.
 */
export function parcelShippingOptions({ liveByKey, group, country, allowUntracked }) {
  const to = shippingIso(country);
  const live = liveByKey?.get?.(group.key);
  const rows = live?.length
    ? live.filter((row) => !row.unavailable)
    : parcelServices({ from: group.sellerCountry, to, cards: group.selectedCount });
  return rows
    .filter((row) => allowUntracked || !isUntrackedService(row))
    .map(parcelOption)
    .sort((a, b) => a.amountCents - b.amountCents);
}

/**
 * One parcel per seller, each with its own service: the buyer's pick for that
 * parcel, else the order-wide service when that lane offers it, else the
 * lane's cheapest. The order's shipping is the sum of those parcels.
 */
export function liveShippingTotals({ liveByKey, ticked, country, activeService, allowUntracked, parcelPicks = {} }) {
  const to = shippingIso(country);
  const parcels = [];
  let cents = 0;
  let missing = 0;
  for (const group of ticked) {
    const options = parcelShippingOptions({ liveByKey, group, country: to, allowUntracked });
    const wanted = parcelPicks?.[group.key] || '';
    const picked = (wanted && options.find((row) => row.id === wanted))
      || (activeService && options.find((row) => row.id === activeService))
      || options[0]
      || null;
    const estimate = picked
      ? {
        ...picked,
        serviceId: picked.id,
        room: picked.id === 'tracked' || picked.id === 'untracked'
          ? parcelEstimate({ from: group.sellerCountry, to, cards: group.selectedCount, service: picked.id })?.room || 0
          : tierRoom(group.selectedCount),
        fallback: Boolean(wanted && picked.id !== wanted),
      }
      : null;
    parcels.push({
      key: group.key,
      sellerUid: group.sellerUid,
      sellerName: group.sellerName,
      sellerUsername: group.sellerUsername,
      from: shippingIso(group.sellerCountry),
      to,
      cards: group.selectedCount,
      options,
      estimate,
    });
    if (estimate) cents += estimate.amountCents;
    else missing += 1;
  }
  return { parcels, cents, missing, count: parcels.length };
}

export function shippingEstimatesByKey(shipping) {
  return Object.fromEntries(shipping.parcels.map((parcel) => [parcel.key, parcel.estimate]));
}
