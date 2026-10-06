import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';

test('card bootstrap recognizes canonical slugged and numeric card URLs', () => {
  const source = readFileSync(new URL('./public/card-url-boot.js', import.meta.url), 'utf8');
  const context = createContext({ navigator: {}, URLSearchParams, encodeURIComponent });
  runInContext(source, context);
  const { cardBootPlan } = context;

  assert.equal(cardBootPlan('/marketplace/en/cards/713754', 'pokoin.com').id, '713754');
  assert.equal(cardBootPlan('/marketplace/en/cards/713754', 'pokoin.com').lang, 'en');
  assert.equal(cardBootPlan('/marketplace/en/cards/713754', 'pokoin.com').slug, '');
  const slugged = cardBootPlan(
    '/marketplace/en/cards/713754/card-jumbo-ice-cream-091-094-phantasmal-flames',
    'pokoin.com',
  );
  assert.equal(slugged.lang, 'en');
  assert.equal(slugged.id, '713754');
  assert.equal(slugged.slug, 'card-jumbo-ice-cream-091-094-phantasmal-flames');
  assert.equal(
    cardBootPlan('/marketplace/it/cards/713754/card-jumbo-ice-cream-091-094-phantasmal-flames', 'pokoin.com').lang,
    'it',
  );
  assert.equal(cardBootPlan('/api/marketplace-card-page?cardId=713754', 'pokoin.com'), null);
  assert.equal(
    cardBootPlan('/one-piece/marketplace/en/cards/598560/luffy', 'pokoin.com').apiGame,
    'one_piece',
  );
});
