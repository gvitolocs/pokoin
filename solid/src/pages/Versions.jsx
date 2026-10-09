import {
  createEffect,
  createMemo,
  createProjection,
  createSignal,
  For,
  Loading,
  onSettled,
  Repeat,
  Show,
  untrack,
} from 'solid-js';
import { useLocation, useNavigate, useParams } from '@solidjs/router';
import {
  cardFromCatalogRow,
  cardHref,
  fetchCard,
  fetchExactNameCards,
  fetchLastMedianPknMap,
  fetchNamePrintings,
  fetchVersionSet,
} from '@market/api.js';
import { realPublicCardId } from '@market/card-stub.js';
import { isNameReprintCard, mergePrintingRows, printLangBadge, splitVersionPage } from '@market/card-versions.js';
import { filterExactNameRows } from '@market/exact-name.js';
import { game, publicGamePath } from '@market/game.js';
import { applyLastMedianPrices } from '@market/pkn.js';
import { eraHref } from '@market/set-logos.js';
import CardSelectGrid from '../components/CardSelectGrid.jsx';
import CardTile from '../components/CardTile.jsx';
import { SkeletonTile } from '../components/Carousel.jsx';
import SeoHead from '../components/SeoHead.jsx';

const EMPTY_MARK = 'M7 3h10a2 2 0 0 1 2 2v14l-7-3-7 3V5a2 2 0 0 1 2-2zm0 2v11.2l5-2.1 5 2.1V5H7z';

function rowsFrom(list) {
  return (list || []).map(cardFromCatalogRow).filter((row) => row.id);
}

function PageHead(props) {
  return (
    <header class="page-head">
      <div>
        <h1 class="page-title">{props.children}</h1>
      </div>
    </header>
  );
}

function TileGrid(props) {
  return (
    <CardSelectGrid class="grid versions-grid">
      <For each={props.rows}>
        {(row, index) => (
          <div class={String(row.id) === String(props.cardId) ? 'version-tile on' : 'version-tile'}>
            <Show when={props.flags && printLangBadge(row)}>
              <span class="espurr-flag">{printLangBadge(row)}</span>
            </Show>
            <CardTile card={row} rank={index()} />
          </div>
        )}
      </For>
    </CardSelectGrid>
  );
}

/** Rarity Lineup + artwork-era groups for one printing (market/src/pages/Versions.jsx). */
export default function Versions() {
  const params = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const lang = () => params.lang || 'en';
  const cardId = () => realPublicCardId(params.cardId);
  const pageKey = createMemo(() => `${lang()}:${cardId()}:${params.slug || ''}`);

  const idKey = createMemo(() => `${params.cardId}|${cardId()}`);
  createEffect(idKey, () => {
    const raw = String(untrack(() => params.cardId));
    const real = String(untrack(cardId));
    if (raw === real) return;
    const path = untrack(() => location.pathname);
    navigate(`${path.replace(`/cards/${raw}`, `/cards/${real}`)}${untrack(() => location.search)}`, {
      replace: true,
      scroll: false,
    });
  });

  return (
    <Show when={pageKey()} keyed>
      {(key) => {
        // Keyed callbacks must declare the key parameter (see pages/Card.jsx).
        const [keyLang, keyId, ...rest] = key.split(':');
        return <VersionsPage cardId={keyId} lang={keyLang} slug={rest.join(':')} />;
      }}
    </Show>
  );
}

function VersionsPage(props) {
  const cardId = untrack(() => props.cardId);
  const lang = untrack(() => props.lang);
  const slug = untrack(() => props.slug);
  const location = useLocation();
  // Exact-name rows in arrival order, folded onto the card-page rarities.
  const [batches, setBatches] = createSignal([]);
  const [medians, setMedians] = createSignal({});
  let disposed = false;
  let medianSeq = 0;
  let loaded = null;
  let extra = [];

  onSettled(() => () => {
    disposed = true;
  });

  function groupsFor(artCards, nameRows) {
    const current = artCards.find((row) => String(row.id) === cardId)
      || nameRows.find((row) => String(row.id) === cardId)
      || artCards[0]
      || nameRows[0];
    return { current, ...splitVersionPage({ current, nameRows, artRows: artCards }) };
  }

  function scrollToHash() {
    const hash = String(window.location.hash || '').replace('#', '');
    if (!hash) return;
    requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView({ block: 'start' }));
  }

  /** Last median per shown printing; re-asked whenever the printing set changes. */
  function refreshMedians() {
    if (!loaded) return;
    const nameRows = extra.reduce((acc, rows) => mergePrintingRows(acc, rows), loaded.rarities);
    const groups = groupsFor(loaded.artCards, nameRows);
    const ids = [...groups.versions, ...(groups.eras || []).flatMap((group) => group.rows)]
      .map((row) => row.id)
      .filter(Boolean);
    medianSeq += 1;
    const seq = medianSeq;
    if (!ids.length) {
      setMedians({});
      return;
    }
    fetchLastMedianPknMap(ids).then((byId) => {
      if (!disposed && seq === medianSeq) setMedians(byId);
    }).catch(() => {
      if (!disposed && seq === medianSeq) setMedians({});
    });
  }

  function addBatch(rows) {
    if (disposed || !rows.length) return;
    extra = [...extra, rows];
    setBatches(extra);
    refreshMedians();
    scrollToHash();
  }

  document.title = 'Versions · Pokoin';
  // Satellite TCGs have no CLIP version-set yet — soft-fail so card-page
  // rarities still paint the Rarity Lineup.
  const data = createMemo(() => Promise.all([
    fetchVersionSet(cardId).catch(() => ({ printings: [] })),
    fetchCard(cardId, { lang, slug }).catch(() => null),
  ]).then(([set, page]) => {
    const printings = Array.isArray(set?.printings) ? set.printings : [];
    const name = printings.find((row) => String(row.id) === cardId)?.name
      || printings[0]?.name
      || page?.card?.name
      || 'Card';
    if (!disposed) document.title = `${name} · versions · Pokoin`;
    const rarities = [...(page?.rarities || []), ...(page?.versions || []), page?.card || null]
      .map(cardFromCatalogRow)
      .filter((row) => row.id);
    loaded = { artCards: rowsFrom(printings), rarities };
    if (name && name !== 'Card') {
      fetchExactNameCards(name, { lang }).then(addBatch).catch(() => {});
      // Meili stops once a page has no exact hit. Item and trainer
      // reprints are the whole name, so the SQL catalog is the full list.
      if (isNameReprintCard({ name })) {
        fetchNamePrintings(name, { lang }).then((rows) => addBatch(filterExactNameRows(rows, name))).catch(() => {});
      }
    }
    queueMicrotask(() => {
      refreshMedians();
      scrollToHash();
    });
    return {
      ...loaded,
      error: !printings.length && !rarities.length && !page?.card ? 'Card not found.' : '',
    };
  }));

  const nameRows = createMemo(() => batches().reduce((acc, rows) => mergePrintingRows(acc, rows), data().rarities));
  const groups = createMemo(() => groupsFor(data().artCards, nameRows()));
  // Grids reconcile by card id: a late name batch or the median prices patch
  // tiles in place instead of re-creating them.
  const view = createProjection(() => {
    const byId = medians();
    return {
      versions: applyLastMedianPrices(groups().versions, byId),
      eras: (groups().eras || []).map((group) => ({ ...group, rows: applyLastMedianPrices(group.rows, byId) })),
    };
  }, { versions: [], eras: [] });

  const current = () => groups().current;
  const setName = () => String(current()?.set || current()?.set_name || '').trim();
  const cardName = () => String(current()?.name || '').trim();
  const headTitle = () => (cardName() && setName() && setName() !== cardName()
    ? `${cardName()} - ${setName()}`
    : (cardName() || 'Versions'));
  const eraCount = () => view.eras.reduce((sum, group) => sum + group.rows.length, 0);
  const showRarity = () => view.versions.length > 1;
  const headCount = () => (showRarity() ? view.versions.length : eraCount());
  const parentPath = () => String(location.pathname || '').replace(/\/versions\/?$/, '') || '/marketplace';

  const pending = () => (
    <>
      <SeoHead title="Versions" description="Card versions." canonical={publicGamePath(parentPath(), game().id)} noindex />
      <nav class="crumbs">
        <a href="/marketplace">Marketplace</a>
        <span>/</span>
        <span>{slug || cardId}</span>
        <span>/</span>
        <span>Versions</span>
      </nav>
      <PageHead>Versions</PageHead>
      <div class="grid versions-grid">
        <Repeat count={6}>{() => <SkeletonTile />}</Repeat>
      </div>
    </>
  );

  return (
    <div class="page desk versions-page">
      <Loading fallback={pending()}>
        <SeoHead
          title={cardName() ? `${cardName()} versions` : 'Versions'}
          description={cardName() ? `Other printings of ${cardName()}.` : 'Card versions.'}
          canonical={current() ? cardHref(current()) : publicGamePath(parentPath(), game().id)}
          noindex
        />
        <nav class="crumbs">
          <a href="/marketplace">Marketplace</a>
          <span>/</span>
          <Show when={current()} fallback={<span>{slug || cardId}</span>}>
            <a href={cardHref(current())}>{current().name}</a>
          </Show>
          <span>/</span>
          <span>Versions</span>
        </nav>
        <PageHead>
          {headTitle()}
          <Show when={headCount()}>
            <span class="versions-count">{headCount()} {headCount() === 1 ? 'version' : 'versions'}</span>
          </Show>
        </PageHead>
        <Show when={data().error}><p class="desk-alert" role="status">{data().error}</p></Show>
        <Show when={!view.versions.length && !eraCount()}>
          <div class="empty-desk">
            <div class="empty-art" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="28" height="28">
                <path fill="currentColor" d={EMPTY_MARK} />
              </svg>
            </div>
            <p class="empty-title">No versions</p>
            <p class="empty-lede">This printing has no rarity pair or artwork group yet.</p>
          </div>
        </Show>
        <Show when={showRarity()}>
          <section class="versions-section" id="versions">
            <h2>Others from the expansion</h2>
            <TileGrid rows={view.versions} cardId={cardId} />
          </section>
        </Show>
        <For each={view.eras}>
          {(group) => (
            <section class="versions-section" id={group.id}>
              <h2>
                <a class="era-link" href={eraHref(group.label)}>{group.label}</a>
              </h2>
              <TileGrid rows={group.rows} cardId={cardId} flags />
            </section>
          )}
        </For>
      </Loading>
    </div>
  );
}
