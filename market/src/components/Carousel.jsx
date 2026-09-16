import { useLayoutEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import CardTile from './CardTile.jsx';
import { bindRailControls, stepRail } from '../rail-scroll.js';

export function SkeletonTile({ layout = 'grid', album = false }) {
  return (
    <div
      className={[
        layout === 'list' ? 'tile tile-skel tile-row' : 'tile tile-skel',
        album ? 'tile-cut tile-album' : '',
      ].filter(Boolean).join(' ')}
      aria-hidden="true"
    >
      <span className="tile-art"><span className="tile-ph" /></span>
      <div className="tile-meta">
        {album ? (
          <span className="skel-line skel-line-sm" />
        ) : (
          <>
            <strong className="skel-line" />
            <span className="skel-line skel-line-sm" />
          </>
        )}
      </div>
    </div>
  );
}

export default function Carousel({ title, subtitle, cards, href, placeholders = 0 }) {
  const scroller = useRef(null);
  const ready = Boolean(cards?.length);

  useLayoutEffect(() => bindRailControls(scroller.current), [cards, placeholders, ready]);

  if (!ready && placeholders < 1) {
    return null;
  }

  function step(direction) {
    stepRail(scroller.current, direction);
  }

  return (
    <section className="carousel">
      <div className="carousel-head">
        <div className="carousel-title">
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {href ? <Link className="see-all" to={href}>See more →</Link> : null}
      </div>
      <div className="rail-wrap">
        <button className="rail-prev" type="button" onClick={() => step(-1)} aria-label="Previous">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m15.75 19.5-7.5-7.5 7.5-7.5" /></svg>
        </button>
        <div className="rail-scroll" ref={scroller}>
          <div className="carousel-track">
            {ready
              ? cards.map((card, index) => (
                  <CardTile key={card.id} card={card} rank={index} />
                ))
              : Array.from({ length: placeholders }, (_, index) => (
                  <SkeletonTile key={index} />
                ))}
          </div>
        </div>
        <button className="rail-next" type="button" onClick={() => step(1)} aria-label="Next">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
        </button>
      </div>
    </section>
  );
}
