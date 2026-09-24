import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import SeoHead from '../components/SeoHead.jsx';
import { createSiteMapCanvas } from '../site-map-canvas.js';
import {
  KIND_LABEL,
  KIND_PLURAL,
  buildModel,
  createSearch,
  neighbors,
  nodeInfo,
  refFromKey,
  refKey,
  sameRef,
  templateLinks,
} from '../site-map-graph.js';
import '../site-map.css';

const DATA_URL = `${import.meta.env.BASE_URL || '/'}data/site-map.json`;

const LEGEND = [
  { kind: 'page', label: 'Pages & hubs' },
  { kind: 'set', label: 'Sets' },
  { kind: 'card', label: 'Card desks' },
  { kind: 'species', label: 'Pokémon' },
  { kind: 'artist', label: 'Artists' },
];

const GROUP_TITLE = {
  landing: 'Home',
  catalog: 'Catalog',
  competitive: 'Competitive',
  community: 'Community',
  account: 'Account',
  info: 'About Pokoin',
  shell: 'Site chrome',
  internal: 'Internal',
};

const fmt = (n) => Number(n || 0).toLocaleString('en-US');

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

function NodeLink({ info, children, className }) {
  if (!info.href) return null;
  if (info.href === '/') {
    return <a className={className} href="/">{children}</a>;
  }
  return <Link className={className} to={info.href}>{children}</Link>;
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
        {shown.map((ref) => {
          const info = nodeInfo(model, ref);
          return (
            <li key={`${ref.kind}:${ref.i}`}>
              <button type="button" className={`sm-ref is-${ref.kind}`} onClick={() => onPick(ref)}>
                <span className="sm-swatch" aria-hidden="true" />
                <span className="sm-ref-label">{info.label}</span>
                {ref.kind === 'card' ? <span className="sm-ref-sub">{info.sub}</span> : null}
              </button>
            </li>
          );
        })}
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

function Panel({ model, selected, onPick, onClose }) {
  const info = nodeInfo(model, selected);
  const { out, into, instances } = useMemo(() => neighbors(model, selected), [model, selected]);
  const inherited = useMemo(() => (
    ['set', 'era', 'card', 'species', 'artist'].includes(selected.kind) ? templateLinks(model, selected.kind) : []
  ), [model, selected]);
  const outCount = out.reduce((s, g) => s + g.refs.length, 0) + inherited.length;
  const inCount = into.reduce((s, g) => s + g.refs.length, 0);
  return (
    <aside className="sm-panel" aria-label={`${info.kind}: ${info.label}`}>
      <button type="button" className="sm-close" onClick={onClose} aria-label="Close details">×</button>
      <p className={`sm-kind is-${selected.kind}`}><span className="sm-swatch" aria-hidden="true" />{info.kind}</p>
      <h2>{info.label}</h2>
      {info.sub ? <p className="sm-sub">{info.sub}</p> : null}
      {info.href ? <NodeLink info={info} className="btn sm-open">Open page</NodeLink> : null}
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

function SearchBox({ model, onPick }) {
  const search = useMemo(() => createSearch(model), [model]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const results = useMemo(() => search(query, 10), [search, query]);
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
        placeholder="Find a page, set, Pokémon, artist or card"
        aria-label="Search the site map"
        aria-controls="sm-search-results"
        aria-activedescendant={results.length ? `sm-hit-${active}` : undefined}
        onChange={(event) => { setQuery(event.target.value); setActive(0); }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
          if (event.key === 'ArrowUp') { event.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (event.key === 'Enter' && results[active]) { event.preventDefault(); pick(results[active]); }
          if (event.key === 'Escape') setQuery('');
        }}
      />
      {query && results.length ? (
        <ul id="sm-search-results" role="listbox">
          {results.map((ref, n) => {
            const info = nodeInfo(model, ref);
            return (
              <li key={`${ref.kind}:${ref.i}`} id={`sm-hit-${n}`} role="option" aria-selected={n === active}>
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

/** The same map as plain links: the text alternative to the canvas, and crawlable. */
function HubIndex({ model }) {
  const { data } = model;
  const groups = useMemo(() => {
    const out = {};
    data.pages.forEach((page) => {
      if (page.template || page.id === 'chrome' || page.group === 'internal') return;
      (out[page.group] ||= []).push(page);
    });
    return out;
  }, [data]);
  return (
    <section className="sm-index" aria-labelledby="sm-index-title">
      <h2 id="sm-index-title">Every hub, as a list</h2>
      <p className="sm-lede">
        {fmt(data.stats.cards)} card desks hang off these hubs: open a set, a Pokémon or an artist to reach them.
      </p>
      <div className="sm-index-grid">
        {Object.entries(GROUP_TITLE).filter(([key]) => groups[key]).map(([key, title]) => (
          <div key={key}>
            <h3>{title}</h3>
            <ul>
              {groups[key].map((page) => (
                <li key={page.id}>
                  {page.path === '/' ? <a href="/">{page.label}</a> : <Link to={page.path}>{page.label}</Link>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <details>
        <summary>Eras and sets <span>{fmt(data.sets.length)}</span></summary>
        <div className="sm-columns">
          {data.eras.map((era, e) => {
            const sets = data.sets.filter((set) => set.era === e);
            if (!sets.length) return null;
            return (
              <div key={era.id} className="sm-era">
                <h4><Link to={`/marketplace/eras/${era.id}`}>{era.name}</Link></h4>
                <ul>
                  {sets.sort((a, b) => a.name.localeCompare(b.name)).map((set) => (
                    <li key={set.slug}><Link to={`/marketplace/sets/${set.slug}`}>{set.name}</Link></li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </details>
      <details>
        <summary>Pokémon <span>{fmt(data.species.length)}</span></summary>
        <ul className="sm-flow">
          {data.species.map((row) => (
            <li key={row.slug}><Link to={`/marketplace/en/pokemon/${row.slug}`}>{row.name}</Link></li>
          ))}
        </ul>
      </details>
      <details>
        <summary>Artists <span>{fmt(data.artists.length)}</span></summary>
        <ul className="sm-flow">
          {[...data.artists].sort((a, b) => a.name.localeCompare(b.name)).map((row) => (
            <li key={row.slug}><Link to={`/marketplace/en/artists/${row.slug}`}>{row.name}</Link></li>
          ))}
        </ul>
      </details>
    </section>
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
  const selected = useMemo(() => (model && focusKey ? refFromKey(model, focusKey) : null), [model, focusKey]);

  const select = useCallback((ref, { fly = false } = {}) => {
    if (!model) return;
    panelInset(engineRef.current, wrapRef.current, ref);
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (ref) next.set('focus', refKey(model, ref));
      else next.delete('focus');
      return next;
    }, { replace: true });
    if (fly && ref) engineRef.current?.flyTo(ref);
  }, [model, setParams]);

  // The engine outlives selection changes; it reaches the latest select() through a ref.
  const selectRef = useRef(select);
  selectRef.current = select;
  useEffect(() => {
    if (!model || !canvasRef.current) return undefined;
    const engine = createSiteMapCanvas(canvasRef.current, model, {
      readColors: () => readColors(wrapRef.current),
      onHover: (ref, x, y) => setHover(ref ? { ref, x, y } : null),
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
    engine.setSelected(selected);
    if (!landed.current) {
      landed.current = true;
      panelInset(engine, wrapRef.current, selected);
      if (selected) engine.flyTo(selected, { ms: 900 });
    }
  }, [model, selected]);

  useEffect(() => {
    engineRef.current?.setHidden(hidden);
  }, [hidden, model]);

  const toggle = (kind) => setHidden((prev) => {
    const next = new Set(prev);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    return next;
  });

  const stats = data?.stats;
  const hoverInfo = model && hover && !sameRef(hover.ref, selected) ? nodeInfo(model, hover.ref) : null;

  return (
    <div className="page site-map-page" ref={wrapRef}>
      <SeoHead
        title="Site Map · Every Pokoin Page and Link | Pokoin"
        description="An interactive map of pokoin.com: every page template, catalog hub and card desk, and the links between them."
        canonical="/sitemap"
      />
      <div className="sm-stage">
        <canvas
          ref={canvasRef}
          className="sm-canvas"
          tabIndex={0}
          role="img"
          aria-label="Map of every pokoin.com page and link. Drag to pan, scroll or pinch to zoom, click a node to see its links. The same hubs are listed as links below the map."
        />
        <header className="sm-head">
          <p className="page-kicker">Pokoin</p>
          <h1>Site map</h1>
          {stats ? (
            <p className="sm-stats">
              <strong>{fmt(stats.pages)}</strong> pages · <strong>{fmt(stats.links)}</strong> links
            </p>
          ) : null}
          {model ? <SearchBox model={model} onPick={(ref) => select(ref, { fly: true })} /> : null}
          {model ? <a className="sm-jump" href="#sm-index-title">Browse as a list ↓</a> : null}
        </header>
        {!model && !error ? <p className="sm-status" role="status">Mapping every page…</p> : null}
        {error ? <p className="sm-status" role="alert">The map did not load ({error}).</p> : null}
        {model ? (
          <div className="sm-legend" role="group" aria-label="Show or hide node types">
            {LEGEND.map((row) => (
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
          <div className="sm-tip" style={{ left: hover.x, top: hover.y }} aria-hidden="true">
            <span className={`sm-kind is-${hover.ref.kind}`}><span className="sm-swatch" />{hoverInfo.kind}</span>
            <strong>{hoverInfo.label}</strong>
            {hoverInfo.sub ? <span>{hoverInfo.sub}</span> : null}
          </div>
        ) : null}
        {model && selected ? (
          <Panel model={model} selected={selected} onPick={(ref) => select(ref, { fly: true })} onClose={() => select(null)} />
        ) : null}
      </div>
      {stats ? (
        <p className="sm-footnote">
          {fmt(stats.pageLinks)} links between {fmt(stats.templates)} page templates, read from the app source ·{' '}
          {fmt(stats.catalogLinks)} catalog links between eras, sets, card desks, Pokémon, artists and rarity hubs ·{' '}
          {fmt(stats.shellLinks)} header &amp; footer links. Built {new Date(data.generatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}.
        </p>
      ) : null}
      {model ? <HubIndex model={model} /> : null}
    </div>
  );
}
