/**
 * MyPokoin inventory row actions: a board row in the shape the desk listing
 * form reads, what an edit or an unlist does to the seller's book, the market
 * presets the editor offers, and the PATCH body of an edit.
 * Pure — no framework, no network — so the rules are testable on their own.
 */

import { inventoryMarketValue } from './inventory-price.js';
import { editPriceFields } from './pricing-group-note.js';
import { localizeStrategyName } from './pricer.js';
import { MAX_LISTING_PHOTOS } from './user-photos.js';

/**
 * Board rows come from two places: an API answer (camelCase) or the stored
 * book of the listing read, which keeps whatever the server sent
 * (`price_pkn`, `set_name`, …). Read one field through both spellings.
 */
function field(row, camel, snake = camel.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`)) {
  const value = row?.[camel];
  return value === undefined || value === null ? row?.[snake] : value;
}

const text = (value) => String(value ?? '').trim();

function number(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * One camelCase offer, as the listing form reads it (`listingFormFromOffer`).
 * `shippingAvailable` stays true unless the row says otherwise, like an offer.
 */
export function offerFromInventoryRow(row) {
  const photos = field(row, 'photoUrls', 'photo_urls');
  return {
    id: text(field(row, 'id') ?? field(row, 'listingId', 'listing_id')),
    cardId: text(field(row, 'cardId', 'card_id')),
    pricePkn: number(field(row, 'pricePkn', 'price_pkn')),
    quantityAvailable: number(field(row, 'quantityAvailable', 'quantity_available')),
    condition: text(field(row, 'condition')),
    language: text(field(row, 'language')),
    foilState: text(field(row, 'foilState', 'foil_state')),
    reverse: field(row, 'reverse') === true,
    firstEdition: field(row, 'firstEdition', 'first_edition') === true,
    signed: field(row, 'signed') === true,
    altered: field(row, 'altered') === true,
    sealed: field(row, 'sealed') === true,
    graded: field(row, 'graded') === true,
    gradingCompany: text(field(row, 'gradingCompany', 'grading_company')),
    grade: text(field(row, 'grade')),
    certificationId: text(field(row, 'certificationId', 'certification_id')),
    shippingAvailable: field(row, 'shippingAvailable', 'shipping_available') !== false,
    sellerComment: text(field(row, 'sellerComment', 'seller_comment')),
    location: text(field(row, 'location')),
    photoUrls: Array.isArray(photos) ? photos : [],
    status: text(field(row, 'status')) || 'active',
    sellerUid: text(field(row, 'sellerUid', 'seller_uid')),
    sourceListingId: text(field(row, 'sourceListingId', 'source_listing_id')),
    source: text(field(row, 'source')),
  };
}

/** The `card` prop the listing form needs: the row is all the desk has. */
export function cardFromInventoryRow(row) {
  const image = text(field(row, 'cardImageUrl', 'card_image_url'));
  return {
    id: text(field(row, 'cardId', 'card_id')),
    name: text(field(row, 'cardName', 'card_name')) || text(field(row, 'name')),
    imageUrl: image,
    heroImageUrl: image,
    set: text(field(row, 'setName', 'set_name')),
  };
}

/** The `identity` prop (set title + collector number) from the row. */
export function identityFromInventoryRow(row) {
  return {
    set: text(field(row, 'setName', 'set_name')),
    number: text(field(row, 'collectorNumber', 'collector_number')),
  };
}

/**
 * The answer of a listing edit merged into its row: the PATCH answers the
 * fields it touched, so the rest of the row (thumbnail, location, group)
 * stays. Untouched rows keep their objects, so the board keeps their nodes.
 */
export function applyEditedRow(rows, saved) {
  const list = Array.isArray(rows) ? rows : [];
  const id = text(saved?.id);
  if (!id) return list;
  let hit = false;
  const next = list.map((row) => {
    if (text(row?.id) !== id) return row;
    hit = true;
    return { ...row, ...saved };
  });
  return hit ? next : list;
}

/**
 * The row an unlist leaves behind: none. The book is built by
 * `loadOwnerBook` → `inventoryBooks.load`, whose page walk keeps only
 * `liveInventoryListings` rows (`isLiveInventoryListing`: status active or
 * paused with copies left). `cancelListing` sets status `inactive`, so the
 * server would drop the row on the next read and the book must not keep it
 * either; leaving it would show a listing that is no longer for sale.
 */
export function removeListingRow(rows, id) {
  const list = Array.isArray(rows) ? rows : [];
  const want = text(id);
  if (!want) return list;
  const next = list.filter((row) => text(row?.id) !== want);
  return next.length === list.length ? list : next;
}

/**
 * The listing is bound to a CardTrader product, by the server's own rule
 * (`sync_core::parse_ct_product_id`): the source listing id is `ct:<digits>`
 * or `cardtrader:<digits>`. A Card Rails key alone is not a product id.
 */
export function cardtraderLinked(row) {
  const raw = text(field(row, 'sourceListingId', 'source_listing_id')).toLowerCase();
  return /^(?:ct|cardtrader):\d+$/.test(raw);
}

/** The clickable presets, in the order the editor lists them. */
const PRESET_SOURCES = [
  ['cardtrader', 'CardTrader market'],
  ['cardmarketpro', 'Cardmarket pro'],
  ['cardmarketprivate', 'Cardmarket private'],
  ['pokoin', 'Pokoin cheapest'],
];

/** The ask beside the CardTrader net belongs in the hover text. */
function presetTitle(value) {
  const title = String(value.title || '');
  if (!value.askLabel || /\bask\b/i.test(title)) return title;
  return `${title} Ask ${value.askLabel}.`.trim();
}

/**
 * Market prices the editor offers for one row, from a price-check `prices`
 * map (the per-game answer, keyed as `priceCheckKey`). Sources without a
 * value are left out; TCGplayer stays a reference, never a preset, because
 * its quotes are USD and nothing here converts USD to PKN.
 */
export function listingPresets(prices, row) {
  const map = prices && typeof prices === 'object' ? prices : {};
  const presets = [];
  for (const [id, label] of PRESET_SOURCES) {
    const value = inventoryMarketValue(map, row, id);
    if (!value) continue;
    presets.push({ id, label, pkn: value.value, title: presetTitle(value) });
  }
  const tcg = inventoryMarketValue(map, row, 'tcgplayer');
  if (tcg) {
    presets.push({
      id: 'tcgplayer',
      label: 'TCGplayer',
      usdLow: tcg.low,
      usdHigh: tcg.high,
      title: tcg.title,
      reference: true,
    });
  }
  return presets;
}

/**
 * The PATCH body of a listing edit, as `updateListing` wants it.
 *
 * An edit sends only what the form actually shows, and never the fields that
 * are not the seller's to restate: not `source` (a CardTrader import would
 * lose its origin), not `sourceListingId` (the product binding), not the
 * catalogue copy (`cardName`, `cardImageUrl`, `setName`, `collectorNumber`),
 * not `reserveAvailable` / `nftAvailable` (options this form has). `signed`
 * and `altered` go only when their chip is on screen, else an edit would
 * clear a flag the seller set elsewhere. The price follows `editPriceFields`
 * (only a typed price, which also takes the listing out of its group), and a
 * paused listing stays paused: un-pausing is the seller's press, not a
 * side effect of saving a comment.
 */
export function editListingBody(form = {}, editing = null) {
  const flags = form.flags || {};
  const graded = flags.graded === true;
  const body = {
    condition: form.condition,
    language: form.language,
    quantityAvailable: form.quantity,
    foilState: form.foil,
    reverse: form.foil === 'reverse',
    firstEdition: flags.firstEd === true,
    sealed: flags.sealed === true,
    graded,
    gradingCompany: graded ? text(form.company) : null,
    grade: graded ? text(form.grade) : null,
    certificationId: graded ? text(form.cert) : null,
    shippingAvailable: flags.shipping !== false,
    sellerComment: text(form.comment),
    status: text(field(editing, 'status')).toLowerCase() === 'paused' ? 'paused' : 'active',
    ...editPriceFields(form.amount, field(editing, 'pricePkn', 'price_pkn'), form.priceTyped === true),
  };
  if (form.sendLocation) body.location = form.location || '';
  if (form.showSigned) body.signed = flags.signed === true;
  if (form.showAltered) body.altered = flags.altered === true;
  if (form.sellerUid) body.sellerUid = form.sellerUid;
  return body;
}

/** The group id of one listing; `memberships` is the store's Map or the server's pairs. */
export function pricingGroupOf(memberships, listingId) {
  const id = text(listingId);
  if (!id) return '';
  if (memberships instanceof Map) return text(memberships.get(id));
  for (const pair of memberships || []) {
    if (Array.isArray(pair) && text(pair[0]) === id) return text(pair[1]);
  }
  return '';
}

/** A strategy's own name, in the seller's currency; '' when the id is not one. */
export function strategyNameOf(strategies, id, ctx) {
  const strategy = (strategies || []).find((entry) => text(entry?.id) === text(id));
  return strategy ? text(localizeStrategyName(strategy.name, ctx)) : '';
}

/**
 * What the drawer's Pricing menu shows as chosen: the listing's group with
 * its strategy, or the price the seller typed.
 */
export function pricingMenuLabel({ memberships, groups, strategies, listingId, ctx } = {}) {
  const group = (groups || []).find((entry) => text(entry?.id) === pricingGroupOf(memberships, listingId));
  if (!group) return 'Custom price';
  const name = text(group.name) || 'Group';
  const strategy = strategyNameOf(strategies, group.strategyId, ctx);
  return `Group: ${name}${strategy ? ` · ${strategy}` : ''}`;
}

/**
 * The menu's entries in order: the seller's own price, every group with the
 * strategy it prices by, every strategy on its own, then "New strategy…".
 */
export function pricingMenuEntries({ groups, strategies, ctx } = {}) {
  const entries = [{ kind: 'custom', id: '', label: 'Custom price' }];
  for (const group of groups || []) {
    const id = text(group?.id);
    if (!id) continue;
    const name = text(group.name) || 'Group';
    const strategy = strategyNameOf(strategies, group.strategyId, ctx);
    entries.push({
      kind: 'group',
      id,
      name,
      strategyId: text(group.strategyId),
      label: `Group ${name}${strategy ? ` · ${strategy}` : ''}`,
    });
  }
  for (const strategy of strategies || []) {
    const id = text(strategy?.id);
    if (!id) continue;
    const name = strategyNameOf(strategies, id, ctx) || 'Strategy';
    entries.push({ kind: 'strategy', id, name, label: name });
  }
  entries.push({ kind: 'separator', id: '', label: '' });
  entries.push({ kind: 'new', id: '', label: 'New strategy…' });
  return entries;
}

/**
 * The dry run of one listing under the picked group or strategy: the group's
 * strategy prices it, and it joins the group only on save. Null when there is
 * nothing to check (a typed price, or a group with no strategy).
 */
export function pricingDryRunBody(choice, groups, listingId) {
  const id = text(listingId);
  const kind = text(choice?.kind);
  if (!id || (kind !== 'group' && kind !== 'strategy')) return null;
  const strategyId = kind === 'strategy'
    ? text(choice.id)
    : text((groups || []).find((entry) => text(entry?.id) === text(choice.id))?.strategyId);
  if (!strategyId) return null;
  return { strategyId, listingIds: [id], dryRun: true };
}

/**
 * The price a dry run gives this listing. An empty plan with `unchanged` set
 * means the price is already what the strategy says, so it stays; `noComp`
 * leaves no price at all, which the editor says outright.
 */
export function pricingDryRunPrice(answer, current = null) {
  const plan = Array.isArray(answer?.plan) ? answer.plan : [];
  const target = number(plan[0]?.target);
  if (target != null && target > 0) return target;
  if (Number(answer?.unchanged) > 0) return number(current);
  return null;
}

/**
 * The calls one "Save changes" click makes, in order: the listing PATCH first
 * (it carries the price only for a typed price — a group or strategy sets it),
 * then the pricing step. A group takes the listing in, then prices it as the
 * pricer pop-up does; a strategy only prices it.
 */
export function pricingSavePlan(choice, listingId) {
  const kind = text(choice?.kind) || 'custom';
  const steps = [{ call: 'patch', priceInPatch: kind === 'custom' }];
  const id = text(listingId);
  const picked = text(choice?.id);
  if (!id || !picked) return steps;
  if (kind === 'group') {
    steps.push({ call: 'saveGroup', body: { groupId: picked, add: [id] } });
    steps.push({ call: 'apply', body: { groupId: picked, listingIds: [id] } });
  } else if (kind === 'strategy') {
    steps.push({ call: 'apply', body: { strategyId: picked, listingIds: [id] } });
  }
  return steps;
}

/** The menu's "Custom price" entry: the seller's own number, no rule behind it. */
export const CUSTOM_PRICING = { kind: 'custom', id: '', name: 'Custom price', label: 'Custom price' };

/**
 * The editor's fields as one snapshot, with the price in PKN. The form lists
 * in the seller's currency, so comparing the typed string would call every
 * currency flip an edit, and a row opened and never touched would look dirty.
 */
export function listingFormState(form = {}) {
  const flags = form.chips || {};
  return {
    pricePkn: number(form.pricePkn),
    qty: text(form.qty),
    condition: text(form.condition),
    language: text(form.language),
    foil: text(form.foil),
    comment: text(form.comment),
    company: text(form.company),
    grade: text(form.grade),
    cert: text(form.cert),
    firstEd: flags.firstEd === true,
    sealed: flags.sealed === true,
    graded: flags.graded === true,
    shipping: flags.shipping === true,
    signed: flags.signed === true,
    altered: flags.altered === true,
    photos: Array.isArray(form.photos) ? form.photos.join('|') : text(form.photos),
    pricing: Boolean(form.pricing),
  };
}

/**
 * Whether the seller changed anything since the row came in. `baseline` is a
 * `listingFormState` snapshot taken after the form's own conversion.
 */
export function listingFormEdited(baseline, current) {
  if (!baseline) return false;
  const next = listingFormState(current);
  for (const [key, value] of Object.entries(next)) {
    if (baseline[key] !== value) return true;
  }
  return false;
}

/**
 * What the editor clears when it moves to another row. The drawer keeps its
 * form mounted across a switch, so anything not taken from the new row would
 * be saved onto it — the previous row's photos above all.
 */
export function rowEditorReset(offer = null) {
  const photos = Array.isArray(offer?.photoUrls) ? offer.photoUrls.slice(0, MAX_LISTING_PHOTOS) : [];
  return { photos, ownLocation: null, stockBoxes: [], stockReady: false, boxTouched: false, priceTyped: false };
}

/**
 * Whether the PATCH carries a price. A chosen group or strategy prices the
 * listing itself, so a number typed before the pick must not go with it.
 */
export function patchCarriesPrice(choice, priceTyped) {
  const kind = text(choice?.kind);
  if (kind && kind !== 'custom') return false;
  return priceTyped === true;
}

/**
 * A dry-run answer only counts while it is the newest one for this row: after
 * a switch or another pick, the answer still in flight would overwrite a price
 * the seller has since chosen.
 */
export function pricingAnswerCounts({ token, latest, listingId, currentId } = {}) {
  const run = number(token);
  return run != null && run === number(latest) && text(listingId) === text(currentId);
}

/**
 * The price the field shows for a menu entry: a group or strategy has none of
 * its own (its dry run fills it in), and the seller's own price goes back to
 * what the listing has, because a rule's preview was never their number.
 */
export function pricingFieldPkn(choice, originalPkn) {
  return text(choice?.kind) === 'custom' ? number(originalPkn) : null;
}

/** What a 200 answer says about the CardTrader side: its error, or nothing. */
export function cardtraderWarning(answer) {
  const pushed = answer?.cardtrader;
  if (!pushed || typeof pushed !== 'object' || pushed.ok !== false) return '';
  return text(pushed.error) || 'CardTrader push failed.';
}

/**
 * What one "Save changes" click leaves behind: the row the board writes — the
 * PATCH answer, because the listing saved even when the pricing step after it
 * did not — the note for the board's action line, and whether the editor keeps
 * itself open.
 */
export function listingSaveOutcome({ saved = null, pricedPkn = null, pricingFailed = '' } = {}) {
  const found = saved && (saved.id ? saved : saved.listing) || null;
  const row = found && pricedPkn != null ? { ...found, pricePkn: pricedPkn } : found;
  const failed = text(pricingFailed);
  return { row, note: cardtraderWarning(saved), pricingFailed: failed, keepOpen: Boolean(failed) };
}

/**
 * The board node of one listing, by its id: what the row looked like when the
 * drawer opened is gone after a switch or a re-render, so the board asks for
 * the node by id at the moment it needs it (focus back on close).
 */
export function listingRowNode(nodes, id) {
  const want = text(id);
  if (!want) return null;
  for (const node of nodes || []) {
    if (text(node?.dataset?.listingId) === want) return node;
  }
  return null;
}

/**
 * Whether the drawer is about to lose edits the seller has not saved. Another
 * row and closing the panel both lose them; opening the row it already shows,
 * or losing a clean form, does not — so the same rule answers for a switch and
 * a close, and the two can never ask differently.
 */
export function dropsUnsavedEdits({ dirty, openId, nextId = '' } = {}) {
  return dirty === true && text(openId) !== '' && text(nextId) !== text(openId);
}

/** The drawer's two chip rows: what the card is, and what the listing offers. */
export function drawerChipSplit(chips = []) {
  const offered = ['sealed', 'shipping'];
  const list = Array.isArray(chips) ? chips : [];
  return {
    property: list.filter((chip) => !offered.includes(text(chip?.key))),
    listing: list.filter((chip) => offered.includes(text(chip?.key))),
  };
}
