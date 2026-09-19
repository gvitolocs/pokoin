import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  artistHref,
  versionsHref,
  cardHref,
  cardtraderPublicUrl,
  cancelListing,
  createListing,
  dropListing,
  cardFromCatalogRow,
  fetchCard,
  fetchCardSales,
  fetchCanonicalPath,
  fetchCardmarketRedirect,
  fetchCardtraderRedirect,
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
  unlockSilver,
  warmupCard,
  warmupNeighbors,
  readWatchlistIds,
  vintedHref,
} from '../api.js';
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
import { albumShade, cardShadeStyle } from '../art-shade.js';
import { peekCardSales, rememberStaleCardSales, saveCardSales } from '../sold-sales-cache.js';
import { authFrom } from '../punchouts.js';
import { useAuth } from '../auth.jsx';
import { cartItemFromOffer, useCart } from '../cart.jsx';
import { deskClipCandidates, deskSetShortcuts, deskShowMoreVersions, mergePrintingRows, rarityVersions, versionOptionLabel } from '../card-versions.js';
import { cardDocumentTitle, displayName, printingIdentity } from '../identity.js';
import { defaultCardLanguage, getSearchLang, languagesForNationality, rewriteCatalogLang, searchLangFromPath } from '../locale.js';
import ExpansionMark from '../components/ExpansionMark.jsx';
import { Action, track } from '../track.js';
import { LIST_CURRENCIES, listPriceHint, listingPriceToPkn } from '../pkn.js';
import { cardStubFromRoute, mergeDeskCard, realPublicCardId } from '../card-stub.js';
import CardArt from '../components/CardArt.jsx';
import RelatedCards from '../components/RelatedCards.jsx';
import SeoCrumbs from '../components/SeoCrumbs.jsx';
import SeoHead from '../components/SeoHead.jsx';
import { tcgEra, eraHref } from '../set-logos.js';
import { speciesFromCard, pokemonHref } from '../pokemon-hubs.js';
import ShopListingRow from '../components/ShopListing.jsx';
import {
  breadcrumbJsonLd,
  cardImageAlt,
  cardSeoDescription,
  languageHrefFromNationality,
  pickRelatedCards,
  productJsonLd,
  rarityHref,
} from '../seo.js';

const CONDITIONS = [
  { value: '', label: 'Any condition' },
  { value: 'NM', label: 'Near Mint' },
  { value: 'SP', label: 'Slightly Played' },
  { value: 'MP', label: 'Moderately Played' },
  { value: 'PL', label: 'Played' },
  { value: 'Poor', label: 'Poor' },
];

const LIST_LANGS = [
  'EN', 'IT', 'FR', 'DE', 'ES', 'JP', 'PT', 'NL', 'PL', 'RU', 'KO', 'ZH', 'ZHT', 'ID', 'TH', 'VI',
];

const FOILS = [
  { value: 'standard', label: 'Standard' },
  { value: 'holo', label: 'Holo' },
  { value: 'reverse', label: 'Reverse' },
  { value: 'stamped', label: 'Stamped' },
  { value: 'promo', label: 'Promo' },
  { value: 'other', label: 'Other' },
];

const MOOD_CONDS = [
  { value: 'NM', label: '😄 NM' },
  { value: 'SP', label: '🙂 SP' },
  { value: 'MP', label: '😐 MP' },
  { value: 'PL', label: '🙁 PL' },
  { value: 'Poor', label: '😭 Poor' },
];

const LIST_CHIPS = [
  { key: 'firstEd', label: '1st Ed.' },
  { key: 'sealed', label: 'Sealed' },
  { key: 'graded', label: 'Graded' },
  { key: 'shipping', label: 'Shipping' },
];

function catalogPrintings(rows) {
  return (rows || []).map(cardFromCatalogRow).filter((row) => row.id);
}

function sortOffers(rows, key) {
  const list = [...(rows || [])];
  if (key === 'price-desc') {
    list.sort((a, b) => Number(b.pricePkn || 0) - Number(a.pricePkn || 0));
  } else if (key === 'qty') {
    list.sort((a, b) => Number(b.quantityAvailable || 0) - Number(a.quantityAvailable || 0));
  } else if (key === 'seller') {
    list.sort((a, b) => String(a.sellerName || '').localeCompare(String(b.sellerName || '')));
  } else {
    list.sort((a, b) => Number(a.pricePkn || 0) - Number(b.pricePkn || 0));
  }
  return list;
}

function conditionKey(value) {
  const text = String(value || '').toUpperCase();
  if (text.includes('NEAR') || text === 'NM') return 'NM';
  if (text.includes('SLIGHT') || text === 'SP') return 'SP';
  if (text.includes('MODERATE') || text === 'MP') return 'MP';
  if (text.includes('PLAYED') || text === 'PL') return 'PL';
  if (text.includes('POOR')) return 'Poor';
  return text;
}

function offerLang(offer) {
  if (!offer) {
    return '';
  }
  return String(offer.language || '').toUpperCase();
}

function pricedOffers(rows) {
  return [...(rows || [])]
    .filter((offer) => Number(offer.pricePkn) > 0)
    .sort((a, b) => Number(a.pricePkn || 0) - Number(b.pricePkn || 0));
}

function formatChange24h(pct) {
  if (pct == null || !Number.isFinite(Number(pct))) {
    return { text: '24h —', empty: true };
  }
  const value = Number(pct) * 100;
  const sign = value > 0 ? '+' : '';
  return {
    text: `24h ${sign}${value.toFixed(1)}%`,
    empty: false,
    up: value >= 0,
  };
}

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
        label="Sold language"
        allLabel="All languages"
        options={languages}
        value={language}
        onChange={onLanguage}
        optionLabel={soldLanguageLabel}
      />
      <SoldGraphFilter
        label="Sold condition"
        allLabel="All conditions"
        options={conditions}
        value={condition}
        onChange={onCondition}
        optionLabel={soldConditionLabel}
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
  const price = active ? (formatPkn(active.medianPkn) || '0 PKN') : '';
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

function matchDeal(rows, language, condition) {
  return pricedOffers(rows).find((offer) => {
    if (language && offerLang(offer) !== language) {
      return false;
    }
    if (condition && conditionKey(offer.condition) !== condition) {
      return false;
    }
    return true;
  }) || null;
}

function preferredDeal(rows, nationality) {
  const lang = defaultCardLanguage(nationality);
  return matchDeal(rows, lang, 'NM')
    || matchDeal(rows, null, 'NM')
    || matchDeal(rows, lang, null)
    || matchDeal(rows);
}

function conditionLabel(code) {
  return CONDITIONS.find((row) => row.value === code)?.label || code;
}

function defaultFoil(card) {
  const hay = `${card?.rarity || ''} ${card?.name || ''} ${card?.variant || ''}`.toLowerCase();
  if (/\breverse\b/.test(hay)) return 'reverse';
  if (/\bholo\b/.test(hay)) return 'holo';
  return 'standard';
}

function ListingForm({
  card,
  identity,
  suggestedPrice,
  fromPath,
  onListed,
  preferredLanguage,
  preferredCondition,
}) {
  const navigate = useNavigate();
  const { signedIn, ready, sellerName, getBearer } = useAuth();
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState('PKN');
  const [qty, setQty] = useState('1');
  const [condition, setCondition] = useState('NM');
  const [language, setLanguage] = useState(() => defaultCardLanguage(card?.nationality));
  const [foil, setFoil] = useState(defaultFoil(card));
  const [chips, setChips] = useState({
    firstEd: false,
    sealed: false,
    graded: false,
    shipping: true,
  });
  const [comment, setComment] = useState('');
  const [company, setCompany] = useState('PSA');
  const [grade, setGrade] = useState('');
  const [cert, setCert] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const sellLangs = languagesForNationality(card.nationality, LIST_LANGS);
  const listLangs = sellLangs.length ? sellLangs : LIST_LANGS;

  useEffect(() => {
    setPrice('');
    setCurrency('PKN');
    setQty('1');
    setCondition('NM');
    setLanguage(defaultCardLanguage(card.nationality));
    setFoil(defaultFoil(card));
    setChips({
      firstEd: false,
      sealed: false,
      graded: false,
      shipping: true,
    });
    setComment('');
    setCompany('PSA');
    setGrade('');
    setCert('');
    setError('');
    setDone('');
  }, [card.id]);

  useEffect(() => {
    const langs = languagesForNationality(card.nationality, LIST_LANGS);
    const allowed = langs.length ? langs : LIST_LANGS;
    if (preferredLanguage && allowed.includes(preferredLanguage)) {
      setLanguage(preferredLanguage);
      return;
    }
    setLanguage((current) => (
      allowed.includes(current) ? current : defaultCardLanguage(card.nationality)
    ));
  }, [preferredLanguage, card.nationality]);

  useEffect(() => {
    if (preferredCondition) {
      setCondition(preferredCondition);
    }
  }, [preferredCondition]);

  const hint = !price && suggestedPrice ? listPriceHint(suggestedPrice, currency) : '';
  const listedPkn = price
    ? listingPriceToPkn(price, currency)
    : listingPriceToPkn(suggestedPrice, 'PKN');

  function toggleChip(key) {
    setChips((current) => ({ ...current, [key]: !current[key] }));
  }

  async function submit() {
    if (!signedIn) {
      navigate(authFrom(fromPath));
      return;
    }
    const amount = price
      ? listingPriceToPkn(price, currency)
      : listingPriceToPkn(suggestedPrice, 'PKN');
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
    try {
      const token = await getBearer();
      if (!token) {
        navigate(authFrom(fromPath));
        return;
      }
      const created = await createListing({
        cardId: publicCardId(card),
        sellerName,
        sellerCountry: 'EU',
        sellerReputationLabel: 'New',
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
        source: 'pokoin_user_listing',
        cardName: card.name,
        cardImageUrl: card.heroImageUrl || card.imageUrl || '',
        setName: identity.set,
        collectorNumber: identity.number,
      }, token);
      track(Action.sell, card);
      setDone('Listing created.');
      setQty('1');
      onListed?.(created);
    } catch (err) {
      if (err.status === 401) {
        navigate(authFrom(fromPath));
        return;
      }
      setError(err.message || 'Listing failed.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel sell-form">
      <div className="add-head">
        <h2>List your card</h2>
        {signedIn ? (
          <span className="seller-chip">{sellerName}</span>
        ) : (
          <Link className="signin-link" to={authFrom(fromPath)} onClick={() => track(Action.sell, card)}>
            Sign in
          </Link>
        )}
      </div>
      <div className="sell-row">
        <label className="sell-field grow">
          Price
          <input
            inputMode="decimal"
            value={price}
            placeholder={hint}
            onChange={(event) => setPrice(event.target.value)}
          />
        </label>
        <label className="sell-field currency">
          Currency
          <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
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
        <button
          type="button"
          className="btn list-btn"
          disabled={!ready || saving || (!signedIn && ready)}
          title={signedIn ? 'List card' : 'Sign in to list'}
          onClick={submit}
        >
          {saving ? 'Listing…' : 'List card'}
        </button>
      </div>
      {currency !== 'PKN' && listedPkn ? (
        <p className="sell-pkn-eq">Lists at {formatPkn(listedPkn)}</p>
      ) : null}
      <div className="sell-options-row">
        <label className="sell-field sell-pick condition-pick">
          <span className="sr-only">Condition</span>
          <select value={condition} onChange={(event) => setCondition(event.target.value)}>
            {MOOD_CONDS.map((row) => (
              <option key={row.value} value={row.value}>{row.label}</option>
            ))}
          </select>
        </label>
        <label className="sell-field sell-pick language-pick">
          <span className="sr-only">Language</span>
          <select value={language} onChange={(event) => setLanguage(event.target.value)}>
            {listLangs.map((code) => (
              <option key={code} value={code}>{code}</option>
            ))}
          </select>
        </label>
        <label className="sell-field sell-pick foil-pick">
          <span className="sr-only">Foil</span>
          <select value={foil} onChange={(event) => setFoil(event.target.value)}>
            {FOILS.map((row) => (
              <option key={row.value} value={row.value}>{row.label}</option>
            ))}
          </select>
        </label>
        <div className="sell-chips" role="group" aria-label="Listing extras">
          {LIST_CHIPS.map((chip) => (
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
      <label className="sell-field comment">
        Seller comment
        <textarea
          rows={3}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
      </label>
      {error ? <p className="sell-msg error">{error}</p> : null}
      {done ? <p className="sell-msg ok">{done}</p> : null}
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
  const { signedIn, silver, ready, profile, availablePkn, getBearer } = useAuth();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

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
      const url = await fetchCardmarketRedirect(card);
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
    const url = vintedHref(card);
    if (!url || /search_text=?$/.test(url)) {
      setMessage('Vinted search is empty.');
      return;
    }
    openOffsite(url);
  }

  if (silver) {
    return (
      <div className="silver-tools">
        <div className="silver-pills">
          <button className="silver-pill is-ct" type="button" onClick={openCardtrader}>CT</button>
          <button className="silver-pill is-cm" type="button" onClick={openCardmarket}>CM</button>
          <button className="silver-pill is-vt" type="button" onClick={openVinted}>VT</button>
        </div>
        {message ? <p className="muted silver-note">{message}</p> : null}
      </div>
    );
  }

  if (!ready || (signedIn && !profile)) {
    return <div className="silver-tools is-pending" aria-hidden="true" />;
  }

  return (
    <div className="silver-tools">
      {signedIn ? (
        <button className="silver-link" type="button" disabled={busy} onClick={unlock}>
          {busy ? 'Unlocking…' : `Unlock Silver · 20 PKN`}
        </button>
      ) : (
        <Link className="silver-link" to={authFrom(fromPath)}>Sign in to unlock</Link>
      )}
      <p className="muted silver-note">
        {signedIn
          ? `Site balance ${formatPknNumber(availablePkn)} PKN. CT / CM / VT stay hidden until Silver.`
          : 'CT / CM / VT need Silver on this session.'}
      </p>
      {message ? <p className="muted silver-note">{message}</p> : null}
    </div>
  );
}

function canUseNativeShare() {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
    return false;
  }
  const ua = String(navigator.userAgent || '');
  if (/iPhone|iPad|iPod|Android/i.test(ua)) {
    return true;
  }
  return navigator.platform === 'MacIntel' && Number(navigator.maxTouchPoints || 0) > 1;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  document.body.appendChild(input);
  input.select();
  document.execCommand('copy');
  input.remove();
}

function cleanPath(path) {
  return String(path || '').split(/[?#]/)[0].replace(/\/$/, '') || '/';
}

function replaceToCanonical(path, navigate, card, routerPath) {
  const here = cleanPath(routerPath || (typeof window === 'undefined' ? '' : window.location.pathname));
  const titleLang = searchLangFromPath(here) || getSearchLang();
  const next = cleanPath(rewriteCatalogLang(path, titleLang));
  if (!next) {
    return;
  }
  if (next === here) {
    return;
  }
  navigate(next, { replace: true, state: card ? { card } : undefined });
}

export default function Card() {
  const { lang = 'en', cardId: rawCardId, slug = '' } = useParams();
  const cardId = realPublicCardId(rawCardId);
  const navigate = useNavigate();
  const location = useLocation();
  const { user, getBearer } = useAuth();
  const { addItem } = useCart();
  const stubCard = useMemo(() => {
    const route = cardStubFromRoute({ cardId, lang, slug });
    const fromState = location.state?.card;
    const stateCard = fromState && String(fromState.id || fromState.card_id) === String(cardId)
      ? fromState
      : null;
    return mergeDeskCard(mergeDeskCard(route, peekRecentTile(cardId)), stateCard);
  }, [cardId, lang, slug, location.state]);
  const stubCardRef = useRef(stubCard);
  stubCardRef.current = stubCard;
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
  const [dealLang, setDealLang] = useState('');
  const [dealCond, setDealCond] = useState('');
  const [offersReady, setOffersReady] = useState(false);
  const [listingBusy, setListingBusy] = useState(false);
  const [shopError, setShopError] = useState('');
  const [namePrintings, setNamePrintings] = useState([]);
  const [artPrintings, setArtPrintings] = useState([]);
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
    setSalesSlices(peekCardSales(cardId)?.slices ?? null);
    setSetNationality('');
  }
  const zoomRef = useRef(null);
  const copiedTimer = useRef(0);
  const listingsSeq = useRef(0);

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
    if (cached?.card) {
      rememberCardId(cached.card);
    } else if (stubCard?.id && stubCard.name) {
      rememberCardId(stubCard);
    }
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
      if (condition && conditionKey(offer.condition) !== condition) {
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
    const row = payload?.card || stubCard;
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
  const setName = identity.set || '';
  const setHref = setName ? `/marketplace/sets/${setSlug(setName)}` : '';
  const artist = identity.artist || payload?.artist?.name || payload?.artist?.illustrator || '';
  const artistPath = artist ? artistHref(artist, lang) : '';
  const identityEmoji = card.emoji || card.cardIdentityEmoji || '';
  const neighborWindow = neighborsOrPeek(publicCardId(card), payload?.neighbors);
  const prevCard = neighborWindow.prev?.[0] || null;
  const nextCard = neighborWindow.next?.[0] || null;
  const nativeLive = pricedOffers(payload?.offers);
  const dealPick = dealLang || dealCond
    ? matchDeal(nativeLive, dealLang || null, dealCond || null)
    : preferredDeal(nativeLive, card.nationality);
  const lastDayPkn = formatPkn(salesSeries?.lastMedianPkn);
  const change24h = formatChange24h(salesSeries?.change24hPct);
  const canBuy = Boolean(dealPick);
  const dealLangs = languagesForNationality(card.nationality, LIST_LANGS);
  const dealConds = CONDITIONS.map((row) => row.value).filter(Boolean);
  const shownLangRaw = dealLang || offerLang(dealPick) || '';
  const shownLang = !shownLangRaw || dealLangs.includes(shownLangRaw) ? shownLangRaw : '';
  const shownCond = dealCond || (dealPick ? conditionKey(dealPick.condition) : '');
  const languages = languagesForNationality(
    card.nationality,
    [...new Set((payload?.offers || []).map((row) => String(row.language || '').toUpperCase()).filter(Boolean))],
  );
  const dealCopy = !offersReady
    ? null
    : !nativeLive.length
      ? 'No sellers yet. Be the first to list this card.'
      : !dealPick
        ? 'No listing matches this selection.'
        : null;
  const suggested = nativeLive[0]?.pricePkn > 0
    ? Number(nativeLive[0].pricePkn)
    : '';
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
  const related = pickRelatedCards(card, [
    clipPrintings,
    namePrintings,
    neighborWindow.prev,
    neighborWindow.next,
  ], 12);
  const cardPath = card.canonicalPath || cardHref(card);
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
    const url = `${window.location.origin}${card.canonicalPath || cardHref(card)}`;
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
      <SeoHead
        title={cardDocumentTitle(card)}
        description={cardSeoDescription(card)}
        canonical={cardPath}
        image={art}
        imageAlt={cardImageAlt(card)}
        jsonLd={[
          productJsonLd(card, { url: `https://pokoin.com${cardPath}`, offers: nativeLive }),
          breadcrumbJsonLd(seoCrumbs.filter(Boolean).map((crumb) => ({
            name: crumb.name,
            href: crumb.href,
          }))),
        ]}
      />
      <header
        className={heroShade ? 'asset-header shaded' : 'asset-header'}
        style={cardShadeStyle(card)}
      >
        <div className="asset-title-row">
          <h1>{displayName(card)}{identityEmoji ? <span className="asset-emoji"> {identityEmoji}</span> : null}</h1>
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
              <Link to={setHref} onClick={() => track(Action.clickSet, card)}>{setName}</Link>
            ) : null}
            {collector ? (
              <>
                {setName ? ' ' : null}
                {collector}
              </>
            ) : null}
            {artist ? (
              <>
                {' · '}
                {artistPath ? (
                  <Link to={artistPath} onClick={() => track(Action.clickArtist, card)}>{artist}</Link>
                ) : (
                  <span>{artist}</span>
                )}
              </>
            ) : null}
          </p>
          <div className="asset-quotes">
            <span
              className={lastDayPkn ? 'quote-pill quote-pkn' : 'quote-pill quote-pkn oos'}
              title="Last day's median inferred sold price in PKN"
            >
              {salesSeries == null ? '—' : (lastDayPkn || '—')}
            </span>
            <span
              className={change24h.empty ? 'quote-pill oos' : 'quote-pill'}
              title="Day-over-day median of sold prices"
            >
              {change24h.text}
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
            <button
              type="button"
              className="art-frame"
              onClick={() => {
                setZoom(true);
                track(Action.zoomArt, card);
              }}
            >
              {art ? <CardArt src={art} alt={cardImageAlt(card)} fetchPriority="high" full /> : <span className="tile-ph" />}
            </button>
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
          <ListingForm
            card={card}
            identity={identity}
            suggestedPrice={suggested}
            fromPath={fromPath}
            preferredLanguage={dealLang}
            preferredCondition={dealCond}
            onListed={(created) => {
              listingsSeq.current += 1;
              const seq = listingsSeq.current;
              invalidateListings(card.id);
              rememberCreatedListing(card.id, created);
              setPayload((current) => mergeCreatedListing(current, created));
              setOffersReady(true);
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
              {offersReady ? (canBuy ? formatPkn(dealPick.pricePkn) : '—') : '—'}
            </div>
            {canBuy && offersReady ? null : (
              <p className="muted own-k">{dealCopy || '\u00a0'}</p>
            )}
            <div className="deal-selects">
              <label className="sort deal-select">
                <span className="sr-only">Language</span>
                <select
                  value={shownLang}
                  onChange={(event) => setDealLang(event.target.value)}
                >
                  <option value="">Select language</option>
                  {shownLang && !dealLangs.includes(shownLang) ? (
                    <option value={shownLang}>{shownLang}</option>
                  ) : null}
                  {dealLangs.map((code) => (
                    <option key={code} value={code}>{code}</option>
                  ))}
                </select>
              </label>
              <label className="sort deal-select">
                <span className="sr-only">Condition</span>
                <select
                  value={shownCond}
                  onChange={(event) => setDealCond(event.target.value)}
                >
                  <option value="">Select condition</option>
                  {shownCond && !dealConds.includes(shownCond) ? (
                    <option value={shownCond}>{conditionLabel(shownCond)}</option>
                  ) : null}
                  {dealConds.map((code) => (
                    <option key={code} value={code}>{conditionLabel(code)}</option>
                  ))}
                </select>
              </label>
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
          <section className="panel reserve-blurb">
            <h2>POKOIN CARD RESERVE</h2>
            <p>Unified custody, seller aggregation and inspection-ready settlement for serious collectors.</p>
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
            <div className="shop-list">
              {offers.map((offer, index) => {
                const mine = mineIds.includes(offer.id);
                return (
                  <ShopListingRow
                    key={offer.id || `${offer.sellerName}-${offer.pricePkn}-${index}`}
                    offer={offer}
                    mine={mine}
                    listingBusy={listingBusy}
                    onBuy={() => {
                      track(Action.clickListing, card, { resultRank: index });
                      addItem(cartItemFromOffer(card, offer));
                      navigate('/cart');
                    }}
                    onCancel={() => cancelMine([offer.id])}
                  />
                );
              })}
            </div>
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
          className="zoom"
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
              onClick={() => setZoom(false)}
            />
          ) : null}
        </dialog>
      ) : null}
    </article>
  );
}
