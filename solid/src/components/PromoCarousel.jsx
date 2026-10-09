import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from 'solid-js';
import { cardHref, fetchExpansion, fetchPromoFanPool, getJson, imageSrc, peekPromoFanPool } from '@market/api.js';
import { game, isPokemonGame } from '@market/game.js';
import { PROMO_BANNERS, promoLogoIsName, promoLogoSrc, satellitePromoBanners } from '@market/promo-banners.js';
import { FAN_POOL, fillFan, pickFan } from '@market/promo-fan.js';
import { Action, track } from '@market/track.js';
import { handOffCard } from '../lib/card-handoff.js';
import CardArt from './CardArt.jsx';

const PROMO_INTERVAL_MS = 5500;
const ROLES = ['left', 'center', 'right'];

function loadFanPool(slug) {
  return fetchPromoFanPool(slug);
}

function prefetchExpansionPage(slug) {
  fetchExpansion({ slug, limit: 48 }).catch(() => {});
}

function neighborIndexes(index, count) {
  return [index, (index + 1) % count, (index - 1 + count) % count];
}

// Same early start as React: the first slide's chase pool is requested when
// the module loads, before Home mounts.
if (typeof window !== 'undefined' && isPokemonGame()) {
  loadFanPool(PROMO_BANNERS[0].slug).catch(() => {});
}

function PromoFanCard(props) {
  const [ready, setReady] = createSignal(false);
  const [wide, setWide] = createSignal(false);
  const art = () => imageSrc(props.card, 'hero');
  const center = () => props.role === 'center';
  createEffect(art, (src) => {
    if (!src) props.onFail?.();
  });
  return (
    <Show when={art()}>
      <a
        class={['promo-card', `is-${props.role}`, { 'is-ready': ready(), 'is-wide': wide() }]}
        href={cardHref(props.card)}
        aria-label={props.card.name}
        onPointerEnter={(event) => {
          handOffCard(props.card);
          props.onPointerEnter?.(event);
        }}
        onClick={() => {
          handOffCard(props.card);
          track(Action.clickTile, props.card, { resultRank: props.index });
        }}
      >
        <span class="promo-card-rise">
          <CardArt
            src={art()}
            alt={props.card.name}
            fallback="hide"
            full
            dragCard={props.card}
            loading={center() ? 'eager' : 'lazy'}
            fetchPriority={center() ? 'high' : 'low'}
            onLoad={(img) => {
              if (img && img.naturalWidth > img.naturalHeight) setWide(true);
              setReady(true);
            }}
            onError={() => props.onFail?.()}
          />
        </span>
      </a>
    </Show>
  );
}

function PromoFan(props) {
  const [midAway, setMidAway] = createSignal(false);
  // Failed scans are skipped for this pool only; a new pool starts clean.
  const poolKey = () => (props.cards || []).map((card) => String(card.id || card.card_id || '')).join(',');
  const [failed, setFailed] = createSignal(() => (poolKey(), new Set()));
  const slots = createMemo(() => {
    const visual = fillFan(props.cards || [], failed());
    return ROLES.map((role, index) => ({ role, index, card: visual[index] })).filter((slot) => slot.card);
  });
  const ready = () => (props.cards || []).length > 0;
  return (
    <div
      class={['promo-fan', { 'is-mid-away': midAway() }]}
      aria-hidden={props.loading && !ready() ? 'true' : undefined}
      onPointerLeave={() => setMidAway(false)}
    >
      <span class="promo-spark" aria-hidden="true" />
      <span class="promo-spark" aria-hidden="true" />
      <span class="promo-spark" aria-hidden="true" />
      <span class="promo-spark" aria-hidden="true" />
      <span class="promo-swoosh" aria-hidden="true" />
      <For each={slots()} keyed={(slot) => `${slot.role}-${slot.card.id}`}>
        {(slot) => (
          <PromoFanCard
            card={slot().card}
            role={slot().role}
            index={slot().index}
            onPointerEnter={slot().role === 'center' ? undefined : () => setMidAway(true)}
            onFail={() => {
              const id = String(slot().card.id || slot().card.card_id || '');
              if (!id) return;
              setFailed((current) => {
                if (current.has(id)) return current;
                const next = new Set(current);
                next.add(id);
                return next;
              });
            }}
          />
        )}
      </For>
    </div>
  );
}

function PromoWordmark(props) {
  const src = () => promoLogoSrc(props.banner, { pokemon: props.pokemon });
  return (
    <Show when={src()}>
      <span class="promo-wordmark-slot">
        <img class="promo-wordmark" src={src()} alt="" onError={() => props.onFail?.()} />
      </span>
    </Show>
  );
}

/**
 * Home hero (market/src/components/PromoCarousel.jsx): five current
 * expansions with a fan of their chase cards, auto-advancing every 5.5 s
 * unless hovered, focused, hidden or reduced-motion. The stage paints with
 * its copy and fixed fan box on the first frame, so the scans landing later
 * never move the rails below, and it holds its tallest slide (see boxHeight).
 */
export default function PromoCarousel() {
  const pokemon = isPokemonGame();
  const site = game();
  const firstSlug = PROMO_BANNERS[0].slug;
  const [banners, setBanners] = createSignal(pokemon ? PROMO_BANNERS : []);
  const [index, setIndex] = createSignal(0);
  const [cardsBySlug, setCardsBySlug] = createSignal((() => {
    if (!pokemon) return {};
    const first = peekPromoFanPool(firstSlug);
    return first?.length ? { [firstSlug]: first } : {};
  })());
  const [logoFailed, setLogoFailed] = createSignal('');
  const [paused, setPaused] = createSignal(false);
  const [hidden, setHidden] = createSignal(typeof document !== 'undefined' && document.hidden);
  const [reduceMotion, setReduceMotion] = createSignal(
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  onSettled(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotion = () => setReduceMotion(mq.matches);
    mq.addEventListener('change', onMotion);
    const onVis = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    let cancel = false;
    if (!pokemon) {
      getJson('/api/marketplace-expansion-page?limit=12')
        .then((data) => {
          if (cancel) return;
          const slides = satellitePromoBanners(data?.expansions, site.name);
          setBanners(slides);
          if (slides[0]?.slug) loadFanPool(slides[0].slug).catch(() => {});
        })
        .catch(() => {});
    }
    return () => {
      cancel = true;
      mq.removeEventListener('change', onMotion);
      document.removeEventListener('visibilitychange', onVis);
    };
  });

  // The current slide and its neighbours: paint a cached pool at once, fetch the rest.
  createEffect(
    () => [index(), banners()],
    ([at, list]) => {
      if (!list.length) return;
      neighborIndexes(at, list.length).forEach((slot) => {
        const slug = list[slot].slug;
        const peeked = peekPromoFanPool(slug);
        if (peeked?.length) {
          setCardsBySlug((current) => (current[slug] ? current : { ...current, [slug]: peeked }));
        }
        loadFanPool(slug)
          .then((cards) => setCardsBySlug((current) => ({ ...current, [slug]: cards || [] })))
          .catch(() => {});
      });
    },
  );

  // Auto-advance; every slide change re-arms the timer.
  createEffect(
    () => (banners().length && !reduceMotion() && !paused() && !hidden() ? [index(), banners().length] : null),
    (run) => {
      if (!run) return undefined;
      const count = run[1];
      const timer = window.setInterval(() => setIndex((current) => (current + 1) % count), PROMO_INTERVAL_MS);
      return () => window.clearInterval(timer);
    },
  );

  const count = () => banners().length;
  const banner = () => (count() ? banners()[index() % count()] : null);
  // A memo, so a neighbour's pool landing does not count as this slide's pool changing.
  const pool = createMemo(() => (banner() ? cardsBySlug()[banner().slug] : null));
  // A fresh shuffle whenever the slide or its pool changes (React: [banner, pool, index]).
  const fanCards = createMemo(() => {
    index();
    const cards = pool();
    return banner() && cards?.length ? pickFan(cards, FAN_POOL) : [];
  });

  // Reserve the box: on phones a slide's height follows its copy (wordmark
  // vs title, lede lines), so the stage keeps the tallest slide seen at this
  // width and a shorter one never pulls the rails below up (React shifts
  // there on every auto-advance). Desktop has a fixed height already.
  let promoBox;
  const [boxHeight, setBoxHeight] = createSignal(0);
  createEffect(() => banner()?.slug, () => {
    const frame = requestAnimationFrame(() => {
      const height = promoBox?.offsetHeight || 0;
      if (height > untrack(boxHeight)) setBoxHeight(height);
    });
    return () => cancelAnimationFrame(frame);
  });
  onSettled(() => {
    let width = window.innerWidth;
    const onResize = () => {
      if (window.innerWidth === width) return;
      width = window.innerWidth;
      setBoxHeight(0);
      requestAnimationFrame(() => setBoxHeight(promoBox?.offsetHeight || 0));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  function go(delta) {
    const n = count();
    setIndex((current) => (current + delta + n) % n);
  }

  return (
    <Show when={banner()} fallback={<section class="promo-stage" aria-hidden="true" />}>
      <section
        class="promo-stage"
        aria-roledescription="carousel"
        aria-label="Featured expansions"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocusIn={() => setPaused(true)}
        onFocusOut={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            go(-1);
          } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            go(1);
          }
        }}
      >
        <div
          class="promo"
          ref={(el) => { promoBox = el; }}
          style={boxHeight() ? { 'min-height': `${boxHeight()}px` } : undefined}
        >
          <button class="promo-arrow is-prev" type="button" aria-label="Previous expansion" onClick={() => go(-1)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
              <path d="m15.75 19.5-7.5-7.5 7.5-7.5" />
            </svg>
          </button>
          <button class="promo-arrow is-next" type="button" aria-label="Next expansion" onClick={() => go(1)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
              <path d="m8.25 4.5 7.5 7.5-7.5 7.5" />
            </svg>
          </button>
          {/* Keyed by slide: a new slide remounts so the copy's rise animation replays. */}
          <Show when={banner()} keyed>
            {(slide) => {
              const logoName = () => promoLogoIsName(slide) && logoFailed() !== slide.slug;
              return (
                <div class="promo-slide">
                  <div class={['promo-copy', { 'is-logo-name': logoName() }]}>
                    <p class="eyebrow">{slide.series}</p>
                    <Show when={logoFailed() !== slide.slug}>
                      <PromoWordmark banner={slide} pokemon={pokemon} onFail={() => setLogoFailed(slide.slug)} />
                    </Show>
                    <h1 class={logoName() ? 'sr-only' : undefined}>{slide.title}</h1>
                    <p class="promo-lede">{slide.lede}</p>
                    <a
                      class="btn"
                      href={`/marketplace/sets/${slide.slug}`}
                      onPointerEnter={() => prefetchExpansionPage(slide.slug)}
                      onClick={() => track(Action.clickBanner, untrack(fanCards)[0] || { id: slide.slug, name: slide.title })}
                    >
                      {slide.cta}
                    </a>
                  </div>
                  <PromoFan cards={fanCards()} loading={!pool()?.length} />
                </div>
              );
            }}
          </Show>
        </div>
        <div class="promo-dots" role="tablist" aria-label="Choose expansion">
          <For each={banners()}>
            {(item, slot) => (
              <button
                type="button"
                role="tab"
                aria-selected={slot() === index() ? 'true' : 'false'}
                aria-label={item.title}
                class={slot() === index() ? 'is-on' : undefined}
                onClick={() => setIndex(slot())}
                onPointerEnter={() => loadFanPool(item.slug).catch(() => {})}
              />
            )}
          </For>
        </div>
      </section>
    </Show>
  );
}
