import { For, onSettled, Show } from 'solid-js';
import { brandSrc } from '@market/brand-assets.js';
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
} from '@market/buyer-protection.js';
import { PROTECTION_MAIL_ICON, PROTECTION_PILLAR_ICON, PROTECTION_STEPS } from '@market/protection-content.js';
import '@market/protection.css';

function Icon(props) {
  return (
    <svg viewBox="0 0 24 24" width={props.size ?? 22} height={props.size ?? 22} aria-hidden="true">
      <path fill="currentColor" d={props.d} />
    </svg>
  );
}

/** /protection: buyer protection, static. */
export default function Protection() {
  onSettled(() => {
    document.title = 'Buyer protection · Pokoin';
  });

  return (
    <div class="page protection-page">
      <section class="protection-hero">
        <div class="protection-hero-copy">
          <p class="protection-kicker">Card Reserve</p>
          <h1>Buyer protection</h1>
          <p class="protection-lede">{PROTECTION_TITLE}. Your PKN waits in escrow until the card is in your hands.</p>
          <ul class="protection-badges">
            <li><strong>{SHIP_DAYS} days</strong><span>No shipment → your PKN comes back</span></li>
            <li><strong>Escrow</strong><span>{ESCROW_LINE}</span></li>
            <li><strong>{DISPUTE_REPLY}</strong><span>First reply to any dispute</span></li>
          </ul>
        </div>
        <img
          class="protection-hero-art"
          src={brandSrc('protection/shield.svg')}
          alt="A shield holding a card and a locked PKN coin."
          width="320"
          height="300"
        />
      </section>

      <section class="protection-pillars" aria-label="What is covered">
        <For each={PROTECTION_PILLARS}>
          {(pillar) => (
            <article>
              <span class="protection-pillar-icon">
                <Icon d={PROTECTION_PILLAR_ICON[pillar.title] || PROTECTION_PILLAR_ICON.Disputes} />
              </span>
              <h2>{pillar.title}</h2>
              <p>{pillar.body}</p>
              <Show when={pillar.link}>
                <a class="protection-mail-link" href={pillar.link.href}>
                  <Icon d={PROTECTION_MAIL_ICON} size={16} />
                  {pillar.link.label}
                </a>
              </Show>
            </article>
          )}
        </For>
      </section>

      <section class="protection-panel" aria-labelledby="protection-flow-title">
        <h2 id="protection-flow-title">How a physical order works</h2>
        <ol class="protection-flow">
          <For each={PROTECTION_STEPS}>
            {(step, index) => (
              <li>
                <span class="protection-flow-n">{index() + 1}</span>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </li>
            )}
          </For>
        </ol>
        <p class="protection-branch">
          <span aria-hidden="true">↳</span>
          {NO_SHIP_GUARANTEE} Open a dispute from Orders and we return the PKN.
        </p>
      </section>

      <section class="protection-panel protection-disputes" aria-labelledby="protection-disputes-title">
        <div>
          <h2 id="protection-disputes-title">Something went wrong?</h2>
          <p>
            Use <strong>Report a problem</strong> on the order — missing cards, wrong condition, or a
            seller that never shipped all go in the same thread. First reply within {DISPUTE_REPLY},
            decision within {DISPUTE_DECISION}.
          </p>
          <div class="protection-times">
            <div><strong>{DISPUTE_REPLY}</strong><span>first reply</span></div>
            <div><strong>{DISPUTE_DECISION}</strong><span>decision</span></div>
          </div>
        </div>
        <aside class="protection-contact">
          <p>Need it in writing? Email us with your order id.</p>
          <a class="protection-contact-mail" href={contactMailto()}>
            <Icon d={PROTECTION_MAIL_ICON} />
            <span>{CONTACT_EMAIL}</span>
          </a>
          <a class="btn" href="/orders">Report a problem on Orders</a>
        </aside>
      </section>

      <aside class="protection-note">
        <strong>Digital-only orders</strong> are not held until delivery: those cards go into your
        collection as soon as you pay. Cards bought from a seller’s live shop are still mailed.
        Escrow covers Pokoin listings paid in PKN.
      </aside>

      <div class="protection-cta">
        <a class="btn" href="/orders">Go to Orders</a>
        <a class="btn ghost" href="/marketplace">Browse the marketplace</a>
        <a class="btn ghost" href="/flex">Pokoin Flex shipping</a>
      </div>
    </div>
  );
}
