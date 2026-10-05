/** Our location order against Power Tools position order, for one Zero pack. */
export function pickingOrdersMatch(items = []) {
  if (!items.length) return { comparable: false, equal: false };
  const missing = items.some((item) => !(Number(item.powerTools?.position) > 0));
  if (missing) return { comparable: false, equal: false };
  const ours = items.map((item) => String(item.itemId));
  const theirs = [...items]
    .sort((a, b) => a.powerTools.position - b.powerTools.position
      || String(a.itemId).localeCompare(String(b.itemId)))
    .map((item) => String(item.itemId));
  return { comparable: true, equal: ours.every((id, index) => id === theirs[index]) };
}
