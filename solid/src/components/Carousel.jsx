import { createEffect, For, Repeat, Show } from 'solid-js';
import { bindRailControls, stepRail } from '@market/rail-scroll.js';
import CardSelectGrid from './CardSelectGrid.jsx';
import CardTile from './CardTile.jsx';

export function SkeletonTile(props) {
  return (
    <div
      class={[props.layout === 'list' ? 'tile tile-skel tile-row' : 'tile tile-skel', { 'tile-cut tile-album': props.album }]}
      aria-hidden="true"
    >
      <span class="tile-art"><span class="tile-ph" /></span>
      <div class="tile-meta">
        <Show
          when={props.album}
          fallback={(
            // The real tile's line boxes (name, identity, price) around the bars, so a
            // rail that fills in keeps its height (market Carousel.jsx SkeletonTile).
            <>
              <strong><span class="skel-line skel-inline" /></strong>
              <em class="tile-id"><span class="skel-line skel-line-sm skel-inline" /></em>
              <Show when={props.layout !== 'list'}>
                <span class="price"><span class="skel-line skel-line-sm skel-inline" /></span>
              </Show>
            </>
          )}
        >
          <span class="skel-line skel-line-sm" />
        </Show>
      </div>
    </div>
  );
}

/**
 * Horizontal rail (market/src/components/Carousel.jsx). Tiles are keyed by
 * card identity, so a rail that gains cards (progressive paint, priced
 * refresh) only inserts or patches the changed tiles.
 */
export default function Carousel(props) {
  let scroller;
  const ready = () => Boolean(props.cards?.length);
  createEffect(
    () => [props.cards?.length || 0, props.placeholders || 0],
    () => bindRailControls(scroller),
  );
  return (
    <Show when={ready() || (props.placeholders || 0) > 0}>
      <section class="carousel">
        <div class="carousel-head">
          <div class="carousel-title">
            <h2>{props.title}</h2>
            <Show when={props.subtitle}><p>{props.subtitle}</p></Show>
          </div>
          <Show when={props.href}><a class="see-all" href={props.href}>See more →</a></Show>
        </div>
        <div class="rail-wrap">
          <button class="rail-prev" type="button" onClick={() => stepRail(scroller, -1)} aria-label="Previous">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m15.75 19.5-7.5-7.5 7.5-7.5" /></svg>
          </button>
          <div class="rail-scroll" ref={(node) => { scroller = node; }}>
            <CardSelectGrid class="carousel-track">
              <Show when={ready()} fallback={<Repeat count={props.placeholders || 0}>{() => <SkeletonTile />}</Repeat>}>
                <For each={props.cards}>
                  {(card, index) => <CardTile card={card} rank={index()} eagerLimit={props.eagerLimit || 0} />}
                </For>
              </Show>
            </CardSelectGrid>
          </div>
          <button class="rail-next" type="button" onClick={() => stepRail(scroller, 1)} aria-label="Next">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
          </button>
        </div>
      </section>
    </Show>
  );
}
