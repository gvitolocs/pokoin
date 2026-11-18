import { createSignal, For, Show } from 'solid-js';
import manifest from '@market/../public/review/manifest.json';
import TestDock from '../components/TestDock.jsx';
import { BoardBar, BoardToggle, usePageTitle, ZoomDialog } from './tools/board.jsx';

const asset = (file) => `${import.meta.env.BASE_URL}review/${file}?v=${manifest.revision}`;

function mapShot(side) {
  return {
    src: asset(side.file),
    label: side.label,
    caption: side.caption,
    details: side.details || [],
    metrics: side,
  };
}

const SECTIONS = manifest.sections.map((section) => ({
  id: section.id || section.title,
  title: section.title,
  kicker: section.kicker,
  live: section.live,
  note: section.note,
  pairs: (section.pairs || []).map((pair) => [mapShot(pair.before), mapShot(pair.after)]),
}));

const STRIP = manifest.strip
  ? { src: asset(manifest.strip.file), label: manifest.strip.label, caption: manifest.strip.caption }
  : null;

const DEFERRED = manifest.deferred || [];
const GPU = manifest.gpu || null;

function SkewMetrics(props) {
  const m = () => props.metrics;
  return (
    <Show when={m()}>
      <Show when={m().brightSkewDeg != null}>
        <span class="sanitize-metric">Bright edge: {m().brightSkewDeg}°</span>
      </Show>
      <Show when={m().outerSkewDeg != null}>
        <span class="sanitize-metric">Silhouette: {m().outerSkewDeg}°</span>
      </Show>
      <Show when={m().attackSharpness != null}>
        <span class="sanitize-metric">Attack sharpness: {m().attackSharpness}</span>
      </Show>
      <Show when={m().skewDeg != null && m().brightSkewDeg == null}>
        <span class="sanitize-metric">Skew: {m().skewDeg}°</span>
      </Show>
    </Show>
  );
}

function Shot(props) {
  return (
    <figure class="sanitize-shot">
      <button type="button" class="sanitize-frame" onClick={() => props.onZoom(props.shot)}>
        <img src={props.shot.src} alt={props.shot.label} />
        <Show when={props.guides}><span class="sanitize-guides" aria-hidden="true" /></Show>
      </button>
      <figcaption>
        <strong>{props.shot.label}</strong>
        <span>{props.shot.caption}</span>
        <Show when={props.shot.details?.length}>
          <ul class="sanitize-details">
            <For each={props.shot.details}>{(line) => <li>{line}</li>}</For>
          </ul>
        </Show>
        <Show when={props.shot.metrics?.cornerLightSpecks != null}>
          <span class="sanitize-metric">Corner specks: {props.shot.metrics.cornerLightSpecks}</span>
        </Show>
        <SkewMetrics metrics={props.shot.metrics} />
      </figcaption>
    </figure>
  );
}

/** Leftover-scan sanitizer before/after board. */
export default function Sanitize() {
  const [guides, setGuides] = createSignal(true);
  const [zoom, setZoom] = createSignal(null);
  usePageTitle('Sanitize review · test.pokoin.com');

  return (
    <div class="sanitize">
      <BoardBar host={`test.pokoin.com · sanitizer · ${manifest.revision}`}>
        <BoardToggle checked={guides()} onChange={setGuides}>Hairlines</BoardToggle>
      </BoardBar>

      <main class="sanitize-main">
        <p class="sanitize-lead">
          Local JPEG review ({manifest.generatedAt.slice(0, 10)}). Not live CDN.
          Charizard leftover only — no CardTrader source. Use hairlines for the
          outer-edge red-line test; compare attack-text sharpness for interior
          artifacts.
        </p>

        <Show when={GPU}>
          <p class="sanitize-note">
            GPU: {GPU.device} · measured bright edge {GPU.measuredBrightDeg}° ·
            applied rotate {GPU.appliedDeg}°
          </p>
        </Show>

        <For each={SECTIONS}>
          {(section) => (
            <section class="sanitize-block">
              <p class="sanitize-kicker">{section.kicker}</p>
              <h1>{section.title}</h1>
              <p class="sanitize-note">{section.note}</p>
              <Show when={section.live}>
                <p>
                  <a href={section.live} target="_blank" rel="noreferrer">Live card 713832</a>
                </p>
              </Show>
              <For each={section.pairs}>
                {(shots) => (
                  <div class="sanitize-pair">
                    <For each={shots}>
                      {(shot) => <Shot shot={shot} guides={guides()} onZoom={(next) => setZoom(() => next)} />}
                    </For>
                  </div>
                )}
              </For>
            </section>
          )}
        </For>

        <Show when={STRIP}>
          <section class="sanitize-block">
            <h2>Side-by-side strip</h2>
            <p class="sanitize-note">{STRIP.caption}</p>
            <button type="button" class="sanitize-strip" onClick={() => setZoom(() => STRIP)}>
              <img src={STRIP.src} alt={STRIP.label} />
            </button>
          </section>
        </Show>

        <Show when={DEFERRED.length}>
          <section class="sanitize-block sanitize-deferred">
            <h2>Held back</h2>
            <p class="sanitize-note">
              Other pipeline samples stay off this page until their border passes
              are fixed.
            </p>
            <ul class="sanitize-deferred-list">
              <For each={DEFERRED}>
                {(entry) => (
                  <li>
                    <strong>{entry.title}</strong>
                    <span>{entry.reason}</span>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
      </main>

      <TestDock />
      <ZoomDialog shot={zoom()} onClose={() => setZoom(null)} />
    </div>
  );
}
