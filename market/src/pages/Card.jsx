import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  artistHref,
  versionsHref,
  cardHref,
  cardtraderPublicUrl,
  createListing,
  fetchCard,
  fetchCanonicalPath,
  fetchCardmarketRedirect,
  fetchCardtraderRedirect,
  fetchListings,
  formatPkn,
  imageSrc,
  invalidateListings,
  peekCard,
  peekCanonicalPath,
  peekListings,
  neighborsOrPeek,
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
import { authFrom } from '../punchouts.js';
import { useAuth } from '../auth.jsx';
import { cartItemFromOffer, useCart } from '../cart.jsx';
import { printingIdentity } from '../identity.js';
import { Action, track } from '../track.js';
import CardTile from '../components/CardTile.jsx';
import CardArt from '../components/CardArt.jsx';

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

  useEffect(() => {
    if (preferredLanguage) {
      setLanguage(preferredLanguage);
    }
  }, [preferredLanguage]);

  useEffect(() => {
    if (preferredCondition) {
      setCondition(preferredCondition);
    }
  }, [preferredCondition]);

  const hint = !price && suggestedPrice ? String(suggestedPrice) : '';

  function toggleChip(key) {
    setChips((current) => ({ ...current, [key]: !current[key] }));
  }

  async function submit() {
    if (!signedIn) {
      navigate(authFrom(fromPath));
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
        navigate(authFrom(fromPath));
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
  const { signedIn, silver, availablePkn, getBearer } = useAuth();
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
          <button className="silver-pill" type="button" onClick={openCardtrader}>CT</button>
          <button className="silver-pill" type="button" onClick={openCardmarket}>CM</button>
          <button className="silver-pill" type="button" onClick={openVinted}>VT</button>
        </div>
        {message ? <p className="muted silver-note">{message}</p> : null}
      </div>
    );
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
          ? `Site balance ${availablePkn.toLocaleString()} PKN. CT / CM / VT stay hidden until Silver.`
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
  const next = cleanPath(path);
  if (!path || !next) {
    return;
  }
  const here = cleanPath(routerPath || (typeof window === 'undefined' ? '' : window.location.pathname));
  if (next === here) {
    return;
  }
  navigate(path, { replace: true, state: card ? { card } : undefined });
}

export default function Card() {
  const { lang = 'en', cardId, slug = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { signedIn } = useAuth();
  const { addItem } = useCart();
  const stubCard = location.state?.card && String(location.state.card.id) === String(cardId)
    ? location.state.card
    : null;
  const [payload, setPayload] = useState(() => {
    const cached = peekCard(cardId, { lang });
    if (cached) {
      const listed = peekListings(cardId);
      return {
        ...cached,
        neighbors: neighborsOrPeek(cardId, cached.neighbors),
        ...(listed ? { offers: listed.listings || [] } : {}),
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
  const zoomRef = useRef(null);
  const copiedTimer = useRef(0);

  useLayoutEffect(() => {
    if (slug) {
      return;
    }
    const known = peekCanonicalPath(cardId, { lang })
      || stubCard?.canonicalPath
      || stubCard?.canonical_path;
    if (known) {
      replaceToCanonical(known, navigate, stubCard, location.pathname);
    }
  }, [cardId, lang, slug, navigate, stubCard, location.pathname]);

  useEffect(() => {
    let cancelled = false;
    setZoom(false);
    setCopied(false);
    setError('');
    setCondition('');
    setLanguage('');
    setOfferSort('price');
    setDealLang('');
    setDealCond('');
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
    const cached = peekCard(cardId, { lang });
    const listed = peekListings(cardId);
    if (cached) {
      setPayload({
        ...cached,
        neighbors: neighborsOrPeek(cardId, cached.neighbors),
        ...(listed ? { offers: listed.listings || [] } : {}),
      });
      setOffersReady(Boolean(listed));
      rememberNeighbors(cached.card, cached.neighbors);
    } else if (stubCard) {
      setPayload({
        card: stubCard,
        offers: listed?.listings || [],
        versions: [],
        neighbors: neighborsOrPeek(cardId),
      });
      setOffersReady(Boolean(listed));
    } else {
      setPayload(null);
      setOffersReady(false);
    }

    function showCard(data) {
      if (cancelled) {
        return null;
      }
      rememberNeighbors(data.card, data.neighbors);
      const neighborWindow = neighborsOrPeek(cardId, data.neighbors);
      warmupNeighbors(neighborWindow, { lang });
      const card = data.card;
      setPayload((current) => {
        const next = {
          ...data,
          neighbors: neighborWindow,
        };
        return current?.offers?.length
          ? { ...next, offers: current.offers }
          : next;
      });
      document.title = data.seo?.title || `${card.name} · Pokoin`;
      rememberCardId(card);
      setWatched(readWatchlistIds().includes(String(card.id)));
      track(Action.viewCard, card);
      if (card.canonicalPath) {
        replaceToCanonical(card.canonicalPath, navigate, card, location.pathname);
      }
      const cachedList = peekListings(card.id);
      const listingsPromise = cachedList
        ? Promise.resolve(cachedList)
        : fetchListings(card.id);
      return listingsPromise.then((list) => {
        if (!cancelled) {
          setPayload((current) => (
            current ? { ...current, offers: list.listings || [] } : current
          ));
          setOffersReady(true);
        }
      });
    }

    const pending = cached
      ? Promise.resolve(cached)
      : fetchCard(cardId, { lang, slug, includeOffers: false });
    pending
      .then(showCard)
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
  }, [cardId, lang, navigate]);

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

  if (error && !payload?.card && !stubCard) {
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
          <div className="prod-badges">
            <span className="badge-poke">Pokémon</span>
          </div>
          <div className="asset-title">
            <h1><span className="skel-line skel-title" /></h1>
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

  const card = payload?.card || stubCard;
  const identity = printingIdentity(card);
  const fromPath = card.canonicalPath || window.location.pathname;
  const versions = payload?.versions || [];
  const otherPrintings = versions.filter((row) => String(row.id) !== String(card.id));
  const art = imageSrc(card, 'hero');
  const setName = identity.set || '';
  const setHref = setName ? `/marketplace/sets/${setSlug(setName)}` : '';
  const artist = identity.artist || payload?.artist?.name || payload?.artist?.illustrator || '';
  const artistPath = artist ? artistHref(artist, lang) : '';
  const typeLabel = /^card$|^single$/i.test(String(card.type || card.productType || card.itemKind || 'Card'))
    ? 'Card'
    : (card.type || card.productType || 'Card');
  const identityEmoji = card.emoji || card.cardIdentityEmoji || '';
  const versionsPath = versionsHref(card, lang);
  const neighborWindow = neighborsOrPeek(publicCardId(card), payload?.neighbors);
  const prevCard = neighborWindow.prev?.[0] || null;
  const nextCard = neighborWindow.next?.[0] || null;
  const nativeLive = pricedOffers(payload?.offers);
  const dealPick = dealLang || dealCond
    ? matchDeal(nativeLive, dealLang || null, dealCond || null)
    : preferredDeal(nativeLive);
  const floor = formatPkn(nativeLive[0]?.pricePkn);
  const inStock = offersReady && nativeLive.length > 0;
  const canBuy = Boolean(dealPick);
  const dealLangs = LIST_LANGS;
  const dealConds = CONDITIONS.map((row) => row.value).filter(Boolean);
  const shownLang = dealLang || offerLang(dealPick) || '';
  const shownCond = dealCond || (dealPick ? conditionKey(dealPick.condition) : '');
  const languages = [...new Set((payload?.offers || []).map((row) => String(row.language || '').toUpperCase()).filter(Boolean))];
  const dealCopy = !offersReady
    ? null
    : !nativeLive.length
      ? 'No sellers yet. Be the first to list this card.'
      : !dealPick
        ? 'No listing matches this selection.'
        : null;
  const suggested = nativeLive[0]?.pricePkn > 0
    ? Number(nativeLive[0].pricePkn).toLocaleString('en-US', { maximumFractionDigits: 2 })
    : '';
  const holo = Boolean(card.isHolo || card.holo);
  const collector = identity.number || '—';
  const versionRows = versions.length
    ? (versions.some((row) => String(row.id) === String(card.id))
      ? versions
      : [{ id: card.id, name: card.name, set: setName, set_name: setName, number: collector }, ...versions])
    : [{ id: card.id, name: card.name, set: setName, set_name: setName, number: collector }];

  async function share() {
    const url = `${window.location.origin}${card.canonicalPath || cardHref(card)}`;
    track(Action.share, card);
    if (canUseNativeShare()) {
      try {
        await navigator.share({
          title: card.name || 'Pokoin',
          text: card.name || '',
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
              <Link to={artistPath} onClick={() => track(Action.clickArtist, card)}>{artist}</Link>
            ) : <span>{artist || typeLabel}</span>}
          </p>
        </div>
        <div className="asset-actions">
          <span className={inStock && floor ? 'quote-pill' : 'quote-pill oos'}>
            Floor {offersReady ? (floor || '—') : '—'}
          </span>
          <span className="quote-pill oos" title="No sold-card series yet">24h —</span>
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
                  onPointerEnter={() => warmupCard(prevCard, { lang, listings: true })}
                  onClick={() => track(Action.prevCard, prevCard)}
                >
                  <Chevron dir="left" />
                </Link>
              ) : <span className="art-nav ghost" aria-hidden="true"><Chevron dir="left" /></span>}
              <span className="collector-badge">{collector}</span>
              {nextCard ? (
                <Link
                  className="art-nav"
                  to={cardHref(nextCard)}
                  state={{ card: nextCard }}
                  aria-label="Next card in set"
                  onPointerEnter={() => warmupCard(nextCard, { lang, listings: true })}
                  onClick={() => track(Action.nextCard, nextCard)}
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
              {art ? <CardArt src={art} alt={card.name} fetchPriority="high" full /> : <span className="tile-ph" />}
            </button>
            <label className="sort version-select">
              <span className="sr-only">Version</span>
              <select
                value={String(card.id)}
                onChange={goVersion}
                disabled={versionRows.length < 2}
              >
                {versionRows.map((row) => {
                  const rowId = printingIdentity(row);
                  return (
                    <option key={row.id} value={row.id}>
                      {[row.set || row.set_name, rowId.number].filter(Boolean).join(' ') || row.name}
                    </option>
                  );
                })}
              </select>
            </label>
            <p className="set-link tight">
              <Link to={versionsPath}>View all versions</Link>
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
            preferredLanguage={dealLang}
            preferredCondition={dealCond}
            onListed={() => {
              invalidateListings(card.id);
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
              <SilverHead card={card} fromPath={fromPath} />
            </div>
            <div className={canBuy ? 'prod-px' : 'prod-px oos'}>
              {offersReady ? (canBuy ? formatPkn(dealPick.pricePkn) : '—') : '—'}
            </div>
            {dealCopy ? <p className="muted own-k">{dealCopy}</p> : null}
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
          <header className="panel-head">
            <h2>Shop</h2>
            {payload?.offers?.length ? (
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
          {payload?.offers?.length ? (
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
                <button
                  type="button"
                  key={offer.id || `${offer.sellerName}-${offer.pricePkn}-${index}`}
                  className="shop-row"
                  onClick={() => {
                    track(Action.clickListing, card, { resultRank: index });
                    addItem(cartItemFromOffer(card, offer));
                    navigate('/cart');
                  }}
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
                </button>
              ))}
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
            <CardArt
              src={art}
              alt={card.name}
              full
              onClick={() => setZoom(false)}
            />
          ) : null}
        </dialog>
      ) : null}
    </article>
  );
}
