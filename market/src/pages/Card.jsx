import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  artistHref,
  artistSlug,
  fetchArtistSummaries,
  versionsHref,
  cardHref,
  cardtraderPublicUrl,
  cancelListing,
  createListing,
  updateListing,
  dropListing,
  fetchSellerListings,
  fetchSellerSettings,
  saveSellerSettings,
  cardFromCatalogRow,
  fetchCard,
  fetchCardSales,
  fetchCanonicalPath,
  fetchClientCountry,
  ebayHref,
  fetchCardmarketRedirect,
  fetchCardtraderRedirect,
  fetchTcgplayerRedirect,
  fetchExactNameCards,
  fetchListings,
  fetchPrintNationality,
  fetchVersionSet,
  formatPkn,
  formatPknNumber,
  imageSrc,
  invalidateListings,
  mergeCreatedListing,
  omitListings,
  peekCard,
  peekCanonicalPath,
  peekHasListingRows,
  peekListings,
  rememberCreatedListing,
  neighborsOrPeek,
  peekRecentTile,
  postWatchlist,
  publicCardId,
  rememberCardId,
  rememberNeighbors,
  setSlug,
  toggleWatchlist,
  tcgplayerSearchHref,
  unlockSilver,
  warmupCard,
  warmupNeighbors,
  readWatchlistIds,
  vintedHref,
} from '../api.js';
import { applyListingLive, subscribeListingLive } from '../listing-live.js';
import { suggestPriceFromSlices } from '../scan-pricing.js';
import { getChatDock } from '../chat-dock-store.js';
import { bundleReference, cardsReference, preloadDragImage, referenceForPeer, writeListingDrag } from '../chat-listing.js';
import CardSelectGrid, { useCardSelect } from '../components/CardSelectGrid.jsx';
import { expansionLogoSrc } from '../set-logos.js';
import {
  activeSoldIndex,
  formatSoldAxisTick,
  formatSoldDay,
  isSoldGraphClick,
  nearestSoldIndex,
  soldDateLocale,
  soldGraphScale,
  soldGraphTipMods,
  soldGraphY,
  soldConditionLabel,
  soldGraphTone,
  soldLanguageLabel,
  soldFilterValue,
  soldFilterShowsAll,
  soldUnitCount,
  formatSoldSampleCount,
  SOLD_GRAPH_PAD,
} from '../sold-graph.js';
import { soldGraphView, soldTraitsForGraphDay } from '../sold-sales.js';
import NativeSales from '../components/NativeSales.jsx';
import {
  albumShade,
  cardShadeStyle,
  deskTheme,
  deskThemeVars,
  rarityDeskVars,
  peekDeskIdentity,
  rememberCardBucket,
  rememberDeskIdentity,
} from '../art-shade.js';
import { rarityKindLabel, storedRarityKind } from '../rarity-theme.js';
import { peekCardSales, rememberStaleCardSales, saveCardSales } from '../sold-sales-cache.js';
import { authFrom } from '../punchouts.js';
import AuthLink from '../components/AuthLink.jsx';
import { useAuth } from '../auth.jsx';
import { saveListingPhotos, uploadChatPhoto } from '../chat-client.js';
import { MAX_LISTING_PHOTOS, photoFileToJpeg } from '../user-photos.js';
import { cartItemFromOffer, useCart } from '../cart.jsx';
import { deskClipCandidates, deskSetShortcuts, deskShowMoreVersions, mergePrintingRows, rarityVersions, versionOptionLabel } from '../card-versions.js';
import { cardDocumentTitle, cardmarketSearchUrl, displayName, printingIdentity } from '../identity.js';
import { game, publicGamePath } from '../game.js';
import { defaultCardLanguage, flagSrc, getSearchLang, languagesForNationality } from '../locale.js';
import { sellLanguages, versionRedirects } from '../listing-languages.js';
import ListingLangPick from '../components/ListingLangPick.jsx';
import { SILVER_PRICE_PKN } from '../silver.js';
import ExpansionMark from '../components/ExpansionMark.jsx';
import { Action, track } from '../track.js';
import { LIST_CURRENCIES, fiatFromPkn, listingPriceToPkn } from '../pkn.js';
import { cardStubFromRoute, mergeDeskCard, realPublicCardId } from '../card-stub.js';
import { clearActiveDeskCard, setActiveDeskCard } from '../poko-chat.js';
import CardArt from '../components/CardArt.jsx';
import { isLandscapePrintName } from '../art-cut-landscape.js';
import RelatedCards from '../components/RelatedCards.jsx';
import { preloadRelatedThumbs, relatedFromPage } from '../related-cards.js';
import { ShipFromCountryGate } from '../components/SellerShippingSettings.jsx';
import { useSellerCurrency } from '../use-seller-currency.js';
import { formatListingPrice, formatSellerPrice, priceInputFromPkn } from '../seller-currency.js';
import { useBuyerCurrency } from '../use-buyer-currency.js';
import { currencyFromSearch } from '../pkn.js';
import PriceStack from '../components/PriceStack.jsx';
import InventoryTargets from '../components/InventoryTargets.jsx';
import SeoCrumbs from '../components/SeoCrumbs.jsx';
import SeoHead from '../components/SeoHead.jsx';
import { tcgEra, eraHref } from '../set-logos.js';
import { speciesFromCard, pokemonHref } from '../pokemon-hubs.js';
import ShopList from '../components/ShopList.jsx';
import ShopListingRow from '../components/ShopListing.jsx';
import { listingSelectId, shopDragOffers } from '../shop-marquee.js';
import { readDealLanguage, resolveDealLanguage, writeDealLanguage } from '../deal-pref.js';
import { conditionChipSrc, publicListingSellerName, sellerHref } from '../listing-meta.js';
import { listingBox, liveInventoryListings, recentBoxes } from '../inventory-listings.js';
import { listingExtraChips, listingFoilOptions } from '../listing-faces.js';
import { game as currentGame } from '../game.js';
import {
  CONDITIONS,
  DEAL_CONDS,
  MOOD_CONDS,
  blankListingForm,
  canUseNativeShare,
  canonicalTarget,
  catalogPrintings,
  copyText,
  formatChange72h,
  listedDealConditions,
  listedDealLanguages,
  listingFormFromOffer,
  matchDeal,
  moodCondition,
  nextBoxLocation,
  pricedOffers,
  sortOffers,
} from '../card-desk.js';
import {
  breadcrumbJsonLd,
  cardImageAlt,
  cardSeoDescription,
  languageHrefFromNationality,
  pickRelatedCards,
  productJsonLd,
  rarityHref,
} from '../seo.js';

function stopSoldPointer(event) {
  event.stopPropagation();
}

function SoldGraphFilter({
  label,
  allLabel,
  options,
  value,
  onChange,
  encode = (opt) => opt,
  optionLabel = (opt) => opt,
}) {
  if (!options.length) {
    return null;
  }
  const showAll = soldFilterShowsAll(options);
  return (
    <select
      aria-label={label}
      className={showAll ? undefined : 'is-solo'}
      value={soldFilterValue(options, value, encode)}
      onChange={(event) => onChange(event.target.value)}
    >
      {showAll ? <option value="">{allLabel}</option> : null}
      {options.map((opt) => (
        <option key={String(opt)} value={encode(opt)}>
          {optionLabel(opt)}
        </option>
      ))}
    </select>
  );
}

function SoldGraphToggle({ label, pressed, onToggle }) {
  return (
    <button
      type="button"
      className={pressed ? 'on' : undefined}
      aria-pressed={pressed}
      onClick={() => onToggle(!pressed)}
    >
      {label}
    </button>
  );
}

function SoldGraphFilters({
  conditions,
  languages,
  chips,
  condition,
  language,
  reverse,
  firstEdition,
  graded,
  unitsLabel,
  onCondition,
  onLanguage,
  onReverse,
  onFirstEdition,
  onGraded,
}) {
  // A foil chip plots nothing when the printing never sold that variant, so it
  // only renders when the flagged variant exists in the sold slices.
  if (!conditions.length && !languages.length && !chips.reverse && !chips.firstEdition && !chips.graded) {
    return null;
  }
  return (
    <div
      className="sold-graph-filters"
      onPointerDown={stopSoldPointer}
      onPointerMove={stopSoldPointer}
      onPointerUp={stopSoldPointer}
    >
      {chips.reverse ? (
        <SoldGraphToggle
          label="Reverse"
          pressed={reverse}
          onToggle={onReverse}
        />
      ) : null}
      {chips.firstEdition ? (
        <SoldGraphToggle
          label="1st Ed."
          pressed={firstEdition}
          onToggle={onFirstEdition}
        />
      ) : null}
      {chips.graded ? (
        <SoldGraphToggle
          label="Graded"
          pressed={graded}
          onToggle={onGraded}
        />
      ) : null}
      <SoldGraphFilter
        label="Sold condition"
        allLabel="All conditions"
        options={conditions}
        value={condition}
        onChange={onCondition}
        optionLabel={soldConditionLabel}
      />
      <SoldGraphFilter
        label="Sold language"
        allLabel="All languages"
        options={languages}
        value={language}
        onChange={onLanguage}
        optionLabel={soldLanguageLabel}
      />
      {unitsLabel ? <p className="sold-graph-units">{unitsLabel}</p> : null}
    </div>
  );
}

function SoldPriceGraph({
  series,
  filters,
  chips,
  condition,
  language,
  reverse,
  firstEdition,
  graded,
  onCondition,
  onLanguage,
  onReverse,
  onFirstEdition,
  onGraded,
  onPickDay,
  formatPrice,
}) {
  const wrapRef = useRef(null);
  const touchPointerActiveRef = useRef(false);
  const pointerStartRef = useRef(null);
  const [size, setSize] = useState(null);
  const [hover, setHover] = useState(null);
  const days = Array.isArray(series?.days) ? series.days : [];
  const unitCount = Number(series?.soldQty) > 0
    ? Math.trunc(Number(series.soldQty))
    : (Number(series?.sampleCount) > 0
      ? Math.trunc(Number(series.sampleCount))
      : soldUnitCount(days));
  const unitsLabel = unitCount > 0 ? formatSoldSampleCount(unitCount) : '';
  const conditions = Array.isArray(filters?.conditions) ? filters.conditions : [];
  const languages = Array.isArray(filters?.languages) ? filters.languages : [];
  const chipFlags = chips || {};
  const tone = soldGraphTone(soldFilterValue(conditions, condition));
  const graphClass = `panel sold-graph is-${tone}`;
  const filterBar = (
    <SoldGraphFilters
      conditions={conditions}
      languages={languages}
      chips={chipFlags}
      condition={condition}
      language={language}
      reverse={reverse}
      firstEdition={firstEdition}
      graded={graded}
      unitsLabel={unitsLabel}
      onCondition={onCondition}
      onLanguage={onLanguage}
      onReverse={onReverse}
      onFirstEdition={onFirstEdition}
      onGraded={onGraded}
    />
  );
  useLayoutEffect(() => {
    const node = wrapRef.current;
    if (!node) {
      return undefined;
    }
    const apply = (width, height) => {
      const w = Math.max(240, Math.round(width));
      const h = Math.max(120, Math.round(height));
      setSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    apply(node.clientWidth, node.clientHeight);
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) {
        apply(rect.width, rect.height);
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [days.length]);
  if (!days.length) {
    return (
      <section
        className={graphClass}
        aria-label="Daily sold median"
        aria-busy={series == null || undefined}
      >
        {filterBar}
        {series == null ? null : (
          <p className="sold-graph-empty">No sold-card analytics yet for this printing.</p>
        )}
      </section>
    );
  }
  if (!size) {
    return (
      <section ref={wrapRef} className={graphClass} aria-label="Daily sold median">
        {filterBar}
      </section>
    );
  }
  const width = size.w;
  const height = size.h;
  const pad = SOLD_GRAPH_PAD;
  const values = days.map((row) => Number(row.medianPkn) || 0);
  const scale = soldGraphScale(Math.max(0, ...values));
  const start = Date.parse(`${days[0].day}T00:00:00Z`);
  const end = Date.parse(`${days[days.length - 1].day}T00:00:00Z`);
  const range = Math.max(1, end - start);
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const dateLocale = soldDateLocale();
  const points = days.map((row) => {
    const x = pad.l + (days.length === 1 || range <= 1
      ? plotW / 2
      : ((Date.parse(`${row.day}T00:00:00Z`) - start) / range) * plotW);
    const y = soldGraphY(row.medianPkn, scale.max, pad.t, plotH);
    return [x, y];
  });
  const line = points.map(([x, y]) => `${x},${y}`).join(' ');
  const area = `${pad.l},${pad.t + plotH} ${line} ${pad.l + plotW},${pad.t + plotH}`;
  const first = days[0];
  const last = days[days.length - 1];
  const firstLabel = formatSoldDay(first.day, dateLocale);
  const lastLabel = formatSoldDay(last.day, dateLocale);
  const hoverIndex = activeSoldIndex(hover, days.length);
  const active = hoverIndex == null ? null : days[hoverIndex];
  const activePt = hoverIndex == null ? null : points[hoverIndex];
  const tipMods = activePt ? soldGraphTipMods(activePt[0], activePt[1], width, pad) : [];
  const price = active
    ? ((formatPrice ? formatPrice(active.medianPkn) : formatPkn(active.medianPkn)) || '0 PKN')
    : '';
  const hoverLabel = active ? formatSoldDay(active.day, dateLocale) : '';

  function hoverFromPointer(event) {
    const node = wrapRef.current;
    const rect = node?.getBoundingClientRect();
    if (!rect?.width) {
      return;
    }
    const x = ((event.clientX - rect.left) / rect.width) * width;
    setHover(nearestSoldIndex(points.map(([px]) => px), x));
  }

  function beginHover(event) {
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
    if (event.pointerType === 'touch') {
      touchPointerActiveRef.current = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    hoverFromPointer(event);
  }

  function pickDayFromPointer(event) {
    if (!onPickDay || !isSoldGraphClick(pointerStartRef.current, event)) {
      return;
    }
    const node = wrapRef.current;
    const rect = node?.getBoundingClientRect();
    if (!rect?.width) {
      return;
    }
    const x = ((event.clientX - rect.left) / rect.width) * width;
    const index = nearestSoldIndex(points.map(([px]) => px), x);
    const day = days[index]?.day;
    if (day) {
      onPickDay(day);
    }
  }

  function moveHover(event) {
    if (event.pointerType === 'touch' && !touchPointerActiveRef.current) {
      return;
    }
    hoverFromPointer(event);
  }

  function clearHover(event) {
    pointerStartRef.current = null;
    if (!event || event.pointerType === 'touch') {
      touchPointerActiveRef.current = false;
    }
    setHover(null);
  }

  return (
    <section
      ref={wrapRef}
      className={graphClass}
      aria-label="Daily sold median"
      onPointerMove={moveHover}
      onPointerDown={beginHover}
      onPointerUp={(event) => {
        pickDayFromPointer(event);
        pointerStartRef.current = null;
        if (event.pointerType === 'touch') {
          clearHover(event);
        }
      }}
      onPointerLeave={clearHover}
      onPointerCancel={clearHover}
    >
      {filterBar}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden="true"
      >
        {scale.ticks.map((tick) => {
          const y = soldGraphY(tick, scale.max, pad.t, plotH);
          return (
            <g key={tick}>
              <line
                x1={pad.l}
                x2={pad.l + plotW}
                y1={y}
                y2={y}
                className="sold-graph-grid"
              />
              <text
                x={pad.l - 4}
                y={y + 3}
                textAnchor="end"
                className="sold-graph-axis"
              >
                {formatSoldAxisTick(tick)}
              </text>
            </g>
          );
        })}
        <polygon points={area} className="sold-graph-fill" />
        <polyline points={line} className="sold-graph-line" />
        {activePt ? (
          <line
            x1={activePt[0]}
            x2={activePt[0]}
            y1={pad.t}
            y2={pad.t + plotH}
            className="sold-graph-guide"
          />
        ) : null}
        {points.map(([x, y], index) => (
          <circle
            key={days[index].day}
            cx={x}
            cy={y}
            r={index === hoverIndex ? 4.4 : (days.length === 1 ? 3.5 : 2.4)}
            className={index === hoverIndex ? 'sold-graph-dot is-active' : 'sold-graph-dot'}
          />
        ))}
        <text x={pad.l} y={height - 7} className="sold-graph-axis">{firstLabel}</text>
        <text x={width - 8} y={height - 7} textAnchor="end" className="sold-graph-axis">{lastLabel}</text>
        <rect x="0" y="0" width={width} height={height} className="sold-graph-hit" />
      </svg>
      {activePt ? (
        <div
          className={['sold-graph-tip', ...tipMods].join(' ')}
          style={{
            left: `${(activePt[0] / width) * 100}%`,
            top: `${(activePt[1] / height) * 100}%`,
          }}
          role="status"
        >
          <strong>{price}</strong>
          <span>{hoverLabel}</span>
          {Number(active.soldQty || active.sampleCount) > 0
            ? <span>{formatSoldSampleCount(active.soldQty || active.sampleCount)}</span>
            : null}
          {active.comments?.[0] ? <em>{active.comments[0]}</em> : null}
        </div>
      ) : null}
    </section>
  );
}

function ConditionPick({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const current = MOOD_CONDS.find((row) => row.value === value) || MOOD_CONDS[0];

  useEffect(() => {
    if (!open) return undefined;
    function onDoc(event) {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    }
    function onKey(event) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={`lang-pick${open ? ' is-open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="lang-pick-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Condition ${current.label}`}
        onClick={() => setOpen((next) => !next)}
      >
        <img
          className="shop-cond"
          src={conditionChipSrc(current.value)}
          alt=""
          width="40"
          height="28"
          draggable={false}
        />
      </button>
      {open ? (
        <ul className="lang-pick-menu" role="listbox" aria-label="Condition">
          {MOOD_CONDS.map((row) => (
            <li key={row.value}>
              <button
                type="button"
                role="option"
                aria-selected={row.value === value}
                aria-label={row.label}
                onClick={() => {
                  setOpen(false);
                  onChange(row.value);
                }}
              >
                <img
                  className="shop-cond"
                  src={conditionChipSrc(row.value)}
                  alt=""
                  width="40"
                  height="28"
                  draggable={false}
                />
                {row.value === value ? <em aria-hidden="true">✓</em> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path fill="currentColor" d="M9 4.5 7.8 6.5H5A2.5 2.5 0 0 0 2.5 9v9A2.5 2.5 0 0 0 5 20.5h14a2.5 2.5 0 0 0 2.5-2.5V9A2.5 2.5 0 0 0 19 6.5h-2.8L14.9 4.5H9Zm3 12.2a3.7 3.7 0 1 1 0-7.4 3.7 3.7 0 0 1 0 7.4Z" />
    </svg>
  );
}

function ListingForm({
  card,
  identity,
  salesSlices,
  fromPath,
  onListed,
  preferredLanguage,
  preferredCondition,
  versions = [],
  editing = null,
  onCancelEdit,
}) {
  const navigate = useNavigate();
  const { signedIn, ready, sellerName, user, getBearer } = useAuth();
  const formRef = useRef(null);
  const gameId = currentGame().id;
  const foils = listingFoilOptions(gameId);
  const listChips = listingExtraChips(gameId);
  const blank = blankListingForm(card);
  const [price, setPrice] = useState(blank.price);
  const priceManual = useRef(Boolean(editing?.id));
  const priceFocused = useRef(false);
  const [currency, setCurrency] = useState(blank.currency);
  // Sellers who opted out of PKN payments list in their local currency.
  const { currency: sellerCurrency } = useSellerCurrency();
  const sellerCurrencyRef = useRef(sellerCurrency);
  sellerCurrencyRef.current = sellerCurrency;
  const currencyManual = useRef(false);
  const [qty, setQty] = useState(blank.qty);
  const [condition, setCondition] = useState(blank.condition);
  const [language, setLanguage] = useState(blank.language);
  const [foil, setFoil] = useState(blank.foil);
  const [chips, setChips] = useState(blank.chips);
  const [comment, setComment] = useState(blank.comment);
  const [box, setBox] = useState('');
  const [stockRows, setStockRows] = useState([]);
  const [stockReady, setStockReady] = useState(false);
  const boxTouched = useRef(false);
  const [photos, setPhotos] = useState(() => (Array.isArray(editing?.photoUrls) ? editing.photoUrls.slice(0, MAX_LISTING_PHOTOS) : []));
  const [company, setCompany] = useState(blank.company);
  const [grade, setGrade] = useState(blank.grade);
  const [cert, setCert] = useState(blank.cert);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [jump, setJump] = useState(null);
  const [shipFromCountry, setShipFromCountry] = useState('');
  const [shipGateOpen, setShipGateOpen] = useState(false);
  const [shipGateDraft, setShipGateDraft] = useState('');
  const listLangs = sellLanguages({
    nationality: card.nationality,
    setName: identity?.set || card.set,
    releaseLanguages: card.releaseLanguages,
  });
  const redirects = versionRedirects(versions, card.id, listLangs, {
    nationality: card.nationality,
  });
  const langKey = listLangs.join(',');
  const editingId = editing?.id || '';
  const isEditing = Boolean(editingId);

  function applyFields(next) {
    const listIn = currencyManual.current ? next.currency : sellerCurrencyRef.current;
    setPrice(listIn === next.currency || !next.price
      ? next.price
      : priceInputFromPkn(listingPriceToPkn(next.price, next.currency), listIn));
    setCurrency(listIn);
    setQty(next.qty);
    setCondition(next.condition);
    setLanguage(next.language);
    setFoil(next.foil);
    setChips(next.chips);
    setComment(next.comment);
    setCompany(next.company);
    setGrade(next.grade);
    setCert(next.cert);
    setError('');
    setDone('');
  }

  useEffect(() => {
    if (editingId) {
      applyFields(listingFormFromOffer(editing, card));
      priceManual.current = true;
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    priceManual.current = false;
    applyFields(blankListingForm(card));
  }, [card.id, editingId]);

  useEffect(() => {
    if (editingId) {
      return;
    }
    if (preferredLanguage && listLangs.includes(preferredLanguage)) {
      setLanguage(preferredLanguage);
      return;
    }
    setLanguage((current) => (
      listLangs.includes(current) ? current : (listLangs[0] || defaultCardLanguage(card.nationality))
    ));
  }, [preferredLanguage, langKey, editingId]);

  useEffect(() => {
    if (editingId || !preferredCondition) {
      return;
    }
    setCondition(preferredCondition);
  }, [preferredCondition, editingId]);

  const graphPkn = suggestPriceFromSlices(salesSlices, {
    condition,
    language,
    reverse: foil === 'reverse',
    firstEdition: chips.firstEd,
  });
  const graphPrice = graphPkn > 0
    ? (currency === 'PKN'
      ? formatPknNumber(Math.round(graphPkn), { maximumFractionDigits: 0 })
      : formatPknNumber(fiatFromPkn(graphPkn, currency), { maximumFractionDigits: 2 }))
    : '';

  useEffect(() => {
    if (editingId || priceManual.current || priceFocused.current || !graphPrice) return;
    setPrice(graphPrice);
  }, [graphPrice, editingId, card.id, currency]);

  useEffect(() => {
    // Settings arrive after first paint: switch the untouched form over.
    if (currencyManual.current || currency === sellerCurrency) return;
    if (price && priceManual.current) {
      setPrice(priceInputFromPkn(listingPriceToPkn(price, currency), sellerCurrency));
    }
    setCurrency(sellerCurrency);
  }, [sellerCurrency]); // eslint-disable-line react-hooks/exhaustive-deps

  const hint = !price && graphPrice ? graphPrice : '';
  const listedPkn = price
    ? listingPriceToPkn(price, currency)
    : listingPriceToPkn(graphPrice, currency);

  function toggleChip(key) {
    setChips((current) => ({ ...current, [key]: !current[key] }));
  }

  useEffect(() => {
    if (!signedIn) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const token = await getBearer();
        const settings = await fetchSellerSettings(token);
        if (!cancelled) setShipFromCountry(String(settings.shipFromCountry || '').toUpperCase());
      } catch (_) {
        // First listing opens the ship-from gate.
      }
    })();
    return () => { cancelled = true; };
  }, [signedIn, getBearer]);

  useEffect(() => {
    if (!signedIn || !user?.uid) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const token = await getBearer();
        const data = await fetchSellerListings(user.uid, token, { limit: 1000 });
        if (cancelled) return;
        setStockRows(liveInventoryListings(data.listings || data.items || []));
        setStockReady(true);
      } catch (_) {
        if (!cancelled) {
          setStockRows([]);
          setStockReady(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [signedIn, user?.uid, getBearer, editingId]);

  useEffect(() => {
    if (editingId) {
      const mine = stockRows.find((row) => row.id === editingId);
      setBox(listingBox(mine?.location || editing?.location || ''));
      return;
    }
    if (boxTouched.current) return;
    const first = recentBoxes(stockRows)[0] || '';
    if (first) setBox(first);
  }, [editingId, stockRows, editing?.location]);

  const boxOptions = (() => {
    const names = recentBoxes(stockRows);
    if (box && !names.some((name) => name.toLowerCase() === box.toLowerCase())) {
      return [box, ...names];
    }
    return names;
  })();
  const keptLocation = editingId
    ? (stockRows.find((row) => row.id === editingId)?.location || editing?.location || '')
    : '';
  const sameBox = box && listingBox(keptLocation).toLowerCase() === box.toLowerCase();
  const locationValue = !box ? '' : (sameBox ? keptLocation : nextBoxLocation(stockRows, box));

  async function submit(targets = { pokoin: true, cardtrader: false }) {
    if (!signedIn) {
      navigate(authFrom(fromPath));
      return;
    }
    if (!isEditing && chips.shipping && !shipFromCountry) {
      setShipGateDraft('');
      setShipGateOpen(true);
      return;
    }
    const amount = price
      ? listingPriceToPkn(price, currency)
      : listingPriceToPkn(graphPrice, currency);
    const quantity = Number.parseInt(qty, 10);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) {
      setError('Enter a valid price and quantity.');
      return;
    }
    if (chips.graded && (!company.trim() || !grade.trim() || !cert.trim())) {
      setError('Enter grading company, grade and certification ID.');
      return;
    }
    setSaving(true);
    setError('');
    setDone('');
    let pendingId = '';
    try {
      const token = await getBearer();
      if (!token) {
        navigate(authFrom(fromPath));
        return;
      }
      pendingId = isEditing ? '' : `pending-${Date.now()}`;
      if (pendingId) {
        onListed?.({
          id: pendingId,
          pending: true,
          cardId: publicCardId(card),
          sellerUid: user?.uid || '',
          sellerName,
          sellerCountry: shipFromCountry,
          pricePkn: amount,
          quantityAvailable: quantity,
          condition,
          language,
          status: 'active',
          reverse: foil === 'reverse',
          firstEdition: chips.firstEd,
          graded: chips.graded,
        });
      }
      const fields = {
        condition,
        language,
        pricePkn: amount,
        quantityAvailable: quantity,
        signed: false,
        reverse: foil === 'reverse',
        firstEdition: chips.firstEd,
        foilState: foil,
        sealed: chips.sealed,
        graded: chips.graded,
        gradingCompany: chips.graded ? company.trim() : null,
        grade: chips.graded ? grade.trim() : null,
        certificationId: chips.graded ? cert.trim() : null,
        shippingAvailable: chips.shipping,
        reserveAvailable: false,
        nftAvailable: false,
        sellerComment: comment.trim(),
        ...(!isEditing || stockReady ? { location: locationValue } : {}),
        source: 'pokoin_user_listing',
        cardName: card.name,
        cardImageUrl: card.heroImageUrl || card.imageUrl || '',
        setName: identity.set,
        collectorNumber: identity.number,
      };
      const saved = isEditing
        ? await updateListing(editingId, {
          ...fields,
          sellerUid: user?.uid || editing.sellerUid,
          status: 'active',
        }, token)
        : await createListing({
          cardId: publicCardId(card),
          sellerName,
          sellerCountry: shipFromCountry,
          shipFromCountry,
          sellerReputationLabel: 'New',
          targets: {
            pokoin: targets?.pokoin !== false,
            cardtrader: targets?.cardtrader === true,
          },
          ...fields,
        }, token);
      track(Action.sell, card);
      if (saved?.cardtrader && saved.cardtrader.ok === false) {
        setDone(isEditing ? 'Listing updated.' : 'Listed on Pokoin.');
        setError(saved.cardtrader.error || 'CardTrader push failed.');
      } else if (saved?.listing === null && saved?.cardtrader?.ok) {
        setDone('Listed on CardTrader.');
      } else {
        setDone(isEditing ? 'Listing updated.' : 'Listing created.');
      }
      if (!isEditing) {
        setQty('1');
      }
      const listingRow = saved?.id ? saved : saved?.listing;
      if (listingRow?.id && photos.length) {
        const attached = await saveListingPhotos(token, listingRow.id, photos);
        listingRow.photoUrls = attached?.photoUrls || photos;
      }
      if (listingRow?.id) {
        onListed?.(pendingId ? { ...listingRow, replaceId: pendingId } : listingRow);
      } else if (pendingId) {
        onListed?.({ remove: true, id: pendingId });
      }
    } catch (err) {
      if (pendingId) onListed?.({ remove: true, id: pendingId });
      if (err.status === 401) {
        navigate(authFrom(fromPath));
        return;
      }
      setError(err.message || (isEditing ? 'Update failed.' : 'Listing failed.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={`panel sell-form${isEditing ? ' is-editing' : ''}`} ref={formRef}>
      <div className="add-head">
        <h2>{isEditing ? 'Edit listing' : 'List your card'}</h2>
        {signedIn ? (
          <span className="seller-chip">
            {sellerName}
            {isEditing ? (
              <button type="button" className="linkish sell-cancel-edit" onClick={() => onCancelEdit?.()}>
                Cancel edit
              </button>
            ) : null}
          </span>
        ) : (
          <AuthLink className="signin-link" to={authFrom(fromPath)} onClick={() => track(Action.sell, card)}>
            Sign in
          </AuthLink>
        )}
      </div>
      <div className="sell-row">
        <label className="sell-field grow">
          Price
          <input
            inputMode="decimal"
            value={price}
            placeholder={hint}
            onFocus={() => {
              priceFocused.current = true;
              if (!priceManual.current) setPrice('');
            }}
            onBlur={() => {
              priceFocused.current = false;
              if (!priceManual.current && graphPrice) setPrice(graphPrice);
            }}
            onChange={(event) => {
              const next = event.target.value;
              setPrice(next);
              priceManual.current = next.trim() !== '';
            }}
          />
        </label>
        <label className="sell-field currency">
          Currency
          <select
            value={currency}
            onChange={(event) => {
              currencyManual.current = true;
              setCurrency(event.target.value);
            }}
          >
            {LIST_CURRENCIES.map((code) => (
              <option key={code} value={code}>{code}</option>
            ))}
          </select>
        </label>
        <label className="sell-field qty">
          Qty
          <input
            inputMode="numeric"
            value={qty}
            onChange={(event) => setQty(event.target.value)}
          />
        </label>
        {isEditing ? (
          <button
            type="button"
            className="btn list-btn"
            disabled={!ready || saving || (!signedIn && ready)}
            title={signedIn ? 'Save listing changes' : 'Sign in to list'}
            onClick={() => submit()}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        ) : null}
      </div>
      {!isEditing ? (
        <div className="sell-targets-row">
          <InventoryTargets
            mode="list"
            counts={{ cards: Number.parseInt(qty, 10) || 1 }}
            intent="list"
            disabled={!ready || (!signedIn && ready)}
            busy={saving}
            busyLabel="Listing…"
            pricePkn={listedPkn}
            onSubmit={(targets) => {
              if (!signedIn) {
                navigate(authFrom(fromPath));
                return;
              }
              submit(targets);
            }}
          />
        </div>
      ) : null}
      {sellerCurrency !== 'PKN' ? (
        <p className="sell-pkn-eq">
          {listedPkn ? `Lists at ${formatSellerPrice(listedPkn, sellerCurrency)} · ` : ''}
          Buyers pay you by card · PKN payments are off in <Link to="/profile">Profile</Link>
        </p>
      ) : currency !== 'PKN' && listedPkn ? (
        <p className="sell-pkn-eq">Lists at {formatPkn(listedPkn)}</p>
      ) : null}
      <div className="sell-options-row">
        <div className="sell-field sell-pick condition-pick">
          <span className="sr-only">Condition</span>
          <ConditionPick value={condition} onChange={setCondition} />
        </div>
        <div className="sell-field sell-pick language-pick">
          <span className="sr-only">Language</span>
          <ListingLangPick
            value={language}
            listed={listLangs}
            redirects={redirects}
            onChange={setLanguage}
            onRedirect={setJump}
          />
        </div>
        <label className="sell-field sell-pick foil-pick">
          <span className="sr-only">Finish</span>
          <select value={foil} onChange={(event) => setFoil(event.target.value)}>
            {foils.map((row) => (
              <option key={row.value} value={row.value}>{row.label}</option>
            ))}
          </select>
        </label>
        <div className="sell-chips" role="group" aria-label="Listing extras">
          {listChips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className={chips[chip.key] ? 'on' : ''}
              aria-pressed={chips[chip.key]}
              onClick={() => toggleChip(chip.key)}
            >
              {chip.label}
            </button>
          ))}
        </div>
        <div className="sell-photos">
          {photos.map((url) => (
            <button
              key={url}
              type="button"
              className="listing-photo"
              aria-label="Remove photo"
              onClick={() => setPhotos((current) => current.filter((item) => item !== url))}
            >
              <img src={url} alt="" />
            </button>
          ))}
          {photos.length < MAX_LISTING_PHOTOS ? (
            <label className="listing-photo-add" aria-label="Add photo">
              <CameraIcon />
              <input
                type="file"
                accept="image/*"
                multiple
                hidden
                disabled={saving}
                onChange={async (event) => {
                  const files = [...(event.target.files || [])];
                  event.target.value = '';
                  const room = MAX_LISTING_PHOTOS - photos.length;
                  if (!files.length || room <= 0) return;
                  setSaving(true);
                  setError('');
                  try {
                    const token = await getBearer();
                    const next = [];
                    for (const file of files.slice(0, room)) {
                      const dataUrl = await photoFileToJpeg(file);
                      const saved = await uploadChatPhoto(token, dataUrl, 'listing');
                      if (saved?.url) next.push(saved.url);
                    }
                    setPhotos((current) => [...current, ...next].slice(0, MAX_LISTING_PHOTOS));
                  } catch (err) {
                    setError(err.message || 'Photo was not added.');
                  } finally {
                    setSaving(false);
                  }
                }}
              />
            </label>
          ) : null}
        </div>
      </div>
      <div className="sell-location-row">
        <label className="sell-field location-pick">
          Location
          <select
            value={box}
            onChange={(event) => {
              boxTouched.current = true;
              setBox(event.target.value);
            }}
          >
            <option value="">None</option>
            {boxOptions.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </label>
        {locationValue && locationValue !== box ? (
          <span className="sell-slot">{locationValue.slice(box.length)}</span>
        ) : null}
        <label className="sell-field comment comment-inline">
          Seller comment
          <input
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
        </label>
      </div>
      {chips.graded ? (
        <div className="sell-row">
          <label className="sell-field grow">
            Grading company
            <input value={company} onChange={(event) => setCompany(event.target.value)} />
          </label>
          <label className="sell-field">
            Grade
            <input value={grade} onChange={(event) => setGrade(event.target.value)} />
          </label>
          <label className="sell-field grow">
            Certification
            <input value={cert} onChange={(event) => setCert(event.target.value)} />
          </label>
        </div>
      ) : null}
      {error ? <p className="sell-msg error">{error}</p> : null}
      {done ? <p className="sell-msg ok">{done}</p> : null}
      {jump ? createPortal(
        <div className="lang-redirect" role="dialog" aria-modal="true" aria-labelledby="lang-redirect-title">
          <div className="lang-redirect-card">
            <p id="lang-redirect-title">You will be taken to the {jump.label} version of this card.</p>
            <div className="lang-redirect-actions">
              <button type="button" onClick={() => setJump(null)}>Stay here</button>
              <button
                type="button"
                className="lang-redirect-go"
                onClick={() => {
                  const target = jump.card;
                  const href = cardHref(target);
                  const id = target?.id || target?.card_id;
                  setJump(null);
                  navigate(href && href !== '/marketplace' ? href : `/marketplace/${getSearchLang()}/cards/${id}`);
                }}
              >
                Continue
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
      <ShipFromCountryGate
        open={shipGateOpen}
        value={shipGateDraft}
        onChange={setShipGateDraft}
        busy={saving}
        error={error}
        onClose={() => setShipGateOpen(false)}
        onSave={async () => {
          setSaving(true);
          setError('');
          try {
            const token = await getBearer();
            const data = await saveSellerSettings({ shipFromCountry: shipGateDraft }, token);
            setShipFromCountry(data.shipFromCountry || shipGateDraft);
            setShipGateOpen(false);
            setSaving(false);
            await submit({ pokoin: true, cardtrader: false });
          } catch (err) {
            setError(err.message || 'Could not save ship-from country.');
            setSaving(false);
          }
        }}
      />
    </section>
  );
}

function Chevron({ dir }) {
  const left = dir === 'left';
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d={left
          ? 'M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z'
          : 'M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z'}
      />
    </svg>
  );
}

function SilverHead({ card, fromPath }) {
  const navigate = useNavigate();
  const { signedIn, silver, ready, profile, getBearer } = useAuth();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [country, setCountry] = useState('');

  useEffect(() => {
    let live = true;
    fetchClientCountry().then((code) => {
      if (live) {
        setCountry(code);
      }
    });
    return () => {
      live = false;
    };
  }, []);

  async function unlock() {
    if (!signedIn) {
      navigate(authFrom(fromPath));
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const token = await getBearer();
      const data = await unlockSilver(token);
      setMessage(data.silverUntil ? `Silver until ${data.silverUntil}` : 'Silver unlocked.');
    } catch (err) {
      setMessage(err.message || 'Unlock failed.');
    } finally {
      setBusy(false);
    }
  }

  function openOffsite(url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  async function openCardtrader() {
    setMessage('');
    try {
      const url = cardtraderPublicUrl(card) || await fetchCardtraderRedirect(card);
      if (!url) {
        throw new Error('CardTrader did not return a URL.');
      }
      openOffsite(url);
    } catch (err) {
      setMessage(err.message || 'CardTrader unavailable.');
    }
  }

  async function openCardmarket() {
    setMessage('');
    try {
      const url = await fetchCardmarketRedirect(card).catch(() => '') || cardmarketSearchUrl(card, game().id);
      if (!url) {
        throw new Error('Cardmarket did not return a URL.');
      }
      openOffsite(url);
    } catch (err) {
      setMessage(err.message || 'Cardmarket unavailable.');
    }
  }

  function openVinted() {
    setMessage('');
    const url = vintedHref(card, undefined, country);
    if (!url || /search_text=?$/.test(url)) {
      setMessage('Vinted search is empty.');
      return;
    }
    openOffsite(url);
  }

  function openEbay() {
    setMessage('');
    const url = ebayHref(card, undefined, country);
    if (!url || /_nkw=?$/.test(url)) {
      setMessage('eBay search is empty.');
      return;
    }
    openOffsite(url);
  }

  async function openTcgplayer() {
    setMessage('');
    try {
      const url = await fetchTcgplayerRedirect(card);
      if (!url) {
        throw new Error('No TCGplayer product for this card.');
      }
      openOffsite(url);
    } catch (err) {
      const fallback = tcgplayerSearchHref(card);
      if (fallback && !/[?&]q=?$/.test(fallback)) {
        openOffsite(fallback);
        return;
      }
      setMessage(err.message || 'TCGplayer unavailable.');
    }
  }

  if (silver) {
    return (
      <div className="silver-tools">
        <div className="silver-pills">
          <button className="silver-pill is-ct" type="button" onClick={openCardtrader}>CT</button>
          <button className="silver-pill is-cm" type="button" onClick={openCardmarket}>CM</button>
          <button className="silver-pill is-tp" type="button" onClick={openTcgplayer} aria-label="TCGplayer">TP</button>
          <button className="silver-pill is-vt" type="button" onClick={openVinted}>VT</button>
          <button className="silver-pill is-eb" type="button" onClick={openEbay} aria-label="Search eBay">
            <span className="eb-e">E</span><span className="eb-b">B</span>
          </button>
        </div>
        {message ? <p className="muted silver-note">{message}</p> : null}
      </div>
    );
  }

  if (!ready || (signedIn && !profile)) {
    return <div className="silver-tools is-pending" aria-hidden="true" />;
  }

  return (
    <div className="silver-tools is-locked">
      {signedIn ? (
        <button className="silver-link" type="button" disabled={busy} onClick={unlock}>
          {busy ? 'Unlocking…' : `Unlock Silver · ${SILVER_PRICE_PKN} PKN`}
        </button>
      ) : (
        <AuthLink className="silver-link" to={authFrom(fromPath)}>Sign in to unlock</AuthLink>
      )}
      {message ? <p className="muted silver-note">{message}</p> : null}
    </div>
  );
}

function replaceToCanonical(path, navigate, card, routerPath) {
  const next = canonicalTarget(path, routerPath);
  if (!next) {
    return;
  }
  navigate(next, { replace: true, state: card ? { card } : undefined });
}

function dragThisCard(card, offers) {
  const dock = getChatDock();
  const username = dock.peerLabel && dock.peerLabel !== 'Seller' ? dock.peerLabel : '';
  return referenceForPeer(card, offers, { uid: dock.peer, username });
}

/** Desk scan: participates in page multi-select and drags a pile with related tiles. */
function DeskArtFrame({ card, art, offers, onZoom }) {
  const select = useCardSelect();
  const id = String(card?.id || '');
  const picked = Boolean(id && select?.selected?.has(id));
  const landscape = isLandscapePrintName(card?.name)
    || String(card?.artLayout || card?.art_layout || '').toLowerCase() === 'landscape';
  return (
    <div
      role="button"
      tabIndex={0}
      className={`art-frame${picked ? ' is-selected' : ''}${landscape ? ' is-landscape' : ''}`}
      data-card-id={id || undefined}
      draggable
      onClick={() => onZoom?.()}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onZoom?.();
      }}
      onDragStart={(event) => {
        const mixed = select?.dragReference?.({ heldCard: card });
        if (mixed) {
          writeListingDrag(event, mixed);
          return;
        }
        const group = select?.cardsForDrag(card) || [card];
        if (group.length > 1) {
          writeListingDrag(event, cardsReference(group));
          return;
        }
        writeListingDrag(event, dragThisCard(card, offers || []));
      }}
    >
      {art ? (
        <CardArt
          src={art}
          card={card}
          alt={cardImageAlt(card)}
          fetchPriority="high"
          full
          onError={() => {
            console.warn('[pokoin:desk-art] hero failed', {
              cardId: card?.id,
              art,
              imageUrl: card?.imageUrl,
              heroImageUrl: card?.heroImageUrl,
            });
          }}
        />
      ) : <span className="tile-ph" />}
    </div>
  );
}

export default function Card() {
  const { lang = 'en', cardId: rawCardId, slug = '' } = useParams();
  const cardId = realPublicCardId(rawCardId);
  const navigate = useNavigate();
  const location = useLocation();
  const pinnedCurrency = currencyFromSearch(location.search);
  const buyer = useBuyerCurrency(pinnedCurrency);
  const { settings: sellerSettings } = useSellerCurrency();
  const { user, getBearer } = useAuth();
  const { addItem } = useCart();
  const stubCard = useMemo(() => {
    const route = cardStubFromRoute({ cardId, lang, slug });
    const fromState = location.state?.card;
    const stateCard = fromState && String(fromState.id || fromState.card_id) === String(cardId)
      ? fromState
      : null;
    return mergeDeskCard(
      mergeDeskCard(mergeDeskCard(route, peekRecentTile(cardId)), peekDeskIdentity(cardId)),
      stateCard,
    );
  }, [cardId, lang, slug, location.state]);
  const stubCardRef = useRef(stubCard);
  stubCardRef.current = stubCard;
  // lang:cardId of the last successful desk fetch. The canonical-URL replace
  // re-runs this effect with a new slug but the same card — that must not
  // re-hit the origin for data that just painted.
  const fetchedForRef = useRef('');
  const [payload, setPayload] = useState(() => {
    const cached = peekCard(cardId, { lang });
    if (cached) {
      const listed = peekListings(cardId);
      return {
        ...cached,
        neighbors: neighborsOrPeek(cardId, cached.neighbors),
        ...(peekHasListingRows(listed) ? { offers: listed.listings } : {}),
      };
    }
    if (stubCard) {
      return {
        card: stubCard,
        offers: [],
        versions: [],
        neighbors: neighborsOrPeek(cardId),
      };
    }
    return null;
  });
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(false);
  const [copied, setCopied] = useState(false);
  const [watched, setWatched] = useState(false);
  const [offerSort, setOfferSort] = useState('price');
  const [condition, setCondition] = useState('');
  const [language, setLanguage] = useState('');
  const [dealLang, setDealLang] = useState(() => readDealLanguage());
  const [dealCond, setDealCond] = useState('NM');
  const [offersReady, setOffersReady] = useState(false);
  const [listingBusy, setListingBusy] = useState(false);
  const [shopError, setShopError] = useState('');
  const [editingOffer, setEditingOffer] = useState(null);
  const [namePrintings, setNamePrintings] = useState(() => {
    const cached = peekCard(cardId, { lang });
    return catalogPrintings(cached?.rarities);
  });
  const [artPrintings, setArtPrintings] = useState(() => {
    const cached = peekCard(cardId, { lang });
    return (cached?.versions || []).map(cardFromCatalogRow).filter((row) => row.id);
  });
  const [salesSlices, setSalesSlices] = useState(() => peekCardSales(cardId)?.slices ?? null);
  const [salesCondition, setSalesCondition] = useState('');
  const [salesLanguage, setSalesLanguage] = useState('');
  const [salesReverse, setSalesReverse] = useState(false);
  const [salesFirstEdition, setSalesFirstEdition] = useState(false);
  const [salesGraded, setSalesGraded] = useState(false);
  const [setNationality, setSetNationality] = useState('');
  const salesCardRef = useRef(cardId);
  if (salesCardRef.current !== cardId) {
    salesCardRef.current = cardId;
    setSalesCondition('');
    setSalesLanguage('');
    setSalesReverse(false);
    setSalesFirstEdition(false);
    setSalesGraded(false);
    setDealCond('NM');
    setSalesSlices(peekCardSales(cardId)?.slices ?? null);
    setSetNationality('');
    const cached = peekCard(cardId, { lang });
    const listed = peekListings(cardId);
    const offers = peekHasListingRows(listed) ? listed.listings : [];
    if (cached) {
      setPayload({
        ...cached,
        neighbors: neighborsOrPeek(cardId, cached.neighbors),
        ...(offers.length ? { offers } : {}),
      });
      setArtPrintings((cached.versions || []).map(cardFromCatalogRow).filter((row) => row.id));
      setNamePrintings(catalogPrintings(cached.rarities));
    } else if (stubCard) {
      setPayload({
        card: stubCard,
        offers,
        versions: [],
        neighbors: neighborsOrPeek(cardId),
      });
      setArtPrintings([]);
      setNamePrintings([]);
    } else {
      setPayload(null);
      setArtPrintings([]);
      setNamePrintings([]);
    }
  }
  const zoomRef = useRef(null);
  const copiedTimer = useRef(0);
  const listingsSeq = useRef(0);

  useEffect(() => {
    if (!cardId) return undefined;
    return subscribeListingLive(cardId, (event) => {
      setPayload((current) => {
        if (!current?.offers?.length) return current;
        const offers = applyListingLive(current.offers, event);
        return offers === current.offers ? current : { ...current, offers };
      });
    });
  }, [cardId]);

  useLayoutEffect(() => {
    if (String(rawCardId) !== String(cardId)) {
      const next = `${location.pathname.replace(`/cards/${rawCardId}`, `/cards/${cardId}`)}${location.search}`;
      navigate(next, { replace: true, state: location.state });
      return;
    }
    if (slug) {
      return;
    }
    const known = peekCanonicalPath(cardId, { lang })
      || stubCard?.canonicalPath
      || stubCard?.canonical_path;
    if (known) {
      replaceToCanonical(known, navigate, stubCard, location.pathname);
    }
  }, [rawCardId, cardId, lang, slug, navigate, stubCard, location.pathname, location.search, location.state]);

  useEffect(() => {
    let cancelled = false;
    listingsSeq.current += 1;
    const seq = listingsSeq.current;
    const stubCard = stubCardRef.current;
    setZoom(false);
    setCopied(false);
    setError('');
    setCondition('');
    setLanguage('');
    setOfferSort('price');
    setDealLang('');
    setDealCond('');
    setListingBusy(false);
    setShopError('');
    setEditingOffer(null);
    const cached = peekCard(cardId, { lang });
    const listed = peekListings(cardId);
    setArtPrintings(
      (cached?.versions || []).map(cardFromCatalogRow).filter((row) => row.id),
    );
    setNamePrintings(catalogPrintings(cached?.rarities));
    setWatched(readWatchlistIds().includes(String(cardId)));
    if (!slug) {
      const known = peekCanonicalPath(cardId, { lang })
        || stubCard?.canonicalPath
        || stubCard?.canonical_path;
      if (known) {
        replaceToCanonical(known, navigate, stubCard, location.pathname);
      } else {
        fetchCanonicalPath(cardId, { lang })
          .then((path) => {
            if (!cancelled && path) {
              replaceToCanonical(path, navigate, stubCard, location.pathname);
            }
          })
          .catch(() => {});
      }
    }
    // Only record a successful desk hydrate for this host's game.
    // Do not remember URL stubs or cross-game card-page cache hits.
    if (cached) {
      setPayload({
        ...cached,
        neighbors: neighborsOrPeek(cardId, cached.neighbors),
        ...(peekHasListingRows(listed) ? { offers: listed.listings } : {}),
      });
      setOffersReady(peekHasListingRows(listed));
      rememberNeighbors(cached.card, cached.neighbors);
    } else if (stubCard) {
      setPayload((current) => {
        if (current?.card && String(current.card.id || current.card.card_id) === String(cardId)) {
          const card = mergeDeskCard(current.card, stubCard);
          return {
            ...current,
            card,
            offers: peekHasListingRows(listed) ? listed.listings : current.offers || [],
            neighbors: current.neighbors || neighborsOrPeek(cardId),
          };
        }
        return {
          card: stubCard,
          offers: peekHasListingRows(listed) ? listed.listings : [],
          versions: [],
          neighbors: neighborsOrPeek(cardId),
        };
      });
      setOffersReady(peekHasListingRows(listed));
      if (stubCard.name) {
        document.title = cardDocumentTitle(stubCard);
      }
    } else {
      setPayload(null);
      setOffersReady(false);
    }

    const listingsSeqAtLoad = seq;
    fetchListings(cardId, { fresh: true }).then((list) => {
      if (cancelled || listingsSeqAtLoad !== listingsSeq.current) {
        return;
      }
      const rows = list.listings || [];
      setPayload((current) => {
        if (!current) {
          return current;
        }
        if (!rows.length && current.offers?.length) {
          return current;
        }
        return { ...current, offers: rows };
      });
      setOffersReady(true);
    }).catch(() => {
      if (!cancelled && listingsSeqAtLoad === listingsSeq.current) {
        setOffersReady(true);
      }
    });

    function showCard(data) {
      if (cancelled || !data?.card) {
        return;
      }
      fetchedForRef.current = `${lang}:${cardId}`;
      const neighborWindow = neighborsOrPeek(cardId, data.neighbors);
      warmupNeighbors(neighborWindow, { lang });
      setPayload((current) => {
        const { offers: _pageOffers, ...page } = data;
        const card = mergeDeskCard(current?.card, data.card);
        rememberCardId(card);
        return {
          ...page,
          card,
          version: data.version || card.version || current?.version || '',
          neighbors: neighborWindow,
          offers: current?.offers || [],
        };
      });
      document.title = cardDocumentTitle(mergeDeskCard(stubCard, data.card));
      const card = mergeDeskCard(stubCard, data.card);
      rememberNeighbors(card, data.neighbors);
      const clip = (data.versions || []).map(cardFromCatalogRow).filter((row) => row.id);
      if (clip.length) {
        setArtPrintings(clip);
      }
      const rarities = catalogPrintings(data.rarities);
      if (rarities.length) {
        setNamePrintings((current) => mergePrintingRows(current, rarities));
      }
      setWatched(readWatchlistIds().includes(String(card.id)));
      track(Action.viewCard, card);
      if (card.canonicalPath) {
        replaceToCanonical(card.canonicalPath, navigate, card, location.pathname);
      }
    }

    // The desk already painted this card in this mount; only the URL slug
    // changed (canonical replace). Skip the duplicate origin fetch.
    if (cached && fetchedForRef.current === `${lang}:${cardId}`) {
      return undefined;
    }

    fetchCard(cardId, { lang, slug, includeOffers: false, fresh: Boolean(cached) })
      .then(showCard)
      .catch((err) => {
        if (cancelled) {
          return;
        }
        if (err.status === 404) {
          setPayload(null);
          setError(err.message || 'Card not found.');
          return;
        }
        if (!cached && !stubCard) {
          setError(err.message || 'Card not found.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cardId, lang, slug, navigate]);

  const setNameForNationality = payload?.card?.set
    || payload?.card?.set_name
    || stubCard?.set
    || stubCard?.set_name
    || '';
  useEffect(() => {
    const slug = setSlug(setNameForNationality);
    if (!slug) {
      setSetNationality('');
      return undefined;
    }
    let cancelled = false;
    fetchPrintNationality(slug).then((value) => {
      if (!cancelled) {
        setSetNationality(value);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [cardId, setNameForNationality]);

  const salesNationality = payload?.card?.nationality || stubCard?.nationality || setNationality;
  const salesView = useMemo(
    () => soldGraphView(salesSlices || [], {
      nationality: salesNationality,
      language: salesLanguage,
      condition: salesCondition,
      reverse: salesReverse,
      firstEdition: salesFirstEdition,
      graded: salesGraded,
    }),
    [
      salesSlices,
      salesNationality,
      salesLanguage,
      salesCondition,
      salesReverse,
      salesFirstEdition,
      salesGraded,
    ],
  );
  const salesSeries = salesSlices == null ? null : salesView.series;
  const salesFilters = salesView.filters;
  const graphLangs = languagesForNationality(salesNationality, salesFilters.languages);

  // Keep the chip pressed-state on the effective flags: a printing that never
  // sold the standard variant snaps Reverse/1st Ed./Graded back on.
  useEffect(() => {
    const flags = salesView.flags;
    if (!flags) {
      return;
    }
    if (flags.reverse !== salesReverse) {
      setSalesReverse(flags.reverse);
    }
    if (flags.firstEdition !== salesFirstEdition) {
      setSalesFirstEdition(flags.firstEdition);
    }
    if (flags.graded !== salesGraded) {
      setSalesGraded(flags.graded);
    }
  }, [salesView, salesReverse, salesFirstEdition, salesGraded]);

  useEffect(() => {
    const cached = peekCardSales(cardId);
    if (cached) {
      setSalesSlices(cached.slices);
    }
    let cancelled = false;
    fetchCardSales(cardId, { slices: true }).then((data) => {
      if (cancelled) {
        return;
      }
      if (!Array.isArray(data?.slices)) {
        if (!cached) {
          setSalesSlices([]);
        }
        return;
      }
      saveCardSales(cardId, data.slices);
      setSalesSlices(data.slices);
    }).catch(() => {
      if (cancelled) {
        return;
      }
      if (cached) {
        return;
      }
      const stale = rememberStaleCardSales(cardId);
      setSalesSlices(stale?.slices ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [cardId]);

  useEffect(() => {
    const card = payload?.card || stubCard;
    if (card?.id || card?.name) {
      setActiveDeskCard(card);
    }
    return () => clearActiveDeskCard();
  }, [payload?.card, stubCard]);

  useEffect(() => {
    const name = String(payload?.card?.name || stubCard?.name || '').trim();
    if (!name) {
      return undefined;
    }
    const ac = new AbortController();
    fetchExactNameCards(name, { signal: ac.signal, lang })
      .then((rows) => {
        if (ac.signal.aborted || !rows.length) {
          return;
        }
        setNamePrintings((current) => mergePrintingRows(current, rows));
      })
      .catch((err) => {
        if (err?.name === 'AbortError' || ac.signal.aborted) {
          return;
        }
      });
    return () => ac.abort();
  }, [lang, payload?.card?.name, stubCard?.name]);

  useEffect(() => {
    let cancelled = false;
    fetchVersionSet(cardId)
      .then((data) => {
        if (cancelled) {
          return;
        }
        const rows = (data?.printings || []).map(cardFromCatalogRow).filter((row) => row.id);
        if (rows.length) {
          setArtPrintings(rows);
        }
      })
      .catch(() => {
        /* Keep marketplace-card-page `versions` so 2–6 reprints still paint. */
      });
    return () => {
      cancelled = true;
    };
  }, [cardId]);

  useLayoutEffect(() => {
    if (!zoom) {
      return undefined;
    }
    const el = zoomRef.current;
    if (el && !el.open) {
      el.showModal();
    }
    return undefined;
  }, [zoom]);

  const offers = useMemo(() => {
    const nationality = payload?.card?.nationality || stubCard?.nationality || setNationality;
    const allowed = languagesForNationality(nationality, language ? [language] : []);
    const shopLanguage = allowed.length ? language : '';
    const filtered = (payload?.offers || []).filter((offer) => {
      // Same grades as the condition chips: LP / Lightly Played is SP.
    if (condition && moodCondition(offer) !== condition) {
        return false;
      }
      if (shopLanguage && String(offer.language || '').toUpperCase() !== shopLanguage) {
        return false;
      }
      return true;
    });
    return sortOffers(filtered, offerSort);
  }, [payload, stubCard, setNationality, offerSort, condition, language]);

  const mineIds = useMemo(() => {
    const uid = String(user?.uid || '');
    if (!uid) {
      return [];
    }
    return (payload?.offers || [])
      .filter((row) => String(row.sellerUid || '') === uid)
      .map((row) => row.id)
      .filter(Boolean);
  }, [payload, user?.uid]);

  async function cancelMine(ids) {
    const listingIds = (ids || []).filter(Boolean);
    if (!listingIds.length || listingBusy) {
      return;
    }
    const noun = listingIds.length === 1 ? 'this listing' : `${listingIds.length} listings`;
    if (!window.confirm(`Remove ${noun} from the shop?`)) {
      return;
    }
    setListingBusy(true);
    setShopError('');
    try {
      const token = await getBearer();
      if (!token) {
        navigate(authFrom(location.pathname || '/marketplace'));
        return;
      }
      await Promise.all(listingIds.map((id) => cancelListing(id, token, user.uid)));
      listingIds.forEach((id) => dropListing(cardId, id));
      setPayload((current) => omitListings(current, listingIds));
      setEditingOffer((current) => (
        current && listingIds.includes(current.id) ? null : current
      ));
    } catch (err) {
      if (err.status === 401) {
        navigate(authFrom(location.pathname || '/marketplace'));
        return;
      }
      setShopError(err.message || 'Could not cancel the listing.');
    } finally {
      setListingBusy(false);
    }
  }

  const [artistCover, setArtistCover] = useState('');
  useEffect(() => {
    const card = payload?.card;
    if (!card) return undefined;
    const setTitle = card.set || card.setName || card.expansion_name || '';
    const logo = expansionLogoSrc({ slug: setSlug(setTitle), name: setTitle });
    if (logo) preloadDragImage(logo);
    const illustrator = card.artist || card.illustrator || '';
    const slug = artistSlug(illustrator);
    if (!slug) {
      setArtistCover('');
      return undefined;
    }
    let live = true;
    fetchArtistSummaries({ limit: 1000 }).then((data) => {
      const row = (data?.artists || []).find((item) => item.slug === slug);
      const src = row?.imageUrl || '';
      if (!live) return;
      setArtistCover(src);
      if (src) preloadDragImage(src);
    }).catch(() => {});
    return () => { live = false; };
  }, [payload?.card]);

  const themeCard = payload?.card || stubCard || { id: cardId, card_id: cardId };
  // Precomputed neighbours ride on card-page: paint them as soon as it lands
  // (prefetch cache included), and start their thumbs behind the desk scan.
  const serverRelated = useMemo(() => relatedFromPage(payload, cardId), [payload?.related, cardId]);
  useEffect(() => {
    if (serverRelated.length) {
      preloadRelatedThumbs(serverRelated);
    }
  }, [serverRelated]);

  const pageTheme = useMemo(
    () => deskTheme(themeCard),
    [themeCard],
  );
  useLayoutEffect(() => {
    const card = payload?.card || stubCard;
    if (card) {
      rememberDeskIdentity({ ...card, id: card.id || card.card_id || cardId });
      const shade = albumShade(card);
      if (shade) rememberCardBucket(card.id || card.card_id || cardId, shade);
    }
  }, [payload?.card, stubCard, cardId]);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const kind = storedRarityKind(themeCard);
    const vars = rarityDeskVars(kind) || deskThemeVars(pageTheme);
    if (vars) {
      for (const [key, value] of Object.entries(vars)) {
        root.style.setProperty(key, value);
      }
    }
    if (vars || kind) root.classList.add('desk-tinted');
    root.classList.toggle('desk-rainbow', kind === 'rainbow');
    root.classList.toggle('desk-gold', kind === 'gold');
    root.classList.toggle('desk-ghost', kind === 'ghost');
    return undefined;
  }, [pageTheme, themeCard]);
  useEffect(() => () => {
    const root = document.documentElement;
    root.classList.remove('desk-tinted', 'desk-rainbow', 'desk-gold', 'desk-ghost');
    for (const key of ['--desk-bg', '--desk-surface', '--desk-raised', '--desk-hero', '--desk-hero-border', '--desk-border', '--desk-tint']) {
      root.style.removeProperty(key);
    }
  }, []);

  if (error && !payload?.card) {
    return (
      <div className="status error">
        <p>Card market not found.</p>
        <Link to="/marketplace">Back to marketplace</Link>
      </div>
    );
  }
  if (!payload?.card && !stubCard) {
    return (
      <article className="card-page flutter-page" aria-busy="true">
        <header className="asset-header">
          <div className="asset-title-row">
            <h1><span className="skel-line skel-title" /></h1>
          </div>
          <div className="asset-sub-row">
            <p className="asset-sub"><span className="skel-line skel-line-sm" /></p>
          </div>
        </header>
        <div className="card-desk">
          <div className="hero-art-col">
            <section className="panel art-panel">
              <span className="tile-ph" />
            </section>
          </div>
        </div>
      </article>
    );
  }

  const card = (() => {
    const row = mergeDeskCard(stubCard, payload?.card || null);
    const nationality = String(row?.nationality || setNationality || '').trim();
    if (!row || !nationality || row.nationality === nationality) {
      return row;
    }
    return { ...row, nationality };
  })();
  const identity = printingIdentity(card);
  const fromPath = card.canonicalPath || window.location.pathname;
  const art = imageSrc(card, 'hero');
  // The header tile takes the printing's leftover illustration shade.
  const heroShade = albumShade(card);
  const rarityKind = storedRarityKind(card);
  const setName = identity.set || '';
  const setHref = setName ? `/marketplace/sets/${setSlug(setName)}` : '';
  const artist = identity.artist || payload?.artist?.name || payload?.artist?.illustrator || '';
  const artistPath = artist ? artistHref(artist, lang) : '';
  const identityEmoji = card.emoji || card.cardIdentityEmoji || '';
  const neighborWindow = neighborsOrPeek(publicCardId(card), payload?.neighbors);
  const prevCard = neighborWindow.prev?.[0] || null;
  const nextCard = neighborWindow.next?.[0] || null;
  const nativeLive = pricedOffers(payload?.offers);
  const listedDealLangs = listedDealLanguages(payload?.offers, card);
  const shownCond = dealCond || 'NM';
  const shownLang = resolveDealLanguage({
    selected: dealLang || 'EN',
    listed: offersReady ? listedDealLangs : [],
    country: sellerSettings?.shipFromCountry,
  });
  const dealPick = offersReady ? matchDeal(nativeLive, shownLang, shownCond) : null;
  const lastDayPkn = buyer.format(salesSeries?.lastMedianPkn);
  const change72h = formatChange72h(salesSeries?.change24hPct);
  const canBuy = Boolean(dealPick);
  const dealLangs = sellLanguages({
    nationality: card.nationality,
    setName: identity.set || card.set,
    releaseLanguages: card.releaseLanguages,
  });
  const listedDealConds = listedDealConditions(payload?.offers);
  // Best Deal shows every grade and every language of this printing; unlisted ones grey out.
  const listedCondSet = new Set(listedDealConds.map((row) => row.value));
  const listedLangSet = new Set(listedDealLangs);
  const allDealLangs = [...dealLangs];
  for (const code of [...listedDealLangs, shownLang]) {
    if (code && !allDealLangs.includes(code)) allDealLangs.push(code);
  }
  const languages = languagesForNationality(
    card.nationality,
    [...new Set((payload?.offers || []).map((row) => String(row.language || '').toUpperCase()).filter(Boolean))],
  );
  const collector = identity.number || '';
  const versionRows = rarityVersions(card, namePrintings);
  const versionLabel = versionOptionLabel(card) || collector;
  const canSwitchVersion = versionRows.length > 1;
  const prevNav = prevCard;
  const nextNav = nextCard;
  const clipPrintings = deskClipCandidates(artPrintings, payload?.versions);
  const setShortcuts = deskSetShortcuts(card, clipPrintings);
  const showMoreVersions = deskShowMoreVersions(card, {
    nameRows: namePrintings,
    clipRows: clipPrintings,
    versionCount: payload?.versionCount,
  });
  const species = speciesFromCard(card);
  const eraName = tcgEra(card);
  const eraPath = eraName ? eraHref(eraName) : '';
  const rarityPath = identity.rarity ? rarityHref(identity.rarity, lang) : '';
  // The client-side picker is only the fallback for a page without `related`.
  const related = serverRelated.length ? serverRelated : pickRelatedCards(card, [
    clipPrintings,
    namePrintings,
    neighborWindow.prev,
    neighborWindow.next,
  ], 12);
  const cardPath = card.canonicalPath || cardHref(card);
  const publicCardPath = publicGamePath(cardPath, game().id) || cardPath;
  const seoCrumbs = [
    { name: 'Marketplace', href: '/marketplace' },
    species
      ? { name: species.name, href: pokemonHref(card, lang) }
      : { name: 'Pokémon', href: `/marketplace/${lang}/pokemon` },
    eraName ? { name: eraName, href: eraPath } : null,
    setName ? { name: setName, href: setHref } : null,
    { name: displayName(card) || 'Card' },
  ];
  const relatedHubs = [
    species ? { name: `All ${species.name}`, href: pokemonHref(card, lang) } : null,
    setName && setHref ? { name: setName, href: setHref } : null,
    artist && artistPath ? { name: artist, href: artistPath } : null,
    eraName && eraPath ? { name: eraName, href: eraPath } : null,
    identity.rarity && rarityPath ? { name: identity.rarity, href: rarityPath } : null,
    card.nationality ? {
      name: `${String(card.nationality).charAt(0).toUpperCase()}${String(card.nationality).slice(1)} print`,
      href: languageHrefFromNationality(card.nationality, lang),
    } : null,
  ].filter(Boolean);

  async function share() {
    const url = `${window.location.origin}${publicCardPath}`;
    track(Action.share, card);
    if (canUseNativeShare()) {
      try {
        await navigator.share({
          title: displayName(card) || 'Pokoin',
          text: displayName(card) || '',
          url,
        });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') {
          return;
        }
      }
    }
    try {
      await copyText(url);
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch (_) {
      setCopied(false);
    }
  }

  function onWatch() {
    const on = toggleWatchlist(card.id);
    setWatched(on);
    postWatchlist(card.id, on ? 'add' : 'remove');
    track(Action.watchlist, card, { type: on ? 'watchlist_add' : 'watchlist_remove' });
  }

  function goVersion(event) {
    const row = versionRows.find((item) => String(item.id) === event.target.value);
    if (!row || String(row.id) === String(card.id)) {
      return;
    }
    track(Action.clickVersion, row);
    navigate(cardHref(row), { state: { card: row } });
  }

  return (
    <article className="card-page flutter-page">
      <CardSelectGrid
        cards={[card, ...related.filter((row) => row?.id && String(row.id) !== String(card?.id || '')).slice(0, 12)]}
        className="card-desk-select"
        contents
      >
      <SeoHead
        title={cardDocumentTitle(card)}
        description={cardSeoDescription(card)}
        canonical={publicCardPath}
        image={art}
        imageAlt={cardImageAlt(card)}
        jsonLd={[
          productJsonLd(card, {
            url: `https://pokoin.com${publicCardPath}`,
            offers: nativeLive,
            currency: pinnedCurrency && pinnedCurrency !== 'PKN' ? pinnedCurrency : '',
            listingId: new URLSearchParams(location.search).get('listing') || '',
            referencePkn: card?.price || card?.pricePkn || 0,
            game: game().id,
          }),
          breadcrumbJsonLd(seoCrumbs.filter(Boolean).map((crumb) => ({
            name: crumb?.name,
            href: crumb?.href ? publicGamePath(crumb.href, game().id) : undefined,
          }))),
        ]}
      />
      <header
        className={!rarityKind && (pageTheme || heroShade) ? 'asset-header shaded' : 'asset-header'}
        style={rarityKind ? undefined : cardShadeStyle(card)}
      >
        <div className="asset-title-row">
          <h1>
            <span
              className="species-drag"
              draggable
              title="Drag to add every printing of this Pokémon"
              onPointerDown={() => preloadDragImage(art)}
              onDragStart={(event) => {
                event.stopPropagation();
                writeListingDrag(event, bundleReference({
                  kind: 'species',
                  slug: species?.name || displayName(card),
                  name: species?.name || displayName(card),
                  imageUrl: art,
                  path: species ? pokemonHref(card, lang) : cardPath,
                }));
              }}
            >{displayName(card)}</span>
            {identityEmoji ? <span className="asset-emoji"> {identityEmoji}</span> : null}
          </h1>
          <div className="asset-title-tools">
            <button type="button" className={watched ? 'icon-btn on' : 'icon-btn'} onClick={onWatch} title={watched ? 'Remove from watchlist' : 'Add to watchlist'}>
              {watched ? '♥' : '♡'}
            </button>
            <button
              type="button"
              className={copied ? 'icon-btn on' : 'icon-btn'}
              onClick={share}
              aria-label={copied ? 'Copied' : 'Share'}
              title={copied ? 'Copied' : 'Share'}
            >
              {copied ? '✓' : '↗'}
            </button>
            {copied ? <span className="share-copied" role="status">Copied</span> : null}
          </div>
        </div>
        <div className="asset-sub-row">
          <p className="asset-sub">
            {setName ? (
              <Link
                to={setHref}
                draggable
                onClick={() => track(Action.clickSet, card)}
                onPointerDown={() => preloadDragImage(
                  expansionLogoSrc({ slug: setSlug(setName), name: setName }),
                )}
                onDragStart={(event) => {
                  event.stopPropagation();
                  writeListingDrag(event, bundleReference({
                    kind: 'expansion',
                    slug: setSlug(setName),
                    name: setName,
                    imageUrl: expansionLogoSrc({ slug: setSlug(setName), name: setName }),
                    path: setHref,
                  }));
                }}
              >{setName}</Link>
            ) : null}
            {collector ? (
              <>
                {setName ? ' ' : null}
                {collector}
              </>
            ) : null}
            {rarityKind ? (
              <span className={`rarity-kind is-${rarityKind}`}>{rarityKindLabel(card)}</span>
            ) : null}
            {artist ? (
              <>
                {' · '}
                {artistPath ? (
                  <Link
                    to={artistPath}
                    draggable
                    onClick={() => track(Action.clickArtist, card)}
                    onPointerDown={() => preloadDragImage(artistCover)}
                    onDragStart={(event) => {
                      event.stopPropagation();
                      writeListingDrag(event, bundleReference({
                        kind: 'artist',
                        slug: artistSlug(artist),
                        name: artist,
                        imageUrl: artistCover,
                        path: artistPath,
                      }));
                    }}
                  >{artist}</Link>
                ) : (
                  <span>{artist}</span>
                )}
              </>
            ) : null}
          </p>
          <div className="asset-quotes">
            <span
              className={buyer.pending || lastDayPkn ? 'quote-pill quote-pkn' : 'quote-pill quote-pkn oos'}
              title="Last day's median inferred sold price"
            >
              {buyer.pending ? '\u00a0' : (salesSeries == null ? '—' : (lastDayPkn || '—'))}
            </span>
            <span
              className={change72h.empty ? 'quote-pill oos' : 'quote-pill'}
              title="Change versus the sold median from 3 days earlier"
            >
              {change72h.text}
            </span>
          </div>
        </div>
      </header>

      <div className="card-desk">
        <div className="hero-art-col">
          <section className="panel art-panel">
            <div className="art-num-row">
              {prevNav ? (
                <Link
                  className="art-nav"
                  to={cardHref(prevNav)}
                  state={{ card: prevNav }}
                  aria-label="Previous card in set"
                  onPointerEnter={() => warmupCard(prevNav, { lang, listings: true })}
                  onClick={() => track(Action.prevCard, prevNav)}
                >
                  <Chevron dir="left" />
                </Link>
              ) : <span className="art-nav ghost" aria-hidden="true"><Chevron dir="left" /></span>}
              {canSwitchVersion ? (
                <select
                  className="collector-badge version-badge"
                  value={String(card.id)}
                  onChange={goVersion}
                  aria-label="Version"
                >
                  {versionRows.map((row) => (
                    <option key={row.id} value={row.id}>
                      {versionOptionLabel(row)}
                    </option>
                  ))}
                </select>
              ) : versionLabel ? (
                <span className="collector-badge">{versionLabel}</span>
              ) : <span />}
              {nextNav ? (
                <Link
                  className="art-nav"
                  to={cardHref(nextNav)}
                  state={{ card: nextNav }}
                  aria-label="Next card in set"
                  onPointerEnter={() => warmupCard(nextNav, { lang, listings: true })}
                  onClick={() => track(Action.nextCard, nextNav)}
                >
                  <Chevron dir="right" />
                </Link>
              ) : <span className="art-nav ghost" aria-hidden="true"><Chevron dir="right" /></span>}
            </div>
            <DeskArtFrame
              card={card}
              art={art}
              offers={payload?.offers || []}
              onZoom={() => {
                setZoom(true);
                track(Action.zoomArt, card);
              }}
            />
            {(setShortcuts.length || showMoreVersions) ? (
              <div className="set-link tight version-links">
                {setShortcuts.length ? (
                  <div className="version-shortcuts">
                    {setShortcuts.map((row) => {
                      const on = String(row.id) === String(card.id);
                      const ident = printingIdentity(row);
                      const label = [ident.set, ident.number].filter(Boolean).join(' ');
                      const mark = (
                        <ExpansionMark
                          setName={ident.set}
                          symbolUrl={row.expansionSymbolUrl || row.defaultSymbolUrl}
                        />
                      );
                      if (on) {
                        return (
                          <span
                            key={row.id}
                            className="set-shortcut is-on"
                            title={label}
                            aria-label={label}
                            aria-current="page"
                          >
                            {mark}
                          </span>
                        );
                      }
                      return (
                        <Link
                          key={row.id}
                          className="set-shortcut"
                          to={cardHref(row)}
                          state={{ card: row }}
                          title={label}
                          aria-label={label}
                          onPointerEnter={() => warmupCard(row, { lang, listings: true })}
                          onClick={() => track(Action.clickVersion, row)}
                        >
                          {mark}
                        </Link>
                      );
                    })}
                  </div>
                ) : null}
                {showMoreVersions ? (
                  <Link
                    className={['more-versions', setShortcuts.length ? '' : 'is-solo'].filter(Boolean).join(' ')}
                    to={versionsHref(card, lang)}
                  >
                    More versions...
                  </Link>
                ) : null}
              </div>
            ) : null}
          </section>
        </div>

        <div className="hero-center">
          <SoldPriceGraph
            series={salesSeries}
            filters={{ ...salesFilters, languages: graphLangs }}
            chips={salesView.chips}
            condition={salesCondition}
            language={salesLanguage}
            reverse={salesReverse}
            firstEdition={salesFirstEdition}
            graded={salesGraded}
            onCondition={setSalesCondition}
            onLanguage={setSalesLanguage}
            onReverse={setSalesReverse}
            onFirstEdition={setSalesFirstEdition}
            onGraded={setSalesGraded}
            formatPrice={(pkn) => buyer.format(pkn)}
            onPickDay={(day) => {
              const traits = soldTraitsForGraphDay(salesSlices || [], {
                nationality: salesNationality,
                language: salesLanguage,
                condition: salesCondition,
                reverse: salesReverse,
                firstEdition: salesFirstEdition,
                graded: salesGraded,
              }, day);
              if (!traits) {
                return;
              }
              setSalesCondition(traits.condition);
              setSalesLanguage(traits.language);
              setSalesReverse(Boolean(traits.reverse));
              setSalesFirstEdition(Boolean(traits.firstEdition));
              setSalesGraded(Boolean(traits.graded));
            }}
          />
          <NativeSales cardId={card.id} />
          <ListingForm
            card={card}
            identity={identity}
            salesSlices={salesSlices}
            fromPath={fromPath}
            preferredLanguage={shownLang}
            preferredCondition={shownCond}
            versions={clipPrintings}
            editing={editingOffer}
            onCancelEdit={() => setEditingOffer(null)}
            onListed={(created) => {
              listingsSeq.current += 1;
              const seq = listingsSeq.current;
              invalidateListings(card.id);
              rememberCreatedListing(card.id, created);
              setPayload((current) => mergeCreatedListing(current, created));
              setOffersReady(true);
              setEditingOffer(null);
              fetchListings(card.id, { fresh: true }).then((list) => {
                if (seq !== listingsSeq.current) {
                  return;
                }
                const rows = list.listings || [];
                setPayload((current) => {
                  if (!current) {
                    return current;
                  }
                  if (!rows.length && current.offers?.length) {
                    return current;
                  }
                  return { ...current, offers: rows };
                });
              }).catch(() => {});
            }}
          />
        </div>

        <div className="hero-deal">
          <section className="panel add-panel">
            <div className="add-head">
              <h2>Best Deal</h2>
              <SilverHead card={card} fromPath={fromPath} />
            </div>
            <div className={canBuy ? 'prod-px' : 'prod-px oos'}>
              {offersReady && canBuy ? <PriceStack parts={buyer.parts(dealPick.pricePkn, dealPick.sellerAcceptsPkn)} /> : '—'}
            </div>
            {offersReady && canBuy ? (
              <p className="deal-sold-by">
                Sold by{' '}
                {sellerHref(dealPick, lang) ? (
                  <Link to={sellerHref(dealPick, lang)}>{publicListingSellerName(dealPick) || 'seller'}</Link>
                ) : (
                  <span>{publicListingSellerName(dealPick) || 'seller'}</span>
                )}
              </p>
            ) : null}
            <div className="deal-facets">
              <div className="deal-facet-row" role="radiogroup" aria-label="Condition">
                {DEAL_CONDS.map((row) => {
                  const listed = listedCondSet.has(row.value);
                  const on = shownCond === row.value;
                  const ring = offersReady && on && canBuy;
                  const dim = offersReady && (on ? !canBuy : !listed);
                  return (
                    <button
                      key={row.value}
                      type="button"
                      role="radio"
                      className={`deal-chip${ring ? ' is-on' : ''}${dim ? ' is-off' : ''}`}
                      aria-checked={on}
                      aria-label={row.label}
                      title={listed && (!on || canBuy) ? row.label : `${row.label} · none listed`}
                      disabled={dim}
                      onClick={() => setDealCond(row.value)}
                    >
                      <img
                        className="shop-cond"
                        src={conditionChipSrc(row.value)}
                        alt=""
                        width="40"
                        height="28"
                        draggable={false}
                      />
                    </button>
                  );
                })}
              </div>
              {allDealLangs.length ? (
                <div className="deal-facet-row" role="radiogroup" aria-label="Language">
                  {allDealLangs.map((code) => {
                    const listed = listedLangSet.has(code);
                    const on = shownLang === code;
                    const ring = offersReady && on && canBuy;
                    const dim = offersReady && (on ? !canBuy : !listed);
                    return (
                      <button
                        key={code}
                        type="button"
                        role="radio"
                        className={`deal-chip${ring ? ' is-on' : ''}${dim ? ' is-off' : ''}`}
                        aria-checked={on}
                        aria-label={code}
                        title={listed && (!on || canBuy) ? code : `${code} · none listed`}
                        disabled={dim}
                        onClick={() => {
                          setDealLang(code);
                          writeDealLanguage(code, user?.uid);
                        }}
                      >
                        <img className="deal-flag" src={flagSrc(code)} alt="" width="22" height="22" />
                        <span>{code}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
            {canBuy ? (
              <button
                className="btn buy-btn"
                type="button"
                onClick={() => {
                  track(Action.buyIntent, card);
                  addItem(cartItemFromOffer(card, dealPick));
                  navigate('/cart');
                }}
              >
                Add to cart
              </button>
            ) : (
              <span className="btn ghost buy-btn">Unavailable</span>
            )}
          </section>
        </div>

        <section className="panel shop-panel shop-terminal">
          <header className="panel-head shop-head">
            <h2>Shop</h2>
            {payload?.offers?.length ? (
              <div className="shop-tools">
                <label className="sort">
                  Condition
                  <select value={condition} onChange={(event) => setCondition(event.target.value)}>
                    {CONDITIONS.map((row) => (
                      <option key={row.value || 'any'} value={row.value}>{row.label}</option>
                    ))}
                  </select>
                </label>
                {languages.length ? (
                  <label className="sort">
                    Language
                    <select value={language} onChange={(event) => setLanguage(event.target.value)}>
                      <option value="">Any</option>
                      {languages.map((code) => (
                        <option key={code} value={code}>{code}</option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label className="sort">
                  Sort
                  <select value={offerSort} onChange={(event) => setOfferSort(event.target.value)}>
                    <option value="price">Lowest price</option>
                    <option value="price-desc">Highest price</option>
                    <option value="qty">Most quantity</option>
                    <option value="seller">Seller</option>
                  </select>
                </label>
              </div>
            ) : null}
          </header>
          {shopError ? <p className="sell-msg error">{shopError}</p> : null}
          {offers.length ? (
            <ShopList offers={offers} deskCard={card}>
              {(selected) => offers.map((offer, index) => {
                const mine = mineIds.includes(offer.id);
                return (
                  <ShopListingRow
                    key={offer.id || `${offer.sellerName}-${offer.pricePkn}-${index}`}
                    offer={offer}
                    card={card}
                    mine={mine}
                    selected={selected.has(listingSelectId(offer))}
                    dragOffers={shopDragOffers(offers, selected, offer)}
                    listingBusy={listingBusy}
                    editing={editingOffer?.id === offer.id}
                    onCart={(qty) => addItem({ ...cartItemFromOffer(card, offer), qty: qty || 1 })}
                    onInspect={() => {
                      setZoom(true);
                      track(Action.zoomArt, card);
                    }}
                    onEdit={() => setEditingOffer(
                      editingOffer?.id === offer.id ? null : offer,
                    )}
                    onCancel={() => cancelMine([offer.id])}
                  />
                );
              })}
            </ShopList>
          ) : (
            <div className="empty-shop">
              <p className="status">
                {offersReady ? 'No items found' : '\u00a0'}
              </p>
            </div>
          )}
        </section>
      </div>

      <RelatedCards
        card={card}
        related={related}
        speciesName={species?.name}
        speciesHref={species ? pokemonHref(card, lang) : ''}
        embedded
      />
      <details className="catalog-fold">
        <summary>More in the catalog</summary>
        <SeoCrumbs items={seoCrumbs} />
        {relatedHubs.length ? (
          <p className="related-hubs">
            {relatedHubs.map((hub, index) => (
              <span key={hub.href}>
                {index ? ' · ' : null}
                <Link to={hub.href}>{hub.name}</Link>
              </span>
            ))}
          </p>
        ) : null}
      </details>

      {zoom ? (
        <dialog
          ref={zoomRef}
          className={`zoom${isLandscapePrintName(card?.name)
            || String(card?.artLayout || card?.art_layout || '').toLowerCase() === 'landscape'
            ? ' is-landscape'
            : ''}`}
          onClose={() => setZoom(false)}
          onClick={(event) => {
            if (event.target === zoomRef.current) {
              setZoom(false);
            }
          }}
        >
          {art ? (
            <CardArt
              src={art}
              alt={cardImageAlt(card)}
              full
              dragCard={dragThisCard(card, payload?.offers || [])}
              onClick={() => setZoom(false)}
            />
          ) : null}
        </dialog>
      ) : null}
      </CardSelectGrid>
    </article>
  );
}
