import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  CONTACT_EMAIL,
  DISPUTE_DECISION,
  DISPUTE_REPLY,
  ESCROW_LINE,
  NO_SHIP_GUARANTEE,
  PROTECTION_PILLARS,
  PROTECTION_TITLE,
  SHIP_DAYS,
  contactMailto,
} from '../buyer-protection.js';
import '../protection.css';
import { brandSrc } from '../brand-assets.js';

const PILLAR_ICON = {
  'PKN escrow': 'M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 6c1.4 0 2.8 1.1 2.8 2.5V11c.6 0 1.2.6 1.2 1.3v3.5c0 .6-.6 1.2-1.3 1.2H9.2c-.6 0-1.2-.6-1.2-1.3v-3.5c0-.6.6-1.2 1.2-1.2V9.5C9.2 8.1 10.6 7 12 7zm0 1.2c-.8 0-1.5.5-1.5 1.3V11h3V9.5c0-.8-.7-1.3-1.5-1.3z',
  'Seller does not ship': 'M20 8h-3V4H3c-1.1 0-2 .9-2 2v11h2c0 1.66 1.34 3 3 3s3-1.34 3-3h6c0 1.66 1.34 3 3 3s3-1.34 3-3h2v-5l-3-4zM6 18.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm13.5-9 1.96 2.5H17V9.5h2.5zm-1.5 9c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z',
  Disputes: 'M21 6h-2v9H6v2c0 .55.45 1 1 1h11l4 4V7c0-.55-.45-1-1-1zm-4 6V3c0-.55-.45-1-1-1H3c-.55 0-1 .45-1 1v14l4-4h10c.55 0 1-.45 1-1z',
};

const MAIL_ICON = 'M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z';

const STEPS = [
  { title: 'You pay', text: 'Site PKN at checkout. Pokoin holds it in escrow — the seller gets nothing yet.' },
  { title: 'Seller ships', text: `Within ${SHIP_DAYS} days, and marks the order shipped on Orders.` },
  { title: 'You confirm', text: 'Mark it delivered when the card is in your hands and as described.' },
  { title: 'Seller is paid', text: 'Only then does Pokoin release your PKN to the seller.' },
];

function Icon({ d, size = 22 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path fill="currentColor" d={d} />
    </svg>
  );
}

export default function Protection() {
  useEffect(() => {
    document.title = 'Buyer protection · Pokoin';
  }, []);

  return (
    <div className="page protection-page">
      <section className="protection-hero">
        <div className="protection-hero-copy">
          <p className="protection-kicker">Card Reserve</p>
          <h1>Buyer protection</h1>
          <p className="protection-lede">{PROTECTION_TITLE}. Your PKN waits in escrow until the card is in your hands.</p>
          <ul className="protection-badges">
            <li><strong>{SHIP_DAYS} days</strong><span>No shipment → your PKN comes back</span></li>
            <li><strong>Escrow</strong><span>{ESCROW_LINE}</span></li>
            <li><strong>{DISPUTE_REPLY}</strong><span>First reply to any dispute</span></li>
          </ul>
        </div>
        <img
          className="protection-hero-art"
          src={brandSrc('protection/shield.svg')}
          alt="A shield holding a card and a locked PKN coin."
          width="320"
          height="300"
        />
      </section>

      <section className="protection-pillars" aria-label="What is covered">
        {PROTECTION_PILLARS.map((pillar) => (
          <article key={pillar.title}>
            <span className="protection-pillar-icon"><Icon d={PILLAR_ICON[pillar.title] || PILLAR_ICON.Disputes} /></span>
            <h2>{pillar.title}</h2>
            <p>{pillar.body}</p>
            {pillar.link ? (
              <a className="protection-mail-link" href={pillar.link.href}>
                <Icon d={MAIL_ICON} size={16} />
                {pillar.link.label}
              </a>
            ) : null}
          </article>
        ))}
      </section>

      <section className="protection-panel" aria-labelledby="protection-flow-title">
        <h2 id="protection-flow-title">How a physical order works</h2>
        <ol className="protection-flow">
          {STEPS.map((step, index) => (
            <li key={step.title}>
              <span className="protection-flow-n">{index + 1}</span>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </li>
          ))}
        </ol>
        <p className="protection-branch">
          <span aria-hidden="true">↳</span>
          {NO_SHIP_GUARANTEE} Open a dispute from Orders and we return the PKN.
        </p>
      </section>

      <section className="protection-panel protection-disputes" aria-labelledby="protection-disputes-title">
        <div>
          <h2 id="protection-disputes-title">Something went wrong?</h2>
          <p>
            Use <strong>Report a problem</strong> on the order — missing cards, wrong condition, or a
            seller that never shipped all go in the same thread. First reply within {DISPUTE_REPLY},
            decision within {DISPUTE_DECISION}.
          </p>
          <div className="protection-times">
            <div><strong>{DISPUTE_REPLY}</strong><span>first reply</span></div>
            <div><strong>{DISPUTE_DECISION}</strong><span>decision</span></div>
          </div>
        </div>
        <aside className="protection-contact">
          <p>Need it in writing? Email us with your order id.</p>
          <a className="protection-contact-mail" href={contactMailto()}>
            <Icon d={MAIL_ICON} />
            <span>{CONTACT_EMAIL}</span>
          </a>
          <Link className="btn" to="/orders">Report a problem on Orders</Link>
        </aside>
      </section>

      <aside className="protection-note">
        <strong>Digital-only orders</strong> are not held until delivery: those cards go into your
        collection as soon as you pay. Cards bought from a seller’s live shop are still mailed.
        Escrow covers Pokoin listings paid in PKN.
      </aside>

      <div className="protection-cta">
        <Link className="btn" to="/orders">Go to Orders</Link>
        <Link className="btn ghost" to="/marketplace">Browse the marketplace</Link>
        <Link className="btn ghost" to="/flex">Pokoin Flex shipping</Link>
      </div>
    </div>
  );
}
