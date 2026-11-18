/**
 * The Vault: Pokoin's own stock, held on the admin account (username givi).
 * The card desk shows these listings in their own panel beside the Shop,
 * without the seller's name, country or a message button.
 */
export const VAULT_SELLER_UID = 'Ax7G1IOIOvZUd7mrIc5gsw0Fcgt2';

export function isVaultOffer(offer) {
  return String(offer?.sellerUid || offer?.seller_uid || '') === VAULT_SELLER_UID;
}

/** `{ vault, shop }`: the same offers split, each keeping its order. */
export function splitVaultOffers(offers = []) {
  const vault = [];
  const shop = [];
  for (const offer of offers || []) (isVaultOffer(offer) ? vault : shop).push(offer);
  return { vault, shop };
}
