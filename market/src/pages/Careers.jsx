import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { LIFE_BUBBLES, LIFE_STRIP, PRINCIPLES, REASONS } from '../careers-art.js';
import { startBubbleDrift } from '../careers-bubbles.js';
import {
  CAREERS_CONTACT,
  OPEN_ROLES,
  groupRolesByDepartment,
  roleHref,
  roleMeta,
} from '../careers-jobs.js';

/** Inline brand mark — Phantom puts a lottie/mascot inside display titles. */
function TitleMark({ className = '' }) {
  return (
    <img
      className={`careers-title-mark ${className}`.trim()}
      src="/home/logo.png"
      width="72"
      height="72"
      alt=""
      draggable={false}
    />
  );
}

/** Art-dependent shot: full-art bleed, physical card, or album art-cut window. */
function CareersCardArt({ art, className }) {
  if (!art?.src) return null;
  const pose = art.pose ? ` pose-${art.pose}` : '';
  if (art.mode === 'art-cut') {
    const cut = art.cut || { left: 0.086, top: 0.126, width: 0.828, height: 0.338, cardRatio: 63 / 88 };
    const cutStyle = {
      '--art-left': String(cut.left),
      '--art-top': String(cut.top),
      '--art-width': String(cut.width),
      '--art-height': String(cut.height),
      '--card-ratio': String(cut.cardRatio ?? 63 / 88),
    };
    return (
      <div
        className={`${className} is-art-cut${pose}`.trim()}
        aria-hidden="true"
        title={art.card || undefined}
      >
        <div className="careers-art-cut art-cut" style={cutStyle}>
          <img
            className="careers-art-cut-img"
            src={art.src}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
          />
        </div>
      </div>
    );
  }
  const mode = art.mode === 'physical-card' ? 'physical-card' : 'full-art';
  return (
    <div
      className={`${className} is-${mode}${pose}`.trim()}
      aria-hidden="true"
      title={art.card || undefined}
    >
      <img
        className="careers-card-shot"
        src={art.src}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
      />
    </div>
  );
}

function PrincipleCard({ item }) {
  const prefix = item.prefix || '';
  const rest = item.rest || '';
  return (
    <li className={`careers-principle-card tone-${item.tone}`}>
      <p className="careers-principle-title">
        {prefix}
        <span className="careers-principle-hl">{item.highlight}</span>
        {rest}
      </p>
      <p className="careers-principle-body">{item.body}</p>
      <CareersCardArt art={item.art} className="careers-principle-art" />
    </li>
  );
}

function PrinciplesSlider() {
  const scrollerRef = useRef(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  useEffect(() => {
    const el = scrollerRef.current;
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
  }, []);

  const scrollBy = (dir) => {
    const el = scrollerRef.current;
    if (!el) return;
    const card = el.querySelector('.careers-principle-card');
    const step = card ? card.getBoundingClientRect().width + 16 : 320;
    el.scrollBy({ left: dir * step, behavior: 'smooth' });
  };

  return (
    <div className="careers-slider">
      <div className="careers-slider-chrome">
        <p className="careers-chip">
          <span className="careers-chip-star" aria-hidden="true">★</span>
          How we work
        </p>
        <div className="careers-slider-arrows">
          <button type="button" className="careers-arrow" aria-label="Previous slide" disabled={atStart} onClick={() => scrollBy(-1)}>
            ‹
          </button>
          <button type="button" className="careers-arrow" aria-label="Next slide" disabled={atEnd} onClick={() => scrollBy(1)}>
            ›
          </button>
        </div>
      </div>
      <ul className="careers-principle-track" ref={scrollerRef}>
        {PRINCIPLES.map((item) => (
          <PrincipleCard key={item.title} item={item} />
        ))}
      </ul>
    </div>
  );
}

function SurfacesSlider() {
  const scrollerRef = useRef(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  useEffect(() => {
    const el = scrollerRef.current;
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
  }, []);

  const scrollBy = (dir) => {
    const el = scrollerRef.current;
    if (!el) return;
    const card = el.querySelector('.careers-life-tile');
    const step = card ? card.getBoundingClientRect().width + 22 : 380;
    el.scrollBy({ left: dir * step, behavior: 'smooth' });
  };

  return (
    <div className="careers-surfaces">
      <div className="careers-surfaces-chrome">
        <p className="careers-chip">
          <span className="careers-chip-star" aria-hidden="true">★</span>
          Live product
        </p>
        <div className="careers-slider-arrows">
          <button type="button" className="careers-arrow" aria-label="Previous surface" disabled={atStart} onClick={() => scrollBy(-1)}>
            ‹
          </button>
          <button type="button" className="careers-arrow" aria-label="Next surface" disabled={atEnd} onClick={() => scrollBy(1)}>
            ›
          </button>
        </div>
      </div>
      <ul className="careers-life-strip" ref={scrollerRef}>
        {LIFE_STRIP.map((item) => (
          <li key={item.label} className={`careers-life-tile tone-${item.tone}`}>
            <div className="careers-life-copy">
              <h3 className="careers-life-title">{item.label}</h3>
              <p className="careers-life-body">{item.body}</p>
            </div>
            <CareersCardArt art={item.art} className="careers-life-art" />
          </li>
        ))}
      </ul>
    </div>
  );
}

function DepartmentAccordion({ department, roles, defaultOpen }) {
  const panelId = useId();
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const count = roles.length;

  return (
    <div className={`careers-dept${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="careers-dept-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="careers-dept-name">{department}</span>
        <span className="careers-dept-count">{count}</span>
        <span className={`careers-dept-chevron${open ? ' is-open' : ''}`} aria-hidden="true">›</span>
      </button>
      <div id={panelId} className="careers-dept-panel" hidden={!open} role="region" aria-label={`${department} openings`}>
        <ul className="careers-role-list">
          {roles.map((role) => {
            const href = roleHref(role);
            const meta = roleMeta(role);
            const external = /^https?:\/\//i.test(href);
            return (
              <li key={role.id || role.title}>
                <a
                  className="careers-role"
                  href={href}
                  {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                >
                  <span className="careers-role-title">{role.title}</span>
                  <span className="careers-role-meta">{meta || 'Open'}</span>
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function OpenPositions({ roles }) {
  const groups = groupRolesByDepartment(roles);
  if (!roles.length) {
    return (
      <div className="careers-jobs-empty" role="status">
        <p className="careers-jobs-empty-title">No open roles right now</p>
        <p className="careers-jobs-empty-lede">
          When a posting is ready it will appear in this list, grouped by team — the same layout as a live board.
          Until then, write to{' '}
          <a href={CAREERS_CONTACT}>contact@pokoin.com</a>.
        </p>
        <a className="careers-soft-btn" href={CAREERS_CONTACT}>Email contact@pokoin.com</a>
      </div>
    );
  }

  return (
    <div className="careers-jobs">
      {groups.map((group, index) => (
        <DepartmentAccordion
          key={group.department}
          department={group.department}
          roles={group.roles}
          defaultOpen={index === 0}
        />
      ))}
    </div>
  );
}

export default function Careers() {
  const location = useLocation();
  const roles = OPEN_ROLES;
  const bubblesRef = useRef(null);

  useEffect(() => {
    document.title = 'Careers · Pokoin';
  }, []);

  // Life at Pokoin: bubbles drift slowly and can be dragged around.
  useEffect(() => {
    const reducedMotion = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    return startBubbleDrift(bubblesRef.current, { reducedMotion });
  }, []);

  useEffect(() => {
    const hash = String(location.hash || '').replace(/^#/, '');
    if (hash !== 'open-positions') return;
    document.getElementById('open-positions')?.scrollIntoView({ block: 'start' });
  }, [location.hash, roles.length]);

  return (
    <div className="page careers-page">
      {/* 0 · pageIntro */}
      <header className="careers-intro">
        <h1 className="careers-display">
          Careers at <TitleMark /> Pokoin
        </h1>
        <p className="careers-intro-lede">
          We’re building the peer-to-peer Pokémon marketplace designed for collectors —
          buy, sell, and settle in PKN.
        </p>
        <a className="careers-soft-btn careers-intro-cta" href="#open-positions">
          Browse open roles
          <span aria-hidden="true">↓</span>
        </a>
      </header>

      {/* 1 · moduleBlockContentBasic: media + prose */}
      <section className="careers-module careers-life" aria-label="Life at Pokoin">
        <div className="careers-media-bleed">
          <div className="careers-media-badge">
            <TitleMark className="is-sm" />
            <span>Life at Pokoin</span>
          </div>
          <div className="careers-media-stage" aria-hidden="true">
            <span className="careers-media-glow careers-media-glow-a" />
            <span className="careers-media-glow careers-media-glow-b" />
            <span className="careers-media-glow careers-media-glow-c" />
            <div className="careers-media-bubbles" ref={bubblesRef}>
              {LIFE_BUBBLES.map((bubble) => {
                const [bfx, bfy] = bubble.face.split(/\s+/);
                return (
                  <div
                    key={bubble.slot}
                    className={`careers-media-art slot-${bubble.slot}`}
                    title={bubble.card}
                    style={{
                      '--bfx-n': Number.parseFloat(bfx),
                      '--bfy-n': Number.parseFloat(bfy),
                    }}
                  >
                    <img
                      className="careers-media-shot"
                      src={bubble.src}
                      alt=""
                      loading={bubble.slot === 'a' ? 'eager' : 'lazy'}
                      decoding="async"
                      draggable={false}
                    />
                  </div>
                );
              })}
            </div>
            <p className="careers-media-caption">Buy. Sell. Settle in PKN.</p>
          </div>
        </div>

        <div className="careers-prose">
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
      <section className="careers-module careers-principles-mod" aria-labelledby="careers-principles-heading">
        <h2 id="careers-principles-heading" className="careers-display">
          Principles guide
          <br />
          our <TitleMark /> people
        </h2>
        <PrinciplesSlider />
      </section>

      {/* 3 · moduleBlockContentWithIntro */}
      <section className="careers-module careers-perks-intro" aria-labelledby="careers-perks-heading">
        <h2 id="careers-perks-heading" className="careers-display">
          Powered by the
          <br />
          best <TitleMark /> reasons
        </h2>
      </section>

      {/* 4 · moduleCardsBasic */}
      <section className="careers-module careers-benefits" aria-labelledby="careers-benefits-heading">
        <div className="careers-prose">
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
        <ul className="careers-perk-grid">
          {REASONS.map((item) => (
            <li key={item.title} className={`careers-perk-card tone-${item.tone}`}>
              <span className="careers-perk-title">{item.title}</span>
              <CareersCardArt art={item.art} className="careers-perk-art" />
            </li>
          ))}
        </ul>
      </section>

      {/* 5 · moduleJobsWithIntro */}
      <section
        className="careers-module careers-open"
        id="open-positions"
        aria-labelledby="careers-open-heading"
      >
        <h2 id="careers-open-heading" className="careers-display">
          Open <TitleMark /> Positions
        </h2>
        <div className="careers-jobs-wrap">
          <OpenPositions roles={roles} />
        </div>
      </section>

      {/* 6 · mediaCarousel — product surfaces, not staff photos */}
      <section className="careers-module careers-strip-mod" aria-label="Pokoin surfaces">
        <SurfacesSlider />
        <p className="careers-strip-note">
          Prefer exploring the live product?{' '}
          <Link to="/marketplace">Open the marketplace</Link>
          {' · '}
          <Link to="/about">About Pokoin</Link>
        </p>
      </section>
    </div>
  );
}
