import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchSellerShop } from '../api.js';
import { rewriteCanonicalCardPath } from '../card-stub.js';
import { cartItemFromOffer, useCart } from '../cart.jsx';
import { getSearchLang } from '../locale.js';
import ShopList from '../components/ShopList.jsx';
import ShopListingRow from '../components/ShopListing.jsx';
import { listingSelectId, shopDragOffers } from '../shop-marquee.js';
import { Alert, EmptyDesk, Metric, MetricGrid } from '../components/Desk.jsx';
import {
  publicListingSellerName,
  sellerCountryFlag,
  sellerCountryLabel,
} from '../listing-meta.js';
import { seedSellerListings } from '../seller-seed.js';

const PAGE_SIZE = 100;

const CONDITION_FILTERS = [
  { value: '', label: 'Any condition' },
  { value: 'NM', label: 'Near Mint' },
  { value: 'SP', label: 'Slightly Played' },
  { value: 'MP', label: 'Moderately Played' },
  { value: 'PL', label: 'Played' },
  { value: 'Poor', label: 'Poor' },
];

const LANG_FILTERS = ['', 'EN', 'IT', 'JP', 'DE', 'FR', 'ES', 'KR', 'PT', 'NL', 'PL', 'RU', 'ZH'];

function isOneDayReady(offer) {
  return Boolean(
    offer?.oneDayReady ||
      offer?.one_day_ready ||
      offer?.shippingMode === 'one_day_ready' ||
      /1-?day/i.test(String(offer?.sellerName || offer?.sellerDisplayName || '')),
  );
}

export default function Seller() {
  const { username = '', lang: routeLang } = useParams();
  const navigate = useNavigate();
  const { addItem } = useCart();
  const lang = routeLang || getSearchLang();
  const handle = decodeURIComponent(String(username || '').trim());
  const seeded = seedSellerListings(handle, { pageSize: PAGE_SIZE, sort: 'price-asc' });

  const [listings, setListings] = useState(() => seeded?.listings ?? null);
  const [total, setTotal] = useState(() => seeded?.total ?? null);
  const [unique, setUnique] = useState(() => seeded?.unique ?? null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [condition, setCondition] = useState('');
  const [language, setLanguage] = useState('');
  const [sort, setSort] = useState('price-asc');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(!seeded);

  useEffect(() => {
    setPage(1);
  }, [query, condition, language, sort, handle]);

  useEffect(() => {
    document.title = `${handle} · Pokoin`;
    if (!handle) return undefined;
    let cancelled = false;
    setLoading(true);
    const offset = (Math.max(1, page) - 1) * PAGE_SIZE;
    fetchSellerShop(handle, {
      limit: PAGE_SIZE,
      offset,
      q: query.trim(),
      condition,
      language,
      sort,
    })
      .then((data) => {
        if (cancelled) return;
        const rows = data.listings || data.items || [];
        setListings(rows);
        setTotal(Number(data.total ?? rows.length) || 0);
        setUnique(
          Number(
            data.unique ??
              data.uniqueCards ??
              new Set(rows.map((r) => String(r.cardId || r.card_id || '')).filter(Boolean)).size,
          ) || 0,
        );
        setError('');
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setListings([]);
        setTotal(0);
        setUnique(0);
        setError(err.message || 'Seller not found.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [handle, page, query, condition, language, sort]);

  const sample = listings?.[0];
  const display = publicListingSellerName(sample, handle);
  const country = sellerCountryFlag(sample?.sellerCountry);
  const countryLine = sellerCountryLabel(sample?.sellerCountry);
  const ready = useMemo(() => Boolean((listings || []).some(isOneDayReady)), [listings]);

  const totalItems = total ?? 0;
  const uniqueItems = unique ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE) || 1);
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startIdx = totalItems ? (safePage - 1) * PAGE_SIZE + 1 : 0;
  const endIdx = Math.min(safePage * PAGE_SIZE, totalItems);

  if (listings && !listings.length && error && totalItems === 0 && !loading) {
    return (
      <EmptyDesk title="Seller not found" lede={error}>
        <p className="status">Usernames match live native listings.</p>
      </EmptyDesk>
    );
  }

  return (
    <div className="page desk seller-page seller-shop-ct">
      <header className="seller-hero seller-hero-ct">
        <span className="seller-avatar" aria-hidden="true">
          {(display || '?').slice(0, 1).toUpperCase()}
        </span>
        <div className="seller-id">
          <p className="page-kicker">Seller</p>
          <h1 className="page-title">{display}</h1>
          <div className="seller-hero-meta">
            {country ? (
              <p className="seller-country">
                <img src={country.src} alt="" width="22" height="22" />
                <span>({(countryLine || country.label).toUpperCase()})</span>
              </p>
            ) : null}
            {ready ? <span className="seller-badge seller-badge-ready">1-Day Ready</span> : null}
          </div>
        </div>
      </header>

      {listings || total != null ? (
        <MetricGrid>
          <Metric value={totalItems} label="Total items" />
          <Metric value={uniqueItems} label="Unique items" />
        </MetricGrid>
      ) : (
        <p className="status">Loading listings…</p>
      )}

      <Alert>{error && listings?.length ? error : ''}</Alert>

      {listings != null ? (
        <section className="panel shop-panel shop-terminal seller-shop-panel">
          <header className="panel-head shop-head">
            <h2>Shop</h2>
          </header>

          <div className="shop-toolbar seller-shop-tools" role="search">
            <input
              className="shop-search"
              type="search"
              placeholder="Type an item name"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search listings"
            />
            <div className="shop-find">
              <select
                aria-label="Condition"
                value={condition}
                onChange={(e) => setCondition(e.target.value)}
              >
                {CONDITION_FILTERS.map((opt) => (
                  <option key={opt.value || 'any'} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="Language"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                {LANG_FILTERS.map((code) => (
                  <option key={code || 'any'} value={code}>
                    {code || 'Any language'}
                  </option>
                ))}
              </select>
              <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="price-asc">Price ↑</option>
                <option value="price-desc">Price ↓</option>
                <option value="name">Name</option>
                <option value="qty">Quantity</option>
              </select>
            </div>
          </div>

          <p className="seller-result-count">
            {loading ? (
              'Loading…'
            ) : totalItems ? (
              <>
                Showing <strong>{startIdx}</strong>–<strong>{endIdx}</strong> of{' '}
                <strong>{totalItems}</strong>
              </>
            ) : (
              'No matching listings'
            )}
          </p>

          {listings.length ? (
            <ShopList className="seller-shop-list">
              {(selected) => listings.map((offer, index) => {
                const cardId = String(offer.cardId || offer.card_id || '');
                const path = rewriteCanonicalCardPath(
                  offer.canonicalPath || offer.canonical_path || '',
                  cardId,
                  lang,
                );
                const enriched = {
                  ...offer,
                  canonicalPath: path || offer.canonicalPath || '',
                };
                const cardStub = {
                  id: cardId,
                  name: offer.cardName || offer.name || 'Card',
                  canonicalPath: path || `/marketplace/${lang || 'en'}/cards/${cardId}`,
                };
                return (
                  <ShopListingRow
                    key={offer.id || `${cardId}-${index}`}
                    offer={enriched}
                    card={cardStub}
                    showCard
                    selected={selected.has(listingSelectId(enriched))}
                    dragOffers={shopDragOffers(listings, selected, enriched)}
                    onCart={(qty) => {
                      if (!cardId || !offer.id) return;
                      const item = cartItemFromOffer(cardStub, enriched);
                      addItem(qty ? { ...item, qty } : item);
                    }}
                    onBuy={(qty) => {
                      if (!cardId || !offer.id) return;
                      const item = cartItemFromOffer(cardStub, enriched);
                      addItem(qty ? { ...item, qty } : item);
                      navigate('/cart');
                    }}
                  />
                );
              })}
            </ShopList>
          ) : !loading ? (
            <EmptyDesk title="No listings" lede={`${display} has no live asks for these filters.`} />
          ) : null}

          {totalItems > PAGE_SIZE ? (
            <div className="seller-pager">
              <button
                type="button"
                className="btn ghost"
                disabled={safePage <= 1 || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </button>
              <span className="seller-pager-status">
                Page {safePage} / {totalPages}
              </span>
              <button
                type="button"
                className="btn ghost"
                disabled={safePage >= totalPages || loading}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
