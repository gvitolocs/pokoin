// Shop header logic: the Price column header toggles the two price orders of
// the existing offer sort; the sort menu keeps every sort option reachable.
export const SHOP_SORTS = Object.freeze([
  { value: 'price', label: 'Lowest price' },
  { value: 'price-desc', label: 'Highest price' },
  { value: 'qty', label: 'Most quantity' },
  { value: 'seller', label: 'Seller' },
]);

export function isPriceSort(sort) {
  return sort === 'price' || sort === 'price-desc';
}

/** Next sort when the Price header is clicked: lowest first <-> highest first; from any other sort, lowest first. */
export function nextPriceSort(sort) {
  return sort === 'price' ? 'price-desc' : 'price';
}

/** Arrow of the Price header: down for highest-first, up for lowest-first. */
export function priceArrow(sort) {
  return sort === 'price-desc' ? 'down' : 'up';
}

/** Index of the next menu option for an arrow/Home/End key, or -1 when the key is not navigation. */
export function menuStep(key, index, count) {
  if (!count) return -1;
  if (key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowUp') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return -1;
}
