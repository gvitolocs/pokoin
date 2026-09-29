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
  const [fill, setFill] = useState(Math.round(FLEX_ASSUMPTIONS.defaultBagFill * 100));

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
      bagFill: fill / 100,
    })
    : null;
  const pickup = routeReady && delivery === 'home'
    ? flexQuote({
      from,
      to,
      cards,
      sellers,
      tracked: effectiveTracked,
      bagFill: fill / 100,
    })
    : null;
  const parts = quote?.flex.parts;
  const alone = quote?.alone.cents || 0;
  const bar = (value) => `${Math.max(0, Math.min(100, (value / Math.max(1, alone)) * 100))}%`;

  return (
    <section id="flex-calc" className="flex-panel flex-calc" aria-labelledby="flex-calc-title">
      <header className="flex-panel-head">
        <h2 id="flex-calc-title">What you’d save</h2>
        <p>
          “Alone” is what checkout charges when each seller posts their own pack. Flex is the same
          cards as Flex boxes sharing one ~20 kg bag — how it’s worked out is at the bottom of the page.
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
              onChange={(event) => setSellers(Number(event.target.value))}
            />
            <small className="flex-range-hint">
              {sellers === 1
                ? 'One seller ships every card alone — Flex shines with several packs in one bag.'
                : `${sellers} sellers · ~${Math.ceil(cards / sellers)} cards each · ${sellers} parcels alone vs 1 shared bag`}
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
          <label className="flex-range">
            <span>How full the bag gets <strong>{fill}%</strong></span>
            <input type="range" min="25" max="100" step="5" value={fill} onChange={(event) => setFill(Number(event.target.value))} />
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
                  <>Flex is not cheaper with one seller{delivery === 'home' ? ' and home delivery' : ''} here</>
                ) : (
                  <>Flex is not cheaper here</>
                )}
              </p>
              {quote.savedCents <= 0 && sellers === 1 && pickup && pickup.savedCents > 0 ? (
                <p className="flex-note">
                  Home delivery inside {country(to)} costs about what posting it yourself does.
                  With partner pickup this pack is <strong><Money cents={pickup.flex.cents} /></strong> —
                  {' '}{pickup.savedPct}% less. Add more sellers to see Flex fill a shared bag.
                </p>
              ) : null}
              {quote.sellers > 1 ? (
                <p className="flex-note">
                  {quote.sellers} sellers · {quote.perSellerCards} cards each · {quote.sellers} parcels alone
                  become {quote.sellers} Flex boxes in one bag.
                </p>
              ) : null}
              <div className="flex-bars" aria-hidden="true">
                <div className="flex-bar is-alone"><span style={{ width: '100%' }} /></div>
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
                  <i className="p-trunk" />Share of the bag <Money cents={parts.trunk} />
                  <small>
                    {quote.totalGrams} g of a {Math.round(FLEX_ASSUMPTIONS.bagGrams * quote.bagFill / 1000)} kg bag ·
                    {' '}one {quote.trunk.carrier} parcel {country(from)} → {country(to)} = <Money cents={quote.trunk.cents} /> per bag
                  </small>
                </li>
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
                <strong>{quote.packsPerBag}</strong> packs like each seller’s fill one bag —
                {' '}{quote.packsPerBag} parcels become 2 bag moves.
              </p>
              {quote.trunk.estimated ? (
                <p className="flex-note">This route has no parcel rate yet in one direction, so the bag uses the reverse direction’s price.</p>
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
        <p>Tracked alone → Flex pickup for <strong>3 sellers</strong> splitting that card count, 60% full bag.</p>
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
  const example = useMemo(() => flexQuote({ from: 'DK', to: 'IT', cards: 20 }), []);

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
                <div><strong>{formatEur(example.flex.cents)}</strong><span>20 cards Denmark → Italy, instead of {formatEur(example.alone.cents)}</span></div>
                <div><strong>{example.packsPerBag}</strong><span>packs share one bag instead of {example.packsPerBag} parcels</span></div>
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
          <li><strong>Shipping alone</strong> is the rate Pokoin checkout uses today for that route and pack size (4 / 20 / 50 / more cards) — tracked or untracked letter, as you pick.</li>
          <li><strong>The bag</strong> travels as one parcel on the same route at the carrier’s largest parcel rate. A route with no direct rate borrows the reverse direction.</li>
          <li><strong>Your share</strong> is your pack’s weight ({FLEX_ASSUMPTIONS.boxGrams} g box + {FLEX_ASSUMPTIONS.gramsPerCard} g per sleeved card) out of a {FLEX_ASSUMPTIONS.bagGrams / 1000} kg bag at the fill level you choose.</li>
          <li><strong>Fixed costs</strong>: Flex box {formatEur(FLEX_ASSUMPTIONS.boxCents)}, partner handling {formatEur(FLEX_ASSUMPTIONS.handlingCents)} per pack. Home delivery adds <em>one</em> hop from the Pokoin warehouse to the buyer (all packs already consolidated — not one delivery per seller).</li>
          <li>These are planning numbers — the final Flex price is set when partner shops open.</li>
        </ul>
      </details>
    </div>
  );
}
