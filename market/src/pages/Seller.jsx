import { useEffect, useMemo, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { fetchSellerByUsername } from '../api.js';
import ShopListingRow from '../components/ShopListing.jsx';
import { Alert, EmptyDesk, Metric, MetricGrid } from '../components/Desk.jsx';
import { peekHasListingRows, peekSellerListings } from '../listings-cache.js';
import {

const PAGE_SIZE = 100;
const FETCH_LIMIT = 1000;

const CONDITION_FILTERS = [
  { value: "", label: "Any condition" },
  { value: "NM", label: "Near Mint" },
  { value: "SP", label: "Slightly Played" },
  { value: "MP", label: "Moderately Played" },
  { value: "PL", label: "Played" },
  { value: "Poor", label: "Poor" },
];

const LANG_FILTERS = ["", "EN", "IT", "JP", "DE", "FR", "ES", "KR", "PT", "NL", "PL", "RU", "ZH"];

function sellerDisplayName(offer, fallback) {
  return String(offer?.sellerName || offer?.sellerDisplayName || fallback || "").trim();
}

function conditionCode(value) {
  const e = String(value || "").toUpperCase();
  if (e.includes("NEAR") || e === "NM") return "NM";
  if (e.includes("SLIGHT") || e === "SP") return "SP";
  if (e.includes("MODERATE") || e === "MP") return "MP";
  if (e.includes("PLAYED") || e === "PL") return "PL";
  if (e.includes("POOR")) return "Poor";
  return e;
}

function matchesQuery(offer, q) {
  if (!q) return true;
  const hay = [
    offer?.cardName,
    offer?.name,
    offer?.setName,
    offer?.collectorNumber,
    offer?.condition,
    offer?.language,
  ]
    .map((x) => String(x || "").toLowerCase())
    .join(" ");
  return hay.includes(q);
}

function sortOffers(list, sort) {
  const rows = [...(list || [])];
  if (sort === "price-desc") rows.sort((a, b) => Number(b.pricePkn || 0) - Number(a.pricePkn || 0));
  else if (sort === "qty") {
    rows.sort((a, b) => Number(b.quantityAvailable || 0) - Number(a.quantityAvailable || 0));
  } else if (sort === "name") {
    rows.sort((a, b) =>
      String(a.cardName || a.name || "").localeCompare(String(b.cardName || b.name || "")),
    );
  } else rows.sort((a, b) => Number(a.pricePkn || 0) - Number(b.pricePkn || 0));
  return rows;
}

function isOneDayReady(offer) {
  return Boolean(
    offer?.oneDayReady ||
      offer?.one_day_ready ||
      offer?.shippingMode === "one_day_ready" ||
      /1-?day/i.test(String(offer?.sellerName || offer?.sellerDisplayName || "")),
  );
}

export default function Seller() {
  const { username: raw = "" } = useParams();
  const username = decodeURIComponent(String(raw || "").trim());

  const [listings, setListings] = useState(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [condition, setCondition] = useState("");
  const [language, setLanguage] = useState("");
  const [sort, setSort] = useState("price-asc");
  const [page, setPage] = useState(1);

  useEffect(() => {
    document.title = `${username} · Pokoin`;
    if (!username) return undefined;
    let cancelled = false;
    setError("");
    fetchSellerByUsername(username, { limit: FETCH_LIMIT })
      .then((payload) => {
        if (!cancelled) setListings(payload?.listings || payload?.items || []);
      })
      .catch((err) => {
        if (!cancelled) {
          setListings([]);
          setError(err?.message || "Seller not found.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [username]);

  const first = listings?.[0];
  const displayName = sellerDisplayName(first, username) || username;
  const country = first?.sellerCountry;
  const ready = Boolean(listings?.some(isOneDayReady));

  const uniqueCount = useMemo(() => {
    const ids = new Set((listings || []).map((row) => String(row.cardId || row.card_id || "")));
    ids.delete("");
    return ids.size;
  }, [listings]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = (listings || []).filter((offer) => matchesQuery(offer, q));
    if (condition) rows = rows.filter((offer) => conditionCode(offer?.condition) === condition);
    if (language) {
      rows = rows.filter((offer) => String(offer?.language || "").toUpperCase().startsWith(language));
    }
    return sortOffers(rows, sort);
  }, [listings, query, condition, language, sort]);

  const totalFiltered = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / PAGE_SIZE) || 1);
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startIdx = totalFiltered ? (safePage - 1) * PAGE_SIZE : 0;
  const endIdx = Math.min(startIdx + PAGE_SIZE, totalFiltered);
  const pageRows = filtered.slice(startIdx, endIdx);

  useEffect(() => {
    setPage(1);
  }, [query, condition, language, sort, username]);

  if (listings && !listings.length && error) {
    return (
      <div className="page desk seller-page">
        <h1 className="page-title">Seller not found</h1>
        <p className="page-lede">{error}</p>
        <p className="status">Usernames match live native listings.</p>
      </div>
    );
  }

  return (
    <div className="page desk seller-page seller-shop-ct">
      <header className="seller-hero seller-hero-ct">
        <span className="seller-avatar" aria-hidden="true">
          {(displayName || "?").slice(0, 1).toUpperCase()}
        </span>
        <div className="seller-id">
          <p className="page-kicker">Seller</p>
          <h1 className="page-title">{displayName}</h1>
          <div className="seller-hero-meta">
            {country ? (
              <p className="seller-country">
                <span>({String(country).toUpperCase()})</span>
              </p>
            ) : null}
            {ready ? <span className="seller-badge seller-badge-ready">1-Day Ready</span> : null}
          </div>
        </div>
      </header>

      {listings ? (
        <div className="metric-grid">
          <div className="metric">
            <strong className="metric-value">{listings.length}</strong>
            <span className="metric-label">Total items</span>
          </div>
          <div className="metric">
            <strong className="metric-value">{uniqueCount}</strong>
            <span className="metric-label">Unique items</span>
          </div>
        </div>
      ) : (
        <p className="status">Loading listings…</p>
      )}

      {error && listings?.length ? <p className="status">{error}</p> : null}

      {listings?.length ? (
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
                  <option key={opt.value || "any"} value={opt.value}>
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
                  <option key={code || "any"} value={code}>
                    {code || "Any language"}
                  </option>
                ))}
              </select>
              <label className="sort">
                Sort
                <select value={sort} onChange={(e) => setSort(e.target.value)}>
                  <option value="price-asc">Price ↑</option>
                  <option value="price-desc">Price ↓</option>
                  <option value="name">Name</option>
                  <option value="qty">Quantity</option>
                </select>
              </label>
            </div>
          </div>

          <p className="result-count seller-result-count">
            {totalFiltered === 0 ? (
              <>
                No matches in <strong>{listings.length}</strong> listings
              </>
            ) : (
              <>
                Showing{" "}
                <strong>
                  {startIdx + 1}–{endIdx}
                </strong>{" "}
                of <strong>{totalFiltered}</strong>
                {totalFiltered !== listings.length ? <> (filtered from {listings.length})</> : null}
              </>
            )}
          </p>

          <div className="shop-list seller-shop-list">
            {pageRows.map((offer, idx) => (
              <ShopListingRow
                key={offer.id || `${offer.cardId}-${idx}`}
                offer={offer}
                showCard
              />
            ))}
          </div>

          {totalPages > 1 ? (
            <nav className="seller-pager" aria-label="Shop pages">
              <button
                type="button"
                className="btn ghost"
                disabled={safePage <= 1}
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
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </button>
            </nav>
          ) : null}
        </section>
      ) : listings ? (
        <div className="empty-state">
          <h2>No listings</h2>
          <p className="page-lede">{displayName} has no live asks.</p>
        </div>
      ) : null}
    </div>
  );
}
