import { createEffect, createSignal, createUniqueId, For, onSettled, Show } from 'solid-js';
import { useLocation } from '@solidjs/router';
import { LIFE_BUBBLES, LIFE_STRIP, PRINCIPLES, REASONS } from '@market/careers-art.js';
import { startBubbleDrift } from '@market/careers-bubbles.js';
import {
  CAREERS_CONTACT,
  OPEN_ROLES,
  groupRolesByDepartment,
  roleHref,
  roleMeta,
} from '@market/careers-jobs.js';
import { usePageTitle } from './tools/board.jsx';

/** Inline brand mark — Phantom puts a lottie/mascot inside display titles. */
function TitleMark(props) {
  return (
    <img
      class={['careers-title-mark', props.class]}
      src="/home/logo.png"
      width="72"
      height="72"
      alt=""
      draggable="false"
    />
  );
}

const DEFAULT_CUT = { left: 0.086, top: 0.126, width: 0.828, height: 0.338, cardRatio: 63 / 88 };

/** Art-dependent shot: full-art bleed, physical card, or album art-cut window. */
function CareersCardArt(props) {
  const art = () => props.art;
  const pose = () => (art().pose ? `pose-${art().pose}` : '');
  // Same window math as album .art-cut, but inline so careers-card-shot CSS cannot blank it.
  const windowStyle = () => {
    const cut = art().cut || DEFAULT_CUT;
    const cardRatio = cut.cardRatio ?? 63 / 88;
    return {
      position: 'relative',
      width: '100%',
      'aspect-ratio': String((cut.width * cardRatio) / cut.height),
      overflow: 'hidden',
      'border-radius': '0.45rem',
    };
  };
  const imgStyle = () => {
    const cut = art().cut || DEFAULT_CUT;
    return {
      position: 'absolute',
      display: 'block',
      width: `${100 / cut.width}%`,
      height: 'auto',
      'max-width': 'none',
      left: `${(-100 * cut.left) / cut.width}%`,
      top: `${(-100 * cut.top) / cut.height}%`,
      'object-fit': 'fill',
    };
  };
  return (
    <Show when={art()?.src}>
      <Show
        when={art().mode === 'art-cut'}
        fallback={(
          <div
            class={[props.class, `is-${art().mode === 'physical-card' ? 'physical-card' : 'full-art'}`, pose()]}
            aria-hidden="true"
            title={art().card || undefined}
          >
            <img class="careers-card-shot" src={art().src} alt="" loading="lazy" decoding="async" draggable="false" />
          </div>
        )}
      >
        <div class={[props.class, 'is-art-cut', pose()]} aria-hidden="true" title={art().card || undefined}>
          <div class="careers-art-cut" style={windowStyle()}>
            <img src={art().src} alt="" style={imgStyle()} loading="eager" decoding="async" draggable="false" />
          </div>
        </div>
      </Show>
    </Show>
  );
}

function PrincipleCard(props) {
  return (
    <li class={`careers-principle-card tone-${props.item.tone}`}>
      <p class="careers-principle-title">
        {props.item.prefix || ''}
        <span class="careers-principle-hl">{props.item.highlight}</span>
        {props.item.rest || ''}
      </p>
      <p class="careers-principle-body">{props.item.body}</p>
      <CareersCardArt art={props.item.art} class="careers-principle-art" />
    </li>
  );
}

/** Scroller with ‹ › arrows that disable at either end (PrinciplesSlider / SurfacesSlider). */
function useEdgeScroller(cardSelector, gap, fallbackStep) {
  let el;
  const [atStart, setAtStart] = createSignal(true);
  const [atEnd, setAtEnd] = createSignal(false);
  onSettled(() => {
    if (!el) return undefined;
    const sync = () => {
      const max = el.scrollWidth - el.clientWidth;
      setAtStart(el.scrollLeft <= 4);
      setAtEnd(max <= 4 || el.scrollLeft >= max - 4);
    };
    sync();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    el.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync);
    requestAnimationFrame(sync);
    return () => {
      ro?.disconnect();
      el.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
    };
  });
  const scrollBy = (dir) => {
    if (!el) return;
    const card = el.querySelector(cardSelector);
    const step = card ? card.getBoundingClientRect().width + gap : fallbackStep;
    el.scrollBy({ left: dir * step, behavior: 'smooth' });
  };
  return { ref: (node) => { el = node; }, atStart, atEnd, scrollBy };
}

function SliderArrows(props) {
  return (
    <div class="careers-slider-arrows">
      <button type="button" class="careers-arrow" aria-label={`Previous ${props.noun}`} disabled={props.scroller.atStart()} onClick={() => props.scroller.scrollBy(-1)}>
        ‹
      </button>
      <button type="button" class="careers-arrow" aria-label={`Next ${props.noun}`} disabled={props.scroller.atEnd()} onClick={() => props.scroller.scrollBy(1)}>
        ›
      </button>
    </div>
  );
}

function PrinciplesSlider() {
  const scroller = useEdgeScroller('.careers-principle-card', 16, 320);
  return (
    <div class="careers-slider">
      <div class="careers-slider-chrome">
        <p class="careers-chip">
          <span class="careers-chip-star" aria-hidden="true">★</span>
          How we work
        </p>
        <SliderArrows scroller={scroller} noun="slide" />
      </div>
      <ul class="careers-principle-track" ref={scroller.ref}>
        <For each={PRINCIPLES}>{(item) => <PrincipleCard item={item} />}</For>
      </ul>
    </div>
  );
}

function SurfacesSlider() {
  const scroller = useEdgeScroller('.careers-life-tile', 22, 380);
  return (
    <div class="careers-surfaces">
      <div class="careers-surfaces-chrome">
        <p class="careers-chip">
          <span class="careers-chip-star" aria-hidden="true">★</span>
          Live product
        </p>
        <SliderArrows scroller={scroller} noun="surface" />
      </div>
      <ul class="careers-life-strip" ref={scroller.ref}>
        <For each={LIFE_STRIP}>
          {(item) => (
            <li class={`careers-life-tile tone-${item.tone}`}>
              <div class="careers-life-copy">
                <h3 class="careers-life-title">{item.label}</h3>
                <p class="careers-life-body">{item.body}</p>
              </div>
              <CareersCardArt art={item.art} class="careers-life-art" />
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}

function DepartmentAccordion(props) {
  const panelId = createUniqueId();
  const [open, setOpen] = createSignal(Boolean(props.defaultOpen));

  return (
    <div class={['careers-dept', { 'is-open': open() }]}>
      <button
        type="button"
        class="careers-dept-toggle"
        aria-expanded={String(open())}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span class="careers-dept-name">{props.department}</span>
        <span class="careers-dept-count">{props.roles.length}</span>
        <span class={['careers-dept-chevron', { 'is-open': open() }]} aria-hidden="true">›</span>
      </button>
      <div id={panelId} class="careers-dept-panel" hidden={!open()} role="region" aria-label={`${props.department} openings`}>
        <ul class="careers-role-list">
          <For each={props.roles}>
            {(role) => {
              const href = roleHref(role);
              const external = /^https?:\/\//i.test(href);
              return (
                <li>
                  <a
                    class="careers-role"
                    href={href}
                    target={external ? '_blank' : undefined}
                    rel={external ? 'noopener noreferrer' : undefined}
                  >
                    <span class="careers-role-title">{role.title}</span>
                    <span class="careers-role-meta">{roleMeta(role) || 'Open'}</span>
                  </a>
                </li>
              );
            }}
          </For>
        </ul>
      </div>
    </div>
  );
}

function OpenPositions(props) {
  return (
    <Show
      when={props.roles.length}
      fallback={(
        <div class="careers-jobs-empty" role="status">
          <p class="careers-jobs-empty-title">No open roles right now</p>
          <p class="careers-jobs-empty-lede">
            When a posting is ready it will appear in this list, grouped by team — the same layout as a live board.
            Until then, write to{' '}
            <a href={CAREERS_CONTACT}>contact@pokoin.com</a>.
          </p>
          <a class="careers-soft-btn" href={CAREERS_CONTACT}>Email contact@pokoin.com</a>
        </div>
      )}
    >
      <div class="careers-jobs">
        <For each={groupRolesByDepartment(props.roles)}>
          {(group, index) => (
            <DepartmentAccordion department={group.department} roles={group.roles} defaultOpen={index() === 0} />
          )}
        </For>
      </div>
    </Show>
  );
}

function bubbleFace(bubble) {
  const [bfx, bfy] = bubble.face.split(/\s+/);
  return { '--bfx-n': Number.parseFloat(bfx), '--bfy-n': Number.parseFloat(bfy) };
}

/** Careers page. */
export default function Careers() {
  const location = useLocation();
  let bubblesEl;
  usePageTitle('Careers · Pokoin');

  // Life at Pokoin: bubbles drift slowly and can be dragged around.
  onSettled(() => {
    const reducedMotion = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    return startBubbleDrift(bubblesEl, { reducedMotion });
  });

  createEffect(() => String(location.hash || '').replace(/^#/, ''), (hash) => {
    if (hash !== 'open-positions') return;
    document.getElementById('open-positions')?.scrollIntoView({ block: 'start' });
  });

  return (
    <div class="page careers-page">
      {/* 0 · pageIntro */}
      <header class="careers-intro">
        <h1 class="careers-display">
          Careers at <TitleMark /> Pokoin
        </h1>
        <p class="careers-intro-lede">
          We’re building the peer-to-peer Pokémon marketplace designed for collectors —
          buy, sell, and settle in PKN.
        </p>
        <a class="careers-soft-btn careers-intro-cta" href="#open-positions">
          Browse open roles
          <span aria-hidden="true">↓</span>
        </a>
      </header>

      {/* 1 · moduleBlockContentBasic: media + prose */}
      <section class="careers-module careers-life" aria-label="Life at Pokoin">
        <div class="careers-media-bleed">
          <div class="careers-media-badge">
            <TitleMark class="is-sm" />
            <span>Life at Pokoin</span>
          </div>
          <div class="careers-media-stage" aria-hidden="true">
            <span class="careers-media-glow careers-media-glow-a" />
            <span class="careers-media-glow careers-media-glow-b" />
            <span class="careers-media-glow careers-media-glow-c" />
            <div class="careers-media-bubbles" ref={bubblesEl}>
              <For each={LIFE_BUBBLES}>
                {(bubble) => (
                  <div
                    class={`careers-media-art slot-${bubble.slot}`}
                    title={bubble.card}
                    style={bubbleFace(bubble)}
                  >
                    <img
                      class="careers-media-shot"
                      src={bubble.src}
                      alt=""
                      loading={bubble.slot === 'a' ? 'eager' : 'lazy'}
                      decoding="async"
                      draggable="false"
                    />
                  </div>
                )}
              </For>
            </div>
            <p class="careers-media-caption">Buy. Sell. Settle in PKN.</p>
          </div>
        </div>

        <div class="careers-prose">
          <h2 id="help-us-keep-the-market-with-collectors">Help us keep the market with the collectors</h2>
          <p>
            Pokoin is peer-to-peer. You list a card. Another collector buys it.
          </p>
          <p>
            We started Pokoin to build the collector market we wanted: fast desks,
            honest sold books, and catalog depth that respects printings — not a listing farm.
          </p>

          <h2 id="built-as-one-product">Built as one product, used worldwide</h2>
          <p>
            Card Reserve, the PKN wallet, and Scan share one host and identity.
            Great ideas can come from anywhere; the tools should work the same way.
          </p>
        </div>
      </section>

      {/* 2 · moduleCardsSliderWithIntro */}
      <section class="careers-module careers-principles-mod" aria-labelledby="careers-principles-heading">
        <h2 id="careers-principles-heading" class="careers-display">
          Principles guide
          <br />
          our <TitleMark /> people
        </h2>
        <PrinciplesSlider />
      </section>

      {/* 3 · moduleBlockContentWithIntro */}
      <section class="careers-module careers-perks-intro" aria-labelledby="careers-perks-heading">
        <h2 id="careers-perks-heading" class="careers-display">
          Powered by the
          <br />
          best <TitleMark /> reasons
        </h2>
      </section>

      {/* 4 · moduleCardsBasic */}
      <section class="careers-module careers-benefits" aria-labelledby="careers-benefits-heading">
        <div class="careers-prose">
          <h2 id="careers-benefits-heading">Why join</h2>
          <p>
            These are concrete reasons to work on Pokoin — product facts, not invented meal stipends
            or unlimited-PTO claims. Compensation and benefits land with each real posting.
          </p>
          <p>
            Speculative interest is welcome at{' '}
            <a href={CAREERS_CONTACT}>contact@pokoin.com</a>
            {' '}with what you build and why Pokoin.
          </p>
        </div>
        <ul class="careers-perk-grid">
          <For each={REASONS}>
            {(item) => (
              <li class={`careers-perk-card tone-${item.tone}`}>
                <span class="careers-perk-title">{item.title}</span>
                <CareersCardArt art={item.art} class="careers-perk-art" />
              </li>
            )}
          </For>
        </ul>
      </section>

      {/* 5 · moduleJobsWithIntro */}
      <section
        class="careers-module careers-open"
        id="open-positions"
        aria-labelledby="careers-open-heading"
      >
        <h2 id="careers-open-heading" class="careers-display">
          Open <TitleMark /> Positions
        </h2>
        <div class="careers-jobs-wrap">
          <OpenPositions roles={OPEN_ROLES} />
        </div>
      </section>

      {/* 6 · mediaCarousel — product surfaces, not staff photos */}
      <section class="careers-module careers-strip-mod" aria-label="Pokoin surfaces">
        <SurfacesSlider />
        <p class="careers-strip-note">
          Prefer exploring the live product?{' '}
          <a href="/marketplace">Open the marketplace</a>
          {' · '}
          <a href="/about">About Pokoin</a>
        </p>
      </section>
    </div>
  );
}
