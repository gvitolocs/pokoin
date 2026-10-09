import { createEffect, createMemo, createSignal, For, Show, untrack } from 'solid-js';
import { Portal } from '@solidjs/web';
import { useNavigate } from '@solidjs/router';
import {
  cardHref,
  createListing,
  fetchSellerListings,
  formatPkn,
  formatPknNumber,
  publicCardId,
  saveSellerSettings,
  updateListing,
} from '@market/api.js';
import { blankListingForm, listingFormFromOffer, MOOD_CONDS, nextBoxLocation } from '@market/card-desk.js';
import { saveListingPhotos, uploadChatPhoto } from '@market/chat-client.js';
import { game as currentGame } from '@market/game.js';
import { listingBox, liveInventoryListings, recentBoxes } from '@market/inventory-listings.js';
import { sellLanguages, versionRedirects } from '@market/listing-languages.js';
import { listingExtraChips, listingFoilOptions } from '@market/listing-faces.js';
import { conditionChipSrc } from '@market/listing-meta.js';
import { defaultCardLanguage, getSearchLang } from '@market/locale.js';
import { fiatFromPkn, LIST_CURRENCIES, listingPriceToPkn } from '@market/pkn.js';
import { authAnchorRel, authFrom } from '@market/punchouts.js';
import { suggestPriceFromSlices } from '@market/scan-pricing.js';
import { formatSellerPrice, priceInputFromPkn } from '@market/seller-currency.js';
import { Action, track } from '@market/track.js';
import { MAX_LISTING_PHOTOS, photoFileToJpeg } from '@market/user-photos.js';
import { authReady, authUser, getBearer, signedIn } from '../../stores/auth.js';
import { sellerCurrency, sellerSettings } from '../../stores/buyer.js';
import { authSession, profile } from '../../stores/session.js';
import { sellerNameOf } from '@market/auth-session.js';
import InventoryTargets from './InventoryTargets.jsx';
import ListingLangPick, { dismissWhileOpen } from './ListingLangPick.jsx';
import ShipFromCountryGate from './ShipFromCountryGate.jsx';

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

/**
 * "List your card" / "Edit listing" (market/src/pages/Card.jsx ListingForm).
 * Effects mirror the React dependency lists through memoized keys, so a card
 * that only gained fields (page hydrate) does not reset what the seller typed.
 */
export default function ListingForm(props) {
  const navigate = useNavigate();
  const gameId = currentGame().id;
  const foils = listingFoilOptions(gameId);
  const listChips = listingExtraChips(gameId);
  const card = () => props.card;
  const blank = untrack(() => blankListingForm(props.card));
  const [price, setPrice] = createSignal(blank.price);
  let priceManual = Boolean(untrack(() => props.editing?.id));
  let priceFocused = false;
  let currencyManual = false;
  let boxTouched = false;
  let formEl;
  const [currency, setCurrency] = createSignal(blank.currency);
  const [qty, setQty] = createSignal(blank.qty);
  const [condition, setCondition] = createSignal(blank.condition);
  const [language, setLanguage] = createSignal(blank.language);
  const [foil, setFoil] = createSignal(blank.foil);
  const [chips, setChips] = createSignal(blank.chips);
  const [comment, setComment] = createSignal(blank.comment);
  const [box, setBox] = createSignal('');
  const [stockRows, setStockRows] = createSignal([]);
  const [stockReady, setStockReady] = createSignal(false);
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
  const ready = () => authReady();
  const listLangs = createMemo(() => sellLanguages({
    nationality: card().nationality,
    setName: props.identity?.set || card().set,
    releaseLanguages: card().releaseLanguages,
  }));
  const redirects = createMemo(() => versionRedirects(props.versions || [], card().id, listLangs(), {
    nationality: card().nationality,
  }));
  const langKey = createMemo(() => listLangs().join(','));
  const editingId = createMemo(() => props.editing?.id || '');
  const isEditing = () => Boolean(editingId());

  function applyFields(next) {
    const listIn = currencyManual ? next.currency : untrack(sellerCurrency);
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
  createEffect(resetKey, () => {
    const editing = untrack(() => props.editing);
    const row = untrack(card);
    if (editing?.id) {
      applyFields(listingFormFromOffer(editing, row));
      priceManual = true;
      formEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    priceManual = false;
    applyFields(blankListingForm(row));
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
  const graphPrice = createMemo(() => {
    const pkn = graphPkn();
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
  const listedPkn = () => (price()
    ? listingPriceToPkn(price(), currency())
    : listingPriceToPkn(graphPrice(), currency()));

  function toggleChip(key) {
    setChips((current) => ({ ...current, [key]: !current[key] }));
  }

  // [signedIn, uid, editingId]: the seller's stock for the box/slot picker.
  const stockKey = createMemo(() => (signedIn() && uid() ? `${uid()}|${editingId()}` : ''));
  createEffect(stockKey, (key) => {
    if (!key) return undefined;
    const owner = untrack(uid);
    let cancelled = false;
    (async () => {
      try {
        const token = await getBearer();
        const data = await fetchSellerListings(owner, token, { limit: 1000 });
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
    return () => {
      cancelled = true;
    };
  });

  createEffect(
    () => [editingId(), stockRows(), props.editing?.location || ''],
    ([id, rows, location]) => {
      if (id) {
        const mine = rows.find((row) => row.id === id);
        setBox(listingBox(mine?.location || location || ''));
        return;
      }
      if (boxTouched) return;
      const first = recentBoxes(rows)[0] || '';
      if (first) setBox(first);
    },
  );

  const boxOptions = () => {
    const names = recentBoxes(stockRows());
    const current = box();
    if (current && !names.some((name) => name.toLowerCase() === current.toLowerCase())) return [current, ...names];
    return names;
  };
  const keptLocation = () => (editingId()
    ? (stockRows().find((row) => row.id === editingId())?.location || props.editing?.location || '')
    : '');
  const locationValue = () => {
    const current = box();
    if (!current) return '';
    const sameBox = listingBox(keptLocation()).toLowerCase() === current.toLowerCase();
    return sameBox ? keptLocation() : nextBoxLocation(stockRows(), current);
  };

  async function submit(targets = { pokoin: true, cardtrader: false }) {
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
        ...(!editing || stockReady() ? { location: locationValue() } : {}),
        source: 'pokoin_user_listing',
        cardName: row.name,
        cardImageUrl: row.heroImageUrl || row.imageUrl || '',
        setName: props.identity.set,
        collectorNumber: props.identity.number,
      };
      const saved = editing
        ? await updateListing(id, {
          ...fields,
          sellerUid: uid() || props.editing?.sellerUid,
          status: 'active',
        }, token)
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
      if (saved?.cardtrader && saved.cardtrader.ok === false) {
        setDone(editing ? 'Listing updated.' : 'Listed on Pokoin.');
        setError(saved.cardtrader.error || 'CardTrader push failed.');
      } else if (saved?.listing === null && saved?.cardtrader?.ok) {
        setDone('Listed on CardTrader.');
      } else {
        setDone(editing ? 'Listing updated.' : 'Listing created.');
      }
      if (!editing) setQty('1');
      const listingRow = saved?.id ? saved : saved?.listing;
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
      setError(err.message || (editing ? 'Update failed.' : 'Listing failed.'));
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

  return (
    <section class={['panel sell-form', { 'is-editing': isEditing() }]} ref={(el) => { formEl = el; }}>
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
          </span>
        </Show>
      </div>
      <div class="sell-row">
        <label class="sell-field grow">
          Price
          <input
            inputmode="decimal"
            value={price()}
            placeholder={hint()}
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
            }}
          />
        </label>
        <label class="sell-field currency">
          Currency
          <select
            value={currency()}
            onChange={(event) => {
              currencyManual = true;
              setCurrency(event.currentTarget.value);
            }}
          >
            <For each={LIST_CURRENCIES}>
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
            disabled={!ready() || saving() || (!signedIn() && ready())}
            title={signedIn() ? 'Save listing changes' : 'Sign in to list'}
            onClick={() => submit()}
          >
            {saving() ? 'Saving…' : 'Save changes'}
          </button>
        </Show>
      </div>
      <Show when={!isEditing()}>
        <div class="sell-targets-row">
          <InventoryTargets
            mode="list"
            counts={{ cards: Number.parseInt(qty(), 10) || 1 }}
            intent="list"
            disabled={!ready() || (!signedIn() && ready())}
            busy={saving()}
            busyLabel="Listing…"
            pricePkn={listedPkn()}
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
      <Show
        when={sellerCurrency() !== 'PKN'}
        fallback={(
          <Show when={currency() !== 'PKN' && listedPkn()}>
            <p class="sell-pkn-eq">Lists at {formatPkn(listedPkn())}</p>
          </Show>
        )}
      >
        <p class="sell-pkn-eq">
          {listedPkn() ? `Lists at ${formatSellerPrice(listedPkn(), sellerCurrency())} · ` : ''}
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
          <For each={listChips}>
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
      <Show when={error()}><p class="sell-msg error">{error()}</p></Show>
      <Show when={done()}><p class="sell-msg ok">{done()}</p></Show>
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
  );
}
