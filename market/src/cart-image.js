import { ownCatalogImage, preferFullImage } from './image-urls.js';

/** A cart keeps Pokoin catalogue art, never an expiring CardTrader preview. */
export function cartImageFor(card = {}, offer = {}) {
  const advertised = offer?.cardImageUrl
    || offer?.imageUrl
    || card?.gridImageUrl
    || card?.heroImageUrl
    || card?.imageUrl
    || card?.image_url
    || card?.cdn_image_url
    || '';
  return ownCatalogImage(card, preferFullImage(advertised));
}

export function repairCartImage(row = {}) {
  const card = {
    id: row.cardId || row.card?.id,
    name: row.name || row.card?.name,
    canonicalPath: row.href || row.card?.canonicalPath,
  };
  return cartImageFor(card, { cardImageUrl: row.image });
}
