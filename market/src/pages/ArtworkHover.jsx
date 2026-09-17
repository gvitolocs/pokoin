import { useEffect } from 'react';
import CardArt from '../components/CardArt.jsx';
import TestDock from '../components/TestDock.jsx';

const REVISION = '2026-09-17';

const BEFORE_MASK_REV = 'sam21-1';
const AFTER_MASK_REV = 'clean-1';

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

const ARTIFACT_CASES = [
  {
    version: 'v249112',
    name: 'Lampent',
    image: '/card-images/124556_lampent-42-119-phantom-forces.jpg',
    status: 'Pass',
    note: 'Translucent glass body: SAM carved 3.1% of the silhouette into interior lakes. Now filled.',
  },
  {
    version: 'v249116',
    name: 'Chandelure',
    image: '/card-images/124558_chandelure-rare-holo-43-119-phantom-forces.jpg',
    status: 'Pass',
    note: 'Holofoil granular specks: 56 disconnected islands, 50 under 50 px, plus 4.3% holes. Now solid.',
  },
  {
    version: 'v224472',
    name: 'Noivern GX',
    image: '/card-images/112236_noivern-gx-full-v4.jpg',
    status: 'Pass',
    note: 'Worst speck case: 579 detached islands along the foil edges. Cleanup keeps the two figures.',
  },
  {
    version: 'v239120',
    name: 'Xerneas GX',
    image: '/card-images/119560_xerneas-gx-full-v4.jpg',
    status: 'Pass',
    note: '497 foil specks and 7.2% interior holes before. Cleanup clears both — QA passes, so this mask ships on production.',
  },
];

function maskUrl(version, rev, dir = 'figure-masks') {
  return `/card-images/${dir}/${version}.webp?v=${rev}`;
}

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

function CaseTile({ item, mask, label }) {
  const card = { id: item.version.slice(1), version: item.version, name: item.name };
  return (
    <div
      className="tile tile-cut tile-album artwork-test-card"
      tabIndex="0"
      aria-label={`${item.name} ${label.toLowerCase()} silhouette hover test`}
    >
      <span className="tile-art">
        <CardArt
          src={item.image}
          alt={`${item.name} ${label.toLowerCase()} cleanup comparison`}
          cut
          cutSurface="album"
          full
          card={card}
          figureMask={mask}
          loading="lazy"
        />
      </span>
      <span className="artwork-hover-hint">{label} — hover</span>
    </div>
  );
}

function MaskCase({ item }) {
  const before = maskUrl(item.version, BEFORE_MASK_REV);
  const after = maskUrl(item.version, AFTER_MASK_REV, 'figure-masks-clean');
  return (
    <article className="artwork-test-case artwork-mask-case">
      <div className="artwork-case-pair">
        <CaseTile item={item} mask={before} label="Before" />
        <CaseTile item={item} mask={after} label="After" />
      </div>
      <div className="artwork-test-copy">
        <div className="artwork-test-heading">
          <h2>{item.name}</h2>
          <span className={`artwork-status ${item.status === 'Pass' ? 'is-pass' : 'is-review'}`}>
            {item.status}
          </span>
        </div>
        <p>{item.note}</p>
        <div className="artwork-mask-pair">
          <figure>
            <img src={before} alt={`${item.name} mask before cleanup`} loading="lazy" />
            <figcaption>Before</figcaption>
          </figure>
          <figure>
            <img src={after} alt={`${item.name} mask after cleanup`} loading="lazy" />
            <figcaption>After</figcaption>
          </figure>
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

        <h2 className="artwork-section-title">Hole and speck cleanup — before / after</h2>
        <p className="sanitize-note">
          The same card twice: the left tile wears the raw SAM 2.1 mask uploaded to
          production, the right tile wears the cleaned silhouette
          (<code>fill_holes</code> + island removal + edge closing, uploaded to
          <code>/card-images/figure-masks-clean/</code>). Alpha previews sit under each pair.
        </p>
        <section className="artwork-review-grid" aria-label="Mask cleanup before and after">
          {ARTIFACT_CASES.map((item) => <MaskCase key={item.version} item={item} />)}
        </section>
      </main>

      <TestDock />
    </div>
  );
}
