import { createEffect, createMemo, createSignal, For, Match, onSettled, Show, Switch, untrack } from 'solid-js';
import { useLocation, useParams } from '@solidjs/router';
import { cardHref, fetchPortfolio, formatPkn, imageSrc } from '@market/api.js';
import { game } from '@market/game.js';
import { bindRailControls, stepRail } from '@market/rail-scroll.js';
import CardArt from '../components/CardArt.jsx';
import { Alert, DeskPanel, EmptyDesk, Metric, MetricGrid, PageHead } from '../components/Desk.jsx';
import DumpNav from '../components/DumpNav.jsx';
import { rememberView, restoredView } from '../lib/scroll-restore.js';

const PAGE = 40;

function holdingHref(item) {
  return item?.id ? `/marketplace/portfolio/${item.id}` : '/marketplace/portfolio';
}

function money(value) {
  return formatPkn(value) || '—';
}

/** The asking total counts up over 800 ms (React useCountUp). */
function createCountUp(target) {
  const [value, setValue] = createSignal(0);
  createEffect(target, (goal) => {
    if (!Number.isFinite(goal) || goal <= 0) {
      setValue(0);
      return undefined;
    }
    const start = performance.now();
    let frame = 0;
    const tick = (now) => {
      const progress = Math.min(1, (now - start) / 800);
      const eased = 1 - (1 - progress) ** 3;
      setValue(goal * eased);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  });
  return value;
}

function Mini(props) {
  return (
    <a class="port-mini" href={holdingHref(props.item)}>
      <CardArt src={imageSrc(props.item, 'hero')} alt="" loading="lazy" />
      <strong>{props.item.name}</strong>
      <span class="muted">{props.item.expansion}</span>
      <em>{money(props.item.totalPkn)}</em>
    </a>
  );
}

function Rail(props) {
  let scroller;
  createEffect(() => props.items.length, (count) => (count ? bindRailControls(scroller) : undefined));
  return (
    <Show when={props.items.length}>
      <section class="carousel">
        <div class="carousel-head">
          <h2>{props.title}</h2>
        </div>
        <div class="rail-wrap">
          <button class="rail-prev" type="button" aria-label="Previous" onClick={() => stepRail(scroller, -1)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m15.75 19.5-7.5-7.5 7.5-7.5" /></svg>
          </button>
          <div class="rail-scroll" ref={(node) => { scroller = node; }}>
            <div class="carousel-track">
              <For each={props.items}>{(item) => <Mini item={item} />}</For>
            </div>
          </div>
          <button class="rail-next" type="button" aria-label="Next" onClick={() => stepRail(scroller, 1)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
          </button>
        </div>
      </section>
    </Show>
  );
}

function PortfolioList() {
  const site = game();
  const location = useLocation();
  const href = untrack(() => `${location.pathname}${location.search}`);
  const restored = restoredView(href);
  const [catalog, setCatalog] = createSignal(null);
  const [error, setError] = createSignal('');
  const [query, setQuery] = createSignal(String(restored?.query || ''));
  const [shown, setShown] = createSignal(Number(restored?.shown) > PAGE ? Number(restored.shown) : PAGE);
  let sentinel;
  const displayed = createCountUp(() => catalog()?.totals?.pkn || 0);
  document.title = 'Portfolio · Pokoin';

  onSettled(() => {
    let cancelled = false;
    fetchPortfolio()
      .then((data) => { if (!cancelled) setCatalog(() => data); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Portfolio failed.'); });
    return () => { cancelled = true; };
  });

  const ranked = createMemo(() => {
    const data = catalog();
    if (!data) return { valuable: [], unit: [], copies: [], holdings: [] };
    const items = data.items || [];
    const byTotal = [...items].sort((a, b) => (b.totalPkn || 0) - (a.totalPkn || 0));
    const byUnit = [...items].sort((a, b) => (b.pricePkn || 0) - (a.pricePkn || 0));
    const byQty = [...items].sort((a, b) => (b.qty || 0) - (a.qty || 0) || (b.totalPkn || 0) - (a.totalPkn || 0));
    const needle = query().trim().toLowerCase();
    const holdings = needle
      ? byTotal.filter((item) => `${item.name} ${item.expansion} ${item.game}`.toLowerCase().includes(needle))
      : byTotal;
    return { valuable: byTotal.slice(0, 10), unit: byUnit.slice(0, 10), copies: byQty.slice(0, 10), holdings };
  });

  // A new search starts again from the first page (not the restored one).
  createEffect(query, () => setShown(PAGE), { defer: true });
  createEffect(() => ({ shown: shown(), query: query() }), (view) => rememberView(href, view));

  createEffect(
    () => (catalog() ? [ranked().holdings.length, query()] : null),
    (input) => {
      if (!input || !sentinel) return undefined;
      const [total] = input;
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setShown((current) => Math.min(current + PAGE, total));
      }, { rootMargin: '800px 0px' });
      observer.observe(sentinel);
      return () => observer.disconnect();
    },
  );

  const sets = () => catalog()?.sets || [];
  const maxPkn = () => Math.max(1, ...sets().map((row) => row.pkn || 0));
  const visible = () => ranked().holdings.slice(0, shown());

  return (
    <Switch>
      <Match when={error()}>
        <div class="page desk">
          <PageHead kicker="Market" title="Portfolio" />
          <DumpNav />
          <Alert>{error()}</Alert>
        </div>
      </Match>
      <Match when={!catalog()}>
        <div class="page desk">
          <PageHead kicker="Portfolio" title="Live asking" lede="Loading Pokoin catalog…" />
          <DumpNav />
        </div>
      </Match>
      <Match when={true}>
        <div class="page desk port-page">
          <PageHead
            kicker="Portfolio"
            title={`${site.brand} · live listings`}
            lede="Pokoin catalog in PKN. Art from cdn.pokoin.com. Asking overlays live native listings when they exist."
          />
          <DumpNav />
          <MetricGrid>
            <Metric value={money(displayed())} label="Asking" hint={money(catalog().totals.pkn)} />
            <Metric value={(catalog().totals.qty || 0).toLocaleString('en-US')} label="Copies" />
            <Metric value={(catalog().totals.listings || 0).toLocaleString('en-US')} label="Listings" />
            <Metric value={(catalog().totals.cards || 0).toLocaleString('en-US')} label="Cards" />
          </MetricGrid>

          <Show when={sets().length}>
            <section>
              <div class="carousel-head">
                <h2>By set</h2>
              </div>
              <div class="port-games">
                <For each={sets()}>
                  {(row) => (
                    <div class="port-game">
                      <strong>{row.name}</strong>
                      <div class="port-bar">
                        <i style={{ width: `${((row.pkn || 0) / maxPkn()) * 100}%` }} />
                      </div>
                      <span>{money(row.pkn)} · {(row.qty || 0).toLocaleString('en-US')} copies</span>
                    </div>
                  )}
                </For>
              </div>
            </section>
          </Show>

          <Rail title="Most valuable" items={ranked().valuable} />
          <Rail title="Highest unit price" items={ranked().unit} />
          <Rail title="Most copies" items={ranked().copies} />

          <section>
            <div class="shop-toolbar">
              <p class="result-count">Holdings</p>
              <input
                class="shop-search"
                type="search"
                value={query()}
                onInput={(event) => setQuery(event.target.value)}
                placeholder="Search this portfolio…"
                aria-label="Search this portfolio"
              />
            </div>
            <DeskPanel flush>
              <div class="port-holdings">
                <For each={visible()}>
                  {(item) => (
                    <a class="port-hold" href={holdingHref(item)}>
                      <CardArt src={imageSrc(item, 'hero')} alt="" loading="lazy" />
                      <div>
                        <strong>{item.name}</strong>
                        <span class="muted">
                          {item.game}
                          {' · '}
                          {item.expansion}
                          {item.number ? ` · ${item.number}` : ''}
                          {item.condition ? ` · ${item.condition}` : ''}
                          {' · ×'}
                          {item.qty}
                        </span>
                      </div>
                      <em>{money(item.totalPkn)}</em>
                    </a>
                  )}
                </For>
              </div>
            </DeskPanel>
            <Show
              when={ranked().holdings.length}
              fallback={(
                <EmptyDesk nested title="No Pokoin cards" lede="Catalog is empty for this game.">
                  <a class="btn" href="/marketplace">Shop</a>
                </EmptyDesk>
              )}
            >
              <p class="page-lede">
                Showing {visible().length.toLocaleString('en-US')} of {ranked().holdings.length.toLocaleString('en-US')}
              </p>
            </Show>
            <div ref={(node) => { sentinel = node; }} />
          </section>
        </div>
      </Match>
    </Switch>
  );
}

function HoldingDetail(props) {
  const [catalog, setCatalog] = createSignal(null);
  const [error, setError] = createSignal('');

  createEffect(() => props.listingId, (listingId) => {
    let cancelled = false;
    fetchPortfolio({ id: listingId })
      .then((data) => { if (!cancelled) setCatalog(() => data); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Portfolio failed.'); });
    return () => { cancelled = true; };
  });

  const item = () => (catalog()?.items || []).find((row) => String(row.id) === String(props.listingId))
    || catalog()?.items?.[0]
    || null;

  createEffect(item, (row) => {
    document.title = `${row?.name || 'Holding'} · Portfolio · Pokoin`;
  });

  return (
    <Switch>
      <Match when={error()}>
        <div class="page desk">
          <DumpNav />
          <Alert>{error()}</Alert>
        </div>
      </Match>
      <Match when={!catalog()}>
        <div class="page desk">
          <p class="page-lede">Loading live PKN holding…</p>
        </div>
      </Match>
      <Match when={!item()}>
        <div class="page desk">
          <Alert>No Pokoin card for that id.</Alert>
          <a class="btn ghost" href="/marketplace/portfolio">Back to portfolio</a>
        </div>
      </Match>
      <Match when={item()}>
        {(row) => (
          <div class="page desk port-page">
            <nav class="crumbs">
              <a href="/marketplace/portfolio">Portfolio</a>
              <span>/</span>
              <span>{row().name}</span>
            </nav>
            <div class="port-detail">
              <CardArt src={imageSrc(row(), 'hero')} alt={row().name} />
              <div>
                <p class="eyebrow">{row().game}</p>
                <h1>{row().name}</h1>
                <p class="muted">
                  {row().expansion}
                  {row().number ? ` · ${row().number}` : ''}
                  {row().condition ? ` · ${row().condition}` : ''}
                  {row().language ? ` · ${row().language}` : ''}
                  {' · ×'}
                  {row().qty}
                </p>
                <p class="port-value">{money(row().totalPkn)}</p>
                <p class="muted">
                  {money(row().pricePkn)} floor · {row().listingCount} native listing{row().listingCount === 1 ? '' : 's'}
                </p>
                <p class="muted">Pokoin PKN. Catalog art from cdn.pokoin.com. Not USD. Not a CardTrader leftover image.</p>
                <p class="comp-subnav">
                  <a href={row().canonicalPath || cardHref(row())}>Open card desk</a>
                  <a href="/marketplace/portfolio">All holdings</a>
                </p>
              </div>
            </div>
          </div>
        )}
      </Match>
    </Switch>
  );
}

/** /marketplace/portfolio and /marketplace/portfolio/:listingId (market/src/pages/Portfolio.jsx). */
export default function Portfolio() {
  const params = useParams();
  return (
    <Show when={params.listingId} keyed fallback={<PortfolioList />}>
      {(id) => <HoldingDetail listingId={id} />}
    </Show>
  );
}
