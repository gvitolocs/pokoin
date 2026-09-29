import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHead } from '../components/Desk.jsx';

/** Fallback until GET /api/pokoin-partner?action=directory is live with real shops. */
const PLACEHOLDER_STORES = [
  { id: 'milan-ace', name: 'Ace Hobby', city: 'Milan', country: 'Italy', role: 'drop-off + pick-up' },
  { id: 'berlin-deck', name: 'Deck & Dice', city: 'Berlin', country: 'Germany', role: 'drop-off + pick-up' },
  { id: 'lisbon-cardforge', name: 'Cardforge', city: 'Lisbon', country: 'Portugal', role: 'drop-off + pick-up' },
  { id: 'copenhagen-tabletop', name: 'Tabletop North', city: 'Copenhagen', country: 'Denmark', role: 'pick-up' },
];

export default function Flex() {
  const [stores, setStores] = useState(PLACEHOLDER_STORES);

  useEffect(() => {
    document.title = 'Pokoin Flex · Pokoin';
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
    <div className="page desk flex-page">
      <PageHead
        kicker="Shipping"
        title={(
          <span className="pokoin-flex-mark" aria-label="Pokoin Flex">
            <img className="pokoin-flex-logo" src="/home/logo.png" alt="" width="40" height="40" />
            <span className="pokoin-flex-word">
              <span className="pokoin-flex-pokoin">Pokoin</span>
              {' '}
              <span className="pokoin-flex-flex">Flex</span>
            </span>
          </span>
        )}
        lede="Pack yourself in Pokoin Flex boxes (sturdy, padded inside), drop at a partner, ride a full ~20 kg Pokoin bag to the sorting center — then partner pickup or home. Coming soon; not selectable at checkout yet."
      >
        <Link className="btn ghost" to="/checkout">Checkout</Link>
        <Link className="btn ghost" to="/protection">Buyer protection</Link>
      </PageHead>

      <p className="flex-soon" role="status">
        Pokoin Flex is unavailable at checkout for now. Tracked and untracked post stay live.
      </p>

      <section className="flex-section">
        <h2>What Flex is</h2>
        <p>
          You pack your cards. You pay less than normal door shipping. You bring that pack to a
          Pokoin Flex partner shop. The shop does not pack for you — it only loads your pack (and
          everyone else’s) into one bigger Pokoin bag, aimed at about <strong>20 kg</strong>.
        </p>
        <p>
          Flex uses <strong>specific shipment equipment</strong>: sturdy boxes padded on the inside,
          so cards travel protected for the whole trunk run — not a random mailer.
        </p>
        <p>
          That bag goes to the <strong>Pokoin sorting center</strong>. From there it continues either
          to another Flex partner for pickup, or onward toward home delivery when that path is open.
        </p>
      </section>

      <section className="flex-section">
        <h2>Why not ship alone</h2>
        <p>
          CardTrader Zero–style lanes often charge sellers for a shipping bracket (say ~€10) while the
          real parcel is only a couple of kilos against a ~20 kg threshold — most of the paid capacity
          is empty. Flex fills that bag with many seller packs and runs <em>one</em> trunk move instead
          of many half-empty ones. Everyone pays less; the street sees fewer parcels.
        </p>
        <p className="page-lede">
          Flex is the environmentally responsible choice on Pokoin: fewer packets on the road, less
          shipping overall, same cards delivered.
        </p>
      </section>

      <section className="flex-section">
        <h2>How it works</h2>
        <div className="flex-columns">
          <article>
            <h3>1 · You pack</h3>
            <ol>
              <li>Pack the cards yourself in a Flex box — sturdy shell, padded inside.</li>
              <li>Choose Flex at checkout when it is live (cheaper than normal shipping).</li>
              <li>Bring your pack to a partner point.</li>
            </ol>
          </article>
          <article>
            <h3>2 · Partner bag</h3>
            <ol>
              <li>Shop scans your drop-off.</li>
              <li>Your pack goes into the shared Pokoin bag (~20 kg target).</li>
              <li>When the bag is ready, it ships to the Pokoin sorting center.</li>
            </ol>
          </article>
          <article>
            <h3>3 · Sort &amp; finish</h3>
            <ol>
              <li>Sorting center opens the trunk bag.</li>
              <li>Packets go to another Flex partner for pickup, or toward home.</li>
              <li>Buyers collect with a code / QR — only their pack.</li>
            </ol>
          </article>
        </div>
      </section>

      <section className="flex-section">
        <h2>Partner stores</h2>
        <p className="page-lede">
          Sample places for the layout. Live shops replace this list when Flex launches.
        </p>
        <ul className="flex-stores">
          {stores.map((store) => (
            <li key={store.id || `${store.name}-${store.city}`}>
              <strong>{store.name}</strong>
              <span>
                {store.city}{store.country ? `, ${store.country}` : ''}
                {store.role ? ` · ${store.role}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex-section">
        <h2>Partner app</h2>
        <p>
          Store staff will scan drop-offs, fill the ~20 kg Pokoin bag, and hand packets to buyers.
          The HTTP surface is
          {' '}
          <code>/api/pokoin-partner</code>
          ; mutating actions still return
          {' '}
          <code>coming_soon</code>
          .
        </p>
      </section>
    </div>
  );
}
