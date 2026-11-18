import { createEffect, createMemo, createSignal, For, Show, untrack } from 'solid-js';
import { Portal } from '@solidjs/web';
import { useGameNavigate } from '../../lib/game-navigate.js';
import {
  cardHref,
  createListing,
  fetchPriceCheck,
  fetchPricingGroups,
  fetchSellerBoxSlots,
  formatPknNumber,
  publicCardId,
  saveSellerSettings,
  updateListing,
} from '@market/api.js';
import { blankListingForm, listingFormFromOffer, MOOD_CONDS, nextBoxLocation, offerLanguage } from '@market/card-desk.js';
import { groupPriceNote, leftGroupLine, listingPricingGroup } from '@market/pricing-group-note.js';
import {
  editListingBody,
  pricingDryRunBody,
  pricingDryRunPrice,
  pricingMenuEntries,
  pricingMenuLabel,
  pricingSavePlan,
} from '@market/listing-row-edit.js';
import { localizeStrategyName } from '@market/pricer.js';
import { saveListingPhotos, uploadChatPhoto } from '@market/chat-client.js';
import { game as currentGame } from '@market/game.js';
import { listingBox } from '@market/inventory-listings.js';
import { inventoryMarketLabel, priceCheckItem, priceCheckKey } from '@market/inventory-price.js';
import { deskLanguageChips, versionRedirects } from '@market/listing-languages.js';
import { listingExtraChips, listingFoilOptions } from '@market/listing-faces.js';
import { conditionChipSrc } from '@market/listing-meta.js';
import { defaultCardLanguage, getSearchLang } from '@market/locale.js';
import { fiatFromPkn, LIST_CURRENCIES, listingPriceToPkn } from '@market/pkn.js';
import { authAnchorRel, authFrom } from '@market/punchouts.js';
import { suggestPriceFromSlices } from '@market/scan-pricing.js';
import { priceInputFromPkn } from '@market/seller-currency.js';
import { Action, track } from '@market/track.js';
import { MAX_LISTING_PHOTOS, photoFileToJpeg } from '@market/user-photos.js';
import { authReady, authUser, getBearer, signedIn } from '../../stores/auth.js';
import { sellerCurrency, sellerSettings } from '../../stores/buyer.js';
import { authSession, profile } from '../../stores/session.js';
import { sellerNameOf } from '@market/auth-session.js';
import InventoryTargets from './InventoryTargets.jsx';
import ListingLangPick, { dismissWhileOpen } from './ListingLangPick.jsx';
import ShipFromCountryGate from './ShipFromCountryGate.jsx';
import QtyStepper from '../QtyStepper.jsx';
import StrategyEditor, { createStrategyEditor } from '../pricer/StrategyEditor.jsx';

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 9h2l.7 8.2a1 1 0 0 0 1 .8h5.6a1 1 0 0 0 1-.8L19 12h2l-.8 9.3a2 2 0 0 1-2 1.7H8.8a2 2 0 0 1-2-1.7L6 12Z" />
    </svg>
  );
}

function ConditionPick(props) {
  const [open, setOpen] = createSignal(false);
  let root;
  dismissWhileOpen(open, setOpen, () => root);
  const current = () => MOOD_CONDS.find((row) => row.value === props.value) || MOOD_CONDS[0];
  return (
    <div class={['lang-pick', { 'is-open': open() }]} ref={(el) => { root = el; }}>
      <button
        type="button"
        class="lang-pick-btn"
        aria-haspopup="listbox"
        aria-expanded={open() ? 'true' : 'false'}
        aria-label={`Condition ${current().label}`}
        onClick={() => setOpen((next) => !next)}
      >
        <img class="shop-cond" src={conditionChipSrc(current().value)} alt="" width="40" height="28" draggable="false" />
      </button>
      <Show when={open()}>
        <ul class="lang-pick-menu" role="listbox" aria-label="Condition">
          <For each={MOOD_CONDS}>
            {(row) => (
              <li>
                <button
                  type="button"
                  role="option"
                  aria-selected={row.value === props.value ? 'true' : 'false'}
                  aria-label={row.label}
                  onClick={() => {
                    setOpen(false);
                    props.onChange(row.value);
                  }}
                >
                  <img class="shop-cond" src={conditionChipSrc(row.value)} alt="" width="40" height="28" draggable="false" />
                  <Show when={row.value === props.value}><em aria-hidden="true">✓</em></Show>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
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

// CardTrader answers a facet it cannot take, a refusal, or a timeout with one
// of these codes; the seller reads the server's message, never the code.
const CARDTRADER_REFUSALS = new Set(['cardtrader_facet_unsupported', 'cardtrader_refused', 'cardtrader_unreachable']);

/**
 * "List your card" / "Edit listing".
 * Effects mirror the React dependency lists through memoized keys, so a card
 * that only gained fields (page hydrate) does not reset what the seller typed.
 * As the row editor (MyPokoin) `props.editing` is the inventory row and
 * `presets`, `currencies`, `moreFlags`, `onDelete` and `preview` fill the edit
 * side; in preview a save writes the fixture row and never calls the API.
 * `variant="drawer"` lays the same fields out in the inventory drawer, with the
 * pricing menu the board's own `createPricing` store drives.
 */
export default function ListingForm(props) {
  const navigate = useGameNavigate();
  const gameId = currentGame().id;
  const foils = listingFoilOptions(gameId);
  const listChips = listingExtraChips(gameId);
  const card = () => props.card;
  const blank = untrack(() => blankListingForm(props.card));
  const [price, setPrice] = createSignal(blank.price);
  let priceManual = Boolean(untrack(() => props.editing?.id));
  // The seller typed a price in this edit (an edit sends the price only then).
  let priceTyped = false;
  let priceFocused = false;
  let currencyManual = false;
  let boxTouched = false;
  let formEl;
  let errorEl;
  const [currency, setCurrency] = createSignal(untrack(sellerCurrency));
  const [qty, setQty] = createSignal(blank.qty);
  const [condition, setCondition] = createSignal(blank.condition);
  const [language, setLanguage] = createSignal(blank.language);
  const [foil, setFoil] = createSignal(blank.foil);
  const [chips, setChips] = createSignal(blank.chips);
  const [comment, setComment] = createSignal(blank.comment);
  const [box, setBox] = createSignal('');
  // The seller's boxes with their next free slot, from the server.
  const [stockBoxes, setStockBoxes] = createSignal([]);
  const [stockReady, setStockReady] = createSignal(false);
  // Where the listing being edited is stored (public offers carry no location);
  // null until the server answered, and then the form leaves location alone.
  const [ownLocation, setOwnLocation] = createSignal(null);
  // Bumped after a save so the next card gets the slot after this one.
  const [stockVersion, setStockVersion] = createSignal(0);
  const [photos, setPhotos] = createSignal(
    untrack(() => (Array.isArray(props.editing?.photoUrls) ? props.editing.photoUrls.slice(0, MAX_LISTING_PHOTOS) : [])),
  );
  const [company, setCompany] = createSignal(blank.company);
  const [grade, setGrade] = createSignal(blank.grade);
  const [cert, setCert] = createSignal(blank.cert);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal('');
  const [done, setDone] = createSignal('');
  const [jump, setJump] = createSignal(null);
  // Seller settings are shared app-wide (stores/buyer.js); a save in the gate overrides.
  const [shipFromCountry, setShipFromCountry] = createSignal(
    () => String(sellerSettings()?.shipFromCountry || '').toUpperCase(),
  );
  const [shipGateOpen, setShipGateOpen] = createSignal(false);
  const [shipGateDraft, setShipGateDraft] = createSignal('');

  const uid = () => authUser()?.uid || authSession()?.uid || '';
  const sellerName = () => sellerNameOf(authUser(), profile());
  // The cached session is enough to paint the form enabled; a save waits for
  // the bearer (getBearer) anyway.
  const ready = () => authReady() || signedIn();
  const editingId = createMemo(() => props.editing?.id || '');
  const isEditing = () => Boolean(editingId());
  const listLangs = createMemo(() => {
    // Editing an inventory row: its own language stays selectable even when the
    // card's catalog languages do not list it (an old card can be sold in Indonesian).
    const stored = editingId() ? [offerLanguage(props.editing, card())] : [];
    return deskLanguageChips({
      nationality: card().nationality,
      setName: props.identity?.set || card().set,
      releaseLanguages: card().releaseLanguages,
      data: stored,
    });
  });
  const redirects = createMemo(() => versionRedirects(props.versions || [], card().id, listLangs(), {
    nationality: card().nationality,
  }));
  const langKey = createMemo(() => listLangs().join(','));
  // "From the market" quotes for the price of the listing being edited.
  const presets = () => (isEditing() && Array.isArray(props.presets) ? props.presets : []);
  // The inventory editor shows the desk's Signed and Altered chips too.
  const extraChips = () => (props.moreFlags
    ? [...listChips, { key: 'signed', label: 'Signed' }, { key: 'altered', label: 'Altered' }]
    : listChips);
  // Currency choices: the seller's own first, or the desk's fixed list.
  const currencies = () => (Array.isArray(props.currencies) && props.currencies.length
    ? props.currencies
    : [...LIST_CURRENCIES.filter((code) => code !== 'PKN'), sellerCurrency()]);
  const presetPrice = (pkn) => (currency() === 'PKN'
    ? formatPknNumber(Math.round(pkn), { maximumFractionDigits: 0 })
    : formatPknNumber(fiatFromPkn(pkn, currency()), { maximumFractionDigits: 2 }));

  function takePreset(row) {
    setPrice(presetPrice(row.pkn));
    priceManual = true;
    priceTyped = true;
    takeOwnPrice();
  }

  // The pricing group of the listing being edited: a new price takes it out.
  const [priceGroup, setPriceGroup] = createSignal(null);
  createEffect(editingId, (id) => {
    setPriceGroup(null);
    if (!id) return;
    (async () => {
      try {
        const token = await getBearer();
        if (!token) return;
        const data = await fetchPricingGroups(token);
        if (untrack(editingId) === id) setPriceGroup(listingPricingGroup(data, id));
      } catch {
        // Never block the form over the note.
      }
    })();
  });

  // ── The row editor's drawer (MyPokoin): the same fields, plus pricing ─────
  const drawer = () => props.variant === 'drawer';
  // Which pricing the listing follows: none picked is the seller's own price.
  const [pricingPick, setPricingPick] = createSignal(null);
  const [pricingOpen, setPricingOpen] = createSignal(false);
  // A picked group or strategy prices the listing itself: shown, never typed.
  const [pricingTarget, setPricingTarget] = createSignal(null);
  const [pricingChecked, setPricingChecked] = createSignal(false);
  // "New strategy…" is a second step of the same drawer, the listing behind it.
  const [strategyStep, setStrategyStep] = createSignal(false);
  const pricingCtx = () => props.pricing?.currencyCtx();
  const originalPkn = () => {
    const value = Number(props.editing?.pricePkn ?? props.editing?.price_pkn);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const priceText = (value) => (value > 0 ? `${presetPrice(value)} ${currency()}` : '');
  const strategyEditor = drawer() && props.pricing
    ? createStrategyEditor({
      ctx: pricingCtx,
      strategies: () => props.pricing.strategies(),
      exampleComp: () => props.pricing.compFor(props.editing),
      save: (draft) => props.pricing.saveStrategy(draft),
      onSaved: (strategy) => pickStrategy(strategy),
    })
    : null;
  const pricingEntries = () => pricingMenuEntries({
    groups: props.pricing?.groups() || [],
    strategies: props.pricing?.strategies() || [],
    ctx: pricingCtx(),
  });
  /** The menu's button: the picked entry, else the group the listing is in. */
  const pricingLabel = () => pricingPick()?.label || pricingMenuLabel({
    memberships: props.pricing?.memberships(),
    groups: props.pricing?.groups() || [],
    strategies: props.pricing?.strategies() || [],
    listingId: editingId(),
    ctx: pricingCtx(),
  });
  /** What a picked group or strategy did to this listing's price. */
  const pricingNoteLine = () => {
    const pick = pricingPick();
    if (!pick) return '';
    const was = priceText(originalPkn());
    if (!pricingChecked()) return `Checking ${pick.name}…`;
    if (pricingTarget() == null) return `No market price for this card; it stays at ${was || 'its current price'}.`;
    return `Set by ${pick.name}${was ? ` · was ${was}` : ''}`;
  };

  function backToCustom() {
    setPricingPick(null);
    setPricingTarget(null);
    setPricingChecked(false);
  }

  /** A typed price or a market preset is the seller's own: custom at once. */
  function takeOwnPrice() {
    if (pricingPick()) backToCustom();
  }

  /** The dry run of the picked entry on this listing alone. */
  async function priceByPricing(pick) {
    const body = pricingDryRunBody(pick, props.pricing?.groups() || [], editingId());
    setPricingChecked(true);
    if (!body) return;
    try {
      const answer = await props.pricing.apply(body);
      const target = pricingDryRunPrice(answer, originalPkn());
      setPricingTarget(target);
      // The field shows the strategy's price; it is not a typed one, so the
      // PATCH leaves the price alone and `apply` sets it.
      if (target) setPrice(presetPrice(target));
    } catch (err) {
      backToCustom();
      setError(err.message || 'The market price was not available.');
    }
  }

  let pricingTrigger;
  let pricingList;
  let pricingRoot;

  /** Follow a group or strategy: dry-run it on this listing and show its price. */
  function followPricing(entry) {
    setPricingPick(entry);
    setPricingTarget(null);
    setPricingChecked(false);
    void priceByPricing(entry);
  }

  /** The menu's choice: custom, a group, a strategy, or a new strategy. */
  function choosePricing(entry) {
    pricingTrigger?.focus();
    setPricingOpen(false);
    if (entry.kind === 'new') {
      strategyEditor?.open(null);
      setStrategyStep(true);
      return;
    }
    if (entry.kind === 'custom') {
      backToCustom();
      // The price in the field becomes the seller's own, and leaves the group.
      priceManual = true;
      priceTyped = true;
      return;
    }
    followPricing(entry);
  }

  /** Back from the strategy step with the saved strategy picked and priced. */
  function pickStrategy(strategy) {
    setStrategyStep(false);
    const entry = pricingEntries().find((row) => row.kind === 'strategy' && row.id === strategy?.id);
    if (entry) followPricing(entry);
  }

  function applyFields(next) {
    // Rows and offers carry PKN; the form lists in the seller's pick or local currency.
    const listIn = untrack(currencyManual ? currency : sellerCurrency);
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

  // [card.id, editingId]
  const resetKey = createMemo(() => `${card().id}|${editingId()}`);
  // The fields as this row came in: the row editor compares against them to
  // ask before it switches listings with something unsaved.
  const [baselineForm, setBaselineForm] = createSignal(null);
  createEffect(resetKey, () => {
    const editing = untrack(() => props.editing);
    const row = untrack(card);
    priceTyped = false;
    backToCustom();
    setStrategyStep(false);
    if (editing?.id) {
      const fields = listingFormFromOffer(editing, row);
      setBaselineForm({ ...fields, photos: untrack(photos).join('|') });
      applyFields(fields);
      priceManual = true;
      formEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    const fields = blankListingForm(row);
    setBaselineForm({ ...fields, photos: untrack(photos).join('|') });
    applyFields(fields);
    priceManual = false;
  });

  const edited = createMemo(() => {
    const base = baselineForm();
    if (!base) return false;
    return base.price !== price()
      || base.qty !== qty()
      || base.condition !== condition()
      || base.language !== language()
      || base.foil !== foil()
      || base.comment !== comment()
      || base.company !== company()
      || base.grade !== grade()
      || base.cert !== cert()
      || JSON.stringify(base.chips) !== JSON.stringify(chips())
      || photos().join('|') !== base.photos
      || Boolean(pricingPick()) !== Boolean(base.pick);
  });
  // The drawer asks "Discard your changes?" before it opens another row.
  createEffect(edited, (dirty) => {
    if (drawer()) props.onFieldEdit?.(dirty);
  });

  // [preferredLanguage, langKey, editingId]
  const languageKey = createMemo(() => `${props.preferredLanguage || ''}|${langKey()}|${editingId()}`);
  createEffect(languageKey, () => {
    if (untrack(editingId)) return;
    const langs = untrack(listLangs);
    const preferred = untrack(() => props.preferredLanguage);
    if (preferred && langs.includes(preferred)) {
      setLanguage(preferred);
      return;
    }
    const nationality = untrack(() => card().nationality);
    setLanguage((current) => (langs.includes(current) ? current : (langs[0] || defaultCardLanguage(nationality))));
  });

  // [preferredCondition, editingId]
  const conditionKey = createMemo(() => `${props.preferredCondition || ''}|${editingId()}`);
  createEffect(conditionKey, () => {
    const preferred = untrack(() => props.preferredCondition);
    if (untrack(editingId) || !preferred) return;
    setCondition(preferred);
  });

  const graphPkn = createMemo(() => suggestPriceFromSlices(props.salesSlices, {
    condition: condition(),
    language: language(),
    reverse: foil() === 'reverse',
    firstEdition: chips().firstEd,
  }));

  // The suggested price is the cheapest professional CardTrader seller of this
  // printing with the same condition, language and finish; the sold graph
  // only fills in when no such offer exists.
  const [proFloorPkn, setProFloorPkn] = createSignal(null);
  const floorItem = createMemo(() => priceCheckItem({
    cardId: card().id,
    condition: condition(),
    language: language(),
    reverse: foil() === 'reverse',
    firstEdition: chips().firstEd === true,
  }));
  const floorKey = createMemo(() => (signedIn() && /^\d+$/.test(floorItem().cardId) ? priceCheckKey(floorItem()) : ''));
  createEffect(floorKey, (key) => {
    setProFloorPkn(null);
    if (!key) return undefined;
    const item = untrack(floorItem);
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchPriceCheck([item], await getBearer());
        const value = Number(data?.prices?.[key]?.ctMatchedPkn);
        if (!cancelled) setProFloorPkn(Number.isFinite(value) && value > 0 ? value : null);
      } catch (_) {
        // The sold graph stays the suggestion.
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  const graphPrice = createMemo(() => {
    const pkn = proFloorPkn() ?? graphPkn();
    if (!(pkn > 0)) return '';
    return currency() === 'PKN'
      ? formatPknNumber(Math.round(pkn), { maximumFractionDigits: 0 })
      : formatPknNumber(fiatFromPkn(pkn, currency()), { maximumFractionDigits: 2 });
  });

  // [graphPrice, editingId, card.id, currency]
  const suggestKey = createMemo(() => `${graphPrice()}|${editingId()}|${card().id}|${currency()}`);
  createEffect(suggestKey, () => {
    const suggested = untrack(graphPrice);
    if (untrack(editingId) || priceManual || priceFocused || !suggested) return;
    setPrice(suggested);
  });

  // Settings arrive after first paint: switch the untouched form over.
  createEffect(sellerCurrency, (next) => {
    const now = untrack(currency);
    if (currencyManual || now === next) return;
    const typed = untrack(price);
    if (typed && priceManual) setPrice(priceInputFromPkn(listingPriceToPkn(typed, now), next));
    setCurrency(next);
  });

  const hint = () => (!price() && graphPrice() ? graphPrice() : '');

  function toggleChip(key) {
    setChips((current) => ({ ...current, [key]: !current[key] }));
  }

  // [signedIn, uid, editingId, saves]: the seller's boxes for the box/slot picker.
  const stockKey = createMemo(() => (signedIn() && uid() ? `${uid()}|${editingId()}|${stockVersion()}` : ''));
  createEffect(stockKey, (key) => {
    if (!key) return undefined;
    const owner = untrack(uid);
    let cancelled = false;
    (async () => {
      try {
        const token = await getBearer();
        const id = untrack(editingId);
        const data = await fetchSellerBoxSlots(owner, token, { stackSize: 80, ...(id ? { id } : {}) });
        if (cancelled) return;
        setStockBoxes(Array.isArray(data?.boxes) ? data.boxes : []);
        setOwnLocation(typeof data?.listing?.location === 'string' ? data.listing.location : null);
        setStockReady(true);
      } catch (_) {
        // Not ready: an edit then keeps the stored location instead of clearing it.
        if (!cancelled) setStockBoxes([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  createEffect(
    () => [editingId(), stockBoxes(), ownLocation() ?? props.editing?.location ?? ''],
    ([id, boxes, location]) => {
      if (id) {
        setBox(listingBox(location || ''));
        return;
      }
      if (boxTouched) return;
      const first = String(boxes[0]?.box || '');
      if (first) setBox(first);
    },
  );

  const boxOptions = () => {
    const names = stockBoxes().map((entry) => String(entry?.box || '')).filter(Boolean);
    const current = box();
    if (current && !names.some((name) => name.toLowerCase() === current.toLowerCase())) return [current, ...names];
    return names;
  };
  const keptLocation = () => (editingId() ? (ownLocation() ?? props.editing?.location ?? '') : '');
  const locationValue = () => {
    const current = box();
    if (!current) return '';
    const sameBox = listingBox(keptLocation()).toLowerCase() === current.toLowerCase();
    return sameBox ? keptLocation() : nextBoxLocation(stockBoxes(), current);
  };

  /** The PATCH body of an edit, or null when the form does not validate. */
  function editDraft() {
    const amount = price()
      ? listingPriceToPkn(price(), currency())
      : listingPriceToPkn(graphPrice(), currency());
    const quantity = Number.parseInt(qty(), 10);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) {
      setError('Enter a valid price and quantity.');
      return null;
    }
    const flags = chips();
    if (flags.graded && (!company().trim() || !grade().trim() || !cert().trim())) {
      setError('Enter grading company, grade and certification ID.');
      return null;
    }
    return editListingBody({
      amount,
      quantity,
      condition: condition(),
      language: language(),
      foil: foil(),
      flags,
      comment: comment(),
      company: company(),
      grade: grade(),
      cert: cert(),
      location: locationValue(),
      // An edit only moves the box slot when the server said where it is.
      sendLocation: stockReady() && ownLocation() !== null,
      priceTyped,
      sellerUid: uid() || props.editing?.sellerUid,
      showSigned: Boolean(props.moreFlags),
      showAltered: Boolean(props.moreFlags),
    }, props.editing);
  }

  async function submit(targets = { pokoin: true, cardtrader: false }) {
    if (isEditing() && props.preview) {
      // The layout preview has no API: the edit and the pricing land on the
      // fixture through the same callbacks the live save uses.
      const draft = editDraft();
      if (!draft) return;
      let pricedPkn = null;
      if (pricingPick()) {
        for (const step of pricingSavePlan(pricingPick(), editingId())) {
          if (step.call === 'patch') continue;
          try {
            if (step.call === 'saveGroup') await props.pricing.saveGroup(step.body);
            else pricedPkn = pricingDryRunPrice(await props.pricing.apply(step.body), originalPkn());
          } catch (err) {
            setError(err.message || 'The price was not applied.');
            return;
          }
        }
      }
      props.onListed?.({
        ...props.editing,
        ...draft,
        ...(pricedPkn != null ? { pricePkn: pricedPkn } : {}),
        id: editingId(),
      });
      return;
    }
    if (!signedIn()) {
      navigate(authFrom(props.fromPath));
      return;
    }
    const editing = isEditing();
    const id = editingId();
    if (!editing && chips().shipping && !shipFromCountry()) {
      setShipGateDraft('');
      setShipGateOpen(true);
      return;
    }
    // An edit builds and validates its body in editDraft; below is the create path.
    const edit = editing ? editDraft() : null;
    if (editing && !edit) return;
    const amount = price()
      ? listingPriceToPkn(price(), currency())
      : listingPriceToPkn(graphPrice(), currency());
    const quantity = Number.parseInt(qty(), 10);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) {
      setError('Enter a valid price and quantity.');
      return;
    }
    const flags = chips();
    if (flags.graded && (!company().trim() || !grade().trim() || !cert().trim())) {
      setError('Enter grading company, grade and certification ID.');
      return;
    }
    const row = card();
    setSaving(true);
    setError('');
    setDone('');
    let pendingId = '';
    try {
      const token = await getBearer();
      if (!token) {
        navigate(authFrom(props.fromPath));
        return;
      }
      pendingId = editing ? '' : `pending-${Date.now()}`;
      if (pendingId) {
        props.onListed?.({
          id: pendingId,
          pending: true,
          cardId: publicCardId(row),
          sellerUid: uid(),
          sellerName: sellerName(),
          sellerCountry: shipFromCountry(),
          pricePkn: amount,
          quantityAvailable: quantity,
          condition: condition(),
          language: language(),
          status: 'active',
          reverse: foil() === 'reverse',
          firstEdition: flags.firstEd,
          graded: flags.graded,
        });
      }
      const fields = {
        condition: condition(),
        language: language(),
        pricePkn: amount,
        quantityAvailable: quantity,
        signed: false,
        reverse: foil() === 'reverse',
        firstEdition: flags.firstEd,
        foilState: foil(),
        sealed: flags.sealed,
        graded: flags.graded,
        gradingCompany: flags.graded ? company().trim() : null,
        grade: flags.graded ? grade().trim() : null,
        certificationId: flags.graded ? cert().trim() : null,
        shippingAvailable: flags.shipping,
        reserveAvailable: false,
        nftAvailable: false,
        sellerComment: comment().trim(),
        ...(!editing || (stockReady() && ownLocation() !== null) ? { location: locationValue() } : {}),
        source: 'pokoin_user_listing',
        cardName: row.name,
        cardImageUrl: row.heroImageUrl || row.imageUrl || '',
        setName: props.identity.set,
        collectorNumber: props.identity.number,
      };
      const saved = editing
        ? await updateListing(id, edit, token)
        : await createListing({
          cardId: publicCardId(row),
          sellerName: sellerName(),
          sellerCountry: shipFromCountry(),
          shipFromCountry: shipFromCountry(),
          sellerReputationLabel: 'New',
          targets: {
            pokoin: targets?.pokoin !== false,
            cardtrader: targets?.cardtrader === true,
          },
          ...fields,
        }, token);
      track(Action.sell, row);
      // One click, one order: the listing first, then the pricing it follows.
      const pricing = pricingPick();
      let pricedPkn = null;
      let pricingFailed = '';
      if (editing && pricing) {
        for (const step of pricingSavePlan(pricing, id)) {
          if (step.call === 'patch') continue;
          try {
            if (step.call === 'saveGroup') await props.pricing.saveGroup(step.body);
            else {
              const answer = await props.pricing.apply(step.body);
              pricedPkn = pricingDryRunPrice(answer, originalPkn());
            }
          } catch (err) {
            // The listing saved; the price did not follow. The seller stays in
            // the drawer with their own price and can save again.
            pricingFailed = err.message || 'the price was not applied.';
            break;
          }
        }
      }
      if (pricingFailed) {
        setDone(editing ? 'Listing updated.' : 'Listing created.');
        setError(`Saved, but the price was not applied: ${pricingFailed}`);
        backToCustom();
        priceTyped = false;
        priceManual = true;
        setPrice(priceText(originalPkn()));
        return;
      }
      if (saved?.cardtrader && saved.cardtrader.ok === false) {
        setDone(editing ? 'Listing updated.' : 'Listed on Pokoin.');
        setError(saved.cardtrader.error || 'CardTrader push failed.');
      } else if (saved?.listing === null && saved?.cardtrader?.ok) {
        setDone('Listed on CardTrader.');
      } else if (editing && leftGroupLine(saved)) {
        // The new price took the listing out of its pricing group.
        setDone(`Listing updated. ${leftGroupLine(saved)}`);
        setPriceGroup(null);
      } else {
        setDone(editing ? 'Listing updated.' : 'Listing created.');
      }
      if (!editing) setQty('1');
      setStockVersion((n) => n + 1);
      const listingRow = saved?.id ? saved : saved?.listing;
      // The group or strategy set the price after the PATCH, so the row shows it.
      if (listingRow && pricedPkn != null) listingRow.pricePkn = pricedPkn;
      if (listingRow?.id && photos().length) {
        const attached = await saveListingPhotos(token, listingRow.id, photos());
        listingRow.photoUrls = attached?.photoUrls || photos();
      }
      if (listingRow?.id) {
        props.onListed?.(pendingId ? { ...listingRow, replaceId: pendingId } : listingRow);
      } else if (pendingId) {
        props.onListed?.({ remove: true, id: pendingId });
      }
    } catch (err) {
      if (pendingId) props.onListed?.({ remove: true, id: pendingId });
      if (err.status === 401) {
        navigate(authFrom(props.fromPath));
        return;
      }
      setError(
        (drawer() && CARDTRADER_REFUSALS.has(err.message) && (err.body?.message || err.body?.error))
        || err.message
        || (editing ? 'Update failed.' : 'Listing failed.'),
      );
    } finally {
      setSaving(false);
    }
  }

  async function addPhotos(event) {
    const files = [...(event.currentTarget.files || [])];
    event.currentTarget.value = '';
    const room = MAX_LISTING_PHOTOS - photos().length;
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
  }

  // The drawer reads its error where it appears: the server's own message for
  // a change CardTrader refuses (422 / 409 / 502) or a pricing step that failed.
  createEffect(error, (message) => {
    if (drawer() && message) errorEl?.focus();
  });

  // Every visitor came to buy first, signed in or not: the sell form waits
  // behind one strip instead of being the biggest panel on the desk. The strip
  // is the same for both, so the desk has one layout.
  const [opened, setOpened] = createSignal(false);
  const collapsed = () => !isEditing() && !opened();

  // ── Pieces both layouts show, so no field is marked up twice ──────────────
  function priceField() {
    return (
      <label class="sell-field grow price">
        Price
        <input
          inputmode="decimal"
          value={price()}
          placeholder={hint()}
          readOnly={drawer() && Boolean(pricingPick())}
          onFocus={() => {
            priceFocused = true;
            if (!priceManual) setPrice('');
          }}
          onBlur={() => {
            priceFocused = false;
            if (!priceManual && graphPrice()) setPrice(graphPrice());
          }}
          onInput={(event) => {
            const next = event.currentTarget.value;
            setPrice(next);
            priceManual = next.trim() !== '';
            priceTyped = true;
            takeOwnPrice();
          }}
        />
      </label>
    );
  }

  function quotesRow() {
    return (
      <Show when={presets().length}>
        <div class="sell-market-quotes" role="group" aria-label="From the market">
          <span class="sell-quote-label">From the market</span>
          <For each={presets()}>
            {(row) => (row.reference ? (
              <span class="sell-quote is-reference" title={row.title}>{row.label} {inventoryMarketLabel({ currency: 'USD', low: row.usdLow, high: row.usdHigh })}</span>
            ) : (
              <button type="button" class="sell-quote" title={row.title} onClick={() => takePreset(row)}>
                {row.label} <b>{presetPrice(row.pkn)}</b>
              </button>
            ))}
          </For>
        </div>
      </Show>
    );
  }

  function gradedRow() {
    return (
      <Show when={chips().graded}>
        <div class="sell-row">
          <label class="sell-field grow">
            Grading company
            <input value={company()} onInput={(event) => setCompany(event.currentTarget.value)} />
          </label>
          <label class="sell-field">
            Grade
            <input value={grade()} onInput={(event) => setGrade(event.currentTarget.value)} />
          </label>
          <label class="sell-field grow">
            Certification
            <input value={cert()} onInput={(event) => setCert(event.currentTarget.value)} />
          </label>
        </div>
      </Show>
    );
  }

  function photosRow() {
    return (
      <div class="sell-photos">
        <For each={photos()}>
          {(url) => (
            <button
              type="button"
              class="listing-photo"
              aria-label="Remove photo"
              onClick={() => setPhotos((current) => current.filter((item) => item !== url))}
            >
              <img src={url} alt="" />
            </button>
          )}
        </For>
        <Show when={photos().length < MAX_LISTING_PHOTOS}>
          <label class="listing-photo-add" aria-label="Add photo">
            <CameraIcon />
            <input type="file" accept="image/*" multiple hidden disabled={saving()} onChange={addPhotos} />
          </label>
        </Show>
      </div>
    );
  }

  function messages() {
    return (
      <>
        <Show when={error()}>
          <p class="sell-msg error" role={drawer() ? 'alert' : undefined} tabindex={drawer() ? '-1' : undefined} ref={(el) => { errorEl = el; }}>
            {error()}
          </p>
        </Show>
        <Show when={done()}><p class="sell-msg ok">{done()}</p></Show>
      </>
    );
  }

  // ── The drawer ────────────────────────────────────────────────────────────
  dismissWhileOpen(pricingOpen, setPricingOpen, () => pricingRoot);

  const otherCode = () => [...new Set(currencies())].find((code) => code !== currency()) || '';
  const typedPkn = () => (price() ? listingPriceToPkn(price(), currency()) : listingPriceToPkn(graphPrice(), currency()));
  /** The same price in the unit the field is not using. */
  const otherUnitLine = () => {
    const code = otherCode();
    const value = typedPkn();
    if (!code || !(value > 0)) return '';
    return code === 'PKN'
      ? `= ${formatPknNumber(Math.round(value), { maximumFractionDigits: 0 })} PKN`
      : `= ${formatPknNumber(fiatFromPkn(value, code), { maximumFractionDigits: 2 })} ${code}`;
  };

  /** The drawer changes the unit written in the field, not the price itself. */
  function switchUnit(code) {
    if (code === currency()) return;
    const typed = price();
    currencyManual = true;
    if (typed) setPrice(priceInputFromPkn(listingPriceToPkn(typed, currency()), code));
    setCurrency(code);
  }

  function currencyChips() {
    return (
      <div class="sell-chip-row is-currency" role="group" aria-label="Currency">
        <For each={[...new Set(currencies())]}>
          {(code) => (
            <button
              type="button"
              class={['inv-chip', { on: code === currency() }]}
              aria-pressed={String(code === currency())}
              onClick={() => switchUnit(code)}
            >
              {code}
            </button>
          )}
        </For>
      </div>
    );
  }

  function pricingKeys(event) {
    const options = pricingList ? [...pricingList.querySelectorAll('[role="option"]')] : [];
    if (!options.length) return;
    const at = options.indexOf(document.activeElement);
    const move = (next) => {
      event.preventDefault();
      options[(next + options.length) % options.length]?.focus();
    };
    if (event.key === 'ArrowDown') move(at + 1);
    else if (event.key === 'ArrowUp') move(at - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(options.length - 1);
    else if (event.key === 'Escape') {
      // The menu swallows it, so the drawer stays open.
      event.preventDefault();
      event.stopPropagation();
      setPricingOpen(false);
      pricingTrigger?.focus();
    } else if (event.key === 'Tab') setPricingOpen(false);
  }

  function pricingMenu() {
    return (
      <div class={['sell-pricing-menu', { 'is-open': pricingOpen() }]} ref={(el) => { pricingRoot = el; }}>
        <button
          type="button"
          class="sell-pricing-btn"
          ref={(el) => { pricingTrigger = el; }}
          aria-haspopup="listbox"
          aria-expanded={pricingOpen() ? 'true' : 'false'}
          onClick={() => setPricingOpen((next) => !next)}
        >
          <strong>{pricingLabel()}</strong>
          <span class="sell-pricing-caret" aria-hidden="true">▾</span>
        </button>
        <Show when={pricingOpen()}>
          <ul class="sell-pricing-list" role="listbox" aria-label="Pricing" ref={(el) => { pricingList = el; }} onKeyDown={pricingKeys}>
            <For each={pricingEntries()}>
              {(entry) => (entry.kind === 'separator' ? (
                <li class="sell-pricing-sep" role="presentation" />
              ) : (
                <li>
                  <button
                    type="button"
                    role="option"
                    aria-selected={String(entry.kind === 'custom' ? !pricingPick() : pricingPick()?.id === entry.id)}
                    onClick={() => choosePricing(entry)}
                  >
                    {entry.label}
                  </button>
                </li>
              ))}
            </For>
          </ul>
        </Show>
      </div>
    );
  }

  // The Reverse chip (Pokémon) or the game's own foil chip, and the rest in a select.
  const reverseFoil = () => foils.find((row) => row.value === 'reverse') || null;
  const chipFinishes = () => (reverseFoil() ? [] : foils.filter((row) => row.value !== 'standard'));
  const selectFinishes = () => (reverseFoil() ? foils.filter((row) => row.value !== 'reverse') : []);
  const shownFinish = () => (foil() === 'reverse' ? 'standard' : foil());

  function propertyChips() {
    const order = ['firstEd', 'signed', 'altered', 'graded', 'sealed', 'shipping'];
    const byKey = Object.fromEntries(extraChips().map((chip) => [chip.key, chip]));
    const list = order.map((key) => byKey[key]).filter(Boolean);
    const finishes = [reverseFoil(), ...chipFinishes()].filter(Boolean)
      .map((row) => ({ key: `foil:${row.value}`, label: row.label }));
    list.splice(list.findIndex((chip) => chip.key === 'firstEd') + 1, 0, ...finishes);
    return (
      <For each={list}>
        {(chip) => {
          const isFoil = String(chip.key).startsWith('foil:');
          const value = isFoil ? chip.key.slice(5) : '';
          const on = () => (isFoil ? foil() === value : chips()[chip.key] === true);
          return (
            <button
              type="button"
              class={['inv-chip', { on: on() }]}
              aria-pressed={String(on())}
              onClick={() => (isFoil ? setFoil(foil() === value ? 'standard' : value) : toggleChip(chip.key))}
            >
              {chip.label}
            </button>
          );
        }}
      </For>
    );
  }

  function drawerBody() {
    return (
      <>
        <div class="sell-drawer-fields" hidden={strategyStep()}>
          <div class="sell-drawer-block sell-pricing">
            <span class="sell-drawer-label">Pricing</span>
            {pricingMenu()}
            <div class="sell-price-line">
              {priceField()}
              <Show when={otherUnitLine()}><span class="sell-price-eq">{otherUnitLine()}</span></Show>
            </div>
            {currencyChips()}
            <Show when={pricingNoteLine()}>
              <p class="mypokoin-help sell-pricing-note" role="status">{pricingNoteLine()}</p>
            </Show>
            {quotesRow()}
            <Show when={!pricingPick() && priceGroup()}>
              <p class="mypokoin-help listing-group-note">{groupPriceNote(priceGroup())}</p>
            </Show>
          </div>
          <div class="sell-drawer-block">
            <span class="sell-drawer-label">Quantity</span>
            <QtyStepper editable class="chat-qty sell-qty" qty={qty()} min={1} max={99} onChange={setQty} />
          </div>
          <div class="sell-drawer-block">
            <span class="sell-drawer-label">Condition</span>
            <div class="sell-chip-row" role="group" aria-label="Condition">
              <For each={MOOD_CONDS}>
                {(row) => (
                  <button
                    type="button"
                    class={['inv-chip', { on: condition() === row.value }]}
                    aria-pressed={String(condition() === row.value)}
                    title={row.label}
                    onClick={() => setCondition(row.value)}
                  >
                    {row.value}
                  </button>
                )}
              </For>
            </div>
          </div>
          <div class="sell-drawer-block">
            <span class="sell-drawer-label">Language</span>
            <div class="sell-chip-row" role="group" aria-label="Language">
              <For each={listLangs()}>
                {(code) => (
                  <button
                    type="button"
                    class={['inv-chip', { on: code === language() }]}
                    aria-pressed={String(code === language())}
                    onClick={() => setLanguage(code)}
                  >
                    {code}
                  </button>
                )}
              </For>
            </div>
          </div>
          <div class="sell-drawer-block">
            <span class="sell-drawer-label">Properties</span>
            <div class="sell-chip-row" role="group" aria-label="Listing extras">
              {propertyChips()}
            </div>
            <Show when={selectFinishes().length > 1}>
              <label class="sell-field sell-pick foil-pick">
                <span class="sell-drawer-label">Finish</span>
                <select value={shownFinish()} onChange={(event) => setFoil(event.currentTarget.value)}>
                  <For each={selectFinishes()}>
                    {(row) => <option value={row.value} selected={row.value === shownFinish()}>{row.label}</option>}
                  </For>
                </select>
              </label>
            </Show>
            {gradedRow()}
          </div>
          <label class="sell-drawer-block sell-comment">
            <span class="sell-drawer-label">Seller comment · public</span>
            <input value={comment()} onInput={(event) => setComment(event.currentTarget.value)} />
          </label>
          <div class="sell-drawer-block sell-location">
            <label class="sell-field location-pick">
              <span class="sell-drawer-label">Location · private</span>
              <select
                value={box()}
                onChange={(event) => {
                  boxTouched = true;
                  setBox(event.currentTarget.value);
                }}
              >
                <option value="" selected={!box()}>None</option>
                <For each={boxOptions()}>
                  {(name) => <option value={name} selected={name === box()}>{name}</option>}
                </For>
              </select>
            </label>
            <Show when={locationValue() && locationValue() !== box()}>
              <span class="sell-slot">{locationValue().slice(box().length)}</span>
            </Show>
          </div>
          <div class="sell-drawer-block sell-photos-block">
            <span class="sell-drawer-label">Photos</span>
            {photosRow()}
          </div>
          {messages()}
        </div>
        <Show when={strategyStep() && strategyEditor}>
          <div class="sell-drawer-step">
            <button type="button" class="pricer-back" onClick={() => setStrategyStep(false)}>← Back to the listing</button>
            <StrategyEditor editor={strategyEditor} heading={false} />
          </div>
        </Show>
        <footer class="sell-drawer-foot">
          <Show
            when={signedIn() || props.preview}
            fallback={(
              <a
                class="signin-link"
                href={authFrom(props.fromPath)}
                rel={authAnchorRel(authFrom(props.fromPath)) || undefined}
                onClick={() => track(Action.sell, card())}
              >
                Sign in
              </a>
            )}
          >
            <button
              type="button"
              class="btn list-btn sell-save"
              disabled={saving() || (!props.preview && !ready())}
              title="Save listing changes"
              onClick={() => submit()}
            >
              {saving() ? 'Saving…' : 'Save changes'}
            </button>
          </Show>
          <Show when={props.onDelete}>
            <button
              type="button"
              class="btn ghost pricer-danger sell-delete sell-delete-icon"
              disabled={saving()}
              title="Unlist this card"
              aria-label="Delete listing"
              onClick={() => props.onDelete()}
            >
              <TrashIcon />
            </button>
          </Show>
        </footer>
      </>
    );
  }

  return (
    <Show
      when={!collapsed()}
      fallback={(
        <section class="panel sell-form is-collapsed">
          <div class="add-head">
            <h2>Have this card?</h2>
            <Show when={props.sellNowNote}>
              <span class="sell-strip-note">{props.sellNowNote}</span>
            </Show>
            <span class="sell-strip-actions">
              <Show when={props.onSellNow}>
                <button type="button" class="btn ghost sell-open sell-now" onClick={() => props.onSellNow()}>Sell now</button>
              </Show>
              <button type="button" class="btn ghost sell-open" onClick={() => setOpened(true)}>List yours</button>
            </span>
          </div>
        </section>
      )}
    >
    <section class={['panel sell-form', { 'is-editing': isEditing(), 'is-drawer': drawer() }]} ref={(el) => { formEl = el; }}>
      {drawer() ? drawerBody() : (
        <>
      <div class="add-head">
        <h2>{isEditing() ? 'Edit listing' : 'List your card'}</h2>
        <Show
          when={signedIn()}
          fallback={(
            <a
              class="signin-link"
              href={authFrom(props.fromPath)}
              rel={authAnchorRel(authFrom(props.fromPath)) || undefined}
              onClick={() => track(Action.sell, card())}
            >
              Sign in
            </a>
          )}
        >
          <span class="seller-chip">
            {sellerName()}
            <Show when={isEditing()}>
              <button type="button" class="linkish sell-cancel-edit" onClick={() => props.onCancelEdit?.()}>
                Cancel edit
              </button>
            </Show>
            <Show when={!isEditing()}>
              <button type="button" class="linkish sell-close" onClick={() => setOpened(false)}>
                Close
              </button>
            </Show>
          </span>
        </Show>
      </div>
      <div class="sell-row">
        {priceField()}
        <label class="sell-field currency">
          Currency
          <select
            value={currency()}
            onChange={(event) => {
              currencyManual = true;
              setCurrency(event.currentTarget.value);
            }}
          >
            <For each={[...new Set(currencies())]}>
              {(code) => <option value={code} selected={code === currency()}>{code}</option>}
            </For>
          </select>
        </label>
        <label class="sell-field qty">
          Qty
          <input inputmode="numeric" value={qty()} onInput={(event) => setQty(event.currentTarget.value)} />
        </label>
        <Show when={isEditing()}>
          <button
            type="button"
            class="btn list-btn"
            disabled={saving() || (!props.preview && (!ready() || !signedIn()))}
            title={props.preview || signedIn() ? 'Save listing changes' : 'Sign in to list'}
            onClick={() => submit()}
          >
            {saving() ? 'Saving…' : 'Save changes'}
          </button>
          <Show when={props.onDelete}>
            <button
              type="button"
              class="btn ghost pricer-danger sell-delete"
              disabled={saving()}
              title="Unlist this card"
              onClick={() => props.onDelete()}
            >
              Delete listing
            </button>
          </Show>
        </Show>
      </div>
      {quotesRow()}
      <Show when={priceGroup()}>
        <p class="mypokoin-help listing-group-note">{groupPriceNote(priceGroup())}</p>
      </Show>
      <Show when={!isEditing()}>
        <div class="sell-targets-row">
          <InventoryTargets
            mode="list"
            counts={{ cards: Number.parseInt(qty(), 10) || 1 }}
            intent="list"
            disabled={!ready() || (!signedIn() && ready())}
            busy={saving()}
            busyLabel="Listing…"
            onSubmit={(targets) => {
              if (!signedIn()) {
                navigate(authFrom(props.fromPath));
                return;
              }
              submit(targets);
            }}
          />
        </div>
      </Show>
      {/* The price field already shows what the card lists at; only the PKN-off notice keeps a line. */}
      <Show when={sellerSettings()?.acceptsPkn === false}>
        <p class="sell-pkn-eq">
          Buyers pay you by card · PKN payments are off in <a href="/profile">Profile</a>
        </p>
      </Show>
      <div class="sell-options-row">
        <div class="sell-field sell-pick condition-pick">
          <span class="sr-only">Condition</span>
          <ConditionPick value={condition()} onChange={setCondition} />
        </div>
        <div class="sell-field sell-pick language-pick">
          <span class="sr-only">Language</span>
          <ListingLangPick
            value={language()}
            listed={listLangs()}
            redirects={redirects()}
            onChange={setLanguage}
            onRedirect={(row) => setJump(() => row)}
          />
        </div>
        <label class="sell-field sell-pick foil-pick">
          <span class="sr-only">Finish</span>
          <select value={foil()} onChange={(event) => setFoil(event.currentTarget.value)}>
            <For each={foils}>
              {(row) => <option value={row.value} selected={row.value === foil()}>{row.label}</option>}
            </For>
          </select>
        </label>
        <div class="sell-chips" role="group" aria-label="Listing extras">
          <For each={extraChips()}>
            {(chip) => (
              <button
                type="button"
                class={chips()[chip.key] ? 'on' : ''}
                aria-pressed={chips()[chip.key] ? 'true' : 'false'}
                onClick={() => toggleChip(chip.key)}
              >
                {chip.label}
              </button>
            )}
          </For>
        </div>
        {photosRow()}
      </div>
      <div class="sell-location-row">
        <label class="sell-field location-pick">
          Location
          <select
            value={box()}
            onChange={(event) => {
              boxTouched = true;
              setBox(event.currentTarget.value);
            }}
          >
            <option value="" selected={!box()}>None</option>
            <For each={boxOptions()}>
              {(name) => <option value={name} selected={name === box()}>{name}</option>}
            </For>
          </select>
        </label>
        <Show when={locationValue() && locationValue() !== box()}>
          <span class="sell-slot">{locationValue().slice(box().length)}</span>
        </Show>
        <label class="sell-field comment comment-inline">
          Seller comment
          <input value={comment()} onInput={(event) => setComment(event.currentTarget.value)} />
        </label>
      </div>
      {gradedRow()}
      {messages()}
        </>
      )}
      <Show when={jump()}>
        <Portal mount={document.body}>
          <div class="lang-redirect" role="dialog" aria-modal="true" aria-labelledby="lang-redirect-title">
            <div class="lang-redirect-card">
              <p id="lang-redirect-title">You will be taken to the {jump()?.label} version of this card.</p>
              <div class="lang-redirect-actions">
                <button type="button" onClick={() => setJump(null)}>Stay here</button>
                <button
                  type="button"
                  class="lang-redirect-go"
                  onClick={() => {
                    const target = jump()?.card;
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
          </div>
        </Portal>
      </Show>
      <ShipFromCountryGate
        open={shipGateOpen()}
        value={shipGateDraft()}
        onChange={setShipGateDraft}
        busy={saving()}
        error={error()}
        onClose={() => setShipGateOpen(false)}
        onSave={async () => {
          setSaving(true);
          setError('');
          try {
            const token = await getBearer();
            const data = await saveSellerSettings({ shipFromCountry: shipGateDraft() }, token);
            setShipFromCountry(data.shipFromCountry || shipGateDraft());
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
    </Show>
  );
}
