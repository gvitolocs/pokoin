/**
 * MyPokoin listing edit: a price typed by hand on a listing in a pricing
 * group takes it out of the group (server rule `pricer::group_move`, see
 * docs/pricer-cardrails-contract.md). These lines tell the seller so.
 */

/** The group (`{ id, name }`) a listing is in, from fetchPricingGroups' answer, or null. */
export function listingPricingGroup(data, listingId) {
  const id = String(listingId ?? '');
  if (!id || !data || !Array.isArray(data.memberships) || !Array.isArray(data.groups)) return null;
  const pair = data.memberships.find((entry) => Array.isArray(entry) && String(entry[0]) === id);
  if (!pair) return null;
  const group = data.groups.find((entry) => entry && String(entry.id) === String(pair[1]));
  if (!group) return null;
  return { id: String(group.id), name: String(group.name || '') };
}

/** The note shown under the price while editing a grouped listing; '' for no group. */
export function groupPriceNote(group) {
  if (!group?.id) return '';
  return group.name
    ? `Priced by your pricing group “${group.name}”. Typing a new price takes this card out of the group.`
    : 'Priced by a pricing group. Typing a new price takes this card out of the group.';
}

/** The line added after a save that took the listing out of its group; '' otherwise. */
export function leftGroupLine(saved) {
  const left = saved?.leftPricingGroup ?? saved?.listing?.leftPricingGroup;
  if (!left?.id) return '';
  return left.name
    ? `It left the pricing group “${left.name}”: the price is yours now.`
    : 'It left its pricing group: the price is yours now.';
}
