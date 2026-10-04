import { useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { useCart } from '../cart.jsx';
import { groupBySeller } from '../cart-model.js';
import { useDeliveryCountry } from '../cart-rails.js';
import { formatLocalFromEurCents } from '../pkn.js';
import { shipFromCountryName } from '../ship-countries.js';
import { defaultShippingService, pokoinFlexOption } from '../shipping-quote.js';
import { useLiveShipping } from '../use-live-shipping.js';
import { useBuyerCurrency } from '../use-buyer-currency.js';
import '../cart.css';

/** Rate list for the cart: Packlink carriers + letter rates, priced per seller parcel. */
export default function Shipping() {
  const cart = useCart();
  const { signedIn, getBearer } = useAuth();
  const buyer = useBuyerCurrency();
  const delivery = useDeliveryCountry({ signedIn, getBearer });

  useEffect(() => {
    document.title = 'Shipping · Pokoin';
  }, []);

  const groups = useMemo(
    () => groupBySeller(cart.items).filter((group) => group.selectedCount > 0),
    [cart.items],
  );
  const to = cart.shippingChoice.country || delivery.country;
  const serviceId = cart.shippingChoice.service;
  const toName = shipFromCountryName(to) || to;
  const live = useLiveShipping({ groups, to, service: serviceId });
  const choices = live.services;
  const active = choices.some((row) => row.id === serviceId)
    ? serviceId
    : defaultShippingService(choices);
  const flex = pokoinFlexOption();

  function pick(id) {
    cart.setShippingChoice({ service: id });
  }

  return (
    <main className="page bk-ship-page">
      <p className="bk-ship-back"><Link to="/cart">Back to cart</Link></p>
      <h1>Shipping</h1>
      <p className="bk-ship-lede">
        Each seller ships their cards as one parcel to {toName}. Pick a Packlink carrier or letter
        service. Checkout uses this choice.
      </p>
      {!groups.length ? (
        <p>Your cart has no cards selected. <Link to="/cart">Open the cart</Link> and tick the cards you want.</p>
      ) : (
        <>
          <fieldset className="bk-ship-pick">
            <legend>Service{live.status === 'loading' ? ' · loading carriers…' : ''}</legend>
            {choices.map((option) => (
              <label key={option.id} className={active === option.id ? 'is-on' : ''}>
                <input
                  type="radio"
                  name="shippingService"
                  checked={active === option.id}
                  onChange={() => pick(option.id)}
                />
                <span>
                  <strong>{option.label}</strong>
                  <em>
                    {[option.carrier, option.source === 'packlink' ? 'Packlink' : option.source]
                      .filter(Boolean)
                      .join(' · ')}
                    {' · '}
                    {formatLocalFromEurCents(option.cents, buyer.currency)}
                    {option.complete ? '' : ' (not every parcel)'}
                  </em>
                </span>
              </label>
            ))}
            <label className="is-off" title={flex.unavailableReason}>
              <input type="radio" name="shippingService" disabled checked={false} readOnly />
              <span>
                <strong>{flex.label}</strong>
                <em>{flex.unavailableReason}</em>
              </span>
            </label>
          </fieldset>
          <ul className="bk-ship-parcels">
            {live.shipping.parcels.map((parcel) => {
              const group = groups.find((row) => row.key === parcel.key);
              if (!group) return null;
              const quote = parcel.estimate;
              const seller = group.sellerName || group.sellerUsername || 'Seller';
              const cards = group.selectedCount;
              const fromName = shipFromCountryName(group.sellerCountry) || group.sellerCountry || 'the seller';
              return (
                <li key={parcel.key}>
                  <strong>{seller}</strong>
                  <span>
                    {cards} card{cards === 1 ? '' : 's'} · {fromName} → {toName}
                  </span>
                  <b>
                    {quote
                      ? `${quote.serviceName || quote.carrier || 'Shipping'} · ${formatLocalFromEurCents(quote.amountCents, buyer.currency)}`
                      : 'Quoted at checkout'}
                  </b>
                </li>
              );
            })}
          </ul>
          <p className="bk-ship-note">
            Prices come from Packlink PRO plus the letter rate table. A short letter stays the same
            price while the parcel still has room.
            {delivery.saved || cart.shippingChoice.country ? '' : ` This preview uses ${toName}; checkout quotes the address you save.`}
          </p>
          <Link className="btn" to="/cart">Use this shipping</Link>
        </>
      )}
    </main>
  );
}
