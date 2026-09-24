import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import SeoHead from '../components/SeoHead.jsx';
import { fetchCard } from '../api.js';
import { formatPkn, formatPknNumber } from '../pkn.js';
import { createSiteMapCanvas } from '../site-map-canvas.js';
import {
  KIND_LABEL,
  KIND_PLURAL,
  PATH_KINDS,
  PRICE_BUCKETS,
  buildModel,
  createSearch,
  marketSummary,
  neighbors,
  nodeInfo,
  priceEdges,
  refFromKey,
  refKey,
  sameRef,
  shortestPath,
  templateLinks,
} from '../site-map-graph.js';
import '../site-map.css';

const DATA_URL = `${import.meta.env.BASE_URL || '/'}data/site-map.json`;
const IMAGES_URL = `${import.meta.env.BASE_URL || '/'}data/site-map-images.json`;

const LEGEND = [
  { kind: 'page', label: 'Pages & hubs' },
  { kind: 'set', label: 'Sets' },
  { kind: 'card', label: 'Card desks' },
  { kind: 'species', label: 'Pokémon' },
  { kind: 'artist', label: 'Artists' },
];

/** One-click examples for the path finder: famous pairs that cross eras. */
const PATH_EXAMPLES = [
  ['pokemon:pikachu', 'pokemon:charizard'],
  ['pokemon:flabebe', 'era:original'],
  ['artist:mitsuhiro-arita', 'pokemon:eevee'],
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
    font: v('--font', 'system-ui, sans-serif'),
  };
}

/** Screen space the details panel covers: right column on desktop, bottom sheet on phones (site-map.css). */
function panelInset(engine, wrap, ref) {
  const stage = wrap?.querySelector('.sm-stage');
  if (!engine || !stage) return;
  if (!ref) {
    engine.setInset({});
  } else if (stage.clientWidth <= 720) {
    const head = stage.querySelector('.sm-head');
    engine.setInset({ top: head ? head.offsetTop + head.offsetHeight : 0, bottom: stage.clientHeight * 0.52 });
  } else {
    engine.setInset({ right: Math.min(23 * 16, stage.clientWidth - 32) + 16 });
  }
}

/** Card thumbnails: one lazy file, loaded on the first card hover or pick. */
let imagesPromise = null;
function loadImages() {
  imagesPromise ||= fetch(IMAGES_URL).then((res) => (res.ok ? res.json() : null)).catch(() => null);
  return imagesPromise;
}

function cardImage(images, i) {
  const key = images?.images?.[i];
  if (!key) return '';
  return key.startsWith('http') ? key : `${images.cdn}${key}${images.suffix}`;
}

function useImages(active) {
  const [images, setImages] = useState(null);
  useEffect(() => {
    if (!active || images) return undefined;
    let alive = true;
    loadImages().then((json) => { if (alive) setImages(json); });
    return () => { alive = false; };
  }, [active, images]);
  return images;
}

function NodeLink({ info, children, className }) {
  if (!info.href) return null;
  if (info.href === '/' || /^https?:/.test(info.href)) {
    return <a className={className} href={info.href}>{children}</a>;
  }
  return <Link className={className} to={info.href}>{children}</Link>;
}

function RefButton({ model, refNode, onPick, detail = false }) {
  const info = nodeInfo(model, refNode);
  return (
    <button type="button" className={`sm-ref is-${refNode.kind}`} onClick={() => onPick(refNode)}>
      <span className="sm-swatch" aria-hidden="true" />
      <span className="sm-ref-label">{info.label}</span>
      {detail || refNode.kind === 'card' ? <span className="sm-ref-sub">{info.sub}</span> : null}
    </button>
  );
}

function RefList({ model, group, onPick, limit = 12 }) {
  const [open, setOpen] = useState(false);
  const shown = open ? group.refs.slice(0, 400) : group.refs.slice(0, limit);
  const rest = group.refs.length - shown.length;
  return (
    <div className="sm-group">
      <h4>
        {group.title}
        <span>{fmt(group.refs.length)}</span>
      </h4>
      <ul>
        {shown.map((ref) => (
          <li key={`${ref.kind}:${ref.i}`}><RefButton model={model} refNode={ref} onPick={onPick} /></li>
        ))}
      </ul>
      {rest > 0 && !open ? (
        <button type="button" className="sm-more" onClick={() => setOpen(true)}>
          Show {fmt(Math.min(rest, 400 - shown.length))} more
        </button>
      ) : null}
      {open && group.refs.length > 400 ? <p className="sm-note">First 400 of {fmt(group.refs.length)} shown.</p> : null}
    </div>
  );
}

/** Live price and stock from the card desk API; the map's colours are the weekly snapshot. */
function LiveCard({ model, index }) {
  const id = model.data.cards.id[index];
  const images = useImages(true);
  const [live, setLive] = useState({ id: null, card: null, failed: false });
  useEffect(() => {
    let alive = true;
    fetchCard(String(id))
      .then((page) => { if (alive) setLive({ id, card: page?.card || null, failed: !page?.card }); })
      .catch(() => { if (alive) setLive({ id, card: null, failed: true }); });
    return () => { alive = false; };
  }, [id]);
  const card = live.id === id ? live.card : null;
  const src = cardImage(images, index);
  const price = Number(card?.price) > 0 ? Number(card.price) : 0;
  const stock = Number(card?.stock) || 0;
  let status = 'Checking live price…';
  if (card) status = price ? `${formatPkn(price)} · ${fmt(stock)} in stock` : 'No listing right now';
  else if (live.id === id && live.failed) status = 'Live price unavailable';
  return (
    <div className="sm-live">
      {src ? <img src={src} alt="" width="120" height="168" loading="lazy" /> : <div className="sm-live-blank" aria-hidden="true" />}
      <div>
        <p className="sm-live-label">Live</p>
        <p className="sm-live-price">{status}</p>
        {card && price ? <p className="sm-note">Cheapest listing now, including every seller on the desk.</p> : null}
      </div>
    </div>
  );
}

function MarketBlock({ model, selected, onPick, marketAt }) {
  const summary = useMemo(() => marketSummary(model, selected), [model, selected]);
  if (!summary.total || selected.kind === 'card') return null;
  const share = Math.round((summary.listed / summary.total) * 100);
  const cheapest = summary.cheapest;
  return (
    <div className="sm-market">
      <p>
        <strong>{fmt(summary.listed)}</strong> of {fmt(summary.total)} card desks listed ({share}%)
        {summary.listings ? <> · {fmt(summary.listings)} listings</> : null}
      </p>
      <div className="sm-meter" aria-hidden="true"><span style={{ width: `${share}%` }} /></div>
      {cheapest ? (
        <p className="sm-cheapest">
          Cheapest:{' '}
          <button type="button" className="sm-inline" onClick={() => onPick(cheapest)}>
            {nodeInfo(model, cheapest).label}
          </button>{' '}
          · {formatPkn(model.data.cards.pkn[cheapest.i])}
        </p>
      ) : <p className="sm-note">Nothing listed here yet: a gap sellers can fill.</p>}
      <p className="sm-note">Prices as of {dateLabel(marketAt)}.</p>
    </div>
  );
}

function PathBlock({ model, path, target, onPick, onReverse, onClear }) {
  const [copied, setCopied] = useState(false);
  if (!target) return null;
  const targetInfo = nodeInfo(model, target);
  if (!path) {
    return (
      <div className="sm-path">
        <h3>Path to {targetInfo.label}</h3>
        <p className="sm-note">No link path connects these two.</p>
        <button type="button" className="sm-more" onClick={onClear}>Clear</button>
      </div>
    );
  }
  const clicks = path.length - 1;
  const copy = () => {
    navigator.clipboard?.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  };
  return (
    <div className="sm-path">
      <h3>{clicks} {clicks === 1 ? 'click' : 'clicks'} to {targetInfo.label}</h3>
      <ol>
        {path.map((ref, n) => (
          <li key={`${ref.kind}:${ref.i}`}>
            <span className="sm-hop" aria-hidden="true">{n + 1}</span>
            <RefButton model={model} refNode={ref} onPick={onPick} detail={ref.kind !== 'card'} />
          </li>
        ))}
      </ol>
      <div className="sm-path-actions">
        <button type="button" className="btn ghost sm-small" onClick={copy}>{copied ? 'Link copied' : 'Copy link'}</button>
        <button type="button" className="btn ghost sm-small" onClick={onReverse}>Reverse</button>
        <button type="button" className="sm-more" onClick={onClear}>Clear</button>
      </div>
    </div>
  );
}

function Panel({ model, selected, target, path, marketAt, onPick, onTarget, onReverse, onClearTarget, onClose }) {
  const info = nodeInfo(model, selected);
  const { out, into, instances } = useMemo(() => neighbors(model, selected), [model, selected]);
  const inherited = useMemo(() => (
    ['set', 'era', 'card', 'species', 'artist'].includes(selected.kind) ? templateLinks(model, selected.kind) : []
  ), [model, selected]);
  const outCount = out.reduce((s, g) => s + g.refs.length, 0) + inherited.length;
  const inCount = into.reduce((s, g) => s + g.refs.length, 0);
  const canPath = PATH_KINDS.has(selected.kind);
  return (
    <aside className="sm-panel" aria-label={`${info.kind}: ${info.label}`}>
      <button type="button" className="sm-close" onClick={onClose} aria-label="Close details">×</button>
      <p className={`sm-kind is-${selected.kind}`}><span className="sm-swatch" aria-hidden="true" />{info.kind}</p>
      <h2>{info.label}</h2>
      {info.sub ? <p className="sm-sub">{info.sub}</p> : null}
      {info.href ? <NodeLink info={info} className="btn sm-open">Open page</NodeLink> : null}
      {selected.kind === 'card' ? <LiveCard model={model} index={selected.i} /> : null}
      <MarketBlock model={model} selected={selected} onPick={onPick} marketAt={marketAt} />
      <PathBlock model={model} path={path} target={target} onPick={onPick} onReverse={onReverse} onClear={onClearTarget} />
      {canPath && !target ? (
        <div className="sm-path-find">
          <h3>Six degrees of Pokoin</h3>
          <SearchBox
            model={model}
            kinds={PATH_KINDS}
            placeholder={`Path from ${info.label} to…`}
            label={`Find the shortest path from ${info.label}`}
            onPick={onTarget}
          />
        </div>
      ) : null}
      <dl className="sm-counts">
        <div><dt>Links to</dt><dd>{fmt(outCount)}</dd></div>
        <div><dt>Linked from</dt><dd>{fmt(inCount)}</dd></div>
        {instances ? <div><dt>Pages</dt><dd>{fmt(instances.count)}</dd></div> : null}
      </dl>
      {instances ? (
        <p className="sm-note">
          Template for {fmt(instances.count)} {KIND_PLURAL[instances.kind]}
          {instances.kind === 'card' ? ' — too many lines to draw, so the stars stay lit instead.' : '.'}
        </p>
      ) : null}
      {out.length ? <h3>Links to</h3> : null}
      {out.map((group) => <RefList key={`out-${group.key}`} model={model} group={group} onPick={onPick} />)}
      {inherited.length ? (
        <RefList model={model} group={{ key: 'inherited', title: `Every ${selected.kind === 'species' ? 'Pokémon' : KIND_LABEL[selected.kind].toLowerCase()} page also links to`, refs: inherited }} onPick={onPick} limit={6} />
      ) : null}
      {into.length ? <h3>Linked from</h3> : null}
      {into.map((group) => <RefList key={`in-${group.key}`} model={model} group={group} onPick={onPick} />)}
      {selected.kind !== 'page' || model.data.pages[selected.i].group !== 'internal' ? (
        <p className="sm-note">Plus the header &amp; footer, which every page carries.</p>
      ) : null}
    </aside>
  );
}

function SearchBox({ model, onPick, kinds = null, placeholder = 'Find a page, set, Pokémon, artist or card', label = 'Search the site map' }) {
  // The name index is built on the first keystroke, not on page load.
  const searchRef = useRef(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useMemo(() => `sm-hits-${Math.random().toString(36).slice(2, 8)}`, []);
  const results = useMemo(() => {
    if (!query.trim()) return [];
    searchRef.current ||= createSearch(model);
    const hits = searchRef.current(query, kinds ? 30 : 10);
    return (kinds ? hits.filter((ref) => kinds.has(ref.kind)) : hits).slice(0, 10);
  }, [model, query, kinds]);
  const pick = (ref) => {
    onPick(ref);
    setQuery('');
    setActive(0);
  };
  return (
    <div className="sm-search" role="search">
      <input
        type="search"
        value={query}
        placeholder={placeholder}
        aria-label={label}
        aria-controls={listId}
        aria-activedescendant={results.length ? `${listId}-${active}` : undefined}
        onChange={(event) => { setQuery(event.target.value); setActive(0); }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
          if (event.key === 'ArrowUp') { event.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (event.key === 'Enter' && results[active]) { event.preventDefault(); pick(results[active]); }
          if (event.key === 'Escape') setQuery('');
        }}
      />
      {query && results.length ? (
        <ul id={listId} role="listbox">
          {results.map((ref, n) => {
            const info = nodeInfo(model, ref);
            return (
              <li key={`${ref.kind}:${ref.i}`} id={`${listId}-${n}`} role="option" aria-selected={n === active}>
                <button type="button" className={`sm-ref is-${ref.kind}`} onMouseEnter={() => setActive(n)} onClick={() => pick(ref)}>
                  <span className="sm-swatch" aria-hidden="true" />
                  <span className="sm-ref-label">{info.label}</span>
                  <span className="sm-ref-sub">{ref.kind === 'page' ? info.sub : info.kind}{ref.kind === 'card' ? ` · ${info.sub}` : ''}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {query && !results.length ? <p className="sm-empty">Nothing on the map matches “{query}”.</p> : null}
    </div>
  );
}

function MarketLegend({ model, onlyListed, onToggleListed }) {
  const { edges, min, max } = priceEdges(model);
  const bounds = [min, ...edges, max];
  const listed = model.data.stats.listed;
  return (
    <div className="sm-ramp" role="group" aria-label="Cheapest listed price">
      <span className="sm-ramp-title">Cheapest listing, PKN</span>
      <ol>
        {Array.from({ length: PRICE_BUCKETS }, (_, b) => (
          <li key={b}>
            <span className="sm-ramp-chip" style={{ background: `var(--sm-ramp-${b})` }} aria-hidden="true" />
            {b === PRICE_BUCKETS - 1 ? `${formatPknNumber(bounds[b])}+` : `${formatPknNumber(bounds[b])}–${formatPknNumber(bounds[b + 1])}`}
          </li>
        ))}
      </ol>
      <button type="button" className="sm-legend-item is-unlisted" aria-pressed={!onlyListed} onClick={onToggleListed}>
        <span className="sm-swatch" aria-hidden="true" />
        Not listed <span className="sm-legend-n">{fmt(model.count - listed)}</span>
      </button>
    </div>
  );
}

export default function SiteMap() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [params, setParams] = useSearchParams();
  const [hidden, setHidden] = useState(() => new Set());
  const [hover, setHover] = useState(null);
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const engineRef = useRef(null);

  useEffect(() => {
    let alive = true;
    fetch(DATA_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => { if (alive) setData(json); })
      .catch((err) => { if (alive) setError(String(err.message || err)); });
    return () => { alive = false; };
  }, []);

  const model = useMemo(() => (data ? buildModel(data) : null), [data]);
  const focusKey = params.get('focus') || '';
  const toKey = params.get('to') || '';
  const market = params.get('view') === 'market';
  const onlyListed = market && params.get('listed') === '1';
  const selected = useMemo(() => (model && focusKey ? refFromKey(model, focusKey) : null), [model, focusKey]);
  const target = useMemo(() => (model && selected && toKey ? refFromKey(model, toKey) : null), [model, selected, toKey]);
  const path = useMemo(() => (model && selected && target ? shortestPath(model, selected, target) : null), [model, selected, target]);

  const setParam = useCallback((patch) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    }, { replace: true });
  }, [setParams]);

  const select = useCallback((ref, { fly = false } = {}) => {
    if (!model) return;
    panelInset(engineRef.current, wrapRef.current, ref);
    setParam({ focus: ref ? refKey(model, ref) : '', to: '' });
    if (fly && ref) engineRef.current?.flyTo(ref);
  }, [model, setParam]);

  const setTarget = useCallback((ref) => {
    if (!model || (ref && sameRef(ref, selected))) return;
    setParam({ to: ref ? refKey(model, ref) : '' });
  }, [model, selected, setParam]);

  const reversePath = useCallback(() => {
    if (!model || !selected || !target) return;
    setParam({ focus: refKey(model, target), to: refKey(model, selected) });
  }, [model, selected, target, setParam]);

  const startPath = useCallback((fromKey, toKeyValue) => {
    const from = refFromKey(model, fromKey);
    if (!from) return;
    panelInset(engineRef.current, wrapRef.current, from);
    setParam({ focus: fromKey, to: toKeyValue });
  }, [model, setParam]);

  // The engine outlives selection changes; it reaches the latest select() through a ref.
  const selectRef = useRef(select);
  selectRef.current = select;
  useEffect(() => {
    if (!model || !canvasRef.current) return undefined;
    const engine = createSiteMapCanvas(canvasRef.current, model, {
      readColors: () => readColors(wrapRef.current),
      onHover: (ref, x, y) => {
        if (ref?.kind === 'card') loadImages();
        setHover(ref ? { ref, x, y } : null);
      },
      onSelect: (ref) => selectRef.current(ref, { fly: true }),
    });
    engineRef.current = engine;
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, [model]);

  // A deep link (?focus=set:base-set) flies there on first paint; later picks fly from select().
  const landed = useRef(false);
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setSelected(path ? null : selected);
    engine.setPath(path);
    if (path) {
      panelInset(engine, wrapRef.current, selected);
      engine.frame(path);
    }
    if (!landed.current) {
      landed.current = true;
      panelInset(engine, wrapRef.current, selected);
      if (selected && !path) engine.flyTo(selected, { ms: 900 });
    }
  }, [model, selected, path]);

  useEffect(() => {
    engineRef.current?.setHidden(hidden);
  }, [hidden, model]);

  useEffect(() => {
    engineRef.current?.setMarket({ mode: market ? 'market' : 'structure', onlyListed });
  }, [market, onlyListed, model]);

  const toggle = (kind) => setHidden((prev) => {
    const next = new Set(prev);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    return next;
  });

  const stats = data?.stats;
  const hoverCard = hover?.ref.kind === 'card';
  const images = useImages(Boolean(hoverCard));
  const hoverInfo = model && hover && !sameRef(hover.ref, selected) ? nodeInfo(model, hover.ref) : null;
  const hoverPkn = hoverCard ? data.cards.pkn[hover.ref.i] : 0;
  const hoverSrc = hoverCard ? cardImage(images, hover.ref.i) : '';

  return (
    <div className="page site-map-page" ref={wrapRef}>
      <SeoHead
        title="Site Map · Every Pokoin Page and Link | Pokoin"
        description="An interactive map of pokoin.com: every page template, catalog hub and card desk, the links between them, and what is listed right now."
        canonical="/sitemap"
      />
      <div className="sm-stage">
        <canvas
          ref={canvasRef}
          className="sm-canvas"
          tabIndex={0}
          role="img"
          aria-label="Map of every pokoin.com page and link. Drag to pan, scroll or pinch to zoom, click a node to see its links. Use the search box to find any page."
        />
        <header className="sm-head">
          <p className="page-kicker">Pokoin</p>
          <h1>Site map</h1>
          {stats ? (
            <p className="sm-stats">
              <strong>{fmt(stats.pages)}</strong> pages · <strong>{fmt(stats.links)}</strong> links
              {market ? <> · <strong>{Math.round((stats.listed / stats.cards) * 100)}%</strong> listed</> : null}
            </p>
          ) : null}
          {model ? (
            <div className="sm-modes" role="group" aria-label="Colour the map by">
              <button type="button" aria-pressed={!market} onClick={() => setParam({ view: '', listed: '' })}>Structure</button>
              <button type="button" aria-pressed={market} onClick={() => setParam({ view: 'market' })}>Market</button>
            </div>
          ) : null}
          {model ? <SearchBox model={model} onPick={(ref) => select(ref, { fly: true })} /> : null}
          {model ? (
            <p className="sm-try">
              Six degrees:{' '}
              {PATH_EXAMPLES.map(([from, to]) => {
                const a = refFromKey(model, from);
                const b = refFromKey(model, to);
                if (!a || !b) return null;
                return (
                  <button key={from + to} type="button" className="sm-inline" onClick={() => startPath(from, to)}>
                    {nodeInfo(model, a).label} → {nodeInfo(model, b).label}
                  </button>
                );
              })}
            </p>
          ) : null}
        </header>
        {!model && !error ? <p className="sm-status" role="status">Mapping every page…</p> : null}
        {error ? <p className="sm-status" role="alert">The map did not load ({error}).</p> : null}
        {model ? (
          <div className="sm-legend" role="group" aria-label="Show or hide node types">
            {market ? (
              <MarketLegend model={model} onlyListed={onlyListed} onToggleListed={() => setParam({ listed: onlyListed ? '' : '1' })} />
            ) : null}
            {LEGEND.filter((row) => !(market && row.kind === 'card')).map((row) => (
              <button
                key={row.kind}
                type="button"
                className={`sm-legend-item is-${row.kind}`}
                aria-pressed={!hidden.has(row.kind)}
                onClick={() => toggle(row.kind)}
              >
                <span className="sm-swatch" aria-hidden="true" />
                {row.label}
                <span className="sm-legend-n">
                  {fmt({ page: data.pages.length, set: data.sets.length, card: stats.cards, species: stats.species, artist: stats.artists }[row.kind])}
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {model ? (
          <div className="sm-zoom" role="group" aria-label="Zoom">
            <button type="button" onClick={() => engineRef.current?.zoom(1.6)} aria-label="Zoom in">+</button>
            <button type="button" onClick={() => engineRef.current?.zoom(1 / 1.6)} aria-label="Zoom out">−</button>
            <button type="button" onClick={() => engineRef.current?.reset()} aria-label="Show the whole map">⤢</button>
          </div>
        ) : null}
        {hoverInfo ? (
          <div className={`sm-tip${hoverSrc ? ' has-image' : ''}`} style={{ left: hover.x, top: hover.y }} aria-hidden="true">
            {hoverSrc ? <img src={hoverSrc} alt="" width="84" height="117" /> : null}
            <div>
              <span className={`sm-kind is-${hover.ref.kind}`}><span className="sm-swatch" />{hoverInfo.kind}</span>
              <strong>{hoverInfo.label}</strong>
              {hoverInfo.sub ? <span className="sm-tip-sub">{hoverInfo.sub}</span> : null}
              {hoverCard ? (
                <span className="sm-tip-price">
                  {hoverPkn > 0 ? `from ${formatPkn(hoverPkn)} · ${fmt(data.cards.lc[hover.ref.i])} listings` : 'Not listed'}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
        {model && selected ? (
          <Panel
            model={model}
            selected={selected}
            target={target}
            path={path}
            marketAt={stats.marketAt}
            onPick={(ref) => select(ref, { fly: true })}
            onTarget={setTarget}
            onReverse={reversePath}
            onClearTarget={() => setParam({ to: '' })}
            onClose={() => select(null)}
          />
        ) : null}
      </div>
    </div>
  );
}
