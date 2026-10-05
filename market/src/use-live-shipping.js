import { useEffect, useMemo, useState } from 'react';
import { fetchShippingOptions } from './api.js';
import { orderServices, parcelEstimate, shippingEstimate, tierRoom } from './cart-shipping.js';
import { defaultShippingService } from './shipping-quote.js';

function iso(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && code !== 'EU' ? code : '';
}

/**
 * Live Packlink + letter rates for each ticked seller parcel.
 * Falls back to the seeded table while the network request is in flight.
 */
export function useLiveShipping({ groups = [], to = '', service = '' } = {}) {
  const ticked = useMemo(
    () => (groups || []).filter((group) => group.selectedCount > 0 && iso(group.sellerCountry)),
    [groups],
  );
  const country = iso(to);
  const seedServices = useMemo(() => orderServices(ticked, country), [ticked, country]);
  const seedShipping = useMemo(
    () => shippingEstimate(ticked, country, service),
    [ticked, country, service],
  );

  const [liveByKey, setLiveByKey] = useState(() => new Map());
  const [status, setStatus] = useState('idle');

  useEffect(() => {
    if (!country || !ticked.length) {
      setLiveByKey(new Map());
      setStatus('idle');
      return undefined;
    }
    let cancelled = false;
    const controller = new AbortController();
    setStatus('loading');
    Promise.all(ticked.map(async (group) => {
      try {
        const data = await fetchShippingOptions({
          fromCountry: group.sellerCountry,
          toCountry: country,
          cards: group.selectedCount,
          signal: controller.signal,
        });
        return [group.key, Array.isArray(data?.options) ? data.options : []];
      } catch (error) {
        if (error?.name === 'AbortError') return [group.key, null];
        return [group.key, []];
      }
    })).then((rows) => {
      if (cancelled) return;
      const next = new Map();
      for (const [key, options] of rows) {
        if (options) next.set(key, options);
      }
      setLiveByKey(next);
      setStatus(next.size ? 'ready' : 'failed');
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [country, ticked.map((group) => `${group.key}:${group.selectedCount}:${group.sellerCountry}`).join('|')]);

  const services = useMemo(() => {
    if (!liveByKey.size) return seedServices;
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
    if (!byId.size) return seedServices;
    return [...byId.values()]
      .map((row) => ({ ...row, complete: row.parcels === ticked.length }))
      .sort((a, b) => Number(b.complete) - Number(a.complete) || a.cents - b.cents);
  }, [liveByKey, seedServices, ticked]);

  const shipping = useMemo(() => {
    if (!liveByKey.size) return seedShipping;
    const wanted = service || defaultShippingService(services);
    const parcels = [];
    let cents = 0;
    let missing = 0;
    for (const group of ticked) {
      const options = liveByKey.get(group.key) || [];
      const picked = options.find((row) => row.id === wanted)
        || options.find((row) => row.id === defaultShippingService(options))
        || options[0]
        || null;
      const estimate = picked
        ? {
          serviceId: picked.id,
          amountCents: Number(picked.amountCents) || 0,
          tracked: picked.tracked !== false,
          serviceName: picked.serviceName || '',
          carrier: picked.carrier || '',
          packageTier: picked.packageTier || '',
          room: picked.id === 'tracked' || picked.id === 'untracked'
            ? parcelEstimate({ from: group.sellerCountry, to: country, cards: group.selectedCount, service: picked.id })?.room || 0
            : tierRoom(group.selectedCount),
          fallback: Boolean(wanted && picked.id !== wanted),
        }
        : null;
      parcels.push({ key: group.key, estimate });
      if (estimate) cents += estimate.amountCents;
      else missing += 1;
    }
    return { parcels, cents, missing, count: parcels.length };
  }, [liveByKey, seedShipping, service, services, ticked]);

  const estimates = useMemo(
    () => Object.fromEntries(shipping.parcels.map((parcel) => [parcel.key, parcel.estimate])),
    [shipping],
  );

  return { services, shipping, estimates, status };
}
