import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { cardHref, fetchExpansion, fetchPromoFanPool, imageSrc, peekPromoFanPool } from '../api.js';
import { FAN_POOL, fillFan, pickFan } from '../promo-fan.js';
import { Action, track } from '../track.js';
import CardArt from './CardArt.jsx';

const PROMO_INTERVAL_MS = 5500;

/** Current expansions on the home promo carousel (five slides). */
export const PROMO_BANNERS = [
  {
    slug: 'storm-emeralda',
    series: 'Mega Evolution',
    title: 'Storm Emeralda',
    lede: 'Japanese M6 is on the floor. Chase Mega Rayquaza ex.',
    cta: 'Explore cards from this expansion',
  },
  {
    slug: 'mega-evolution',
    series: 'Mega Evolution',
    title: 'Mega Evolution',
    lede: 'The first Mega Evolution set is on the floor. Chase Mega Lucario ex.',
    cta: 'Explore cards from this expansion',
  },
  {
    slug: 'phantasmal-flames',
    series: 'Mega Evolution',
    title: 'Phantasmal Flames',
    lede: 'The second Mega Evolution set is on the floor. Chase Mega Charizard X ex.',
    cta: 'Explore cards from this expansion',
  },
  {
    slug: 'black-bolt',
    series: 'Black & White',
    title: 'Black Bolt',
    lede: 'Unova returns in black. Zekrom ex and the chase holos.',
    cta: 'Explore cards from this expansion',
  },
  {
    slug: 'white-flare',
    series: 'Black & White',
    title: 'White Flare',
    lede: 'Unova in white. Reshiram ex and the set’s secret rares.',
    cta: 'Explore cards from this expansion',
  },
];

function PromoFanCard({ card, role, index, onPointerEnter, onFail }) {
  const [ready, setReady] = useState(false);
  const art = imageSrc(card, 'hero');
  useEffect(() => {
    if (!art) {
      onFail?.();
    }
  }, [art, onFail]);
  if (!art) {
    return null;
  }
  return (
    <Link
      className={`promo-card is-${role}${ready ? ' is-ready' : ''}`}
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
          full
          dragCard={card}
          loading="eager"
          fetchPriority="high"
          onLoad={() => setReady(true)}
          onError={onFail}
        />
      </span>
    </Link>
  );
}

function PromoFan({ cards, loading }) {
  const [midAway, setMidAway] = useState(false);
  const [failed, setFailed] = useState(() => new Set());
  const poolKey = (cards || []).map((card) => String(card.id || card.card_id || '')).join(',');
  useEffect(() => {
    setFailed(new Set());
  }, [poolKey]);
  const visual = fillFan(cards, failed);
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
            onFail={() => {
              const id = String(card.id || card.card_id || '');
              if (!id) {
                return;
              }
              setFailed((current) => {
                if (current.has(id)) {
                  return current;
                }
                const next = new Set(current);
                next.add(id);
                return next;
              });
            }}
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

function loadFanPool(slug) {
  return fetchPromoFanPool(slug);
}

if (typeof window !== 'undefined') {
  loadFanPool(PROMO_BANNERS[0].slug).catch(() => {});
}

export default function PromoCarousel() {
  const [index, setIndex] = useState(0);
  const [cardsBySlug, setCardsBySlug] = useState(() => {
    const first = peekPromoFanPool(PROMO_BANNERS[0].slug);
    return first?.length ? { [PROMO_BANNERS[0].slug]: first } : {};
  });
  const [fanCards, setFanCards] = useState(() => {
    const first = peekPromoFanPool(PROMO_BANNERS[0].slug);
    return first?.length ? pickFan(first, FAN_POOL) : [];
  });
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
    const count = PROMO_BANNERS.length;
    neighborIndexes(index, count).forEach((slot) => {
      const slug = PROMO_BANNERS[slot].slug;
      const peeked = peekPromoFanPool(slug);
      if (peeked?.length) {
        setCardsBySlug((current) => (
          current[slug] ? current : { ...current, [slug]: peeked }
        ));
      }
      loadFanPool(slug)
        .then((cards) => {
          setCardsBySlug((current) => ({ ...current, [slug]: cards || [] }));
        })
        .catch(() => {});
    });
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
      return undefined;
    }
    setFanCards(pickFan(pool, FAN_POOL));
    return undefined;
  }, [banner.slug, pool, index]);

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
              loadFanPool(item.slug).catch(() => {});
            }}
          />
        ))}
      </div>
    </section>
  );
}
