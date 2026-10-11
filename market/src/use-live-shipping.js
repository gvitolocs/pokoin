import { useEffect, useMemo, useState } from 'react';
import {
  activeShippingService,
  fetchLiveShipping,
  liveShippingKey,
  liveShippingServices,
  liveShippingTotals,
  seedShippingServices,
  shippingAllowsUntracked,
  shippingEstimatesByKey,
  shippingIso,
  tickedShippingGroups,
} from './live-shipping.js';

/**
 * Live Packlink + letter rates for each ticked seller parcel.
 * Falls back to the seeded table while the network request is in flight.
 * The rules live in live-shipping.js (shared with the Solid UI).
 */
export function useLiveShipping({ groups = [], to = '', service = '', subtotalPkn = 0 } = {}) {
  const ticked = useMemo(() => tickedShippingGroups(groups), [groups]);
  const country = shippingIso(to);
  const seedServices = useMemo(() => seedShippingServices(ticked, country), [ticked, country]);

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
    fetchLiveShipping(ticked, country, controller.signal).then((next) => {
      if (cancelled) return;
      setLiveByKey(next);
      setStatus(next.size ? 'ready' : 'failed');
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [liveShippingKey(ticked, country)]);

  const allowUntracked = shippingAllowsUntracked(subtotalPkn);

  const services = useMemo(
    () => liveShippingServices({ liveByKey, seedServices, ticked, allowUntracked }),
    [liveByKey, seedServices, ticked, allowUntracked],
  );

  const activeService = activeShippingService(services, service, allowUntracked);

  const shipping = useMemo(
    () => liveShippingTotals({ liveByKey, ticked, country, services, activeService, allowUntracked }),
    [liveByKey, service, services, ticked, country, activeService, allowUntracked],
  );

  const estimates = useMemo(() => shippingEstimatesByKey(shipping), [shipping]);

  return { services, shipping, estimates, status };
}
