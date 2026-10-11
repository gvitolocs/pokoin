import { createEffect, createMemo, createSignal, For, onSettled, Show } from 'solid-js';
import { fetchSellerSettings } from '@market/api.js';
import mascotUrl from '@market/assets/pokoin-mascot@8x.png';
import { brandSrc } from '@market/brand-assets.js';
import {
  FLEX_PLACEHOLDER_STORES,
  FLEX_STEPS,
  FLEX_TABLE_SIZES,
  fetchFlexStores,
  flexServiceChoices,
} from '@market/flex-content.js';
import {
  FLEX_ASSUMPTIONS,
  flexAverageSaving,
  flexCountries,
  flexLaneTable,
  flexQuote,
  formatEur,
  routeServices,
} from '@market/flex-savings.js';
import { resolveFlexDefaultCountries } from '@market/flex-user-country.js';
import { shipFromCountryName } from '@market/ship-countries.js';
import PokoinWordmark from '../components/PokoinWordmark.jsx';
import { authReady, getBearer, signedIn } from '../stores/auth.js';
import '@market/flex.css';

/** Plain names: flag emoji render as boxes on Windows and many Linux fonts. */
function country(code) {
  return shipFromCountryName(code) || code;
}

function Calculator() {
  const countries = flexCountries();
  const [from, setFrom] = createSignal('');
  const [to, setTo] = createSignal('');
  const [routeReady, setRouteReady] = createSignal(false);
  const [cards, setCards] = createSignal(20);
  const [sellers, setSellers] = createSignal(3);
  const [tracked, setTracked] = createSignal(null);
  const [delivery, setDelivery] = createSignal('pickup');
  const [pickupPackets, setPickupPackets] = createSignal(FLEX_ASSUMPTIONS.defaultPickupPackets);

  // Default route once auth answered: the profile country when signed in, else the visitor's.
  createEffect(
    () => (authReady() && !routeReady() ? (signedIn() ? 'in' : 'out') : ''),
    (state) => {
      if (!state) return undefined;
      let cancelled = false;
      resolveFlexDefaultCountries({
        allowedFrom: countries.from,
        allowedTo: countries.to,
        signedIn: state === 'in',
        loadProfileCountry: state === 'in'
          ? async () => {
            const token = await getBearer();
            if (!token) return '';
            const settings = await fetchSellerSettings(token);
            return String(settings?.shipFromCountry || '').trim().toUpperCase();
          }
          : null,
      }).then((defaults) => {
        if (cancelled) return;
        setFrom(defaults.from);
        setTo(defaults.to);
        setRouteReady(true);
      });
      return () => {
        cancelled = true;
      };
    },
  );

  const perSeller = () => Math.max(1, Math.ceil(cards() / Math.max(1, sellers())));
  const services = createMemo(() => (routeReady() ? routeServices({ from: from(), to: to(), cards: perSeller() }) : []));
  const serviceChoices = createMemo(() => flexServiceChoices(services()));
  const effectiveTracked = () => (tracked() != null ? tracked() : (serviceChoices()[0]?.tracked ?? true));
  const quote = createMemo(() => (routeReady()
    ? flexQuote({
      from: from(),
      to: to(),
      cards: cards(),
      sellers: sellers(),
      tracked: effectiveTracked(),
      delivery: delivery(),
      pickupPackets: pickupPackets(),
    })
    : null));
  const parts = () => quote()?.flex.parts;
  const scale = () => Math.max(quote()?.alone.cents || 0, quote()?.flex.cents || 0, 1);
  const bar = (value) => `${Math.max(0, Math.min(100, (value / scale()) * 100))}%`;

  return (
    <section id="flex-calc" class="flex-panel flex-calc" aria-labelledby="flex-calc-title">
      <header class="flex-panel-head">
        <h2 id="flex-calc-title">What you’d save</h2>
        <p>
          “Alone” is what checkout charges when each seller posts their own pack. Flex is two
          shipments: the partner sends one pack for the sellers who dropped off, then the magazine
          sends one pack to the city pickup.
        </p>
      </header>
      <div class="flex-calc-grid">
        <form class="flex-calc-inputs" onSubmit={(event) => event.preventDefault()}>
          <div class="flex-route">
            <label>
              <span>From</span>
              <select value={from()} onChange={(event) => setFrom(event.target.value)}>
                <For each={countries.from}>{(code) => <option value={code}>{country(code)}</option>}</For>
              </select>
            </label>
            <span class="flex-route-arrow" aria-hidden="true">→</span>
            <label>
              <span>To</span>
              <select value={to()} onChange={(event) => setTo(event.target.value)}>
                <For each={countries.to}>{(code) => <option value={code}>{country(code)}</option>}</For>
              </select>
            </label>
          </div>
          <label class="flex-range">
            <span>Cards in the order <strong>{cards()}</strong></span>
            <input type="range" min="1" max="60" value={cards()} onInput={(event) => setCards(Number(event.target.value))} />
          </label>
          <label class="flex-range">
            <span>Sellers <strong>{sellers()}</strong></span>
            <input
              type="range"
              min="1"
              max={FLEX_ASSUMPTIONS.maxSellers}
              value={sellers()}
              onInput={(event) => {
                const next = Number(event.target.value);
                setSellers(next);
                setPickupPackets((current) => Math.max(current, next));
              }}
            />
            <small class="flex-range-hint">
              {sellers() === 1
                ? 'One seller is one direct shipment. Flex adds a box, handling, and a second hop, so it costs more.'
                : `${sellers()} sellers drop at the partner · ~${Math.ceil(cards() / sellers())} cards each · the partner ships one pack instead of ${sellers()}`}
            </small>
          </label>
          <fieldset class="flex-seg flex-services">
            <legend>Ship alone with</legend>
            <For each={serviceChoices()}>
              {(row) => (
                <label class={{ 'is-on': quote()?.alone.id === row.id }}>
                  <input
                    type="radio"
                    name="flex-service"
                    value={row.tracked ? 'tracked' : 'untracked'}
                    checked={(tracked() ?? effectiveTracked()) === row.tracked}
                    onChange={() => setTracked(row.tracked)}
                  />
                  <span>{row.tracked ? 'Tracked' : 'Untracked letter'}</span>
                  <small>
                    {row.carrier} · {formatEur(row.cents)}
                    {sellers() > 1 ? ` × ${sellers()} = ${formatEur(row.cents * sellers())}` : ''}
                  </small>
                </label>
              )}
            </For>
          </fieldset>
          <fieldset class="flex-seg">
            <legend>Delivery</legend>
            <For each={[['pickup', 'Partner pickup'], ['home', 'Home delivery']]}>
              {([value, label]) => (
                <label class={{ 'is-on': delivery() === value }}>
                  <input type="radio" name="flex-delivery" value={value} checked={delivery() === value} onChange={() => setDelivery(value)} />
                  {label}
                </label>
              )}
            </For>
          </fieldset>
          <label class={['flex-range', { 'is-off': delivery() === 'home' }]}>
            <span>Packets in the city pickup pack <strong>{delivery() === 'home' ? '—' : pickupPackets()}</strong></span>
            <input
              type="range"
              min={sellers()}
              max={FLEX_ASSUMPTIONS.maxPickupPackets}
              value={Math.max(pickupPackets(), sellers())}
              disabled={delivery() === 'home'}
              onInput={(event) => setPickupPackets(Number(event.target.value))}
            />
            <small class="flex-range-hint">
              {delivery() === 'home'
                ? 'Home delivery is one parcel from the magazine to the buyer. This slider is the shared pack people collect at a partner.'
                : `The magazine ships one pack to the partner shop. ${pickupPackets()} buyer ${pickupPackets() === 1 ? 'packet shares' : 'packets share'} it · this order is ${sellers()} of them.`}
            </small>
          </label>
        </form>

        <div class="flex-calc-result" aria-live="polite">
          <Show
            when={quote()}
            fallback={<p class="flex-note">No carrier rate for {country(from())} → {country(to())} yet. Pick another route.</p>}
          >
            {(q) => (
              <>
                <div class="flex-compare">
                  <div class="is-alone">
                    <span>Shipping alone</span>
                    <strong>{formatEur(q().alone.cents)}</strong>
                    <em>
                      {q().sellers > 1
                        ? `${q().sellers}× ${q().alone.carrier} · ${q().alone.service}`
                        : `${q().alone.carrier} · ${q().alone.service}`}
                    </em>
                  </div>
                  <div class="is-flex">
                    <span>With Flex</span>
                    <strong>{formatEur(q().flex.cents)}</strong>
                    <em>{delivery() === 'home' ? `home delivery, ${q().lastMile.tracked ? 'tracked' : 'untracked'}` : 'pickup at a partner'}</em>
                  </div>
                </div>
                <p class={['flex-saving', { 'is-none': !(q().savedCents > 0) }]}>
                  <Show
                    when={q().savedCents > 0}
                    fallback={sellers() === 1
                      ? <>One seller is one direct shipment. Flex costs <strong>{formatEur(-q().savedCents)}</strong> more here</>
                      : <>Flex is not cheaper here</>}
                  >
                    You save <strong>{formatEur(q().savedCents)}</strong> · {q().savedPct}% on this order
                  </Show>
                </p>
                <Show
                  when={q().sellers === 1}
                  fallback={(
                    <p class="flex-note">
                      {q().sellers} seller packets become one partner shipment
                      {delivery() === 'pickup' && q().city
                        ? `. The city pack holds ${q().pickupPackets} packets; this order pays for ${q().sellers} of them.`
                        : '. Home delivery is one parcel for the whole order, not one per seller.'}
                    </p>
                  )}
                >
                  <p class="flex-note">
                    The partner still ships one pack, the same size as posting these cards yourself,
                    plus the Flex box and handling
                    {delivery() === 'pickup'
                      ? ', and the magazine still sends a pack to the city pickup.'
                      : ', and home delivery is a second parcel.'}
                  </p>
                </Show>
                <div class="flex-bars" aria-hidden="true">
                  <div class="flex-bar is-alone"><span style={{ width: bar(q().alone.cents) }} /></div>
                  <div class="flex-bar is-flex">
                    <span class="p-box" style={{ width: bar(parts().box) }} />
                    <span class="p-handling" style={{ width: bar(parts().handling) }} />
                    <span class="p-trunk" style={{ width: bar(parts().trunk) }} />
                    <span class="p-last" style={{ width: bar(parts().lastMile) }} />
                  </div>
                </div>
                <ul class="flex-breakdown">
                  <li>
                    <i class="p-box" />Flex box{q().sellers > 1 ? ` ×${q().sellers}` : ''} {formatEur(parts().box)}
                  </li>
                  <li>
                    <i class="p-handling" />Partner handling{q().sellers > 1 ? ` ×${q().sellers}` : ''} {formatEur(parts().handling)}
                  </li>
                  <li>
                    <i class="p-trunk" />Partner ships one pack {formatEur(parts().trunk)}
                    <small>
                      {q().sellers} seller {q().sellers === 1 ? 'packet' : 'packets'} · {q().totalGrams} g ·
                      {' '}{q().intake.carrier} · {q().intake.service} · {country(from())} → {country(to())}
                      {q().intake.tier === 'EXTRA_LARGE'
                        ? ` · ${q().intake.bags} × 20 kg bag`
                        : ' · same size class as a normal parcel'}
                    </small>
                  </li>
                  <Show when={q().city}>
                    <li>
                      <i class="p-last" />
                      City pickup pack {formatEur(parts().lastMile)}
                      <small>
                        Magazine → partner in {country(to())} · {q().city.carrier} · {q().city.service} ·
                        {' '}{q().pickupPackets} {q().pickupPackets === 1 ? 'packet' : 'packets'} in the pack · this order is {q().sellers} ·
                        {' '}full pack {formatEur(q().city.cents)}
                      </small>
                    </li>
                  </Show>
                  <Show when={q().lastMile}>
                    <li>
                      <i class="p-last" />
                      Home delivery (one parcel from the Pokoin warehouse) {formatEur(parts().lastMile)}
                      <small>
                        {q().lastMile.carrier} · {q().lastMile.service} · {q().totalGrams} g inside {country(to())}
                      </small>
                    </li>
                  </Show>
                </ul>
                <p class="flex-road">
                  A 20 kg bag holds <strong>{q().packsPerBag}</strong> packs this size.
                  This quote prices the two hops from the packets you set, not from a guessed fill.
                </p>
                <Show when={q().intake.estimated || q().city?.estimated}>
                  <p class="flex-note">This route has no parcel rate yet in one direction, so that hop uses the reverse direction’s price.</p>
                </Show>
              </>
            )}
          </Show>
        </div>
      </div>
    </section>
  );
}

function LaneTable() {
  const rows = flexLaneTable({ sizes: FLEX_TABLE_SIZES, sellers: 3 });
  return (
    <section class="flex-panel flex-lanes" aria-labelledby="flex-lanes-title">
      <header class="flex-panel-head">
        <h2 id="flex-lanes-title">Every route we ship today</h2>
        <p>
          Tracked alone → Flex pickup for <strong>3 sellers</strong> dropping at a partner,
          with <strong>{FLEX_ASSUMPTIONS.defaultPickupPackets} packets</strong> in the city pickup pack.
        </p>
      </header>
      <div class="flex-table-wrap">
        <table class="flex-table">
          <thead>
            <tr>
              <th scope="col">Route</th>
              <For each={FLEX_TABLE_SIZES}>{(size) => <th scope="col">{size} cards</th>}</For>
            </tr>
          </thead>
          <tbody>
            <For each={rows}>
              {(row) => (
                <tr>
                  <th scope="row">{country(row.from)} → {country(row.to)}</th>
                  <For each={row.quotes}>
                    {(quote) => (
                      <td>
                        <Show when={quote} fallback="—">
                          <s>{formatEur(quote.alone.cents)}</s>
                          {' '}<strong>{formatEur(quote.flex.cents)}</strong>
                          <em>−{quote.savedPct}%</em>
                        </Show>
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** /flex: Pokoin Flex shipping, calculator and partner shops. */
export default function Flex() {
  const [stores, setStores] = createSignal(FLEX_PLACEHOLDER_STORES);
  const average = flexAverageSaving();
  const example = flexQuote({
    from: 'DK',
    to: 'IT',
    cards: 20,
    sellers: 3,
    pickupPackets: FLEX_ASSUMPTIONS.defaultPickupPackets,
  });

  onSettled(() => {
    document.title = 'Pokoin Flex · Ship together, pay less · Pokoin';
    let cancelled = false;
    fetchFlexStores().then((list) => {
      if (!cancelled && list) setStores(() => list);
    });
    return () => {
      cancelled = true;
    };
  });

  return (
    <div class="page flex-page">
      <section class="flex-hero">
        <div class="flex-hero-copy">
          <p class="flex-kicker">Shipping <span>Coming soon</span></p>
          <h1 class="flex-title">
            <span class="sr-only">Pokoin Flex</span>
            <PokoinWordmark />
            <span class="flex-tag" aria-hidden="true">Flex</span>
          </h1>
          <p class="flex-lede">
            Ship together, pay less. Pack your cards in a padded Flex box, drop it at a partner shop,
            and it rides in one shared ~20 kg bag instead of its own half-empty parcel.
          </p>
          <div class="flex-stats">
            <Show when={average}>
              <div><strong>{average.savedPct}%</strong><span>cheaper than tracked post on average, with partner pickup</span></div>
            </Show>
            <Show when={example}>
              <div><strong>{formatEur(example.flex.cents)}</strong><span>20 cards, 3 sellers, Denmark → Italy, instead of {formatEur(example.alone.cents)}</span></div>
              <div><strong>{example.pickupPackets}</strong><span>packets share the city pickup pack; the partner ships one pack for the 3 sellers</span></div>
            </Show>
          </div>
          <div class="flex-cta">
            <a class="btn" href="#flex-calc">Calculate your saving</a>
            <a class="btn ghost" href="/protection">Buyer protection</a>
          </div>
        </div>
        <figure class="flex-hero-art">
          <img src={brandSrc('flex/flex-hero.svg')} alt="Small padded packs ride into one 20 kg Pokoin bag, then the sorting center, then a partner shop." width="960" height="290" />
          <img class="flex-hero-mascot" src={mascotUrl} alt="" width="26" height="24" />
        </figure>
      </section>

      <p class="flex-soon" role="status">
        Flex is not selectable at checkout yet. Tracked and untracked post stay live until partner shops open.
      </p>

      <Calculator />

      <section class="flex-steps" aria-labelledby="flex-steps-title">
        <h2 id="flex-steps-title">How Flex works</h2>
        <ol>
          <For each={FLEX_STEPS}>
            {(step, index) => (
              <li>
                <img src={brandSrc(`flex/${step.art}.svg`)} alt="" width="120" height="120" />
                <span class="flex-step-n">{index() + 1}</span>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </li>
            )}
          </For>
        </ol>
      </section>

      <LaneTable />

      <section class="flex-split">
        <article class="flex-panel flex-boxcard">
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
        <article class="flex-panel flex-why">
          <h2>Why one bag beats many parcels</h2>
          <p>
            A seller shipping alone pays for a whole parcel bracket even when the pack weighs a few
            grams. Flex fills one bag with many packs and runs one trunk move instead of dozens of
            half-empty ones — cheaper for everyone, and far fewer parcels on the road.
          </p>
        </article>
      </section>

      <section class="flex-panel flex-partners" aria-labelledby="flex-partners-title">
        <header class="flex-panel-head">
          <h2 id="flex-partners-title">Partner shops</h2>
          <p>Sample shops for now — the live list replaces this when Flex launches.</p>
        </header>
        <ul class="flex-stores">
          <For each={stores()}>
            {(store) => (
              <li>
                <img src={brandSrc('flex/step-drop.svg')} alt="" width="44" height="44" />
                <span>
                  <strong>{store.name}</strong>
                  <em>{store.city}{store.country ? `, ${store.country}` : ''}</em>
                </span>
                <Show when={store.role}><small>{store.role}</small></Show>
              </li>
            )}
          </For>
        </ul>
      </section>

      <details class="flex-panel flex-method">
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
