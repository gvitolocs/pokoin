import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { cardHref, fetchExpansion, imageSrc, peekExpansion } from '../api.js';
import { printingIdentity } from '../identity.js';
import { Action, track } from '../track.js';
import CardArt from './CardArt.jsx';

const PROMO_LIMIT = 48;
const PROMO_INTERVAL_MS = 5500;

/** Newest English sets the catalog actually carries, presented like tcg.pokemon.com. */
export const PROMO_BANNERS = [
  {
    slug: 'mega-evolution',
    series: 'Mega Evolution',
    title: 'Mega Evolution',
    lede: 'The first Mega Evolution set is on the floor. Chase Mega Lucario ex.',
    cta: 'View cards from this expansion',
  },
  {
    slug: 'phantasmal-flames',
    series: 'Mega Evolution',
    title: 'Phantasmal Flames',
    lede: 'The second Mega Evolution set is on the floor. Chase Mega Charizard X ex.',
    cta: 'View cards from this expansion',
  },
  {
    slug: 'black-bolt',
    series: 'Black & White',
    title: 'Black Bolt',
    lede: 'Unova returns in black. Zekrom ex and the chase holos.',
    cta: 'View cards from this expansion',
  },
  {
    slug: 'white-flare',
    series: 'Black & White',
    title: 'White Flare',
    lede: 'Unova in white. Reshiram ex and the set’s secret rares.',
    cta: 'View cards from this expansion',
  },
  {
    slug: 'destined-rivals',
    series: 'Scarlet & Violet',
    title: 'Destined Rivals',
    lede: 'Team Rocket and other legendary characters. The rivalries collectors want.',
    cta: 'View cards from this expansion',
  },
];

function isSecretRare(card) {
  const identity = printingIdentity(card);
  const rarity = identity.rarity.toLowerCase();
  if (/secret rare|gold secret|hyper rare|special illustration rare/.test(rarity)) {
    return true;
  }
  const match = String(identity.number).match(/(\d+)\s*\/\s*(\d+)/);
  return Boolean(match && Number(match[1]) > Number(match[2]));
}

function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function pickSecretRares(cards, n = 3) {
  const withArt = (cards || []).filter((card) => imageSrc(card, 'hero') || imageSrc(card, 'grid'));
  const secrets = withArt.filter(isSecretRare);
  const picked = [];
  const seen = new Set();
  function take(list) {
    for (const card of shuffle(list)) {
      const id = String(card.id || card.card_id || '');
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      picked.push(card);
      if (picked.length === n) {
        return;
      }
    }
  }
  take(secrets);
  if (picked.length < n) {
    take(withArt);
  }
  return picked;
}

function fanSlots(cards) {
  if (cards.length >= 3) {
    return [cards[1], cards[0], cards[2]];
  }
  if (cards.length === 2) {
    return [cards[1], cards[0], null];
  }
  if (cards.length === 1) {
    return [null, cards[0], null];
  }
  return [null, null, null];
}

function PromoFanCard({ card, role, index, onPointerEnter }) {
  const [ready, setReady] = useState(false);
  const art = imageSrc(card, 'hero') || imageSrc(card, 'grid');
  if (!art) {
    return null;
  }
  if (!ready) {
    return (
      <span className="promo-card-preload" aria-hidden="true">
        <CardArt src={art} alt="" fallback="hide" onLoad={() => setReady(true)} />
      </span>
    );
  }
  return (
    <Link
      className={`promo-card is-${role} is-ready`}
      to={cardHref(card)}
      state={{ card }}
      aria-label={card.name}
      onPointerEnter={onPointerEnter}
      onClick={() => track(Action.clickTile, card, { resultRank: index })}
    >
      <span className="promo-card-rise">
        <CardArt
          src={art}
          alt={card.name}
          fallback="hide"
          fetchPriority={role === 'center' ? 'high' : 'low'}
        />
      </span>
    </Link>
  );
}

function PromoFan({ cards, loading }) {
  const [midAway, setMidAway] = useState(false);
  const visual = fanSlots(cards);
  const roles = ['left', 'center', 'right'];
  const ready = cards.length > 0;
  return (
    <div
      className={`promo-fan${midAway ? ' is-mid-away' : ''}`}
      aria-hidden={loading && !ready ? 'true' : undefined}
      onPointerLeave={() => setMidAway(false)}
    >
      <span className="promo-spark" aria-hidden="true" />
      <span className="promo-spark" aria-hidden="true" />
      <span className="promo-spark" aria-hidden="true" />
      <span className="promo-spark" aria-hidden="true" />
      <span className="promo-swoosh" aria-hidden="true" />
      {roles.map((role, index) => {
        const card = visual[index];
        if (!card) {
          return null;
        }
        return (
          <PromoFanCard
            key={`${role}-${card.id}`}
            card={card}
            role={role}
            index={index}
            onPointerEnter={role === 'center' ? undefined : () => setMidAway(true)}
          />
        );
      })}
    </div>
  );
}

function neighborIndexes(index, count) {
  return [
    index,
    (index + 1) % count,
    (index - 1 + count) % count,
  ];
}

function prefetchExpansionPage(slug) {
  fetchExpansion({ slug, limit: 48 }).catch(() => {});
}

export default function PromoCarousel() {
  const [index, setIndex] = useState(0);
  const [cardsBySlug, setCardsBySlug] = useState({});
  const [fanCards, setFanCards] = useState([]);
  const [paused, setPaused] = useState(false);
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  const [reduceMotion, setReduceMotion] = useState(() => (
    typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ));

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotion = () => setReduceMotion(mq.matches);
    mq.addEventListener('change', onMotion);
    const onVis = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      mq.removeEventListener('change', onMotion);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const count = PROMO_BANNERS.length;
    neighborIndexes(index, count).forEach((slot) => {
      const slug = PROMO_BANNERS[slot].slug;
      const peeked = peekExpansion({ slug, limit: PROMO_LIMIT });
      if (peeked?.cards?.length) {
        setCardsBySlug((current) => (
          current[slug] ? current : { ...current, [slug]: peeked.cards }
        ));
      }
      fetchExpansion({ slug, limit: PROMO_LIMIT })
        .then((data) => {
          if (!cancelled) {
            setCardsBySlug((current) => ({ ...current, [slug]: data.cards || [] }));
          }
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
    };
  }, [index]);

  useEffect(() => {
    if (reduceMotion || paused || hidden) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % PROMO_BANNERS.length);
    }, PROMO_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [reduceMotion, paused, hidden, index]);

  const count = PROMO_BANNERS.length;
  const banner = PROMO_BANNERS[index];
  const pool = cardsBySlug[banner.slug];
  const href = `/marketplace/sets/${banner.slug}`;

  useEffect(() => {
    if (!pool?.length) {
      setFanCards([]);
      return;
    }
    setFanCards(pickSecretRares(pool, 3));
  }, [banner.slug, pool]);

  function go(delta) {
    setIndex((current) => (current + delta + count) % count);
  }

  function onKeyDown(event) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      go(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      go(1);
    }
  }

  return (
    <section
      className="promo-stage"
      aria-roledescription="carousel"
      aria-label="Featured expansions"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setPaused(false);
        }
      }}
      onKeyDown={onKeyDown}
    >
      <div className="promo">
        <button
          className="promo-arrow is-prev"
          type="button"
          aria-label="Previous expansion"
          onClick={() => go(-1)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
            <path d="m15.75 19.5-7.5-7.5 7.5-7.5" />
          </svg>
        </button>
        <button
          className="promo-arrow is-next"
          type="button"
          aria-label="Next expansion"
          onClick={() => go(1)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
            <path d="m8.25 4.5 7.5 7.5-7.5 7.5" />
          </svg>
        </button>
        <div className="promo-slide" key={banner.slug}>
          <div className="promo-copy">
            <p className="eyebrow">{banner.series}</p>
            <h1>{banner.title}</h1>
            <p className="promo-lede">{banner.lede}</p>
            <Link
              className="btn"
              to={href}
              onPointerEnter={() => prefetchExpansionPage(banner.slug)}
              onClick={() => track(Action.clickBanner, fanCards[0] || { id: banner.slug, name: banner.title })}
            >
              {banner.cta}
            </Link>
          </div>
          <PromoFan cards={fanCards} loading={!pool?.length} />
        </div>
      </div>
      <div className="promo-dots" role="tablist" aria-label="Choose expansion">
        {PROMO_BANNERS.map((item, slot) => (
          <button
            key={item.slug}
            type="button"
            role="tab"
            aria-selected={slot === index}
            aria-label={item.title}
            className={slot === index ? 'is-on' : undefined}
            onClick={() => setIndex(slot)}
            onPointerEnter={() => {
              fetchExpansion({ slug: item.slug, limit: PROMO_LIMIT }).catch(() => {});
            }}
          />
        ))}
      </div>
    </section>
  );
}
