import { preferFullImage } from './image-urls.js';
import { printingIdentity } from './identity.js';

export const FAN_SLOTS = 3;
export const FAN_POOL = 8;

export function isSecretRare(card) {
  const identity = printingIdentity(card);
  const rarity = identity.rarity.toLowerCase();
  if (/secret rare|gold secret|hyper rare|special illustration rare/.test(rarity)) {
    return true;
  }
  const match = String(identity.number).match(/(\d+)\s*\/\s*(\d+)/);
  return Boolean(match && Number(match[1]) > Number(match[2]));
}

function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function cardId(card) {
  return String(card?.id || card?.card_id || '');
}

function heroSrc(card) {
  return preferFullImage(
    card?.heroImageUrl
    || card?.imageUrl
    || card?.cdn_image_url
    || card?.image_url
    || card?.gridImageUrl
    || card?.tileImageUrl
    || card?.homepageImageUrl
    || card?.homepage_image_url,
  );
}

/** Shuffle chase scans for the home promo fan. No pinned ids. */
export function pickFan(cards, n = FAN_POOL) {
  return pickSecretRares(cards, n);
}

export function pickSecretRares(cards, n = FAN_POOL) {
  const withArt = (cards || []).filter((card) => heroSrc(card));
  const secrets = withArt.filter(isSecretRare);
  const picked = [];
  const seen = new Set();
  function take(list) {
    for (const card of shuffle(list)) {
      const id = cardId(card);
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      picked.push(card);
      if (picked.length === n) {
        return;
      }
    }
  }
  take(secrets);
  if (picked.length < n) {
    take(withArt);
  }
  return picked;
}

export function fanSlots(cards) {
  if (cards.length >= 3) {
    return [cards[1], cards[0], cards[2]];
  }
  if (cards.length === 2) {
    return [cards[1], cards[0], null];
  }
  if (cards.length === 1) {
    return [null, cards[0], null];
  }
  return [null, null, null];
}

/** Left / center / right from a pool, skipping scans that already 404'd. */
export function fillFan(cards, failed = new Set(), slots = FAN_SLOTS) {
  const viable = (cards || []).filter((card) => {
    const id = cardId(card);
    return id && !failed.has(id);
  });
  return fanSlots(viable.slice(0, slots));
}
