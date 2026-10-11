import { createMemo, createSignal, For, Match, onSettled, Show, Switch, untrack } from 'solid-js';
import { useParams } from '@solidjs/router';
import { fetchExpansions } from '@market/api.js';
import { languageMatches } from '@market/browse-hubs.js';
import { LANGUAGE_HUBS, languageHref } from '@market/seo.js';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';
import SeoCrumbs from '../components/desk/SeoCrumbs.jsx';
import SeoHead from '../components/SeoHead.jsx';
import SetGuideGrid, { SetGuideSkeleton } from '../components/SetGuideGrid.jsx';

function LanguageIndex(props) {
  return (
    <div class="page desk hub-page">
      <SeoHead
        title="Pokémon Card Languages | Pokoin"
        description="Browse Pokémon TCG expansions by print language: English, Japanese, Korean, and Chinese."
        canonical={`/marketplace/${props.lang}/languages`}
      />
      <SeoCrumbs items={[
        { name: 'Marketplace', href: '/marketplace' },
        { name: 'Languages' },
      ]} />
      <PageHead kicker="Catalog" title="Languages" />
      <ol class="hub-index hub-index-wide">
        <For each={LANGUAGE_HUBS}>
          {(row) => (
            <li>
              <a href={languageHref(row.slug, props.lang)}>{row.name} print</a>
            </li>
          )}
        </For>
      </ol>
    </div>
  );
}

/** Expansions of one print language (Western takes American and European prints). */
function LanguageSets(props) {
  const hub = untrack(() => props.hub);
  const [expansions, setExpansions] = createSignal(null);
  const [error, setError] = createSignal('');
  let disposed = false;
  fetchExpansions({ limit: 2000 })
    .then((data) => {
      if (!disposed) setExpansions(() => data.expansions || data.sets || []);
    })
    .catch((err) => {
      if (!disposed) setError(err.message || 'Sets failed.');
    });
  onSettled(() => () => {
    disposed = true;
  });
  const rows = createMemo(() => (expansions() || []).filter((row) => languageMatches(row, hub)));

  return (
    <div class="page desk set-guide-page hub-page">
      <SeoHead
        title={`${hub.name} Pokémon Cards | Pokoin`}
        description={`${hub.name} Pokémon TCG expansions and printings on Pokoin.`}
        canonical={languageHref(hub.slug, props.lang)}
      />
      <SeoCrumbs items={[
        { name: 'Marketplace', href: '/marketplace' },
        { name: 'Languages', href: `/marketplace/${props.lang}/languages` },
        { name: hub.name },
      ]} />
      <PageHead kicker="Print language" title={`${hub.name} print`} />
      <p class="result-count">
        <Show when={expansions() != null} fallback="Loading…">
          <strong>{rows().length}</strong> sets
        </Show>
      </p>
      <Alert message={error()} />
      <Show
        when={!(expansions() && !rows().length)}
        fallback={<EmptyDesk title="No sets for this print language" lede="Try another language hub." />}
      >
        <Show when={expansions() != null} fallback={<SetGuideSkeleton />}>
          <SetGuideGrid rows={rows()} />
        </Show>
      </Show>
    </div>
  );
}

/** /marketplace/:lang/languages(/:slug) (market/src/pages/LanguageHub.jsx). */
export default function LanguageHub() {
  const params = useParams();
  const lang = () => params.lang || 'en';
  const hub = () => LANGUAGE_HUBS.find((row) => row.slug === String(params.slug || '').toLowerCase()) || null;
  return (
    <Switch>
      <Match when={!params.slug}><LanguageIndex lang={lang()} /></Match>
      <Match when={!hub()}>
        <div class="page desk hub-page">
          <EmptyDesk title="Unknown language" lede="Open the language index.">
            <a class="btn" href={`/marketplace/${lang()}/languages`}>Languages</a>
          </EmptyDesk>
        </div>
      </Match>
      <Match when={hub()} keyed>{(row) => <LanguageSets hub={row} lang={lang()} />}</Match>
    </Switch>
  );
}
