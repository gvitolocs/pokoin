import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import PokoinWordmark from '../components/PokoinWordmark.jsx';
import mascotUrl from '../assets/pokoin-mascot@8x.png';
import { useAuth } from '../auth.jsx';
import { fetchSellerSettings } from '../api.js';
import {
  FLEX_ASSUMPTIONS,
  flexAverageSaving,
  flexCountries,
  flexLaneTable,
  flexQuote,
  formatEur,
  routeServices,
} from '../flex-savings.js';
import { resolveFlexDefaultCountries } from '../flex-user-country.js';
import { shipFromCountryName } from '../ship-countries.js';
import '../flex.css';
import { brandSrc } from '../brand-assets.js';

/** Fallback until GET /api/pokoin-partner?action=directory is live with real shops. */
const PLACEHOLDER_STORES = [
  { id: 'milan-ace', name: 'Ace Hobby', city: 'Milan', country: 'Italy', role: 'drop-off + pick-up' },
  { id: 'berlin-deck', name: 'Deck & Dice', city: 'Berlin', country: 'Germany', role: 'drop-off + pick-up' },
  { id: 'lisbon-cardforge', name: 'Cardforge', city: 'Lisbon', country: 'Portugal', role: 'drop-off + pick-up' },
  { id: 'copenhagen-tabletop', name: 'Tabletop North', city: 'Copenhagen', country: 'Denmark', role: 'pick-up' },
];

const STEPS = [
  { art: 'step-pack', title: 'Pack it yourself', text: 'Cards go in a Flex box — a sturdy shell, padded inside — instead of a random mailer.' },
  { art: 'step-drop', title: 'Drop at a partner', text: 'A partner shop scans your pack. It does not repack anything, it only loads it.' },
  { art: 'step-bag', title: 'One shared bag', text: 'Your pack rides with everyone else’s in one ~20 kg Pokoin bag to the sorting center.' },
  { art: 'step-collect', title: 'Collect with a code', text: 'The buyer picks it up at a partner shop with a QR code, or it continues home.' },
];

const TABLE_SIZES = [4, 20, 50];

/** Plain names: flag emoji render as boxes on Windows and many Linux fonts. */
function country(code) {
  return shipFromCountryName(code) || code;
}

function Money({ cents }) {
  return <>{formatEur(cents)}</>;
}

function Calculator() {
  const { ready, signedIn, getBearer } = useAuth();
  const countries = useMemo(() => flexCountries(), []);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [routeReady, setRouteReady] = useState(false);
  const [cards, setCards] = useState(20);
  const [sellers, setSellers] = useState(3);
  const [tracked, setTracked] = useState(null);
  const [delivery, setDelivery] = useState('pickup');
  const [pickupPackets, setPickupPackets] = useState(FLEX_ASSUMPTIONS.defaultPickupPackets);

  useEffect(() => {
    if (!ready || routeReady) return undefined;
    let cancelled = false;
    (async () => {
      const defaults = await resolveFlexDefaultCountries({
        allowedFrom: countries.from,
        allowedTo: countries.to,
        signedIn,
        loadProfileCountry: signedIn
          ? async () => {
            const token = await getBearer();
            if (!token) return '';
            const settings = await fetchSellerSettings(token);
            return String(settings?.shipFromCountry || '').trim().toUpperCase();
          }
          : null,
      });
      if (cancelled) return;
      setFrom(defaults.from);
      setTo(defaults.to);
      setRouteReady(true);
    })();
    return () => { cancelled = true; };
  }, [ready, signedIn, getBearer, countries, routeReady]);

  const perSeller = Math.max(1, Math.ceil(cards / Math.max(1, sellers)));
  const services = routeReady
    ? routeServices({ from, to, cards: perSeller })
    : [];
  const serviceChoices = [true, false]
    .map((wantTracked) => services.find((row) => row.tracked === wantTracked))
    .filter(Boolean)
    .sort((a, b) => a.cents - b.cents);
  const effectiveTracked = tracked != null
    ? tracked
    : (serviceChoices[0]?.tracked ?? true);

  const quote = routeReady
    ? flexQuote({
      from,
      to,
      cards,
      sellers,
      tracked: effectiveTracked,
      delivery,
      pickupPackets,
    })
    : null;
  const parts = quote?.flex.parts;
  const scale = Math.max(quote?.alone.cents || 0, quote?.flex.cents || 0, 1);
  const bar = (value) => `${Math.max(0, Math.min(100, (value / scale) * 100))}%`;

  return (
    <section id="flex-calc" className="flex-panel flex-calc" aria-labelledby="flex-calc-title">
      <header className="flex-panel-head">
        <h2 id="flex-calc-title">What you’d save</h2>
        <p>
          “Alone” is what checkout charges when each seller posts their own pack. Flex is two
          shipments: the partner sends one pack for the sellers who dropped off, then the magazine
          sends one pack to the city pickup.
        </p>
      </header>
      <div className="flex-calc-grid">
        <form className="flex-calc-inputs" onSubmit={(event) => event.preventDefault()}>
          <div className="flex-route">
            <label>
              <span>From</span>
              <select value={from} onChange={(event) => setFrom(event.target.value)}>
                {countries.from.map((code) => <option key={code} value={code}>{country(code)}</option>)}
              </select>
            </label>
            <span className="flex-route-arrow" aria-hidden="true">→</span>
            <label>
              <span>To</span>
              <select value={to} onChange={(event) => setTo(event.target.value)}>
                {countries.to.map((code) => <option key={code} value={code}>{country(code)}</option>)}
              </select>
            </label>
          </div>
          <label className="flex-range">
            <span>Cards in the order <strong>{cards}</strong></span>
            <input type="range" min="1" max="60" value={cards} onChange={(event) => setCards(Number(event.target.value))} />
          </label>
          <label className="flex-range">
            <span>Sellers <strong>{sellers}</strong></span>
            <input
              type="range"
              min="1"
              max={FLEX_ASSUMPTIONS.maxSellers}
              value={sellers}
              onChange={(event) => {
                const next = Number(event.target.value);
                setSellers(next);
                setPickupPackets((current) => Math.max(current, next));
              }}
            />
            <small className="flex-range-hint">
              {sellers === 1
                ? 'One seller is one direct shipment. Flex adds a box, handling, and a second hop, so it costs more.'
                : `${sellers} sellers drop at the partner · ~${Math.ceil(cards / sellers)} cards each · the partner ships one pack instead of ${sellers}`}
            </small>
          </label>
          <fieldset className="flex-seg flex-services">
            <legend>Ship alone with</legend>
            {serviceChoices.map((row) => (
              <label key={row.id} className={quote?.alone.id === row.id ? 'is-on' : ''}>
                <input
                  type="radio"
                  name="flex-service"
                  value={row.tracked ? 'tracked' : 'untracked'}
                  checked={(tracked ?? effectiveTracked) === row.tracked}
                  onChange={() => setTracked(row.tracked)}
                />
                <span>{row.tracked ? 'Tracked' : 'Untracked letter'}</span>
                <small>
                  {row.carrier} · {formatEur(row.cents)}
                  {sellers > 1 ? ` × ${sellers} = ${formatEur(row.cents * sellers)}` : ''}
                </small>
              </label>
            ))}
          </fieldset>
          <fieldset className="flex-seg">
            <legend>Delivery</legend>
            {[['pickup', 'Partner pickup'], ['home', 'Home delivery']].map(([value, label]) => (
              <label key={value} className={delivery === value ? 'is-on' : ''}>
                <input type="radio" name="flex-delivery" value={value} checked={delivery === value} onChange={() => setDelivery(value)} />
                {label}
              </label>
            ))}
          </fieldset>
          <label className={`flex-range${delivery === 'home' ? ' is-off' : ''}`}>
            <span>Packets in the city pickup pack <strong>{delivery === 'home' ? '—' : pickupPackets}</strong></span>
            <input
              type="range"
              min={sellers}
              max={FLEX_ASSUMPTIONS.maxPickupPackets}
              value={Math.max(pickupPackets, sellers)}
              disabled={delivery === 'home'}
              onChange={(event) => setPickupPackets(Number(event.target.value))}
            />
            <small className="flex-range-hint">
              {delivery === 'home'
                ? 'Home delivery is one parcel from the magazine to the buyer. This slider is the shared pack people collect at a partner.'
                : `The magazine ships one pack to the partner shop. ${pickupPackets} buyer ${pickupPackets === 1 ? 'packet shares' : 'packets share'} it · this order is ${sellers} of them.`}
            </small>
          </label>
        </form>

        <div className="flex-calc-result" aria-live="polite">
          {quote ? (
            <>
              <div className="flex-compare">
                <div className="is-alone">
                  <span>Shipping alone</span>
                  <strong><Money cents={quote.alone.cents} /></strong>
                  <em>
                    {quote.sellers > 1
                      ? `${quote.sellers}× ${quote.alone.carrier} · ${quote.alone.service}`
                      : `${quote.alone.carrier} · ${quote.alone.service}`}
                  </em>
                </div>
                <div className="is-flex">
                  <span>With Flex</span>
                  <strong><Money cents={quote.flex.cents} /></strong>
                  <em>{delivery === 'home' ? `home delivery, ${quote.lastMile.tracked ? 'tracked' : 'untracked'}` : 'pickup at a partner'}</em>
                </div>
              </div>
              <p className={`flex-saving${quote.savedCents > 0 ? '' : ' is-none'}`}>
                {quote.savedCents > 0 ? (
                  <>You save <strong><Money cents={quote.savedCents} /></strong> · {quote.savedPct}% on this order</>
                ) : sellers === 1 ? (
                  <>One seller is one direct shipment. Flex costs <strong><Money cents={-quote.savedCents} /></strong> more here</>
                ) : (
                  <>Flex is not cheaper here</>
                )}
              </p>
              {quote.sellers === 1 ? (
                <p className="flex-note">
                  The partner still ships one pack, the same size as posting these cards yourself,
                  plus the Flex box and handling
                  {delivery === 'pickup'
                    ? ', and the magazine still sends a pack to the city pickup.'
                    : ', and home delivery is a second parcel.'}
                </p>
              ) : (
                <p className="flex-note">
                  {quote.sellers} seller packets become one partner shipment
                  {delivery === 'pickup' && quote.city
                    ? `. The city pack holds ${quote.pickupPackets} packets; this order pays for ${quote.sellers} of them.`
                    : '. Home delivery is one parcel for the whole order, not one per seller.'}
                </p>
              )}
              <div className="flex-bars" aria-hidden="true">
                <div className="flex-bar is-alone"><span style={{ width: bar(quote.alone.cents) }} /></div>
                <div className="flex-bar is-flex">
                  <span className="p-box" style={{ width: bar(parts.box) }} />
                  <span className="p-handling" style={{ width: bar(parts.handling) }} />
                  <span className="p-trunk" style={{ width: bar(parts.trunk) }} />
                  <span className="p-last" style={{ width: bar(parts.lastMile) }} />
                </div>
              </div>
              <ul className="flex-breakdown">
                <li>
                  <i className="p-box" />Flex box{quote.sellers > 1 ? ` ×${quote.sellers}` : ''} <Money cents={parts.box} />
                </li>
                <li>
                  <i className="p-handling" />Partner handling{quote.sellers > 1 ? ` ×${quote.sellers}` : ''} <Money cents={parts.handling} />
                </li>
                <li>
                  <i className="p-trunk" />Partner ships one pack <Money cents={parts.trunk} />
                  <small>
                    {quote.sellers} seller {quote.sellers === 1 ? 'packet' : 'packets'} · {quote.totalGrams} g ·
                    {' '}{quote.intake.carrier} · {quote.intake.service} · {country(from)} → {country(to)}
                    {quote.intake.tier === 'EXTRA_LARGE'
                      ? ` · ${quote.intake.bags} × 20 kg bag`
                      : ' · same size class as a normal parcel'}
                  </small>
                </li>
                {quote.city ? (
                  <li>
                    <i className="p-last" />
                    City pickup pack <Money cents={parts.lastMile} />
                    <small>
                      Magazine → partner in {country(to)} · {quote.city.carrier} · {quote.city.service} ·
                      {' '}{quote.pickupPackets} {quote.pickupPackets === 1 ? 'packet' : 'packets'} in the pack · this order is {quote.sellers} ·
                      {' '}full pack <Money cents={quote.city.cents} />
                    </small>
                  </li>
                ) : null}
                {quote.lastMile ? (
                  <li>
                    <i className="p-last" />
                    Home delivery (one parcel from the Pokoin warehouse) <Money cents={parts.lastMile} />
                    <small>
                      {quote.lastMile.carrier} · {quote.lastMile.service} · {quote.totalGrams} g inside {country(to)}
                    </small>
                  </li>
                ) : null}
              </ul>
              <p className="flex-road">
                A 20 kg bag holds <strong>{quote.packsPerBag}</strong> packs this size.
                This quote prices the two hops from the packets you set, not from a guessed fill.
              </p>
              {quote.intake.estimated || quote.city?.estimated ? (
                <p className="flex-note">This route has no parcel rate yet in one direction, so that hop uses the reverse direction’s price.</p>
              ) : null}
            </>
          ) : (
            <p className="flex-note">No carrier rate for {country(from)} → {country(to)} yet. Pick another route.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function LaneTable() {
  const rows = useMemo(() => flexLaneTable({ sizes: TABLE_SIZES, sellers: 3 }), []);
  return (
    <section className="flex-panel flex-lanes" aria-labelledby="flex-lanes-title">
      <header className="flex-panel-head">
        <h2 id="flex-lanes-title">Every route we ship today</h2>
        <p>
          Tracked alone → Flex pickup for <strong>3 sellers</strong> dropping at a partner,
          with <strong>{FLEX_ASSUMPTIONS.defaultPickupPackets} packets</strong> in the city pickup pack.
        </p>
      </header>
      <div className="flex-table-wrap">
        <table className="flex-table">
          <thead>
            <tr>
              <th scope="col">Route</th>
              {TABLE_SIZES.map((size) => <th key={size} scope="col">{size} cards</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.from}-${row.to}`}>
                <th scope="row">{country(row.from)} → {country(row.to)}</th>
                {row.quotes.map((quote, index) => (
                  <td key={TABLE_SIZES[index]}>
                    {quote ? (
                      <>
                        <s><Money cents={quote.alone.cents} /></s>
                        {' '}<strong><Money cents={quote.flex.cents} /></strong>
                        <em>−{quote.savedPct}%</em>
                      </>
                    ) : '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function Flex() {
  const [stores, setStores] = useState(PLACEHOLDER_STORES);
  const average = useMemo(() => flexAverageSaving(), []);
  const example = useMemo(() => flexQuote({
    from: 'DK',
    to: 'IT',
    cards: 20,
    sellers: 3,
    pickupPackets: FLEX_ASSUMPTIONS.defaultPickupPackets,
  }), []);

  useEffect(() => {
    document.title = 'Pokoin Flex · Ship together, pay less · Pokoin';
    let cancelled = false;
    fetch('/api/pokoin-partner?action=directory')
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled || !Array.isArray(body?.stores) || !body.stores.length) return;
        setStores(body.stores);
      })
      .catch(() => { /* keep placeholders */ });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="page flex-page">
      <section className="flex-hero">
        <div className="flex-hero-copy">
          <p className="flex-kicker">Shipping <span>Coming soon</span></p>
          <h1 className="flex-title">
            <span className="sr-only">Pokoin Flex</span>
            <PokoinWordmark />
            <span className="flex-tag" aria-hidden="true">Flex</span>
          </h1>
          <p className="flex-lede">
            Ship together, pay less. Pack your cards in a padded Flex box, drop it at a partner shop,
            and it rides in one shared ~20 kg bag instead of its own half-empty parcel.
          </p>
          <div className="flex-stats">
            {average ? (
              <div><strong>{average.savedPct}%</strong><span>cheaper than tracked post on average, with partner pickup</span></div>
            ) : null}
            {example ? (
              <>
                <div><strong>{formatEur(example.flex.cents)}</strong><span>20 cards, 3 sellers, Denmark → Italy, instead of {formatEur(example.alone.cents)}</span></div>
                <div><strong>{example.pickupPackets}</strong><span>packets share the city pickup pack; the partner ships one pack for the 3 sellers</span></div>
              </>
            ) : null}
          </div>
          <div className="flex-cta">
            <a className="btn" href="#flex-calc">Calculate your saving</a>
            <Link className="btn ghost" to="/protection">Buyer protection</Link>
          </div>
        </div>
        <figure className="flex-hero-art">
          <img src={brandSrc('flex/flex-hero.svg')} alt="Small padded packs ride into one 20 kg Pokoin bag, then the sorting center, then a partner shop." width="960" height="290" />
          <img className="flex-hero-mascot" src={mascotUrl} alt="" width="26" height="24" />
        </figure>
      </section>

      <p className="flex-soon" role="status">
        Flex is not selectable at checkout yet. Tracked and untracked post stay live until partner shops open.
      </p>

      <Calculator />

      <section className="flex-steps" aria-labelledby="flex-steps-title">
        <h2 id="flex-steps-title">How Flex works</h2>
        <ol>
          {STEPS.map((step, index) => (
            <li key={step.art}>
              <img src={brandSrc(`flex/${step.art}.svg`)} alt="" width="120" height="120" />
              <span className="flex-step-n">{index + 1}</span>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <LaneTable />

      <section className="flex-split">
        <article className="flex-panel flex-boxcard">
          <img src={brandSrc('flex/flex-box.svg')} alt="" width="120" height="120" />
          <div>
            <h2>The Flex box</h2>
            <p>
              A sturdy outer shell padded on the inside, sized for sleeved cards and top loaders.
              Every pack in the bag looks the same, so partners load fast and nothing gets crushed
              on the trunk run.
            </p>
          </div>
        </article>
        <article className="flex-panel flex-why">
          <h2>Why one bag beats many parcels</h2>
          <p>
            A seller shipping alone pays for a whole parcel bracket even when the pack weighs a few
            grams. Flex fills one bag with many packs and runs one trunk move instead of dozens of
            half-empty ones — cheaper for everyone, and far fewer parcels on the road.
          </p>
        </article>
      </section>

      <section className="flex-panel flex-partners" aria-labelledby="flex-partners-title">
        <header className="flex-panel-head">
          <h2 id="flex-partners-title">Partner shops</h2>
          <p>Sample shops for now — the live list replaces this when Flex launches.</p>
        </header>
        <ul className="flex-stores">
          {stores.map((store) => (
            <li key={store.id || `${store.name}-${store.city}`}>
              <img src={brandSrc('flex/step-drop.svg')} alt="" width="44" height="44" />
              <span>
                <strong>{store.name}</strong>
                <em>{store.city}{store.country ? `, ${store.country}` : ''}</em>
              </span>
              {store.role ? <small>{store.role}</small> : null}
            </li>
          ))}
        </ul>
      </section>

      <details className="flex-panel flex-method">
        <summary>How the estimate is worked out</summary>
        <ul>
          <li><strong>Shipping alone</strong> is the rate Pokoin checkout uses today, once per seller, for that route and that seller’s card count — tracked or untracked letter, as you pick.</li>
          <li><strong>Phase 1 — partner shop.</strong> The sellers drop their Flex boxes. The partner ships <em>one</em> pack on the same route, sized to the cards inside. One seller means that pack is the same shipment as posting it yourself.</li>
          <li><strong>Phase 2 — city pickup.</strong> The magazine ships <em>one</em> pack to the partner shop in the destination country. The slider is how many buyer packets are in it. This order pays its seller packets’ share of that one shipment. Home delivery replaces this with one parcel to the buyer.</li>
          <li><strong>Weight.</strong> Each Flex box is {FLEX_ASSUMPTIONS.boxGrams} g plus {FLEX_ASSUMPTIONS.gramsPerCard} g per sleeved card. A hop at or under {FLEX_ASSUMPTIONS.parcelMaxGrams / 1000} kg uses the normal letter or parcel rate for that weight. Heavier than that, it uses the 20 kg bag rate, and another bag for each extra {FLEX_ASSUMPTIONS.bagGrams / 1000} kg.</li>
          <li><strong>Fixed costs</strong>: Flex box {formatEur(FLEX_ASSUMPTIONS.boxCents)}, partner handling {formatEur(FLEX_ASSUMPTIONS.handlingCents)} per seller packet.</li>
          <li>These are planning numbers — the final Flex price is set when partner shops open.</li>
        </ul>
      </details>
    </div>
  );
}
