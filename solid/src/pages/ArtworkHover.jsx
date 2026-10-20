import { For } from 'solid-js';
import CardArt from '../components/CardArt.jsx';
import TestDock from '../components/TestDock.jsx';
import { BoardBar, usePageTitle } from './tools/board.jsx';

const REVISION = '2026-10-20';

const BEFORE_MASK_REV = 'sam21-1';
const AFTER_MASK_REV = 'clean-1';
const WHOLE_MASK_REV = 'whole-1';
const PRODUCTION_MASK_REV = 'clean-2';

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

// Full-art silhouettes cut from the artofpkm "TCG Gallery" clean artwork (no
// card text). Production is figure-masks-clean/; the clean-art set is
// figure-masks-artofpkm/. VITE_ARTOFPKM_MASK_BASE points the right tile at a
// local copy while the set is still under review (dev only).
const ARTOFPKM_MASK_BASE = import.meta.env.VITE_ARTOFPKM_MASK_BASE || '/card-images/figure-masks-artofpkm';
const CLEAN_ART_CASES = [
  {
    version: 'v240808',
    name: 'Tapu Lele GX',
    image: '/card-images/120404_tapu-lele-gx-full-v4.jpg',
    status: 'Pass',
    note: 'Guardians Rising 60/145. The attack text bit the lower body off the scan-cut silhouette; the clean painting keeps it, and the opaque Tapu Cure GX bar stays out.',
  },
  {
    version: 'v436094',
    name: 'Mewtwo V',
    image: '/card-images/218047_mewtwo-v-ultra-rare-072-078-pokemon-tcg-pokemon-go.jpg',
    status: 'Pass',
    note: 'Pokémon GO 072/078. Holes where the scan foil and text broke the body are gone.',
  },
  {
    version: 'v290118',
    name: 'Charizard VMAX',
    image: '/card-images/145059_charizard-vmax-020-189-darkness-ablaze.jpg',
    status: 'Pass',
    note: 'Darkness Ablaze 020/189. The scan mask failed QA, so production has no hover; the clean painting gives the whole Charizard. Energy icons inside the body stay part of it.',
  },
  {
    version: 'v254958',
    name: 'Zoroark GX',
    image: '/card-images/127479_zoroark-gx-rare-holo-53-73-shining-legends.jpg',
    status: 'Pass',
    note: 'Shining Legends 53/73. New hover. The tail runs under the Trickster GX bar; the bar is cut so it does not lift with the Pokémon.',
  },
  {
    version: 'v316756',
    name: 'Shadow Rider Calyrex V',
    image: '/card-images/158378_shadow-rider-calyrex-v-rare-ultra-172-198-chilling-reign.jpg',
    status: 'Pass',
    note: 'Chilling Reign 172/198. The scan cut dropped Calyrex riding on Spectrier.',
  },
  {
    version: 'v260900',
    name: 'Reshiram & Charizard GX',
    image: '/card-images/130450_reshiram-charizard-gx-rare-holo-20-214-unbroken-bonds.jpg',
    status: 'Pass',
    note: 'Unbroken Bonds 20/214. Text-heavy full art: silhouettes follow the painting under the attack text.',
  },
  {
    version: 'v424984',
    name: 'Hisuian Lilligant V',
    image: '/card-images/212492_hisuian-lilligant-v-ultra-rare-017-189-astral-radiance.jpg',
    status: 'Review',
    note: 'Astral Radiance 017/189. New hover (the scan mask failed QA). Motion streaks next to the body are partly included.',
  },
  {
    version: 'v262284',
    name: 'Mewtwo & Mew GX',
    image: '/card-images/131142_mewtwo-mew-gx-secret-rare-rare-71-236-unified-minds.jpg',
    status: 'Pass',
    note: 'Unified Minds 71/236. Mew under the Miraculous Duo text now lifts with Mewtwo.',
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

function CleanArtCase(props) {
  return (
    <PairCase
      item={props.item}
      before={maskUrl(props.item.version, PRODUCTION_MASK_REV, 'figure-masks-clean')}
      after={`${ARTOFPKM_MASK_BASE}/${props.item.version}.webp?v=artofpkm-1`}
      labels={['Scan cut', 'Clean art']}
      alts={['production scan-cut mask', 'clean-artwork mask']}
      captions={['Production (scan, clean-2)', 'Clean artwork (artofpkm-1)']}
    >
      <p class="artwork-test-id">{props.item.version}</p>
    </PairCase>
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

        <h2 class="artwork-section-title">Clean-art silhouettes — scan cut / clean artwork</h2>
        <p class="sanitize-note">
          Full arts only: their attack text, HP and rule bars sit on the painting, so the
          silhouette SAM cut from the scan had bites and holes. These masks are cut from the
          artofpkm TCG Gallery artwork (catalog 668, no card text), registered onto the same
          scan, and solid card bars are left out. Left tile wears production
          (<code>figure-masks-clean/</code>), right the clean-art mask
          (<code>figure-masks-artofpkm/</code>). Window-art cards keep their scan masks.
        </p>
        <section class="artwork-review-grid" aria-label="Clean-art silhouettes">
          <For each={CLEAN_ART_CASES}>{(item) => <CleanArtCase item={item} />}</For>
        </section>

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
