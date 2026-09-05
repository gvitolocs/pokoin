import assert from 'node:assert/strict';
import test from 'node:test';
import { vintedSearchText, vintedSearchUrl } from './identity.js';

test('Pokemon Vinted query is name + collector, not name alone', () => {
  const query = vintedSearchText({
    name: 'Gumshoos',
    set: 'Destined Rivals',
    number: 'Illustration Rare | 184/182',
  });
  assert.equal(query, 'Gumshoos 184');
  assert.equal(query.includes('Illustration'), false);
  assert.equal(query.includes('Destined'), false);
});

test('Pokemon Vinted query strips the printedTotal side of 113/156', () => {
  const query = vintedSearchText({
    name: 'Gumshoos',
    set_name: 'Ultra Prism',
    number: '113/156',
  });
  assert.equal(query, 'Gumshoos 113');
});

test('One Piece and Riftbound keep their game prefix and collector', () => {
  assert.equal(
    vintedSearchText({ name: 'Sanji', set: 'Romance Dawn', number: 'OP01-013' }, 'one_piece'),
    'One Piece Card Game Sanji OP01-013',
  );
  assert.equal(
    vintedSearchText({ name: 'Kai', set: 'Spiritforged', number: '001' }, 'riftbound'),
    'Riftbound TCG Kai 001',
  );
});

test('name-only fallback is the card name on Pokemon', () => {
  assert.equal(vintedSearchText('Gumshoos'), 'Gumshoos');
  assert.equal(vintedSearchText(''), '');
});

test('Vinted URL pins Hobby e collezionismo catalog 4824', () => {
  const url = vintedSearchUrl({
    name: 'Dawn',
    number: 'Illustration Rare | 129/094',
  });
  assert.equal(
    url,
    'https://www.vinted.it/catalog?search_text=Dawn%20129&catalog[]=4824',
  );
  assert.equal(url.includes('search_id'), false);
  assert.equal(url.includes('time='), false);
});
