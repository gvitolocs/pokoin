import { createSignal, Show } from 'solid-js';
import { APP } from '@market/punchouts.js';
import SeoHead from '../components/SeoHead.jsx';

const SITE = 'https://pokoin.com';
const ORG_ID = `${SITE}/#organization`;
const FOUNDER_ID = `${SITE}/about#giuseppe-vitolo`;
const team = (file) => `${import.meta.env.BASE_URL || '/'}team/${file}`;

const ABOUT_JSON_LD = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': ORG_ID,
      name: 'Pokoin',
      url: `${SITE}/`,
      logo: `${SITE}/pokoin-512.png`,
      email: 'contact@pokoin.com',
      foundingDate: '2026-09-27',
      foundingLocation: {
        '@type': 'Place',
        name: 'Aarhus, Denmark',
        address: { '@type': 'PostalAddress', addressLocality: 'Aarhus', addressCountry: 'DK' },
      },
      address: { '@type': 'PostalAddress', addressLocality: 'Aarhus', addressCountry: 'DK' },
      identifier: { '@type': 'PropertyValue', propertyID: 'CVR', value: '46804007' },
      founder: { '@id': FOUNDER_ID },
      sameAs: [
        'https://www.linkedin.com/company/pokoin/',
        'https://www.youtube.com/@pokoinpos',
        'https://x.com/PokoinPoS',
      ],
    },
    {
      '@type': 'Person',
      '@id': FOUNDER_ID,
      name: 'Giuseppe Vitolo',
      jobTitle: 'Founder & Full-Stack Developer',
      worksFor: { '@id': ORG_ID },
      affiliation: { '@type': 'CollegeOrUniversity', name: 'Aarhus University', url: 'https://www.au.dk/' },
      image: `${SITE}/market/team/giuseppe-vitolo.jpg`,
      sameAs: ['https://www.linkedin.com/in/gvitolocs/', 'https://gvitolo.vercel.app'],
    },
    {
      '@type': 'AboutPage',
      '@id': `${SITE}/about#page`,
      url: `${SITE}/about`,
      name: 'About · Pokoin',
      about: { '@id': ORG_ID },
    },
  ],
};

function IconCards() {
  return (
    <svg class="about-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="8" y="3.5" width="11.5" height="15.5" rx="2" />
      <rect x="4.5" y="5.5" width="11.5" height="15.5" rx="2" />
    </svg>
  );
}

function IconWallet() {
  return (
    <svg class="about-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path fill-rule="evenodd" d="M5.5 6.25h13A1.75 1.75 0 0 1 20.25 8v10.5A1.75 1.75 0 0 1 18.5 20.25h-13A1.75 1.75 0 0 1 3.75 18.5V8A1.75 1.75 0 0 1 5.5 6.25zm11.25 7.5a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z" />
      <rect x="4" y="4" width="16" height="1.75" rx="0.6" />
    </svg>
  );
}

function IconScan() {
  return (
    <svg class="about-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M8 4H6a2 2 0 0 0-2 2v2M16 4h2a2 2 0 0 1 2 2v2M4 16v2a2 2 0 0 0 2 2h2M20 16v2a2 2 0 0 1-2 2h-2" />
    </svg>
  );
}

function FounderAvatar() {
  const [failed, setFailed] = createSignal(false);
  return (
    <Show
      when={!failed()}
      fallback={<span class="about-founder-avatar about-founder-monogram" role="img" aria-label="Giuseppe Vitolo monogram">GV</span>}
    >
      <picture>
        <source type="image/webp" srcset={team('giuseppe-vitolo-256.webp')} />
        <img
          class="about-founder-avatar"
          src={team('giuseppe-vitolo-256.jpg')}
          width="256"
          height="256"
          loading="lazy"
          decoding="async"
          alt="Portrait of Giuseppe Vitolo, founder of Pokoin"
          onError={() => setFailed(true)}
        />
      </picture>
    </Show>
  );
}

/** One founder bubble: the page stays about Pokoin. */
function FounderSection() {
  return (
    <section class="about-section about-founder" aria-labelledby="about-founder-heading">
      <h2 id="about-founder-heading">The founder</h2>
      <figure class="about-founder-card" id="giuseppe-vitolo">
        <FounderAvatar />
        <figcaption>
          <h3 class="about-founder-name">
            Giuseppe Vitolo<span class="about-gold">.</span>
          </h3>
          <p class="about-founder-role">Founder &amp; Full-Stack Developer</p>
          <p class="about-founder-meta">Aarhus, Denmark · CVR 46804007</p>
          <div class="about-founder-links">
            <a href="https://www.linkedin.com/in/gvitolocs/" target="_blank" rel="noopener">
              LinkedIn<span aria-hidden="true"> ↗</span>
            </a>
            <a href="https://datacvr.virk.dk/enhed/virksomhed/46804007" target="_blank" rel="noopener">
              Company register<span aria-hidden="true"> ↗</span>
            </a>
          </div>
        </figcaption>
      </figure>
    </section>
  );
}

/** About page. */
export default function About() {
  return (
    <div class="page about-page">
      <SeoHead
        title="About · Pokoin"
        description="Pokoin is a collector-to-collector trading-card market founded in 2026 in Aarhus, Denmark, by Giuseppe Vitolo (CVR 46804007)."
        canonical="https://pokoin.com/about"
        jsonLd={ABOUT_JSON_LD}
      />
      <header class="about-hero">
        <div>
          <p class="page-kicker">Pokoin</p>
          <h1 class="about-title">
            <span>The market belongs to the collectors.</span>
            <span class="about-gold">Buy. Sell. Trade with collectors.</span>
          </h1>
          <p class="about-lede">A global peer-to-peer marketplace built for everyone.</p>
          <div class="about-actions">
            <a class="btn" href="/marketplace">Explore cards</a>
            <a class="btn ghost" href="/mypokoin">Start selling</a>
          </div>
        </div>
        <img class="about-mark" src="/home/logo.png" width="168" height="168" alt="" />
      </header>

      <section class="about-section about-story" aria-labelledby="about-story-heading">
        <div>
          <h2 id="about-story-heading">A collector market, not a listing farm.</h2>
          <p>
            Pokoin is peer-to-peer. You list a card. Another collector buys it.
            Pay by card or with PKN, Pokoin&rsquo;s store credit.
          </p>
          <p>
            Card Reserve is the shop. The wallet holds PKN. Scan identifies a card
            from a photo and opens the desk. Three surfaces. Same project.
          </p>
        </div>
        <ul class="about-facts">
          <li>
            <strong>Peer to peer</strong>
            <span>Collectors trade with collectors. Offers sit on the desk, not a house account.</span>
          </li>
          <li>
            <strong>Simple checkout</strong>
            <span>Pay by card or PKN.</span>
          </li>
          <li>
            <strong>Trusted sellers</strong>
            <span>Every offer comes from a real collector.</span>
          </li>
        </ul>
      </section>

      <section class="about-section" aria-labelledby="about-how-heading">
        <h2 id="about-how-heading">How it works</h2>
        <ol class="about-steps">
          <li>
            <span class="about-step-n">01</span>
            <h3>Browse</h3>
            <p>Search the catalog. Open a desk. See live seller offers on the card.</p>
          </li>
          <li>
            <span class="about-step-n">02</span>
            <h3>Buy or list</h3>
            <p>Pay by card or PKN, or put your own cards on the market from inventory.</p>
          </li>
          <li>
            <span class="about-step-n">03</span>
            <h3>Ship &amp; track</h3>
            <p>Orders stay visible from payment to delivery.</p>
          </li>
        </ol>
      </section>

      <section class="about-section" aria-labelledby="about-surfaces-heading">
        <h2 id="about-surfaces-heading">Shop. Scan. Collect.</h2>
        <p>Open any of them from this site. Native apps are not in the stores yet.</p>
        <div class="about-surfaces">
          <a class="about-surface" href="/marketplace">
            <IconCards />
            <h3>Card Reserve</h3>
            <p>Live Pokémon listings. Seller offers. Signal.</p>
          </a>
          <a class="about-surface" href={APP.wallet}>
            <IconWallet />
            <h3>Wallet</h3>
            <p>Your balance and order history.</p>
          </a>
          <a class="about-surface" href={APP.scan}>
            <IconScan />
            <h3>Scan</h3>
            <p>Explorer, health, and card camera.</p>
          </a>
        </div>
      </section>

      <FounderSection />

      <section class="about-section" aria-labelledby="about-contact-heading">
        <h2 id="about-contact-heading">Talk to us</h2>
        <p>
          Questions, privacy, or press:{' '}
          <a href="mailto:contact@pokoin.com">contact@pokoin.com</a>.
        </p>
        <div class="about-links">
          <a href={APP.contact}>Contact</a>
          <a href={APP.privacy}>Privacy</a>
          <a href={APP.forum}>Forum</a>
          <a href={APP.docs}>Network</a>
        </div>
      </section>

      <section class="about-cta" aria-labelledby="about-open-heading">
        <h2 id="about-open-heading">Open the market</h2>
        <p>Cards, scanning and your collection in the browser. No App Store or Play listing yet.</p>
        <div class="about-actions">
          <a class="btn" href="/marketplace">Marketplace</a>
          <a class="btn ghost" href="/mypokoin">Start selling</a>
        </div>
      </section>
    </div>
  );
}
