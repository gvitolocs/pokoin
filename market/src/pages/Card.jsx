import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  artistHref,
  authFrom,
  cardHref,
  createListing,
  fetchCard,
  fetchExpansion,
  fetchListings,
  formatPkn,
  imageSrc,
  postWatchlist,
  publicCardId,
  rememberCardId,
  setSlug,
  toggleWatchlist,
  readWatchlistIds,
} from '../api.js';
import { useAuth } from '../auth.jsx';
import { printingIdentity } from '../identity.js';
import { Action, track } from '../track.js';
import CardTile from '../components/CardTile.jsx';

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
  { key: 'signed', label: 'Signed' },
  { key: 'shipping', label: 'Shipping' },
];

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

function listingTags(offer) {
  const tags = [];
  if (offer.language) tags.push(String(offer.language).toUpperCase());
  if (offer.reverse) tags.push('Reverse');
  if (offer.firstEdition) tags.push('1st Ed.');
  if (offer.sealed) tags.push('Sealed');
  if (offer.graded) {
    tags.push([offer.gradingCompany, offer.grade].filter(Boolean).join(' ') || 'Graded');
  }
  if (offer.signed) tags.push('Signed');
  if (offer.reserveAvailable) tags.push('Reserve');
  if (offer.nftAvailable) tags.push('NFT');
  return tags;
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

function preferredDeal(rows) {
  return matchDeal(rows, 'EN', 'NM')
    || matchDeal(rows, null, 'NM')
    || matchDeal(rows, 'EN', null)
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

function ListingForm({ card, identity, suggestedPrice, fromPath, onListed }) {
  const { signedIn, ready, sellerName, getBearer } = useAuth();
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState('1');
  const [condition, setCondition] = useState('NM');
  const [language, setLanguage] = useState('EN');
  const [foil, setFoil] = useState(defaultFoil(card));
  const [chips, setChips] = useState({
    firstEd: false,
    sealed: false,
    graded: false,
    signed: false,
    shipping: true,
  });
  const [comment, setComment] = useState('');
  const [company, setCompany] = useState('PSA');
  const [grade, setGrade] = useState('');
  const [cert, setCert] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  useEffect(() => {
    setPrice('');
    setQty('1');
    setCondition('NM');
    setLanguage('EN');
    setFoil(defaultFoil(card));
    setChips({
      firstEd: false,
      sealed: false,
      graded: false,
      signed: false,
      shipping: true,
    });
    setComment('');
    setCompany('PSA');
    setGrade('');
    setCert('');
    setError('');
    setDone('');
  }, [card.id]);

  const hint = !price && suggestedPrice ? String(suggestedPrice) : '';

  function toggleChip(key) {
    setChips((current) => ({ ...current, [key]: !current[key] }));
  }

  async function submit() {
    if (!signedIn) {
      window.location.href = authFrom(fromPath);
      return;
    }
    const amount = Number(price || suggestedPrice);
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
        window.location.href = authFrom(fromPath);
        return;
      }
      await createListing({
        cardId: publicCardId(card),
        sellerName,
        sellerCountry: 'EU',
        sellerReputationLabel: 'New',
        condition,
        language,
        pricePkn: amount,
        quantityAvailable: quantity,
        signed: chips.signed,
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
      onListed?.();
    } catch (err) {
      if (err.status === 401) {
        window.location.href = authFrom(fromPath);
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
          <a className="signin-link" href={authFrom(fromPath)} onClick={() => track(Action.sell, card)}>
            Sign in
          </a>
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
          <select value="PKN" disabled>
            <option value="PKN">PKN</option>
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
      <div className="sell-row">
        <label className="sell-field grow">
          Condition
          <select value={condition} onChange={(event) => setCondition(event.target.value)}>
            {MOOD_CONDS.map((row) => (
              <option key={row.value} value={row.value}>{row.label}</option>
            ))}
          </select>
        </label>
        <label className="sell-field grow">
          Language
          <select value={language} onChange={(event) => setLanguage(event.target.value)}>
            {LIST_LANGS.map((code) => (
              <option key={code} value={code}>{code}</option>
            ))}
          </select>
        </label>
        <label className="sell-field grow">
          Foil
          <select value={foil} onChange={(event) => setFoil(event.target.value)}>
            {FOILS.map((row) => (
              <option key={row.value} value={row.value}>{row.label}</option>
            ))}
          </select>
        </label>
      </div>
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

export default function Card() {
  const { lang = 'en', cardId, slug = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { signedIn } = useAuth();
  const stubCard = location.state?.card && String(location.state.card.id) === String(cardId)
    ? location.state.card
    : null;
  const [payload, setPayload] = useState(stubCard ? { card: stubCard, offers: [], versions: [] } : null);
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
  const [siblings, setSiblings] = useState([]);
  const [siblingsWrap, setSiblingsWrap] = useState(false);
  const zoomRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setZoom(false);
    setCopied(false);
    setOffersReady(false);
    setError('');
    setCondition('');
    setLanguage('');
    setOfferSort('price');
    setDealLang('');
    setDealCond('');
    setWatched(readWatchlistIds().includes(String(cardId)));
    if (!stubCard || String(stubCard.id) !== String(cardId)) {
      setPayload(null);
    }
    fetchCard(cardId, { lang, slug, includeOffers: false })
      .then((data) => {
        if (cancelled) {
          return;
        }
        setPayload(data);
        const card = data.card;
        document.title = data.seo?.title || `${card.name} · Pokoin`;
        rememberCardId(card.id);
        setWatched(readWatchlistIds().includes(String(card.id)));
        track(Action.viewCard, card);
        if (card.canonicalPath) {
          const next = card.canonicalPath.split(/[?#]/)[0].replace(/\/$/, '') || card.canonicalPath;
          const here = window.location.pathname.replace(/\/$/, '') || '/';
          if (next !== here) {
            navigate(card.canonicalPath, { replace: true, state: { card } });
          }
        }
        return fetchListings(card.id).then((list) => {
          if (!cancelled) {
            setPayload((current) => (
              current ? { ...current, offers: list.listings || [] } : current
            ));
            setOffersReady(true);
          }
        });
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || 'Card not found.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setOffersReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cardId, lang, slug, navigate]);

  const setName = payload?.card ? printingIdentity(payload.card).set : '';

  useEffect(() => {
    if (!setName) {
      return undefined;
    }
    let cancelled = false;
    fetchExpansion({ expansionName: setName, limit: 200 })
      .then((data) => {
        if (cancelled) {
          return;
        }
        setSiblings(data.cards || []);
        setSiblingsWrap(!data.hasMore);
      })
      .catch(() => {
        if (!cancelled) {
          setSiblings([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [setName]);

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
    const filtered = (payload?.offers || []).filter((offer) => {
      if (condition && conditionKey(offer.condition) !== condition) {
        return false;
      }
      if (language && String(offer.language || '').toUpperCase() !== language) {
        return false;
      }
      return true;
    });
    return sortOffers(filtered, offerSort);
  }, [payload, offerSort, condition, language]);

  if (error) {
    return (
      <div className="status error">
        <p>Card market not found.</p>
        <Link to="/marketplace">Back to marketplace</Link>
      </div>
    );
  }
  if (!payload?.card) {
    return <p className="status">Loading card…</p>;
  }

  const card = payload.card;
  const identity = printingIdentity(card);
  const fromPath = card.canonicalPath || window.location.pathname;
  const versions = payload.versions || [];
  const otherPrintings = versions.filter((row) => String(row.id) !== String(card.id));
  const art = imageSrc(card, 'hero');
  const setHref = setName ? `/marketplace/sets/${setSlug(setName)}` : '';
  const artist = identity.artist || payload.artist?.name || payload.artist?.illustrator || '';
  const artistPath = artist ? artistHref(artist, lang) : '';
  const typeLabel = /^card$|^single$/i.test(String(card.type || card.productType || card.itemKind || 'Card'))
    ? 'Card'
    : (card.type || card.productType || 'Card');
  const identityEmoji = card.emoji || card.cardIdentityEmoji || '';
  const versionsPath = `${(card.canonicalPath || cardHref(card)).replace(/\/$/, '')}/versions`;
  const siblingIndex = siblings.findIndex((row) => publicCardId(row) === publicCardId(card));
  const prevCard = siblingIndex >= 0 && siblings.length > 1
    ? (siblingIndex > 0 ? siblings[siblingIndex - 1] : (siblingsWrap ? siblings[siblings.length - 1] : null))
    : null;
  const nextCard = siblingIndex >= 0 && siblings.length > 1
    ? (siblingIndex < siblings.length - 1 ? siblings[siblingIndex + 1] : (siblingsWrap ? siblings[0] : null))
    : null;
  const nativeLive = pricedOffers(payload.offers);
  const dealPick = dealLang || dealCond
    ? matchDeal(nativeLive, dealLang || null, dealCond || null)
    : preferredDeal(nativeLive);
  const floor = formatPkn(nativeLive[0]?.pricePkn);
  const inStock = offersReady && nativeLive.length > 0;
  const canBuy = Boolean(dealPick);
  const dealLangs = [...new Set(nativeLive
    .filter((row) => !dealCond || conditionKey(row.condition) === dealCond)
    .map(offerLang)
    .filter(Boolean))];
  const dealConds = CONDITIONS
    .map((row) => row.value)
    .filter((code) => code && nativeLive.some((row) => (
      (!dealLang || offerLang(row) === dealLang) && conditionKey(row.condition) === code
    )));
  const shownLang = dealLang || offerLang(dealPick) || '';
  const shownCond = dealCond || (dealPick ? conditionKey(dealPick.condition) : '');
  const languages = [...new Set((payload.offers || []).map((row) => String(row.language || '').toUpperCase()).filter(Boolean))];
  const dealCopy = !offersReady
    ? 'Checking listings…'
    : !nativeLive.length
      ? 'No sellers yet. Be the first to list this card.'
      : !dealPick
        ? 'No listing matches this selection.'
        : 'Estimated total in PKN. Escrow 0.30%. Slippage guard 1.00%.';
  const suggested = nativeLive[0]?.pricePkn > 0
    ? Number(nativeLive[0].pricePkn).toLocaleString('en-US', { maximumFractionDigits: 2 })
    : '';
  const holo = Boolean(card.isHolo || card.holo);
  const collector = identity.number || '—';

  async function share() {
    const url = `${window.location.origin}${card.canonicalPath || cardHref(card)}`;
    track(Action.share, card);
    try {
      if (navigator.share) {
        await navigator.share({ title: card.name, url });
        return;
      }
    } catch (_) {
      // clipboard fallback
    }
    try {
      await navigator.clipboard.writeText(url);
    } catch (_) {
      // http Vite
    }
    setCopied(true);
  }

  function onWatch() {
    const on = toggleWatchlist(card.id);
    setWatched(on);
    postWatchlist(card.id, on ? 'add' : 'remove');
    track(Action.watchlist, card, { type: on ? 'watchlist_add' : 'watchlist_remove' });
  }

  function goVersion(event) {
    const row = versions.find((item) => String(item.id) === event.target.value);
    if (!row || String(row.id) === String(card.id)) {
      return;
    }
    track(Action.clickVersion, row);
    navigate(cardHref(row), { state: { card: row } });
  }

  return (
    <article className="card-page flutter-page">
      <header className="asset-header">
        <div className="prod-badges">
          <span className="badge-poke">Pokémon</span>
          {identity.rarity ? <span className="badge-rare">{identity.rarity}</span> : null}
          {holo ? <span className="badge-holo">Holo</span> : null}
        </div>
        <div className="asset-title">
          <h1>{card.name}{identityEmoji ? <span className="asset-emoji"> {identityEmoji}</span> : null}</h1>
          <p className="asset-sub">
            {setName ? (
              <Link to={setHref} onClick={() => track(Action.clickSet, card)}>{setName}</Link>
            ) : null}
            {collector ? <> {collector} · </> : ' · '}
            {artist && artistPath ? (
              <a href={artistPath} onClick={() => track(Action.clickArtist, card)}>{artist}</a>
            ) : <span>{artist || typeLabel}</span>}
          </p>
        </div>
        <div className="asset-actions">
          <span className={inStock && floor ? 'quote-pill' : 'quote-pill oos'}>
            Floor {offersReady ? (floor || '—') : '…'}
          </span>
          <span className="quote-pill oos" title="No sold-card series yet">24h —</span>
          <button type="button" className={watched ? 'icon-btn on' : 'icon-btn'} onClick={onWatch} title={watched ? 'Remove from watchlist' : 'Add to watchlist'}>
            {watched ? '♥' : '♡'}
          </button>
          <button type="button" className="icon-btn" onClick={share} title={copied ? 'Copied' : 'Share'}>
            ↗
          </button>
        </div>
      </header>

      <div className="card-desk">
        <div className="hero-art-col">
          <section className="panel art-panel">
            <div className="art-num-row">
              {prevCard ? (
                <Link
                  className="art-nav"
                  to={cardHref(prevCard)}
                  state={{ card: prevCard }}
                  aria-label="Previous card in set"
                  onClick={() => track(Action.prevCard, prevCard)}
                >
                  ‹
                </Link>
              ) : <span className="art-nav ghost" aria-hidden="true">‹</span>}
              <span className="collector-badge">{collector}</span>
              {nextCard ? (
                <Link
                  className="art-nav"
                  to={cardHref(nextCard)}
                  state={{ card: nextCard }}
                  aria-label="Next card in set"
                  onClick={() => track(Action.nextCard, nextCard)}
                >
                  ›
                </Link>
              ) : <span className="art-nav ghost" aria-hidden="true">›</span>}
            </div>
            <button
              type="button"
              className="art-frame"
              onClick={() => {
                setZoom(true);
                track(Action.zoomArt, card);
              }}
            >
              {art ? <img src={art} alt={card.name} fetchPriority="high" decoding="async" /> : <span className="tile-ph" />}
            </button>
            {versions.length ? (
              <label className="sort version-select">
                <span className="sr-only">Version</span>
                <select value={String(card.id)} onChange={goVersion}>
                  {versions.map((row) => {
                    const rowId = printingIdentity(row);
                    return (
                      <option key={row.id} value={row.id}>
                        {[row.set || row.set_name, rowId.number].filter(Boolean).join(' ') || row.name}
                      </option>
                    );
                  })}
                </select>
              </label>
            ) : (
              <p className="version-fallback">{setName} {collector}</p>
            )}
            <p className="set-link tight">
              <a href={versionsPath}>View all versions</a>
            </p>
          </section>
        </div>

        <div className="hero-center">
          <section className="panel analytics-empty">
            <p>No sold-card analytics yet. Condition lines will populate after completed purchases.</p>
          </section>
          <ListingForm
            card={card}
            identity={identity}
            suggestedPrice={suggested}
            fromPath={fromPath}
            onListed={() => {
              fetchListings(card.id).then((list) => {
                setPayload((current) => (
                  current ? { ...current, offers: list.listings || [] } : current
                ));
              });
            }}
          />
        </div>

        <div className="hero-deal">
          <section className="panel add-panel">
            <div className="add-head">
              <h2>Best Deal</h2>
              <a className="silver-link" href={authFrom(fromPath)}>
                {signedIn ? 'Unlock Silver' : 'Sign in to unlock'}
              </a>
            </div>
            <div className={canBuy ? 'prod-px' : 'prod-px oos'}>
              {offersReady ? (canBuy ? formatPkn(dealPick.pricePkn) : '—') : '…'}
            </div>
            <p className="muted own-k">{dealCopy}</p>
            <div className="deal-selects">
              <label className="sort deal-select">
                <span className="sr-only">Language</span>
                <select
                  value={shownLang}
                  disabled={!nativeLive.length}
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
                  disabled={!nativeLive.length}
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
              <a
                className="btn buy-btn"
                href={authFrom(fromPath)}
                onClick={() => track(Action.buyIntent, card)}
              >
                Add to cart
              </a>
            ) : (
              <span className="btn ghost buy-btn">Unavailable</span>
            )}
            <dl className="fee-lines">
              <div><dt>Estimated total</dt><dd>{canBuy ? formatPkn(dealPick.pricePkn) : '—'}</dd></div>
              <div><dt>Network / escrow fee</dt><dd>0.30%</dd></div>
              <div><dt>Slippage guard</dt><dd>1.00%</dd></div>
            </dl>
          </section>
          <section className="panel reserve-blurb">
            <h2>POKOIN CARD RESERVE</h2>
            <p>Unified custody, seller aggregation and inspection-ready settlement for serious collectors.</p>
          </section>
        </div>

        <section className="panel shop-panel shop-terminal">
          <header className="panel-head">
            <h2>Shop</h2>
            {payload.offers?.length ? (
              <label className="sort">
                Sort
                <select value={offerSort} onChange={(event) => setOfferSort(event.target.value)}>
                  <option value="price">Lowest price</option>
                  <option value="price-desc">Highest price</option>
                  <option value="qty">Most quantity</option>
                  <option value="seller">Seller</option>
                </select>
              </label>
            ) : null}
          </header>
          {payload.offers?.length ? (
            <div className="listing-filters">
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
              {condition || language ? (
                <button type="button" className="linkish" onClick={() => { setCondition(''); setLanguage(''); }}>
                  Clear filters
                </button>
              ) : null}
            </div>
          ) : null}
          {offers.length ? (
            <div className="shop-list">
              {offers.map((offer, index) => (
                <a
                  key={offer.id || `${offer.sellerName}-${offer.pricePkn}-${index}`}
                  className="shop-row"
                  href={authFrom(fromPath)}
                  onClick={() => track(Action.clickListing, card, { resultRank: index })}
                >
                  <span className="shop-brand">{offer.sellerName || offer.sellerDisplayName || 'Pokoin'}</span>
                  <span className="shop-txt">
                    {offer.condition || 'NM'}
                    {listingTags(offer).map((tag) => (
                      <em key={tag} className="meta-chip">{tag}</em>
                    ))}
                  </span>
                  <span className="shop-px">{formatPkn(offer.pricePkn) || '—'}</span>
                  <span className="shop-act">
                    {offer.quantityAvailable || 1}
                  </span>
                </a>
              ))}
            </div>
          ) : (
            <div className="empty-shop">
              <p className="status">
                {offersReady ? 'No items found' : 'Checking listings…'}
              </p>
              {offersReady ? (
                <div className="actions">
                  <button type="button" className={watched ? 'btn' : 'btn ghost'} onClick={onWatch}>
                    {watched ? 'In watchlist' : 'Add to watchlist'}
                  </button>
                  <a className="btn ghost" href={authFrom(fromPath)} onClick={() => track(Action.sell, card)}>
                    Sell this card
                  </a>
                </div>
              ) : null}
            </div>
          )}
          <p className="affiliate">Prices in PKN.</p>
        </section>
      </div>

      {otherPrintings.length ? (
        <section className="printings">
          <h2>Printings</h2>
          <div className="carousel-track">
            {otherPrintings.map((row, index) => (
              <CardTile key={row.id} card={row} action={Action.clickVersion} rank={index} />
            ))}
          </div>
        </section>
      ) : null}

      {setName ? (
        <p className="set-link">
          <Link to={setHref} onClick={() => track(Action.clickSet, card)}>
            View all {setName}
          </Link>
        </p>
      ) : null}

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
            <img
              src={art}
              alt={card.name}
              onClick={() => setZoom(false)}
            />
          ) : null}
        </dialog>
      ) : null}
    </article>
  );
}
