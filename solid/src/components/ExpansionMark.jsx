import { createSignal, Show } from 'solid-js';
import { setSlug } from '@market/api.js';
import { setAbbrev } from '@market/identity.js';
import { DEAD_IMAGE, rememberImageFallback, workingImage } from '@market/image-fallback-memo.js';
import { cdnFetchUrl } from '@market/image-urls.js';
import { expansionCode, expansionSymbolSrc } from '@market/set-logos.js';

/**
 * Circular expansion mark, or the letter code when the PNG is missing.
 * Loads from cdn.pokoin.com
 * directly: /card-images/* is a zone 301 to the CDN, one redirect per symbol.
 */
export default function ExpansionMark(props) {
  const slug = () => setSlug(props.setName);
  const src = () => cdnFetchUrl(expansionSymbolSrc({ slug: slug(), expansionSymbolUrl: props.symbolUrl }));
  // A symbol that 404'd here before shows its letter code at once.
  const [dead, setDead] = createSignal(() => workingImage(src()) === DEAD_IMAGE);
  const code = () => expansionCode({ slug: slug(), name: props.setName }) || setAbbrev(props.setName) || '●';
  return (
    <Show when={!dead() && src()} fallback={<span class="set-shortcut-code">{code()}</span>}>
      <img
        class="set-shortcut-sym"
        src={src()}
        alt=""
        onError={() => {
          rememberImageFallback(src(), DEAD_IMAGE, { keepMs: 24 * 60 * 60_000 });
          setDead(true);
        }}
      />
    </Show>
  );
}
