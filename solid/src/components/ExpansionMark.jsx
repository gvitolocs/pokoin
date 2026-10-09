import { createSignal, Show } from 'solid-js';
import { setSlug } from '@market/api.js';
import { setAbbrev } from '@market/identity.js';
import { cdnFetchUrl } from '@market/image-urls.js';
import { expansionCode, expansionSymbolSrc } from '@market/set-logos.js';

/**
 * Circular expansion mark, or the letter code when the PNG is missing
 * (market/src/components/ExpansionMark.jsx). Loads from cdn.pokoin.com
 * directly: /card-images/* is a zone 301 to the CDN, one redirect per symbol.
 */
export default function ExpansionMark(props) {
  const slug = () => setSlug(props.setName);
  const src = () => cdnFetchUrl(expansionSymbolSrc({ slug: slug(), expansionSymbolUrl: props.symbolUrl }));
  const [dead, setDead] = createSignal(() => (src(), false));
  const code = () => expansionCode({ slug: slug(), name: props.setName }) || setAbbrev(props.setName) || '●';
  return (
    <Show when={!dead() && src()} fallback={<span class="set-shortcut-code">{code()}</span>}>
      <img class="set-shortcut-sym" src={src()} alt="" onError={() => setDead(true)} />
    </Show>
  );
}
