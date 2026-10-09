import { LISTING_DRAG_TYPE } from '@market/chat-listing.js';

/** True when a drag carries a Pokoin card / listing reference (trays, chat). */
export function carriesListing(event) {
  return [...(event.dataTransfer?.types || [])].includes(LISTING_DRAG_TYPE);
}
