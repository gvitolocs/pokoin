import { createSignal, Show } from 'solid-js';
import { setSlug } from '@market/api.js';
import { expansionStampSrc } from '@market/expansion-stamps.js';
import { setAbbrev } from '@market/identity.js';
import { cdnFetchUrl } from '@market/image-urls.js';
import { expansionCode, expansionSymbolSrc } from '@market/set-logos.js';

/**
 * Circular expansion mark, or the letter code when the PNG is missing.
 * A stamped deck printing (Battle Academy Mewtwo, Trainer Kit Bisharp, …)
 * shows its stamp first; pass the printing's catalog `number`.
 * Loads from cdn.pokoin.com
 * directly: /card-images/* is a zone 301 to the CDN, one redirect per symbol.
 */
export default function ExpansionMark(props) {
  const slug = () => setSlug(props.setName);
  const sources = () => [
    expansionStampSrc({ slug: slug(), number: props.number }),
    expansionSymbolSrc({ slug: slug(), expansionSymbolUrl: props.symbolUrl }),
  ].filter(Boolean).map(cdnFetchUrl);
  const [failed, setFailed] = createSignal(() => (sources(), 0));
  const src = () => sources()[failed()];
  const code = () => expansionCode({ slug: slug(), name: props.setName }) || setAbbrev(props.setName) || '●';
  return (
    <Show when={src()} fallback={<span class="set-shortcut-code">{code()}</span>}>
      <img class="set-shortcut-sym" src={src()} alt="" onError={() => setFailed((n) => n + 1)} />
    </Show>
  );
}
