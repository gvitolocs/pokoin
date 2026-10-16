import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const src = fs.readFileSync(new URL('./CollectionHoldings.jsx', import.meta.url), 'utf8');

test('Collection red cross removes physical holdings via the authenticated BFF', () => {
  assert.match(src, /removeCollectionItem/);
  assert.match(src, /data-testid="collection-remove"/);
  // The label names the card: cardLabel(row) is cardName || name || cardId.
  assert.match(src, /aria-label=\{`Remove \$\{cardLabel\(row\(\)\)\} from collection`\}/);
  assert.match(src, /function cardLabel\(row\) \{\s*return row\?\.cardName \|\| row\?\.name \|\| row\?\.cardId/);
  // Only physical rows pass onRemove; NFT holdings keep no red cross.
  assert.match(src, /onRemove=\{removeItem\}/);
  assert.match(src, /<For each=\{heldNft\(\)\}>\{\(entry\) => <HoldingRow row=\{entry\.holding\} \/>\}<\/For>/);
  // The row updates in place from the API result (after/deleted).
  assert.match(src, /result\.deleted/);
  assert.match(src, /quantity: result\.after/);
});

test('Collection red cross is a styled X that hides while the remove is in flight', () => {
  assert.match(src, /class="thread-remove"/);
  assert.match(src, /disabled=\{props\.removing\}/);
  assert.match(src, /<path d="M6 6l12 12M18 6L6 18" \/>/);
});

test('MyPokoin owns the page head and the sign-in gate; holdings load over the BFF', () => {
  assert.doesNotMatch(src, /PageHead|<Navigate|RequireSignIn|SignedIn/);
  assert.match(src, /partitionHoldings|isNftHolding/);
  assert.match(src, /data-testid=\{`collection-\$\{colProps\.side\}`\}/);
  assert.match(src, /<Column side="held">/);
  assert.match(src, /<Column side="listed">/);
  assert.match(src, /fetchAllSellerListings|fetchSellerListings/);
  assert.match(src, /data-testid="collection-physical"|Physical/);
  assert.match(src, /Request physical shipping \(NFT\)|canShip/);
  assert.match(src, /fetchOwnedCollection/);
  assert.match(src, /Couldn't load your collection/);
  assert.match(src, /collection-retry/);
  assert.doesNotMatch(src, /onSnapshot/);
  assert.doesNotMatch(src, /user_card_collections/);
  assert.doesNotMatch(src, /firebase\/firestore/);
  assert.doesNotMatch(src, /Missing or insufficient permissions/);
});
