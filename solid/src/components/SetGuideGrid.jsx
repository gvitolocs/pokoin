import { createSignal, For, Repeat, Show } from 'solid-js';
import { setSlug } from '@market/api.js';
import { bundleReference, writeListingDrag } from '@market/chat-listing.js';
import { resolveExpansionNationality } from '@market/expansion-print.js';
import { flagSrc, printFlagFromNationality } from '@market/locale.js';
import { expansionCode, expansionLogoSrc } from '@market/set-logos.js';
import ExpansionMark from './ExpansionMark.jsx';

/** Wordmark, or the circular expansion mark when there is none or it fails to load. */
function SetGuideLogo(props) {
  const logo = () => expansionLogoSrc(props.row);
  const [wordmarkDead, setWordmarkDead] = createSignal(false);
  const showMark = () => !logo() || wordmarkDead();
  return (
    <div class={['set-guide-logo', { 'is-mark': showMark() }]}>
      <Show
        when={!showMark()}
        fallback={(
          <span class="set-shortcut is-on">
            <ExpansionMark
              setName={props.row.name}
              symbolUrl={props.row.expansionSymbolUrl || props.row.symbolImageUrl || props.row.defaultSymbolUrl}
            />
          </span>
        )}
      >
        <img src={logo()} alt="" draggable="false" onError={() => setWordmarkDead(true)} />
      </Show>
    </div>
  );
}

function SetGuideCard(props) {
  const slug = () => props.row.slug || setSlug(props.row.name);
  const row = () => ({ ...props.row, slug: slug() });
  const code = () => expansionCode(row());
  const count = () => props.row.cardCount || props.row.count || props.row.cards || '';
  const printFlag = () => printFlagFromNationality(resolveExpansionNationality(props.row));
  return (
    <a
      class="set-guide-card"
      href={`/marketplace/sets/${slug()}`}
      draggable="true"
      onDragStart={(event) => {
        writeListingDrag(event, bundleReference({
          kind: 'expansion',
          slug: slug(),
          name: props.row.name,
          imageUrl: expansionLogoSrc(row()),
          path: slug() ? `/marketplace/sets/${slug()}` : '',
        }));
      }}
    >
      <SetGuideLogo row={row()} />
      <strong class={printFlag() ? 'has-print-flag' : undefined}>
        <Show when={printFlag()}>
          <span class="set-guide-print-flag">
            <img src={flagSrc(printFlag().code)} alt="" width="28" height="28" draggable="false" />
            <span class="sr-only">{printFlag().label}</span>
          </span>
        </Show>
        <span>{props.row.name}</span>
      </strong>
      <div class="set-guide-meta">
        <Show when={code()}><span class="set-guide-code">{code()}</span></Show>
        <Show when={count()}><span class="muted">{count()}</span></Show>
      </div>
      <span class="set-guide-cta">
        Open set
        <span aria-hidden="true">→</span>
      </span>
    </a>
  );
}

/**
 * Expansion tiles (market/src/components/SetGuideGrid.jsx). Rows are the
 * catalog's own objects, so the keyed list keeps a tile when a filter or era
 * chip only reorders or narrows the set list.
 */
export default function SetGuideGrid(props) {
  return (
    <div class="set-guide-grid">
      <For each={props.rows || []}>{(row) => <SetGuideCard row={row} />}</For>
    </div>
  );
}

/** Placeholder grid while the catalog loads (same markup as the React pages). */
export function SetGuideSkeleton() {
  return (
    <div class="set-guide-grid" aria-hidden="true">
      <Repeat count={8}>{() => <div class="set-guide-card is-skeleton" />}</Repeat>
    </div>
  );
}
