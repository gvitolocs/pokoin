import { useRef } from 'react';
import { Link } from 'react-router-dom';
import CardTile from './CardTile.jsx';

export default function Carousel({ title, cards, href }) {
  const scroller = useRef(null);
  if (!cards?.length) {
    return null;
  }

  function next() {
    const node = scroller.current;
    if (!node) {
      return;
    }
    node.scrollBy({ left: Math.max(220, node.clientWidth * 0.8), behavior: 'smooth' });
  }

  return (
    <section className="carousel">
      <div className="carousel-head">
        <h2>{title}</h2>
        {href ? <Link className="see-all" to={href}>See more →</Link> : null}
      </div>
      <div className="rail-wrap">
        <div className="carousel-track" ref={scroller}>
          {cards.map((card, index) => (
            <CardTile key={card.id} card={card} rank={index} />
          ))}
        </div>
        <button className="rail-next" type="button" onClick={next} aria-label="Next">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
        </button>
      </div>
    </section>
  );
}
