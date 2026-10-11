import { For } from 'solid-js';
import CardArt from '../components/CardArt.jsx';
import TestDock from '../components/TestDock.jsx';
import { BoardBar, usePageTitle } from './tools/board.jsx';

const REVISION = '2026-09-17';

const BEFORE_MASK_REV = 'sam21-1';
const AFTER_MASK_REV = 'clean-1';
const WHOLE_MASK_REV = 'whole-1';

// Whole-silhouette rework: fill every interior hole + keep small details so the
// cut-out reads as one solid shape. Served from figure-masks-whole/ (test only;
// production still resolves figure-masks-clean/).
const WHOLE_CASES = [
  {
    version: 'v232338',
    name: 'Venusaur ex',
    image: '/card-images/116169_venusaur-ex-full-v4.jpg',
    status: 'Review',
    note: 'EX FireRed & LeafGreen 112/112 · Ryo Ueda. Left is production (clean-1); right fills the flower gap and keeps the leaf tips so the silhouette lifts whole.',
  },
];

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

function Status(props) {
  return (
    <span class={['artwork-status', props.status === 'Pass' ? 'is-pass' : 'is-review']}>{props.status}</span>
  );
}

function HoverSample(props) {
  const sample = () => props.sample;
  const card = () => ({
    id: sample().id,
    version: sample().version,
    name: sample().name,
    set: sample().set,
    number: sample().number,
  });
  const mask = () => `/card-images/figure-masks/${sample().version}.webp?v=sam21-1`;

  return (
    <article class="artwork-test-case">
      <div
        class="tile tile-cut tile-album artwork-test-card"
        tabindex="0"
        aria-label={`${sample().name} Pokémon-only hover test`}
      >
        <span class="tile-art">
          <CardArt
            src={sample().image}
            alt={`${sample().name} ${sample().set} ${sample().number}`}
            cut
            cutSurface="album"
            full
            card={card()}
            loading="eager"
          />
        </span>
        <span class="artwork-hover-hint">Hover or focus</span>
      </div>

      <div class="artwork-test-copy">
        <div class="artwork-test-heading">
          <h2>{sample().name}</h2>
          <Status status={sample().status} />
        </div>
        <p>{sample().note}</p>
        <p class="artwork-test-id">{sample().version} · {sample().number}</p>
        <div class="artwork-mask-preview">
          <img src={mask()} alt={`${sample().name} generated alpha mask`} />
          <span>Generated alpha mask</span>
        </div>
      </div>
    </article>
  );
}

function CaseTile(props) {
  const card = () => ({ id: props.item.version.slice(1), version: props.item.version, name: props.item.name });
  return (
    <div
      class="tile tile-cut tile-album artwork-test-card"
      tabindex="0"
      aria-label={`${props.item.name} ${props.label.toLowerCase()} silhouette hover test`}
    >
      <span class="tile-art">
        <CardArt
          src={props.item.image}
          alt={`${props.item.name} ${props.label.toLowerCase()} cleanup comparison`}
          cut
          cutSurface="album"
          full
          card={card()}
          figureMask={props.mask}
          loading="lazy"
        />
      </span>
      <span class="artwork-hover-hint">{props.label} — hover</span>
    </div>
  );
}

/** Before/after mask pair with its two hover tiles (WholeCase / MaskCase in React). */
function PairCase(props) {
  return (
    <article class="artwork-test-case artwork-mask-case">
      <div class="artwork-case-pair">
        <CaseTile item={props.item} mask={props.before} label={props.labels[0]} />
        <CaseTile item={props.item} mask={props.after} label={props.labels[1]} />
      </div>
      <div class="artwork-test-copy">
        <div class="artwork-test-heading">
          <h2>{props.item.name}</h2>
          <Status status={props.item.status} />
        </div>
        <p>{props.item.note}</p>
        {props.children}
        <div class="artwork-mask-pair">
          <figure>
            <img src={props.before} alt={`${props.item.name} ${props.alts[0]}`} loading="lazy" />
            <figcaption>{props.captions[0]}</figcaption>
          </figure>
          <figure>
            <img src={props.after} alt={`${props.item.name} ${props.alts[1]}`} loading="lazy" />
            <figcaption>{props.captions[1]}</figcaption>
          </figure>
        </div>
      </div>
    </article>
  );
}

function WholeCase(props) {
  return (
    <PairCase
      item={props.item}
      before={maskUrl(props.item.version, AFTER_MASK_REV, 'figure-masks-clean')}
      after={maskUrl(props.item.version, WHOLE_MASK_REV, 'figure-masks-whole')}
      labels={['Production', 'Whole']}
      alts={['production mask', 'whole silhouette mask']}
      captions={['Production (clean-1)', `Whole (${WHOLE_MASK_REV})`]}
    >
      <p class="artwork-test-id">{props.item.version}</p>
    </PairCase>
  );
}

function MaskCase(props) {
  return (
    <PairCase
      item={props.item}
      before={maskUrl(props.item.version, BEFORE_MASK_REV)}
      after={maskUrl(props.item.version, AFTER_MASK_REV, 'figure-masks-clean')}
      labels={['Before', 'After']}
      alts={['mask before cleanup', 'mask after cleanup']}
      captions={['Before', 'After']}
    />
  );
}

/** Pokémon-only album hover mask review board. */
export default function ArtworkHover() {
  usePageTitle('Artwork hover masks · test.pokoin.com');

  return (
    <div class="sanitize artwork-hover-page">
      <BoardBar host={`test.pokoin.com · artwork hover · ${REVISION}`} />

      <main class="sanitize-main">
<p class="sanitize-kicker">Qwen3-VL boxes → SAM 2.1 masks</p>
        <h1>Pokémon-only hover</h1>
        <p class="sanitize-lead">
          Hover a painting below. The Pokémon should enlarge while the rectangular
          artwork and its background remain still. The red grounding boxes are never
          rendered in the product UI.
        </p>
        <p class="sanitize-note">
          This is a review board, not a production rollout. Pass means the visible
          silhouette is clean; Review marks a useful edge case retained for inspection.
        </p>

        <h2 class="artwork-section-title">Whole silhouette — production / rework</h2>
        <p class="sanitize-note">
          The cleanup used to punch a hole where a translucent part (the flower) let the
          background through, and dropped small detached details, so silhouettes felt
          glitchy. The rework fills every interior hole and keeps the details, so the whole
          Pokémon lifts as one shape. Left tile wears the production mask
          (<code>figure-masks-clean/</code>), right wears the rework
          (<code>figure-masks-whole/</code>).
        </p>
        <section class="artwork-review-grid" aria-label="Whole silhouette rework">
          <For each={WHOLE_CASES}>{(item) => <WholeCase item={item} />}</For>
        </section>

        <h2 class="artwork-section-title">Sample paintings</h2>
        <section class="artwork-review-grid" aria-label="Artwork hover samples">
          <For each={SAMPLES}>{(sample) => <HoverSample sample={sample} />}</For>
        </section>

        <h2 class="artwork-section-title">Hole and speck cleanup — before / after</h2>
        <p class="sanitize-note">
          The same card twice: the left tile wears the raw SAM 2.1 mask uploaded to
          production, the right tile wears the cleaned silhouette
          (<code>fill_holes</code> + island removal + edge closing, uploaded to
          <code>/card-images/figure-masks-clean/</code>). Alpha previews sit under each pair.
        </p>
        <section class="artwork-review-grid" aria-label="Mask cleanup before and after">
          <For each={ARTIFACT_CASES}>{(item) => <MaskCase item={item} />}</For>
        </section>
      </main>

      <TestDock />
    </div>
  );
}
