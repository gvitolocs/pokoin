import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { conditionChipSrc, conditionShort, conditionTone, listingLanguageFlag } from '../listing-meta.js';
import {
  filterInventoryRows,
  INVENTORY_SORTS,
  inventoryFacets,
  inventoryListingHref,
  inventoryRowDate,
  sortInventoryRows,
  summarizeLiveInventory,
} from '../inventory-listings.js';

const STATUS_CHIPS = [
  { id: '', label: 'All' },
  { id: 'active', label: 'Live' },
  { id: 'paused', label: 'Paused' },
];

const SORT_LABELS = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  'price-up': 'Price low → high',
  'price-down': 'Price high → low',
  'qty-down': 'Qty high → low',
  name: 'Name A → Z',
};

function StatTile({ value, label, tone = '' }) {
  return (
    <div className={`inv-stat${tone ? ` is-${tone}` : ''}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function RowThumb({ row }) {
  const src = String(row?.cardImageUrl || row?.card_image_url || '').trim();
  const name = row?.cardName || row?.name || 'Listing';
  if (src) {
    return <img className="inv-thumb" src={src} alt="" loading="lazy" width="40" height="56" />;
  }
  return <span className="inv-thumb is-empty" aria-hidden="true">{String(name).slice(0, 1).toUpperCase()}</span>;
}

function RowStatus({ status }) {
  const key = String(status || 'active').toLowerCase();
  if (key === 'paused') {
    return <span className="inv-status is-paused">Paused</span>;
  }
  return <span className="inv-status is-live">Live</span>;
}

/**
 * PowerTools-style listing manager for the MyPokoin desk: summary tiles,
 * a filter rail (search / status / condition / language / sort) and a dense
 * thumbnail table — candyext shop chrome on the seller's own stock.
 */
export default function InventoryBoard({ rows, formatPrice }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [condition, setCondition] = useState('');
  const [language, setLanguage] = useState('');
  const [sort, setSort] = useState('newest');

  const facets = useMemo(() => inventoryFacets(rows), [rows]);
  const summary = useMemo(() => summarizeLiveInventory(rows), [rows]);
  const view = useMemo(
    () => sortInventoryRows(filterInventoryRows(rows, { query, status, condition, language }), sort),
    [rows, query, status, condition, language, sort],
  );
  const paused = rows.filter((row) => String(row?.status || '').toLowerCase() === 'paused').length;

  return (
    <section className="inv-board" aria-label="My listings">
      <div className="inv-summary">
        <StatTile value={summary.listings.toLocaleString('en-US')} label="Live listings" />
        <StatTile value={summary.cards.toLocaleString('en-US')} label="Cards in stock" />
        <StatTile value={formatPrice(summary.listedPkn)} label="Total asking" tone="gold" />
        <StatTile value={paused.toLocaleString('en-US')} label="Paused" />
      </div>

      <div className="inv-rail">
        <input
          className="inv-search"
          type="search"
          placeholder="Search name, set, collector…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search listings"
        />
        <div className="inv-chips" role="group" aria-label="Status filter">
          {STATUS_CHIPS.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className={`inv-chip${status === chip.id ? ' on' : ''}`}
              onClick={() => setStatus(chip.id)}
            >
              {chip.label}
            </button>
          ))}
        </div>
        {facets.conditions.length > 1 ? (
          <select className="inv-select" value={condition} onChange={(event) => setCondition(event.target.value)} aria-label="Condition">
            <option value="">Any condition</option>
            {facets.conditions.map((key) => (
              <option key={key} value={key}>{conditionShort(key) || key}</option>
            ))}
          </select>
        ) : null}
        {facets.languages.length > 1 ? (
          <select className="inv-select" value={language} onChange={(event) => setLanguage(event.target.value)} aria-label="Language">
            <option value="">Any language</option>
            {facets.languages.map((key) => (
              <option key={key} value={key}>{key}</option>
            ))}
          </select>
        ) : null}
        <select
          className="inv-select inv-sort"
          value={sort}
          onChange={(event) => setSort(event.target.value)}
          aria-label="Sort"
        >
          {INVENTORY_SORTS.map((key) => (
            <option key={key} value={key}>{SORT_LABELS[key] || key}</option>
          ))}
        </select>
      </div>

      <div className="inv-table">
        <div className="inv-head" aria-hidden="true">
          <span>Card</span>
          <span>Cond</span>
          <span>Lang</span>
          <span className="num">Qty</span>
          <span className="num">Price</span>
          <span>Status</span>
          <span>Listed</span>
          <span />
        </div>
        {view.map((row) => {
          const href = inventoryListingHref(row);
          const setName = String(row?.setName || row?.set_name || '').trim();
          const collector = String(row?.collectorNumber || row?.collector_number || '').trim();
          const language = listingLanguageFlag(row?.language);
          return (
            <Link key={row.id || `${row.cardId}-${row.pricePkn}`} className="inv-row" to={href}>
              <span className="inv-card">
                <RowThumb row={row} />
                <span className="inv-card-txt">
                  <strong>{row?.cardName || row?.name || 'Listing'}</strong>
                  <span className="inv-card-sub">
                    {setName}{collector ? `${setName ? ' · ' : ''}#${collector}` : ''}
                  </span>
                </span>
              </span>
              <span className="inv-cond">
                <img
                  className={`shop-cond is-${conditionTone(row?.condition)}`}
                  src={conditionChipSrc(row?.condition)}
                  alt={conditionShort(row?.condition) || 'NM'}
                  title={conditionShort(row?.condition) || 'NM'}
                  width="40"
                  height="28"
                  loading="lazy"
                />
              </span>
              <span className="inv-lang">
                {language ? <img className="inv-flag" src={language.src} alt={language.code} title={language.code.toUpperCase()} width="18" height="18" loading="lazy" /> : <span className="inv-flag is-empty" />}
                <span className="inv-lang-code">{language ? language.code.toUpperCase() : '—'}</span>
              </span>
              <span className="inv-qty num">{Math.max(0, Number(row?.quantityAvailable ?? row?.quantity_available ?? 0) || 0)}</span>
              <span className="inv-price num">{formatPrice(row?.pricePkn ?? row?.price_pkn)}</span>
              <span><RowStatus status={row?.status} /></span>
              <span className="inv-date">{inventoryRowDate(row) || '—'}</span>
              <span className="inv-chev" aria-hidden="true">›</span>
            </Link>
          );
        })}
        {!view.length ? (
          <p className="inv-empty">No listings match the current filters.</p>
        ) : null}
      </div>
    </section>
  );
}
