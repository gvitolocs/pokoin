import { createMemo, createSignal, Show } from 'solid-js';
import { setSlug } from '@market/api.js';
import { expansionStampSrc } from '@market/expansion-stamps.js';
import { setAbbrev } from '@market/identity.js';
import { DEAD_IMAGE, rememberImageFallback, workingImage } from '@market/image-fallback-memo.js';
import { cdnFetchUrl } from '@market/image-urls.js';
import { expansionCode, expansionSymbolSources } from '@market/set-logos.js';

/**
 * Circular expansion mark: the SVG, then its PNG, then the letter code.
 * A stamped deck printing (Battle Academy Mewtwo, Trainer Kit Bisharp, …)
 * shows its stamp first; pass the printing's catalog `number` and `cardId`.
 * Pass `slug` when the page already has it (set desk), else `setName`.
 * Loads from cdn.pokoin.com
 * directly: /card-images/* is a zone 301 to the CDN, one redirect per symbol.
 */
export default function ExpansionMark(props) {
  const slug = () => props.slug || setSlug(props.setName);
  // Sources that 404'd here before are skipped, so the mark paints at once.
  // A memo: the filter runs once per source list, not again after an error.
  const sources = createMemo(() => [
    expansionStampSrc({ slug: slug(), number: props.number, id: props.cardId }),
    ...expansionSymbolSources({ slug: slug(), expansionSymbolUrl: props.symbolUrl }),
  ].filter(Boolean).map(cdnFetchUrl).filter((url) => workingImage(url) !== DEAD_IMAGE), {
    equals: (a, b) => a.length === b.length && a.every((url, i) => url === b[i]),
  });
  const [failed, setFailed] = createSignal(() => (sources(), 0));
  const src = () => sources()[failed()];
  const code = () => expansionCode({ slug: slug(), name: props.setName }) || setAbbrev(props.setName) || '●';
  return (
    <Show when={src()} fallback={<span class="set-shortcut-code">{code()}</span>}>
      <img
        class={props.class ? `set-shortcut-sym ${props.class}` : 'set-shortcut-sym'}
        src={src()}
        alt=""
        onError={() => {
          rememberImageFallback(src(), DEAD_IMAGE, { keepMs: 24 * 60 * 60_000 });
          setFailed((n) => n + 1);
        }}
      />
    </Show>
  );
}
