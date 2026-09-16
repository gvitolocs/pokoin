import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  DISPUTE_DECISION,
  DISPUTE_REPLY,
  ESCROW_LINE,
  NO_SHIP_GUARANTEE,
  PROTECTION_PILLARS,
  PROTECTION_TITLE,
  SHIP_DAYS,
} from '../buyer-protection.js';
import { PageHead } from '../components/Desk.jsx';

export default function Protection() {
  useEffect(() => {
    document.title = 'Buyer protection · Pokoin';
  }, []);

  return (
    <div className="page desk protection-page">
      <PageHead
        kicker="Card Reserve"
        title="Buyer protection"
        lede={PROTECTION_TITLE}
      />
      <p className="protection-guarantee">{NO_SHIP_GUARANTEE}</p>
      <p className="protection-escrow">{ESCROW_LINE}</p>

      <div className="protection-pillars">
        {PROTECTION_PILLARS.map((pillar) => (
          <article key={pillar.title}>
            <h2>{pillar.title}</h2>
            <p>{pillar.body}</p>
          </article>
        ))}
      </div>

      <section className="protection-steps">
        <h2>How a physical order works</h2>
        <ol>
          <li>You pay in site PKN at checkout. Pokoin holds it.</li>
          <li>The seller ships within {SHIP_DAYS} days and marks the order shipped on Orders.</li>
          <li>You confirm delivery. Then we release PKN to the seller.</li>
          <li>If nothing ships, open a dispute from Orders. We return the PKN.</li>
        </ol>
      </section>

      <section className="protection-steps">
        <h2>Disputes</h2>
        <p>
          Use <strong>Report a problem</strong> on the order. First reply within {DISPUTE_REPLY}.
          We decide within {DISPUTE_DECISION}. Same thread: missing cards, wrong condition, or a
          seller that never shipped. Email <a href="mailto:contact@pokoin.com">contact@pokoin.com</a> if
          you need the order id in writing.
        </p>
        <p className="page-lede">
          NFT-only checkout is not escrow: those rows mint to your holdings as soon as you pay.
          CardTrader live buy-through still ships from that network; Pokoin escrow is for native
          Card Reserve listings paid in PKN.
        </p>
        <p>
          <Link className="btn" to="/orders">Orders</Link>
          {' '}
          <Link className="btn ghost" to="/marketplace">Marketplace</Link>
        </p>
      </section>
    </div>
  );
}
