import { useEffect } from 'react';
import CardArt from '../components/CardArt.jsx';
import TestDock from '../components/TestDock.jsx';

const REVISION = '2026-09-16';

const SAMPLES = [
  {
    id: '219698',
    version: 'v219698',
    name: 'Oddish',
    set: 'Ancient Origins',
    number: '1/98',
    image: '/card-images/109849_oddish-1-98-ancient-origins.jpg',
    status: 'Pass',
    note: 'Clean single-Pokémon silhouette.',
  },
  {
    id: '219702',
    version: 'v219702',
    name: 'Gloom',
    set: 'Ancient Origins',
    number: '2/98',
    image: '/card-images/109851_gloom-full-v4.jpg',
    status: 'Review',
    note: 'Useful regression case for the small evolution icon in the name bar.',
  },
  {
    id: '219706',
    version: 'v219706',
    name: 'Vileplume',
    set: 'Ancient Origins',
    number: '3/98',
    image: '/card-images/109853_vileplume-3-98-ancient-origins.jpg',
    status: 'Review',
    note: 'Checks whether SAM includes loose ground and particle details.',
  },
];

function HoverSample({ sample }) {
  const card = {
    id: sample.id,
    version: sample.version,
    name: sample.name,
    set: sample.set,
    number: sample.number,
  };
  const mask = `/card-images/figure-masks/${sample.version}.webp?v=sam21-1`;

  return (
    <article className="artwork-test-case">
      <div
        className="tile tile-cut tile-album artwork-test-card"
        tabIndex="0"
        aria-label={`${sample.name} Pokémon-only hover test`}
      >
        <span className="tile-art">
          <CardArt
            src={sample.image}
            alt={`${sample.name} ${sample.set} ${sample.number}`}
            cut
            cutSurface="album"
            full
            card={card}
            loading="eager"
          />
        </span>
        <span className="artwork-hover-hint">Hover or focus</span>
      </div>

      <div className="artwork-test-copy">
        <div className="artwork-test-heading">
          <h2>{sample.name}</h2>
          <span className={`artwork-status ${sample.status === 'Pass' ? 'is-pass' : 'is-review'}`}>
            {sample.status}
          </span>
        </div>
        <p>{sample.note}</p>
        <p className="artwork-test-id">{sample.version} · {sample.number}</p>
        <div className="artwork-mask-preview">
          <img src={mask} alt={`${sample.name} generated alpha mask`} />
          <span>Generated alpha mask</span>
        </div>
      </div>
    </article>
  );
}

export default function ArtworkHover() {
  useEffect(() => {
    document.title = 'Artwork hover masks · test.pokoin.com';
  }, []);

  return (
    <div className="sanitize artwork-hover-page">
      <header className="sanitize-bar">
        <a className="brand" href="https://pokoin.com/" aria-label="Pokoin">
          <img src="/home/logo.png" alt="" width="40" height="40" />
          <span>Pokoin</span>
        </a>
        <p className="sanitize-host">test.pokoin.com · artwork hover · {REVISION}</p>
      </header>

      <main className="sanitize-main">
        <p className="sanitize-kicker">Qwen3-VL boxes → SAM 2.1 masks</p>
        <h1>Pokémon-only hover</h1>
        <p className="sanitize-lead">
          Hover a painting below. The Pokémon should enlarge while the rectangular
          artwork and its background remain still. The red grounding boxes are never
          rendered in the product UI.
        </p>
        <p className="sanitize-note">
          This is a review board, not a production rollout. Pass means the visible
          silhouette is clean; Review marks a useful edge case retained for inspection.
        </p>

        <section className="artwork-review-grid" aria-label="Artwork hover samples">
          {SAMPLES.map((sample) => <HoverSample key={sample.version} sample={sample} />)}
        </section>
      </main>

      <TestDock />
    </div>
  );
}
