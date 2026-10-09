import { postEvent } from './api.js';
import { withPrintingIdentity } from './identity.js';

/**
 * Marketplace action pipeline.
 *
 * Server only accepts eventType in { view, search, click, reserve, cart_add, sale }
 * and a public cardId (never ct_id). The UI gesture name is metadata.type.
 * No PII. source is always react-market via postEvent.
 */

export const Action = {
  viewCard: { eventType: 'view', type: 'card_view' },
  clickTile: { eventType: 'click', type: 'tile' },
  clickVersion: { eventType: 'click', type: 'version' },
  clickListing: { eventType: 'click', type: 'listing' },
  clickSet: { eventType: 'click', type: 'set' },
  clickChip: { eventType: 'click', type: 'chip' },
  clickBanner: { eventType: 'click', type: 'banner' },
  clickSuggest: { eventType: 'click', type: 'suggest' },
  zoomArt: { eventType: 'click', type: 'zoom' },
  share: { eventType: 'click', type: 'share' },
  copyLink: { eventType: 'click', type: 'copy' },
  watchlist: { eventType: 'click', type: 'watchlist' },
  sell: { eventType: 'click', type: 'sell' },
  clickArtist: { eventType: 'click', type: 'artist' },
  prevCard: { eventType: 'click', type: 'prev' },
  nextCard: { eventType: 'click', type: 'next' },
  buyIntent: { eventType: 'cart_add', type: 'buy_intent' },
  searchSubmit: { eventType: 'search', type: 'search_submit' },
  loadMore: { eventType: 'click', type: 'load_more' },
};

// Beacons leave after the next paint so a click's own frame never waits on
// JSON/Blob/sendBeacon; pagehide flushes whatever is still queued.
const pending = [];
let flushQueued = false;

function flushEvents() {
  flushQueued = false;
  for (const event of pending.splice(0)) {
    postEvent(event);
  }
}

function queueEvent(event) {
  pending.push(event);
  if (flushQueued) {
    return;
  }
  flushQueued = true;
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => setTimeout(flushEvents, 0));
  } else {
    setTimeout(flushEvents, 0);
  }
}

if (typeof addEventListener === 'function') {
  addEventListener('pagehide', flushEvents);
}

export function track(action, card = {}, extra = {}) {
  if (!action?.eventType) {
    return;
  }
  const printing = withPrintingIdentity(card);
  const id = Number(printing.id || printing.card_id || extra.cardId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return;
  }
  queueEvent({
    cardId: id,
    eventType: action.eventType,
    metadata: {
      type: extra.type || action.type,
      name: printing.name,
      set: printing.set || printing.set_name,
      number: printing.number,
      rarity: printing.rarity,
      itemKind: card.itemKind || card.item_kind,
      productType: card.productType || card.product_type,
      imageUrl: extra.imageUrl || card.heroImageUrl || card.gridImageUrl || card.imageUrl,
      ctId: card.ct_id != null ? String(card.ct_id) : undefined,
      query: extra.query,
      resultRank: extra.resultRank,
      resultCount: extra.resultCount,
    },
  });
}
