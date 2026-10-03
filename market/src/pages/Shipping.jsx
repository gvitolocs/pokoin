import { useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { useCart } from '../cart.jsx';
import { groupBySeller } from '../cart-model.js';
import { parcelEstimate } from '../cart-shipping.js';
import { useDeliveryCountry } from '../cart-rails.js';
import { formatLocalFromEurCents } from '../pkn.js';
import { shipFromCountryName } from '../ship-countries.js';
import { defaultShippingService, shippingServiceOptions } from '../shipping-quote.js';
import { useBuyerCurrency } from '../use-buyer-currency.js';
import '../cart.css';

function selectableOptions(group, to) {
  return shippingServiceOptions({
    fromCountry: group.sellerCountry,
    toCountry: to,
    cardCount: group.selectedCount,
  }).filter((row) => !row.unavailable);
}

/** Rate list for the cart: one service for the order, priced per seller parcel. */
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
  // Same country and service the cart summary uses.
  const to = cart.shippingChoice.country || delivery.country;
  const serviceId = cart.shippingChoice.service;
  const toName = shipFromCountryName(to) || to;

  const parcels = useMemo(() => groups.map((group) => ({
    group,
    options: selectableOptions(group, to),
    fromName: shipFromCountryName(group.sellerCountry) || group.sellerCountry || 'the seller',
  })), [groups, to]);

  const choices = useMemo(() => {
    const byId = new Map();
    for (const parcel of parcels) {
      for (const option of parcel.options) {
        if (!byId.has(option.id)) byId.set(option.id, option);
      }
    }
    return [...byId.values()];
  }, [parcels]);

  const active = choices.some((row) => row.id === serviceId)
    ? serviceId
    : defaultShippingService(choices);

  function pick(id) {
    cart.setShippingChoice({ service: id });
  }

  return (
    <main className="page bk-ship-page">
      <p className="bk-ship-back"><Link to="/cart">Back to cart</Link></p>
      <h1>Shipping</h1>
      <p className="bk-ship-lede">
        Each seller ships their cards as one parcel to {toName}. Pick a service from the rate list.
        Checkout uses this choice.
      </p>
      {!groups.length ? (
        <p>Your cart has no cards selected. <Link to="/cart">Open the cart</Link> and tick the cards you want.</p>
      ) : (
        <>
          <fieldset className="bk-ship-pick">
            <legend>Service</legend>
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
                  <em>{[option.serviceName, option.carrier].filter(Boolean).join(' · ')}</em>
                </span>
              </label>
            ))}
          </fieldset>
          <ul className="bk-ship-parcels">
            {parcels.map((parcel) => {
              const quote = parcelEstimate({
                from: parcel.group.sellerCountry,
                to,
                cards: parcel.group.selectedCount,
                service: active,
              });
              const seller = parcel.group.sellerName || parcel.group.sellerUsername || 'Seller';
              const cards = parcel.group.selectedCount;
              return (
                <li key={parcel.group.key}>
                  <strong>{seller}</strong>
                  <span>
                    {cards} card{cards === 1 ? '' : 's'} · {parcel.fromName} → {toName}
                  </span>
                  <b>
                    {quote
                      ? `${quote.serviceName || quote.carrier || 'Shipping'} · ${formatLocalFromEurCents(quote.amountCents, buyer.currency)}`
                      : 'Quoted at checkout'}
                  </b>
                  {parcel.options.length > 1 ? (
                    <ul>
                      {parcel.options.map((option) => (
                        <li key={option.id}>
                          {option.label}
                          {' · '}
                          {formatLocalFromEurCents(option.amountCents, buyer.currency)}
                          {option.serviceName ? ` · ${option.serviceName}` : ''}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="bk-ship-note">
            A short letter stays the same price while the parcel still has room. A larger parcel moves up a tier.
            {delivery.saved || cart.shippingChoice.country ? '' : ` This preview uses ${toName}; checkout quotes the address you save.`}
          </p>
          <Link className="btn" to="/cart">Use this shipping</Link>
        </>
      )}
    </main>
  );
}
