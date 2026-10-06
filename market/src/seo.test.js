import assert from 'node:assert/strict';
import test from 'node:test';
import { pokemonHref, speciesFromCard, speciesFromSlug, speciesLabel } from './pokemon-hubs.js';
import {
  breadcrumbJsonLd,
  cardSeoTitle,
  languageHrefFromNationality,
  pickRelatedCards,
  rarityHref,
  raritySlug,
  scoreRelated,
} from './seo.js';

test('species hubs slug Charizard and keep Nidoran labels', () => {
  assert.equal(speciesFromSlug('charizard')?.n, 6);
  assert.equal(speciesFromSlug('CHARIZARD')?.name, 'Charizard');
  assert.equal(speciesLabel('nidoranf'), 'Nidoran♀');
  assert.equal(pokemonHref('charizard', 'en'), '/marketplace/en/pokemon/charizard');
  assert.equal(speciesFromCard({ name: 'Charizard ex' })?.slug, 'charizard');
});

test('card SEO title is name set number, not a catalog id', () => {
  assert.equal(
    cardSeoTitle({ name: 'Charizard', set: 'Base Set', number: '4/102' }),
    'Charizard Base Set 4/102 Price & Cards for Sale | Pokoin',
  );
  assert.equal(
    cardSeoTitle({ id: '281978', name: 'Eevee', set: 'Pokémon Jungle', number: '140989' }),
    'Eevee Pokémon Jungle Price & Cards for Sale | Pokoin',
  );
});

test('related cards prefer the same Pokémon then the same set', () => {
  const charizard = { id: '1', name: 'Charizard', set: 'Base Set', rarity: 'Holo Rare' };
  const baseVenusaur = { id: '2', name: 'Venusaur', set: 'Base Set', rarity: 'Holo Rare' };
  const later = { id: '3', name: 'Charizard', set: 'Pokémon 151', rarity: 'Illustration Rare' };
  assert.ok(scoreRelated(charizard, later) > scoreRelated(charizard, baseVenusaur));
  const picked = pickRelatedCards(charizard, [[later, baseVenusaur]], 2);
  assert.equal(picked[0].id, '3');
});

test('rarity and language hubs stay on marketplace paths', () => {
  assert.equal(raritySlug('Special Illustration Rare'), 'special-illustration-rare');
  assert.equal(rarityHref('Holo Rare', 'en'), '/marketplace/en/rarities/holo-rare');
  assert.equal(languageHrefFromNationality('japanese', 'en'), '/marketplace/en/languages/japanese');
  assert.equal(languageHrefFromNationality('western', 'en'), '/marketplace/en/languages/english');
});

test('breadcrumb JSON-LD skips null crumbs and keeps a game-prefixed item URL', () => {
  const data = breadcrumbJsonLd([
    { name: 'Marketplace', href: '/one-piece/marketplace' },
    null,
    undefined,
    { href: '/marketplace/sets/two-legends' },
    { name: 'Two Legends', href: '/one-piece/marketplace/sets/two-legends' },
    { name: 'Tony Tony.Chopper' },
  ]);
  assert.equal(data['@type'], 'BreadcrumbList');
  assert.equal(data.itemListElement.length, 3);
  assert.deepEqual(data.itemListElement.map((row) => row.position), [1, 2, 3]);
  assert.equal(data.itemListElement[0].item, 'https://pokoin.com/one-piece/marketplace');
  assert.equal(data.itemListElement[1].item, 'https://pokoin.com/one-piece/marketplace/sets/two-legends');
  assert.equal(data.itemListElement[2].name, 'Tony Tony.Chopper');
  assert.equal(data.itemListElement[2].item, undefined);
  assert.deepEqual(breadcrumbJsonLd(null).itemListElement, []);
});
