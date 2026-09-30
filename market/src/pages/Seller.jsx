import { useEffect, useMemo, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
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
  sellerCountryShort,
  sellerHandle,
} from '../listing-meta.js';
import { seedSellerListings } from '../seller-seed.js';
import { game } from '../game.js';
import { associateRoleLabel } from '../associate-roles.js';

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

const RARITY_FILTERS = [
  { value: '', label: 'Any rarity' },
  { value: 'holo', label: 'Holo' },
  { value: 'common', label: 'Common' },
  { value: 'uncommon', label: 'Uncommon' },
  { value: 'rare', label: 'Rare' },
  { value: 'ultra', label: 'Ultra Rare' },
  { value: 'illustration', label: 'Illustration Rare' },
  { value: 'secret', label: 'Secret Rare' },
];

function ShopToggle({ label, pressed, onToggle }) {
  return (
    <button
      type="button"
      className={`shop-toggle${pressed ? ' on' : ''}`}
      aria-pressed={pressed}
      onClick={() => onToggle(!pressed)}
    >
      {label}
    </button>
  );
}
function isOneDayReady(offer) {
  return Boolean(
    offer?.oneDayReady ||
      offer?.one_day_ready ||
      offer?.shippingMode === 'one_day_ready' ||
      /1-?day/i.test(String(offer?.sellerName || offer?.sellerDisplayName || '')),
  );
}

function sellerFromPayload(data, handle, sample) {
  const row = data?.seller && typeof data.seller === 'object' ? data.seller : null;
  const username = String(row?.username || sellerHandle(sample) || handle || '')
    .trim()
    .replace(/^@/, '');
  const rawName = String(row?.displayName || publicListingSellerName(sample, username || handle) || '')
    .trim();
  const displayName = rawName && !rawName.includes('@') ? rawName : (username || handle);
  const associateRow = row?.associate && typeof row.associate === 'object' ? row.associate : null;
  const associateRole = String(associateRow?.role || '').trim().toLowerCase();
  return {
    uid: row?.uid || sample?.sellerUid || '',
    username,
    displayName,
    associate: associateRole ? { role: associateRole, displayName: String(associateRow.displayName || '').trim() } : null,
  };
}

export default function Seller() {
  const { username = '', lang: routeLang } = useParams();
  const { addItem } = useCart();
  const { user, profile } = useAuth();
  const lang = routeLang || getSearchLang();
  const handle = decodeURIComponent(String(username || '').trim());
  const selectedGame = game().apiGame;
  const seeded = seedSellerListings(handle, {
    pageSize: PAGE_SIZE,
    sort: 'price-asc',
    game: selectedGame,
  });

  const [listings, setListings] = useState(() => seeded?.listings ?? null);
  const [total, setTotal] = useState(() => seeded?.total ?? null);
  const [unique, setUnique] = useState(() => seeded?.unique ?? null);
  const [seller, setSeller] = useState(() => seeded?.seller ?? {
    uid: '',
    username: handle,
    displayName: handle,
  });
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [condition, setCondition] = useState('');
  const [language, setLanguage] = useState('');
  const [rarity, setRarity] = useState('');
  const [reverse, setReverse] = useState(false);
  const [firstEdition, setFirstEdition] = useState(false);
  const [sort, setSort] = useState('price-asc');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(!seeded);

  useEffect(() => {
    setPage(1);
  }, [query, condition, language, rarity, reverse, firstEdition, sort, handle, selectedGame]);

  useEffect(() => {
    document.title = `${seller.displayName || handle} · Pokoin`;
  }, [seller.displayName, handle]);

  useEffect(() => {
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
      rarity,
      reverse,
      firstEdition,
      sort,
      game: selectedGame,
    })
      .then((data) => {
        if (cancelled) return;
        const rows = data.listings || data.items || [];
        setListings(rows);
        setSeller(sellerFromPayload(data, handle, rows[0]));
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
  }, [handle, page, query, condition, language, rarity, reverse, firstEdition, sort, selectedGame]);

  const sample = listings?.[0];
  const display = seller.displayName || publicListingSellerName(sample, handle);
  const tag = seller.username || sellerHandle(sample) || handle;
  const showTag = tag && tag.toLowerCase() !== String(display || '').toLowerCase();
  const country = sellerCountryFlag(sample?.sellerCountry);
  const countryShort = sellerCountryShort(sample?.sellerCountry);
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

  // Your own shop is managed in MyPokoin, not bought from.
  const ownHandle = String(profile?.username || '').trim().toLowerCase();
  const isOwnShop = Boolean(
    (ownHandle && ownHandle === handle.replace(/^@/, '').toLowerCase())
    || (user?.uid && seller.uid && seller.uid === user.uid),
  );
  if (isOwnShop) return <Navigate to="/mypokoin" replace />;

  return (
    <div className="page desk seller-page seller-shop-ct">
      <header className="seller-hero seller-hero-ct">
        <span className="seller-avatar" aria-hidden="true">
          {(display || '?').slice(0, 1).toUpperCase()}
        </span>
        <div className="seller-id">
          <p className="page-kicker">Seller</p>
          <h1 className="page-title">
            {display}
            {seller.associate?.role ? (
              <span className={`seller-associate-badge is-${seller.associate.role}`}>{associateRoleLabel(seller.associate.role)}</span>
            ) : null}
          </h1>
          {showTag ? <p className="seller-handle">@{tag}</p> : null}
          <div className="seller-hero-meta">
            {country && countryShort ? (
              <p className="seller-country">
                {country.emoji ? (
                  <span aria-hidden="true">{country.emoji}</span>
                ) : country.src ? (
                  <img src={country.src} alt="" width="22" height="22" />
                ) : null}
                <span>({countryShort})</span>
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
              <select
                aria-label="Rarity"
                value={rarity}
                onChange={(e) => setRarity(e.target.value)}
              >
                {RARITY_FILTERS.map((opt) => (
                  <option key={opt.value || 'any-rarity'} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <ShopToggle label="Reverse" pressed={reverse} onToggle={setReverse} />
              <ShopToggle label="1st Ed." pressed={firstEdition} onToggle={setFirstEdition} />
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
            <ShopList className="seller-shop-list" offers={listings}>
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
                  imageUrl: offer.cardImageUrl || offer.imageUrl || offer.image_url || '',
                  homepageImageUrl: offer.homepageImageUrl || offer.homepage_image_url || '',
                  gridImageUrl: offer.gridImageUrl || offer.grid_image_url || '',
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
