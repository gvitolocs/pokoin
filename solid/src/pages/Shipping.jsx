import { createMemo, For, onSettled, Show } from 'solid-js';
import { groupBySeller } from '@market/cart-model.js';
import { formatLocalFromEurCents } from '@market/pkn.js';
import { shipFromCountryName } from '@market/ship-countries.js';
import { defaultShippingService, pokoinFlexOption } from '@market/shipping-quote.js';
import { createDeliveryCountry, createLiveShipping } from '../lib/cart-shipping.js';
import { buyerCurrency } from '../stores/buyer.js';
import { cartItems } from '../stores/cart.js';
import { cartShippingChoice, setCartShippingChoice } from '../stores/cart-actions.js';
import '@market/cart.css';

/** /shipping: Packlink + letter rates, priced per seller parcel. */
export default function Shipping() {
  const delivery = createDeliveryCountry();

  onSettled(() => {
    document.title = 'Shipping · Pokoin';
  });

  const groups = createMemo(() => groupBySeller(cartItems()).filter((group) => group.selectedCount > 0));
  const to = () => cartShippingChoice().country || delivery().country;
  const serviceId = () => cartShippingChoice().service;
  const toName = () => shipFromCountryName(to()) || to();
  const live = createLiveShipping({ groups, to, service: serviceId });
  const active = () => (live.services().some((row) => row.id === serviceId())
    ? serviceId()
    : defaultShippingService(live.services()));
  const flex = pokoinFlexOption();

  return (
    <main class="page bk-ship-page">
      <p class="bk-ship-back"><a href="/cart">Back to cart</a></p>
      <h1>Shipping</h1>
      <p class="bk-ship-lede">
        Each seller ships their cards as one parcel to {toName()}. Pick a Packlink carrier or letter
        service. Checkout uses this choice.
      </p>
      <Show
        when={groups().length}
        fallback={<p>Your cart has no cards selected. <a href="/cart">Open the cart</a> and tick the cards you want.</p>}
      >
        <fieldset class="bk-ship-pick">
          <legend>Service{live.status() === 'loading' ? ' · loading carriers…' : ''}</legend>
          <For each={live.services()}>
            {(option) => (
              <label class={{ 'is-on': active() === option.id }}>
                <input
                  type="radio"
                  name="shippingService"
                  checked={active() === option.id}
                  onChange={() => setCartShippingChoice({ service: option.id })}
                />
                <span>
                  <strong>{option.label}</strong>
                  <em>
                    {[option.carrier, option.source === 'packlink' ? 'Packlink' : option.source]
                      .filter(Boolean)
                      .join(' · ')}
                    {' · '}
                    {formatLocalFromEurCents(option.cents, buyerCurrency())}
                    {option.complete ? '' : ' (not every parcel)'}
                  </em>
                </span>
              </label>
            )}
          </For>
          <label class="is-off" title={flex.unavailableReason}>
            <input type="radio" name="shippingService" disabled checked={false} readonly />
            <span>
              <strong>{flex.label}</strong>
              <em>{flex.unavailableReason}</em>
            </span>
          </label>
        </fieldset>
        <ul class="bk-ship-parcels">
          <For each={live.shipping().parcels}>
            {(parcel) => {
              const group = () => groups().find((row) => row.key === parcel.key);
              return (
                <Show when={group()}>
                  {(g) => {
                    const cards = () => g().selectedCount;
                    const fromName = () => shipFromCountryName(g().sellerCountry) || g().sellerCountry || 'the seller';
                    return (
                      <li>
                        <strong>{g().sellerName || g().sellerUsername || 'Seller'}</strong>
                        <span>
                          {cards()} card{cards() === 1 ? '' : 's'} · {fromName()} → {toName()}
                        </span>
                        <b>
                          {parcel.estimate
                            ? `${parcel.estimate.serviceName || parcel.estimate.carrier || 'Shipping'} · ${formatLocalFromEurCents(parcel.estimate.amountCents, buyerCurrency())}`
                            : 'Quoted at checkout'}
                        </b>
                      </li>
                    );
                  }}
                </Show>
              );
            }}
          </For>
        </ul>
        <p class="bk-ship-note">
          Prices come from Packlink PRO plus the letter rate table. A short letter stays the same
          price while the parcel still has room.
          {delivery().saved || cartShippingChoice().country ? '' : ` This preview uses ${toName()}; checkout quotes the address you save.`}
        </p>
        <a class="btn" href="/cart">Use this shipping</a>
      </Show>
    </main>
  );
}
