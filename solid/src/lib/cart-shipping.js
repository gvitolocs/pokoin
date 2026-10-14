import { createEffect, createMemo, createSignal, untrack } from 'solid-js';
import { fetchAccountAddresses } from '@market/api.js';
import { deliveryCountryFrom, preferredAddressCountry } from '@market/cart-rails-core.js';
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
} from '@market/live-shipping.js';
import { getBearer, signedIn } from '../stores/auth.js';

/**
 * React useDeliveryCountry: the default saved
 * address country once signed in, else the browser locale. Returns an
 * accessor of `{ country, saved }`.
 */
export function createDeliveryCountry() {
  const [fromAccount, setFromAccount] = createSignal('');
  createEffect(signedIn, (on) => {
    if (!on) {
      setFromAccount('');
      return undefined;
    }
    let cancelled = false;
    getBearer()
      .then((token) => (token ? fetchAccountAddresses(token, { reveal: false }) : null))
      .then((data) => {
        if (!cancelled) setFromAccount(preferredAddressCountry(data));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  });
  return createMemo(() => deliveryCountryFrom(fromAccount()));
}

/**
 * React useLiveShipping: live Packlink +
 * letter rates per ticked seller parcel, the seeded table until they land.
 * Inputs are accessors; returns accessors.
 */
export function createLiveShipping({ groups, to, service, subtotalPkn = () => 0 }) {
  const ticked = createMemo(() => tickedShippingGroups(groups()));
  const country = () => shippingIso(to());
  const seed = createMemo(() => seedShippingServices(ticked(), country()));
  const key = createMemo(() => liveShippingKey(ticked(), country()));
  const [liveByKey, setLiveByKey] = createSignal(new Map());
  const [status, setStatus] = createSignal('idle');

  createEffect(key, () => {
    const parcels = untrack(ticked);
    const toCountry = untrack(country);
    if (!toCountry || !parcels.length) {
      setLiveByKey(() => new Map());
      setStatus('idle');
      return undefined;
    }
    let cancelled = false;
    const controller = new AbortController();
    setStatus('loading');
    fetchLiveShipping(parcels, toCountry, controller.signal).then((next) => {
      if (cancelled) return;
      setLiveByKey(() => next);
      setStatus(next.size ? 'ready' : 'failed');
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  });

  const allowUntracked = () => shippingAllowsUntracked(subtotalPkn());
  const services = createMemo(() => liveShippingServices({
    liveByKey: liveByKey(),
    seedServices: seed(),
    ticked: ticked(),
    allowUntracked: allowUntracked(),
  }));
  const activeService = () => activeShippingService(services(), service(), allowUntracked());
  const shipping = createMemo(() => liveShippingTotals({
    liveByKey: liveByKey(),
    ticked: ticked(),
    country: country(),
    services: services(),
    activeService: activeService(),
    allowUntracked: allowUntracked(),
  }));
  const estimates = createMemo(() => shippingEstimatesByKey(shipping()));
  return { services, shipping, estimates, status };
}
