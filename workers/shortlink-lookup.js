import idsBin from './card-ids.bin';
import startsBin from './card-starts.bin';
import blob from './card-slug-blob.txt';
import { slugFromPackedIndex, u32View } from './shortlink-path.js';

const ids = u32View(idsBin);
const starts = u32View(startsBin);

export function lookupSlug(cardId) {
  return slugFromPackedIndex(cardId, ids, starts, blob);
}
