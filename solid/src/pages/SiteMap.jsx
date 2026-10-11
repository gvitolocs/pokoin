import { createEffect, createMemo, createSignal, For, onSettled, Repeat, Show, untrack } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import { fetchCard } from '@market/api.js';
import { formatPkn, formatPknNumber } from '@market/pkn.js';
import { createSiteMapCanvas } from '@market/site-map-canvas.js';
import {
  KIND_LABEL,
  KIND_PLURAL,
  MAX_COMPARE,
  PATH_KINDS,
  PRICE_BUCKETS,
  buildModel,
  compareOverlap,
  compareStats,
  createSearch,
  marketSummary,
  matchCards,
  neighbors,
  nodeInfo,
  normalizeQuery,
  priceEdges,
  refFromKey,
  refKey,
  sameRef,
  shortestPath,
  suggestKeywords,
  templateLinks,
} from '@market/site-map-graph.js';
import '@market/site-map.css';
import SeoHead from '../components/SeoHead.jsx';

const DATA_URL = `${import.meta.env.BASE_URL || '/'}data/site-map.json`;
const IMAGES_URL = `${import.meta.env.BASE_URL || '/'}data/site-map-images.json`;

const LEGEND = [
  { kind: 'page', label: 'Pages & hubs' },
  { kind: 'set', label: 'Sets' },
  { kind: 'card', label: 'Card desks' },
  { kind: 'species', label: 'Pokémon' },
  { kind: 'artist', label: 'Artists' },
];

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const dateLabel = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

function readColors(el) {
  const style = getComputedStyle(el);
  const v = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  return {
    bg: v('--sm-bg', '#000000'),
    text: v('--sm-text', '#ffffff'),
    muted: v('--sm-muted', '#9d9aa4'),
    yellow: v('--sm-page', '#ffd33d'),
    page: v('--sm-page', '#ffd33d'),
    set: v('--sm-set', '#3987e5'),
    card: v('--sm-card', '#c3c2b7'),
    species: v('--sm-species', '#d95926'),
    artist: v('--sm-artist', '#199e70'),
    ramp: Array.from({ length: PRICE_BUCKETS }, (_, b) => v(`--sm-ramp-${b}`, '#ffd33d')),
    compare: Array.from({ length: MAX_COMPARE }, (_, n) => v(`--sm-cmp-${n}`, '#3987e5')),
    font: v('--font', 'system-ui, sans-serif'),
  };
}

const PHONE = 720;
const PEEK = 0.42;

/** Screen space the details panel covers: right column on desktop, bottom sheet on phones (site-map.css). */
function panelInset(engine, wrap, ref) {
  const stage = wrap?.querySelector('.sm-stage');
  if (!engine || !stage) return;
  if (!ref) {
    engine.setInset({});
  } else if (stage.clientWidth <= PHONE) {
    // Fly targets centre above the sheet's peek height (site-map.css .sm-panel.is-peek).
    const head = stage.querySelector('.sm-head');
    engine.setInset({ top: head ? head.offsetTop + head.offsetHeight : 0, bottom: stage.clientHeight * PEEK });
  } else {
    engine.setInset({ right: Math.min(23 * 16, stage.clientWidth - 32) + 16 });
  }
}

/** Card thumbnails: one lazy file, loaded on the first card hover or pick (app-lifetime, like React's module promise). */
let imagesPromise = null;
const [images, setImages] = createSignal(null);
function loadImages() {
  imagesPromise ||= fetch(IMAGES_URL)
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null)
    .then((json) => {
      if (json) setImages(() => json);
      return json;
    });
  return imagesPromise;
}

function cardImage(json, i) {
  const key = json?.images?.[i];
  if (!key) return '';
  return key.startsWith('http') ? key : `${json.cdn}${key}${json.suffix}`;
}

/** In-app link for a node page; the landing (/) and absolute URLs are full loads, as React's <a>. */
function NodeLink(props) {
  const external = () => props.info.href === '/' || /^https?:/.test(props.info.href);
  return (
    <Show when={props.info.href}>
      <a class={props.class} href={props.info.href} rel={external() ? 'external' : undefined}>{props.children}</a>
    </Show>
  );
}

function RefButton(props) {
  const info = () => nodeInfo(props.model, props.refNode);
  return (
    <button type="button" class={['sm-ref', `is-${props.refNode.kind}`]} onClick={() => props.onPick(props.refNode)}>
      <span class="sm-swatch" aria-hidden="true" />
      <span class="sm-ref-label">{info().label}</span>
      <Show when={props.detail || props.refNode.kind === 'card'}>
        <span class="sm-ref-sub">{info().sub}</span>
      </Show>
    </button>
  );
}

function RefList(props) {
  const [open, setOpen] = createSignal(false);
  const limit = () => props.limit ?? 12;
  const shown = () => (open() ? props.group.refs.slice(0, 400) : props.group.refs.slice(0, limit()));
  const rest = () => props.group.refs.length - shown().length;
  return (
    <div class="sm-group">
      <h4>
        {props.group.title}
        <span>{fmt(props.group.refs.length)}</span>
      </h4>
      <ul>
        <For each={shown()}>
          {(ref) => <li><RefButton model={props.model} refNode={ref} onPick={props.onPick} /></li>}
        </For>
      </ul>
      <Show when={rest() > 0 && !open()}>
        <button type="button" class="sm-more" onClick={() => setOpen(true)}>
          Show {fmt(Math.min(rest(), 400 - shown().length))} more
        </button>
      </Show>
      <Show when={open() && props.group.refs.length > 400}>
        <p class="sm-note">First 400 of {fmt(props.group.refs.length)} shown.</p>
      </Show>
    </div>
  );
}

/** Live price and stock from the card desk API; the map's colours are the weekly snapshot. Mounted per card. */
function LiveCard(props) {
  const index = untrack(() => props.index);
  const id = untrack(() => props.model.data.cards.id[index]);
  const [live, setLive] = createSignal({ card: null, failed: false, done: false });
  let disposed = false;
  loadImages();
  fetchCard(String(id))
    .then((page) => { if (!disposed) setLive({ card: page?.card || null, failed: !page?.card, done: true }); })
    .catch(() => { if (!disposed) setLive({ card: null, failed: true, done: true }); });
  onSettled(() => () => {
    disposed = true;
  });
  const src = () => cardImage(images(), index);
  const price = () => (Number(live().card?.price) > 0 ? Number(live().card.price) : 0);
  const status = () => {
    const card = live().card;
    if (card) return price() ? `${formatPkn(price())} · ${fmt(Number(card.stock) || 0)} in stock` : 'No listing right now';
    if (live().done && live().failed) return 'Live price unavailable';
    return 'Checking live price…';
  };
  return (
    <div class="sm-live">
      <Show when={src()} fallback={<div class="sm-live-blank" aria-hidden="true" />}>
        <img src={src()} alt="" width="120" height="168" loading="lazy" />
      </Show>
      <div>
        <p class="sm-live-label">Live</p>
        <p class="sm-live-price">{status()}</p>
        <Show when={live().card && price()}>
          <p class="sm-note">Cheapest listing now, including every seller on the desk.</p>
        </Show>
      </div>
    </div>
  );
}

function MarketBlock(props) {
  const summary = createMemo(() => marketSummary(props.model, props.selected));
  const share = () => Math.round((summary().listed / summary().total) * 100);
  return (
    <Show when={summary().total && props.selected.kind !== 'card'}>
      <div class="sm-market">
        <p>
          <strong>{fmt(summary().listed)}</strong> of {fmt(summary().total)} card desks listed ({share()}%)
          <Show when={summary().listings}> · {fmt(summary().listings)} listings</Show>
        </p>
        <div class="sm-meter" aria-hidden="true"><span style={{ width: `${share()}%` }} /></div>
        <Show when={summary().cheapest} fallback={<p class="sm-note">Nothing listed here yet: a gap sellers can fill.</p>}>
          {(cheapest) => (
            <p class="sm-cheapest">
              Cheapest:{' '}
              <button type="button" class="sm-inline" onClick={() => props.onPick(cheapest())}>
                {nodeInfo(props.model, cheapest()).label}
              </button>{' '}
              · {formatPkn(props.model.data.cards.pkn[cheapest().i])}
            </p>
          )}
        </Show>
        <p class="sm-note">Prices as of {dateLabel(props.marketAt)}.</p>
      </div>
    </Show>
  );
}

function PathBlock(props) {
  const [copied, setCopied] = createSignal(false);
  const targetInfo = () => nodeInfo(props.model, props.target);
  const clicks = () => props.path.length - 1;
  const copy = () => {
    navigator.clipboard?.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  };
  return (
    <Show when={props.target}>
      <Show
        when={props.path}
        fallback={(
          <div class="sm-path">
            <h3>Path to {targetInfo().label}</h3>
            <p class="sm-note">No link path connects these two.</p>
            <button type="button" class="sm-more" onClick={props.onClear}>Clear</button>
          </div>
        )}
      >
        <div class="sm-path">
          <h3>{clicks()} {clicks() === 1 ? 'click' : 'clicks'} to {targetInfo().label}</h3>
          <ol>
            <For each={props.path}>
              {(ref, n) => (
                <li>
                  <span class="sm-hop" aria-hidden="true">{n() + 1}</span>
                  <RefButton model={props.model} refNode={ref} onPick={props.onPick} detail={ref.kind !== 'card'} />
                </li>
              )}
            </For>
          </ol>
          <div class="sm-path-actions">
            <button type="button" class="btn ghost sm-small" onClick={copy}>{copied() ? 'Link copied' : 'Copy link'}</button>
            <button type="button" class="btn ghost sm-small" onClick={props.onReverse}>Reverse</button>
            <button type="button" class="sm-more" onClick={props.onClear}>Clear</button>
          </div>
        </div>
      </Show>
    </Show>
  );
}

/** Details for one node; mounted per ?focus= like React's key={focusKey}. */
function Panel(props) {
  const model = untrack(() => props.model);
  const selected = untrack(() => props.selected);
  const info = nodeInfo(model, selected);
  const { out, into, instances } = neighbors(model, selected);
  const inherited = ['set', 'era', 'card', 'species', 'artist'].includes(selected.kind) ? templateLinks(model, selected.kind) : [];
  const outCount = out.reduce((s, g) => s + g.refs.length, 0) + inherited.length;
  const inCount = into.reduce((s, g) => s + g.refs.length, 0);
  const canPath = PATH_KINDS.has(selected.kind);
  const inheritedTitle = `Every ${selected.kind === 'species' ? 'Pokémon' : KIND_LABEL[selected.kind]?.toLowerCase()} page also links to`;
  return (
    <aside class={['sm-panel', `is-${props.sheet}`]} aria-label={`${info.kind}: ${info.label}`}>
      <SheetHandle sheet={props.sheet} onSheet={props.onSheet} />
      <button type="button" class="sm-close" onClick={props.onClose} aria-label="Close details">×</button>
      <p class={['sm-kind', `is-${selected.kind}`]}><span class="sm-swatch" aria-hidden="true" />{info.kind}</p>
      <h2>{info.label}</h2>
      <Show when={info.sub}><p class="sm-sub">{info.sub}</p></Show>
      <Show when={info.href}><NodeLink info={info} class="btn sm-open">Open page</NodeLink></Show>
      <Show when={selected.kind === 'card'}><LiveCard model={model} index={selected.i} /></Show>
      <MarketBlock model={model} selected={selected} onPick={props.onPick} marketAt={props.marketAt} />
      <PathBlock
        model={model}
        path={props.path}
        target={props.target}
        onPick={props.onPick}
        onReverse={props.onReverse}
        onClear={props.onClearTarget}
      />
      <Show when={canPath && !props.target}>
        <div class="sm-path-find">
          <h3>Six degrees of Pokoin</h3>
          <SearchBox
            model={model}
            kinds={PATH_KINDS}
            placeholder={`Path from ${info.label} to…`}
            label={`Find the shortest path from ${info.label}`}
            onPick={props.onTarget}
          />
        </div>
      </Show>
      <dl class="sm-counts">
        <div><dt>Links to</dt><dd>{fmt(outCount)}</dd></div>
        <div><dt>Linked from</dt><dd>{fmt(inCount)}</dd></div>
        <Show when={instances}><div><dt>Pages</dt><dd>{fmt(instances.count)}</dd></div></Show>
      </dl>
      <Show when={instances}>
        <p class="sm-note">
          Template for {fmt(instances.count)} {KIND_PLURAL[instances.kind]}
          {instances.kind === 'card' ? ' — too many lines to draw, so the stars stay lit instead.' : '.'}
        </p>
      </Show>
      <Show when={out.length}><h3>Links to</h3></Show>
      <For each={out}>{(group) => <RefList model={model} group={group} onPick={props.onPick} />}</For>
      <Show when={inherited.length}>
        <RefList model={model} group={{ key: 'inherited', title: inheritedTitle, refs: inherited }} onPick={props.onPick} limit={6} />
      </Show>
      <Show when={into.length}><h3>Linked from</h3></Show>
      <For each={into}>{(group) => <RefList model={model} group={group} onPick={props.onPick} />}</For>
      <Show when={selected.kind !== 'page' || model.data.pages[selected.i].group !== 'internal'}>
        <p class="sm-note">Plus the header &amp; footer, which every page carries.</p>
      </Show>
    </aside>
  );
}

let searchBoxes = 0;

function SearchBox(props) {
  // The name index is built on the first keystroke, not on page load.
  let search = null;
  const [query, setQuery] = createSignal('');
  const [active, setActive] = createSignal(0);
  const listId = `sm-hits-${(searchBoxes += 1).toString(36)}`;
  const results = createMemo(() => {
    if (!query().trim()) return [];
    search ||= createSearch(props.model);
    const hits = search(query(), props.kinds ? 30 : 10);
    return (props.kinds ? hits.filter((ref) => props.kinds.has(ref.kind)) : hits).slice(0, 10);
  });
  const pick = (ref) => {
    props.onPick(ref);
    setQuery('');
    setActive(0);
  };
  return (
    <div class="sm-search" role="search">
      <input
        type="search"
        value={query()}
        placeholder={props.placeholder || 'Find a page, set, Pokémon, artist or card'}
        aria-label={props.label || 'Search the site map'}
        aria-controls={listId}
        aria-activedescendant={results().length ? `${listId}-${active()}` : undefined}
        onInput={(event) => { setQuery(event.currentTarget.value); setActive(0); }}
        onKeyDown={(event) => {
          const list = results();
          if (event.key === 'ArrowDown') { event.preventDefault(); setActive((a) => Math.min(a + 1, list.length - 1)); }
          if (event.key === 'ArrowUp') { event.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (event.key === 'Enter' && list[active()]) { event.preventDefault(); pick(list[active()]); }
          if (event.key === 'Escape') setQuery('');
        }}
      />
      <Show when={query() && results().length}>
        <ul id={listId} role="listbox">
          <For each={results()}>
            {(ref, n) => {
              const info = nodeInfo(props.model, ref);
              return (
                <li id={`${listId}-${n()}`} role="option" aria-selected={n() === active()}>
                  <button type="button" class={['sm-ref', `is-${ref.kind}`]} onMouseEnter={() => setActive(n())} onClick={() => pick(ref)}>
                    <span class="sm-swatch" aria-hidden="true" />
                    <span class="sm-ref-label">{info.label}</span>
                    <span class="sm-ref-sub">{ref.kind === 'page' ? info.sub : info.kind}{ref.kind === 'card' ? ` · ${info.sub}` : ''}</span>
                  </button>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
      <Show when={query() && !results().length}>
        <p class="sm-empty">Nothing on the map matches “{query()}”.</p>
      </Show>
    </div>
  );
}

/** One keyword field with word-start suggestions from card names as you type. */
function CompareField(props) {
  const [open, setOpen] = createSignal(false);
  const [active, setActive] = createSignal(0);
  const listId = () => `sm-cmp-hits-${props.n}`;
  const shown = createMemo(() => {
    const term = props.term;
    const hits = open() && term.trim() ? suggestKeywords(props.model, term, 6) : [];
    return hits.length === 1 && hits[0].text === normalizeQuery(term) ? [] : hits;
  });
  const pick = (row) => {
    props.onChange(row.text);
    setOpen(false);
    setActive(0);
  };
  const placeholder = () => (props.n === 0 ? 'e.g. lucario' : props.n === 1 ? 'e.g. scizor' : 'Another keyword');
  return (
    <div class="sm-compare-field" style={{ '--sm-swatch': `var(--sm-cmp-${props.n})` }}>
      <div class="sm-compare-box">
        <span class="sm-swatch" aria-hidden="true" />
        <input
          type="search"
          value={props.term}
          placeholder={placeholder()}
          aria-label={`Compare keyword ${props.n + 1}`}
          aria-autocomplete="list"
          aria-controls={listId()}
          aria-activedescendant={shown().length ? `${listId()}-${active()}` : undefined}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onInput={(event) => { props.onChange(event.currentTarget.value); setOpen(true); setActive(0); }}
          onKeyDown={(event) => {
            const list = shown();
            if (event.key === 'ArrowDown') { event.preventDefault(); setActive((x) => Math.min(x + 1, list.length - 1)); }
            if (event.key === 'ArrowUp') { event.preventDefault(); setActive((x) => Math.max(x - 1, 0)); }
            if (event.key === 'Enter') {
              event.preventDefault();
              if (list[active()]) pick(list[active()]);
              else { setOpen(false); event.currentTarget.blur(); }
            }
            if (event.key === 'Escape') setOpen(false);
          }}
        />
        <Show when={props.term.trim()}>
          <span class="sm-compare-n" title="Card desks">{fmt(props.count)}</span>
        </Show>
        <Show when={props.onRemove}>
          <button type="button" class="sm-field-remove" aria-label={`Remove keyword ${props.n + 1}`} onClick={() => props.onRemove()}>×</button>
        </Show>
      </div>
      <Show when={shown().length}>
        <ul id={listId()} role="listbox" class="sm-suggest">
          <For each={shown()}>
            {(row, m) => (
              <li id={`${listId()}-${m()}`} role="option" aria-selected={m() === active()}>
                <button
                  type="button"
                  class="sm-ref"
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(m())}
                  onClick={() => pick(row)}
                >
                  <span class="sm-ref-label">{row.label}</span>
                  <span class="sm-ref-sub">{row.species ? 'Pokémon · ' : ''}{fmt(row.n)} desks</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

/** Keyword fields: one colour each, + adds a field, × removes one. Fields stay mounted per index while typing. */
function CompareInputs(props) {
  const set = (n, value) => props.onChange(props.terms.map((term, m) => (m === n ? value : term)));
  return (
    <div class="sm-compare-inputs">
      <Repeat count={props.terms.length}>
        {(n) => (
          <CompareField
            model={props.model}
            n={n}
            term={props.terms[n] ?? ''}
            count={props.rows[n]?.cards.length || 0}
            onChange={(value) => set(n, value)}
            onRemove={props.terms.length > 1 ? () => props.onChange(props.terms.filter((_, m) => m !== n)) : null}
          />
        )}
      </Repeat>
      <Show when={props.terms.length < MAX_COMPARE}>
        <button type="button" class="sm-add" onClick={() => props.onChange([...props.terms, ''])} aria-label="Add a keyword">+ Add</button>
      </Show>
    </div>
  );
}

const eraName = (model, e) => (e >= 0 ? model.data.eras[e].name : '—');

function eraSpan(model, stats) {
  if (stats.debut < 0) return stats.eras.length ? eraName(model, stats.eras[0]) : '—';
  return stats.debut === stats.latest ? eraName(model, stats.debut) : `${eraName(model, stats.debut)} → ${eraName(model, stats.latest)}`;
}

const ratio = (a, b) => (b > 0 ? a / b : 0);
const times = (x) => (x >= 10 ? `${Math.round(x)}×` : `${x.toFixed(1).replace(/\.0$/, '')}×`);

/** Plain-language one-liners across the keywords; `text` is a render thunk so no DOM is built inside the memo. */
function headlines(model, live) {
  if (live.length < 2) return [];
  const out = [];
  const by = (key) => [...live].sort((a, b) => b.stats[key] - a.stats[key]);
  const [big, small] = [by('cards')[0], by('cards')[live.length - 1]];
  if (ratio(big.stats.cards, small.stats.cards) < 1.15) {
    out.push({ n: big.n, text: () => <>Neck and neck on reach: <For each={live}>{(row, k) => <span>{k() ? ' vs ' : ''}<b>{row.term}</b> {fmt(row.stats.cards)}</span>}</For> card desks.</> });
  } else {
    out.push({ n: big.n, text: () => <><b>{big.term}</b> has {times(ratio(big.stats.cards, small.stats.cards))} the card desks of <b>{small.term}</b> ({fmt(big.stats.cards)} vs {fmt(small.stats.cards)}).</> });
  }
  const priced = live.filter((row) => row.stats.median > 0);
  if (priced.length >= 2) {
    const sorted = [...priced].sort((a, b) => a.stats.median - b.stats.median);
    const [cheap, dear] = [sorted[0], sorted[sorted.length - 1]];
    if (dear.stats.median > cheap.stats.median) {
      out.push({ n: cheap.n, text: () => <><b>{cheap.term}</b> is the cheaper collection: median {formatPkn(cheap.stats.median)} vs {formatPkn(dear.stats.median)} for <b>{dear.term}</b>.</> });
    }
  }
  const dated = live.filter((row) => row.stats.debut >= 0);
  if (dated.length >= 2) {
    const sorted = [...dated].sort((a, b) => a.stats.debut - b.stats.debut);
    const [first, last] = [sorted[0], sorted[sorted.length - 1]];
    out.push(first.stats.debut === last.stats.debut
      ? { n: first.n, text: () => <>All debut in the same era: <b>{eraName(model, first.stats.debut)}</b>.</> }
      : { n: first.n, text: () => <><b>{first.term}</b> is the veteran: printed since <b>{eraName(model, first.stats.debut)}</b>, while <b>{last.term}</b> starts in {eraName(model, last.stats.debut)}.</> });
  }
  const share = (row) => ratio(row.stats.listed, row.stats.cards);
  const withCards = live.filter((row) => row.stats.cards);
  if (withCards.length >= 2) {
    const sorted = [...withCards].sort((a, b) => share(b) - share(a));
    const [easy, hard] = [sorted[0], sorted[sorted.length - 1]];
    if (share(easy) - share(hard) >= 0.03) {
      out.push({ n: hard.n, text: () => <><b>{hard.term}</b> is harder to find: {Math.round(share(hard) * 100)}% of its desks are listed, against {Math.round(share(easy) * 100)}% for <b>{easy.term}</b>.</> });
    }
  }
  const pricey = live.filter((row) => row.stats.priciest);
  if (pricey.length) {
    const top = [...pricey].sort((a, b) => model.data.cards.pkn[b.stats.priciest.i] - model.data.cards.pkn[a.stats.priciest.i])[0];
    out.push({ n: top.n, grail: top.stats.priciest, text: () => <>The priciest ask is on a <b>{top.term}</b> card, {formatPkn(model.data.cards.pkn[top.stats.priciest.i])}:</> });
  }
  return out;
}

/** Five-step bar of where each keyword's listed desks sit on the site-wide price ramp. */
function PriceMix(props) {
  const total = () => props.mix.reduce((s, n) => s + n, 0);
  return (
    <Show when={total()}>
      <div
        class="sm-mix"
        role="img"
        aria-label={`Price mix: ${props.mix.map((n, b) => `${Math.round((n / total()) * 100)}% in step ${b + 1}`).join(', ')}`}
      >
        <For each={props.mix} keyed={false}>
          {(n, b) => <Show when={n()}><span style={{ 'flex-grow': n(), background: `var(--sm-ramp-${b})` }} /></Show>}
        </For>
      </div>
    </Show>
  );
}

function RefChips(props) {
  const limit = () => props.limit ?? 4;
  return (
    <span class="sm-chips">
      <For each={props.refs.slice(0, limit())}>
        {(ref) => (
          <button type="button" class="sm-chip" onClick={() => props.onPick(ref)}>
            {ref.kind === 'card' ? `${nodeInfo(props.model, ref).label} · ${nodeInfo(props.model, ref).sub}` : nodeInfo(props.model, ref).label}
          </button>
        )}
      </For>
      <Show when={props.refs.length > limit()}>
        <span class="sm-legend-n">+{fmt(props.refs.length - limit())}</span>
      </Show>
    </span>
  );
}

function CompareRow(props) {
  const stats = () => props.row.stats;
  const share = () => (stats().cards ? Math.round((stats().listed / stats().cards) * 100) : 0);
  const pkn = (ref) => formatPkn(props.model.data.cards.pkn[ref.i]);
  return (
    <section class="sm-compare-row" style={{ '--sm-row': `var(--sm-cmp-${props.row.n})` }}>
      <h3><span class="sm-swatch" aria-hidden="true" />{props.row.term}</h3>
      <Show when={stats().cards} fallback={<p class="sm-note">No card desk name contains “{props.row.term}”.</p>}>
        <dl>
          <div class="sm-bar-row">
            <dt>Card desks</dt>
            <dd><span class="sm-bar" style={{ width: `${(stats().cards / props.maxCards) * 70}%` }} />{fmt(stats().cards)}</dd>
          </div>
          <div class="sm-bar-row">
            <dt>Median price</dt>
            <dd><span class="sm-bar" style={{ width: `${(stats().median / props.maxMedian) * 70}%` }} />{stats().median ? formatPkn(stats().median) : '—'}</dd>
          </div>
          <Show when={stats().listed}>
            <div class="sm-wide">
              <dt>Price mix, cheap → dear</dt>
              <dd><PriceMix mix={stats().mix} /></dd>
            </div>
          </Show>
          <div><dt>Listed</dt><dd>{fmt(stats().listed)} ({share()}%)</dd></div>
          <div><dt>Listings</dt><dd>{fmt(stats().listings)}</dd></div>
          <div><dt>Sets</dt><dd>{fmt(stats().sets)}</dd></div>
          <div><dt>Artists</dt><dd>{fmt(stats().artists)}</dd></div>
          <div class="sm-wide"><dt>Eras</dt><dd>{eraSpan(props.model, stats())}</dd></div>
          <Show when={stats().cheapest}>
            <div class="sm-wide">
              <dt>Cheapest · priciest</dt>
              <dd>
                <button type="button" class="sm-inline" onClick={() => props.onPick(stats().cheapest)}>{pkn(stats().cheapest)}</button>
                {' · '}
                <button type="button" class="sm-inline" onClick={() => props.onPick(stats().priciest)}>{pkn(stats().priciest)}</button>
                <span class="sm-legend-n"> ({nodeInfo(props.model, stats().priciest).sub})</span>
              </dd>
            </div>
          </Show>
          <Show when={stats().topSet}>
            <div class="sm-wide">
              <dt>Most in one set</dt>
              <dd>
                <button type="button" class="sm-inline" onClick={() => props.onPick(stats().topSet)}>{props.model.data.sets[stats().topSet.i].name}</button>
                {' · '}{fmt(stats().topSet.n)}
              </dd>
            </div>
          </Show>
          <Show when={stats().topArtist}>
            <div class="sm-wide">
              <dt>Most drawn by</dt>
              <dd>
                <button type="button" class="sm-inline" onClick={() => props.onPick(stats().topArtist)}>{props.model.data.artists[stats().topArtist.i].name}</button>
                {' · '}{fmt(stats().topArtist.n)}
              </dd>
            </div>
          </Show>
        </dl>
      </Show>
    </section>
  );
}

/** Side-by-side reach and market for each keyword; bars share one scale per measure. */
function ComparePanel(props) {
  const live = createMemo(() => props.rows.filter((row) => row.term));
  const found = createMemo(() => live().filter((row) => row.stats.cards));
  const maxCards = () => Math.max(1, ...live().map((row) => row.stats.cards));
  const maxMedian = () => Math.max(1, ...live().map((row) => row.stats.median));
  const lines = createMemo(() => headlines(props.model, found()));
  const overlap = createMemo(() => compareOverlap(props.model, found()));
  return (
    <aside class={['sm-panel', 'sm-compare', `is-${props.sheet}`]} aria-label="Keyword comparison">
      <SheetHandle sheet={props.sheet} onSheet={props.onSheet} />
      <p class="sm-kind">Compare</p>
      <Show when={!live().length}>
        <p class="sm-note">Type a Pokémon, a trainer or a mechanic like “vmax” in each field. Suggestions show how many card desks each one lights up.</p>
      </Show>
      <Show when={lines().length}>
        <section class="sm-headlines" aria-label="Head to head">
          <h3>Head to head</h3>
          <ul>
            <For each={lines()}>
              {(line) => (
                <li style={{ '--sm-row': `var(--sm-cmp-${line.n})` }}>
                  <span>
                    {line.text()}
                    <Show when={line.grail}>
                      {' '}
                      <button type="button" class="sm-inline" onClick={() => props.onPick(line.grail)}>
                        {nodeInfo(props.model, line.grail).label} · {nodeInfo(props.model, line.grail).sub}
                      </button>
                    </Show>
                  </span>
                </li>
              )}
            </For>
          </ul>
          <Show when={overlap()}>
            {(both) => (
              <dl class="sm-overlap">
                <div>
                  <dt>Sets with all of them</dt>
                  <dd>
                    <Show when={both().sets.length} fallback="None — they never share a set.">
                      <b>{fmt(both().sets.length)}</b> <RefChips model={props.model} refs={both().sets} onPick={props.onPick} limit={3} />
                    </Show>
                  </dd>
                </div>
                <div>
                  <dt>Artists who drew all of them</dt>
                  <dd>
                    <Show when={both().artists.length} fallback="None.">
                      <b>{fmt(both().artists.length)}</b> <RefChips model={props.model} refs={both().artists} onPick={props.onPick} limit={3} />
                    </Show>
                  </dd>
                </div>
                <Show when={both().cards.length}>
                  <div>
                    <dt>On the same card</dt>
                    <dd><b>{fmt(both().cards.length)}</b> <RefChips model={props.model} refs={both().cards} onPick={props.onPick} limit={3} /></dd>
                  </div>
                </Show>
              </dl>
            )}
          </Show>
        </section>
      </Show>
      <For each={live()}>
        {(row) => <CompareRow model={props.model} row={row} maxCards={maxCards()} maxMedian={maxMedian()} onPick={props.onPick} />}
      </For>
      <Show when={found().length}>
        <p class="sm-note">Matches card desk names at a word start. Prices as of {dateLabel(props.marketAt)}.</p>
      </Show>
    </aside>
  );
}

/** Phone bottom sheet: tap the grip to swap between a peek and most of the screen. */
function SheetHandle(props) {
  return (
    <button
      type="button"
      class="sm-grip"
      aria-label={props.sheet === 'full' ? 'Shrink the panel' : 'Expand the panel'}
      aria-expanded={props.sheet === 'full'}
      onClick={() => props.onSheet(props.sheet === 'full' ? 'peek' : 'full')}
    >
      <span aria-hidden="true" />
    </button>
  );
}

function MarketLegend(props) {
  const edges = () => priceEdges(props.model);
  const bounds = () => [edges().min, ...edges().edges, edges().max];
  return (
    <div class="sm-ramp" role="group" aria-label="Cheapest listed price">
      <span class="sm-ramp-title">Cheapest listing, PKN</span>
      <ol>
        <Repeat count={PRICE_BUCKETS}>
          {(b) => (
            <li>
              <span class="sm-ramp-chip" style={{ background: `var(--sm-ramp-${b})` }} aria-hidden="true" />
              {b === PRICE_BUCKETS - 1
                ? `${formatPknNumber(bounds()[b])}+`
                : `${formatPknNumber(bounds()[b])}–${formatPknNumber(bounds()[b + 1])}`}
            </li>
          )}
        </Repeat>
      </ol>
      <button type="button" class="sm-legend-item is-unlisted" aria-pressed={!props.onlyListed} onClick={props.onToggleListed}>
        <span class="sm-swatch" aria-hidden="true" />
        Not listed <span class="sm-legend-n">{fmt(props.model.count - props.model.data.stats.listed)}</span>
      </button>
    </div>
  );
}

/** /sitemap (market/src/pages/SiteMap.jsx): the interactive map of every page and link. */
export default function SiteMap() {
  const [search, setSearch] = useSearchParams();
  const [data, setData] = createSignal(null);
  const [model, setModel] = createSignal(null);
  const [engine, setEngine] = createSignal(null);
  const [error, setError] = createSignal('');
  const [hidden, setHidden] = createSignal(new Set());
  const [hover, setHover] = createSignal(null);
  // Phone bottom sheet: 'peek' leaves the map visible, 'full' reads the panel.
  const [sheet, setSheet] = createSignal('peek');
  let canvasEl;
  let wrapEl;
  let disposed = false;

  const focusKey = () => String(search.focus || '');
  const toKey = () => String(search.to || '');
  const view = () => String(search.view || '');
  const market = () => view() === 'market';
  const comparing = () => view() === 'compare';
  const onlyListed = () => market() && search.listed === '1';
  const selected = createMemo(() => (model() && focusKey() ? refFromKey(model(), focusKey()) : null));
  const target = createMemo(() => (model() && selected() && toKey() ? refFromKey(model(), toKey()) : null));
  const path = createMemo(() => (model() && selected() && target() ? shortestPath(model(), selected(), target()) : null));

  const setParam = (patch) => {
    const next = {};
    for (const [key, value] of Object.entries(patch)) next[key] = value || undefined;
    setSearch(next, { replace: true });
  };

  const select = (ref, { fly = false } = {}) => {
    const m = model();
    if (!m) return;
    setSheet('peek');
    panelInset(engine(), wrapEl, ref);
    setParam({ focus: ref ? refKey(m, ref) : '', to: '' });
    if (fly && ref) engine()?.flyTo(ref);
  };
  const pickFly = (ref) => select(ref, { fly: true });

  const setTarget = (ref) => {
    if (!model() || (ref && sameRef(ref, selected()))) return;
    setParam({ to: ref ? refKey(model(), ref) : '' });
  };

  const reversePath = () => {
    if (!model() || !selected() || !target()) return;
    setParam({ focus: refKey(model(), target()), to: refKey(model(), selected()) });
  };

  // Compare keywords live in ?q=lucario,scizor so a comparison is a shareable link.
  const [terms, setTerms] = createSignal(untrack(() => {
    const saved = String(search.q || '').split(',').slice(0, MAX_COMPARE);
    return saved.length >= 2 ? saved : [saved[0] || '', ''];
  }));
  const changeTerms = (next) => {
    setTerms(next);
    setParam({ q: next.some((term) => term.trim()) ? next.join(',') : '' });
  };
  const compareRows = createMemo(() => {
    if (!model() || !comparing()) return [];
    return terms().map((term, n) => {
      const cards = matchCards(model(), term);
      return { n, term: term.trim(), cards, stats: compareStats(model(), cards) };
    });
  });

  // One fetch, one model, one canvas engine for the page's life (the data never changes after load).
  fetch(DATA_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((json) => {
      if (disposed) return;
      const built = buildModel(json);
      setData(json);
      setModel(built);
      if (!canvasEl) return;
      setEngine(createSiteMapCanvas(canvasEl, built, {
        readColors: () => readColors(wrapEl),
        onHover: (ref, x, y) => {
          if (ref?.kind === 'card') loadImages();
          setHover(ref ? { ref, x, y } : null);
        },
        onSelect: (ref) => select(ref, { fly: true }),
      }));
    })
    .catch((err) => { if (!disposed) setError(String(err.message || err)); });
  onSettled(() => () => {
    disposed = true;
    untrack(engine)?.destroy();
  });

  // A deep link (?focus=set:base-set) flies there on first paint; later picks fly from select().
  let landed = false;
  createEffect(
    () => [engine(), selected(), path()],
    ([eng, sel, p]) => {
      if (!eng) return;
      eng.setSelected(p ? null : sel);
      eng.setPath(p);
      if (p) {
        panelInset(eng, wrapEl, sel);
        eng.frame(p);
      }
      if (!landed) {
        landed = true;
        panelInset(eng, wrapEl, sel);
        if (sel && !p) eng.flyTo(sel, { ms: 900 });
      }
    },
  );

  createEffect(
    () => [engine(), hidden()],
    ([eng, set]) => { eng?.setHidden(set); },
  );

  createEffect(
    () => [engine(), market(), onlyListed()],
    ([eng, on, listedOnly]) => { eng?.setMarket({ mode: on ? 'market' : 'structure', onlyListed: listedOnly }); },
  );

  createEffect(
    () => [engine(), comparing(), compareRows(), selected()],
    ([eng, on, rows, sel]) => {
      if (!eng || !wrapEl) return;
      const { compare } = readColors(wrapEl);
      eng.setCompare(on ? rows.map((row) => ({ cards: row.cards, color: compare[row.n] })) : null);
      if (on && !sel) panelInset(eng, wrapEl, { kind: 'compare' });
    },
  );

  const toggle = (kind) => setHidden((prev) => {
    const next = new Set(prev);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    return next;
  });

  const stats = () => data()?.stats;
  const hoverCard = () => hover()?.ref.kind === 'card';
  const hoverInfo = () => (model() && hover() && !sameRef(hover().ref, selected()) ? nodeInfo(model(), hover().ref) : null);
  const hoverPkn = () => (hoverCard() ? data().cards.pkn[hover().ref.i] : 0);
  const hoverSrc = () => (hoverCard() ? cardImage(images(), hover().ref.i) : '');
  const legendCount = (kind) => {
    const d = data();
    return fmt({ page: d.pages.length, set: d.sets.length, card: d.stats.cards, species: d.stats.species, artist: d.stats.artists }[kind]);
  };

  return (
    <div class={['page', 'site-map-page', { 'has-panel': Boolean(selected() || comparing()) }]} ref={(el) => { wrapEl = el; }}>
      <SeoHead
        title="Site Map · Every Pokoin Page and Link | Pokoin"
        description="An interactive map of pokoin.com: every page template, catalog hub and card desk, the links between them, and what is listed right now."
        canonical="/sitemap"
      />
      <div class="sm-stage">
        <canvas
          ref={(el) => { canvasEl = el; }}
          class="sm-canvas"
          tabindex={0}
          role="img"
          aria-label="Map of every pokoin.com page and link. Drag to pan, scroll or pinch to zoom, click a node to see its links. Use the search box to find any page."
        />
        <header class="sm-head">
          <p class="page-kicker">Pokoin</p>
          <h1>Site map</h1>
          <Show when={stats()}>
            <p class="sm-stats">
              <strong>{fmt(stats().pages)}</strong> pages · <strong>{fmt(stats().links)}</strong> links
              <Show when={market()}> · <strong>{Math.round((stats().listed / stats().cards) * 100)}%</strong> listed</Show>
            </p>
          </Show>
          <Show when={model()}>
            <div class="sm-modes" role="group" aria-label="Colour the map by">
              <button type="button" aria-pressed={!view()} onClick={() => setParam({ view: '', listed: '' })}>Structure</button>
              <button type="button" aria-pressed={market()} onClick={() => setParam({ view: 'market' })}>Market</button>
              <button type="button" aria-pressed={comparing()} onClick={() => setParam({ view: 'compare', listed: '' })}>Compare</button>
            </div>
          </Show>
          <Show when={model() && comparing()}>
            <CompareInputs model={model()} terms={terms()} rows={compareRows()} onChange={changeTerms} />
          </Show>
          <Show when={model() && !comparing()}>
            <SearchBox model={model()} onPick={pickFly} />
          </Show>
        </header>
        <Show when={!model() && !error()}><p class="sm-status" role="status">Mapping every page…</p></Show>
        <Show when={error()}><p class="sm-status" role="alert">The map did not load ({error()}).</p></Show>
        <Show when={model()}>
          <div class="sm-legend" role="group" aria-label="Show or hide node types">
            <Show when={market()}>
              <MarketLegend model={model()} onlyListed={onlyListed()} onToggleListed={() => setParam({ listed: onlyListed() ? '' : '1' })} />
            </Show>
            <For each={LEGEND.filter((row) => !((market() || comparing()) && row.kind === 'card'))}>
              {(row) => (
                <button
                  type="button"
                  class={['sm-legend-item', `is-${row.kind}`]}
                  aria-pressed={!hidden().has(row.kind)}
                  onClick={() => toggle(row.kind)}
                >
                  <span class="sm-swatch" aria-hidden="true" />
                  {row.label}
                  <span class="sm-legend-n">{legendCount(row.kind)}</span>
                </button>
              )}
            </For>
          </div>
          <div class="sm-zoom" role="group" aria-label="Zoom">
            <button type="button" onClick={() => engine()?.zoom(1.6)} aria-label="Zoom in">+</button>
            <button type="button" onClick={() => engine()?.zoom(1 / 1.6)} aria-label="Zoom out">−</button>
            <button type="button" onClick={() => engine()?.reset()} aria-label="Show the whole map">⤢</button>
          </div>
        </Show>
        <Show when={hoverInfo()}>
          {(info) => (
            <div class={['sm-tip', { 'has-image': Boolean(hoverSrc()) }]} style={{ left: `${hover().x}px`, top: `${hover().y}px` }} aria-hidden="true">
              <Show when={hoverSrc()}><img src={hoverSrc()} alt="" width="84" height="117" /></Show>
              <div>
                <span class={['sm-kind', `is-${hover().ref.kind}`]}><span class="sm-swatch" />{info().kind}</span>
                <strong>{info().label}</strong>
                <Show when={info().sub}><span class="sm-tip-sub">{info().sub}</span></Show>
                <Show when={hoverCard()}>
                  <span class="sm-tip-price">
                    {hoverPkn() > 0 ? `from ${formatPkn(hoverPkn())} · ${fmt(data().cards.lc[hover().ref.i])} listings` : 'Not listed'}
                  </span>
                </Show>
              </div>
            </div>
          )}
        </Show>
        <Show when={model() && comparing() && !selected()}>
          <ComparePanel model={model()} rows={compareRows()} marketAt={stats().marketAt} onPick={pickFly} sheet={sheet()} onSheet={setSheet} />
        </Show>
        <Show when={model() && selected() ? focusKey() : null} keyed>
          {(_focus) => (
            <Panel
              model={model()}
              selected={selected()}
              target={target()}
              path={path()}
              marketAt={stats().marketAt}
              onPick={pickFly}
              onTarget={setTarget}
              onReverse={reversePath}
              onClearTarget={() => setParam({ to: '' })}
              onClose={() => select(null)}
              sheet={sheet()}
              onSheet={setSheet}
            />
          )}
        </Show>
      </div>
    </div>
  );
}
