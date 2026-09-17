import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveSuggestQuery, serializeResolution } from './suggest-resolve.js';
import { liveSuggestGroups, rememberPrintings, rememberSuggestGroups, resetSuggestLive } from './suggest-live.js';

/**
 * Discovered edge corpus — real catalog pathologies from the full-vocabulary
 * scan (docs/TYPEAHEAD_AUDIT.md §E). Every case encodes the winning entity,
 * not just "rows > 0".
 */

function namesOf(query) {
  const resolved = resolveSuggestQuery(query);
  assert.ok(resolved?.best, `${query} must resolve`);
  return resolved;
}

function bestIncludes(query, fragment) {
  const resolved = namesOf(query);
  const all = [
    ...resolved.best.entities.name.map((row) => row.display),
    ...resolved.best.entities.artist.map((row) => row.display),
  ];
  assert.ok(
    all.some((display) => display.toLowerCase().includes(String(fragment).toLowerCase().slice(0, 10))),
    `${query} → expected ${fragment}, got ${all.join('+') || '(none)'}`,
  );
  return resolved;
}

test('normalization: ascii typing recovers accented/punctuated names', () => {
  bestIncludes('flabebe', 'Flabébé');
  bestIncludes("farfetchd", "Farfetch'd");
  bestIncludes('type null', 'Type: Null');
  bestIncludes('typenull', 'Type: Null');
  bestIncludes('porygon z', 'Porygon-Z');
  bestIncludes('ho oh', 'Ho-Oh');
  bestIncludes('mr mime', 'Mr. Mime');
});

test('possessive/owner compounds: single-letter owner token survives', () => {
  bestIncludes('n zoroark', "N's Zoroark");
  bestIncludes('ns zoroark', "N's Zoroark");
  // 'imakuni' exact-matches the artist Imakuni? while the card projection is
  // possessive-prefix — a genuine tie, so assert the popup surfaces the card.
  resetSuggestLive();
  rememberSuggestGroups([{ name: 'Doduo', printings: [{ id: 'doduo', name: 'Doduo', set: 'Jungle' }] }]);
  // Mirror Chrome's artist hydration: the artist key AND the card-name cache.
  const imakuniCard = { id: 'imakuni-doduo', name: "Imakuni?'s Doduo", set: 'Promo' };
  rememberPrintings('artist:tomoaki-imakuni', [imakuniCard]);
  rememberSuggestGroups([{ name: "Imakuni?'s Doduo", printings: [imakuniCard] }]);
  const out = liveSuggestGroups('imakuni doduo', { preferPerGroup: 4, kind: 'singles' });
  const ids = out.groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.ok(ids.includes('imakuni-doduo'));
});

test('compound projections: constituents bind one card, any order', () => {
  bestIncludes('mewtwo mew', 'Mewtwo & Mew GX');
  bestIncludes('mew mewtwo gx', 'Mewtwo & Mew GX');
  bestIncludes('arceus palkia', 'Palkia GX');
  bestIncludes('arceus dialga', 'Palkia GX');
  bestIncludes('charizard braixen', 'Braixen GX');
  bestIncludes('suicune entei', 'Suicune & Entei LEGEND');
  bestIncludes('reshiram charizard', 'Reshiram & Charizard GX');
});

test('LEGEND homonym vs literal projection: literal wins, alias survives as tier', () => {
  const resolved = bestIncludes('palkia legend', 'Palkia & Dialga LEGEND');
  assert.equal(resolved.best.entities.set.length, 0);
  const serialized = serializeResolution(resolved);
  assert.ok(!serialized.includes('set:'), `Enter on 'palkia legend' must not set a CoL filter: ${serialized}`);
  assert.ok(resolved.tiers.some((tier) => tier.entities.set.some((entity) => entity.display === 'Call of Legends')));
  bestIncludes('dialga legend', 'Palkia & Dialga LEGEND');
  bestIncludes('suicune legend', 'Suicune & Entei LEGEND');
  bestIncludes('lugia legend', 'Lugia LEGEND');
});

test('set peels still own short codes and era aliases (legacy path)', () => {
  const resolved = bestIncludes('palkia sl', 'Palkia');
  assert.ok(serializeResolution(resolved).includes('set:Call of Legends'));
});

test('mechanic words: ex/gx/vmax ride the name text', () => {
  bestIncludes('keldeo ex', 'Keldeo EX');
  bestIncludes('charizard gx', 'Charizard GX');
  bestIncludes('m charizard ex', 'M Charizard ex');
});

test('artist + name: typo artist binds and name survives the query', () => {
  bestIncludes('kawayod', 'kawayoo');
  const resolved = bestIncludes('pika yuka', 'Pikachu');
  assert.equal(resolved.best.entities.artist[0]?.slug, 'yuka-morii');
});

test('protected syntax: collector + name, art shorthand', () => {
  bestIncludes('061 shieldon', 'Shieldon');
  bestIncludes('eevee i', 'Eevee');
});

test('metamorphic: case and whitespace preserve semantics', () => {
  const base = JSON.stringify(namesOf('pika yuka').best.entities);
  const upper = JSON.stringify(namesOf('PIKA YUKA').best.entities);
  const spaced = JSON.stringify(namesOf('  pika   yuka  ').best.entities);
  assert.equal(base, upper);
  assert.equal(base, spaced);
});

test('paint: palkia legend sections LEGEND halves before the CoL alias reading', () => {
  resetSuggestLive();
  rememberSuggestGroups([
    { name: 'Palkia & Dialga LEGEND', printings: [{ id: 'pd-top', name: 'Palkia & Dialga LEGEND', set: 'Triumphant', number: '102/107' }] },
    {
      name: 'Palkia',
      printings: [
        { id: 'col', name: 'Palkia', set: 'Call of Legends', number: '19/95' },
        { id: 'ge', name: 'Palkia', set: 'Great Encounters', number: '26/106' },
      ],
    },
  ]);
  const out = liveSuggestGroups('palkia legend', { preferPerGroup: 4, kind: 'singles' });
  const ids = out.groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.equal(ids[0], 'pd-top');
  assert.ok(ids.includes('col'));
  assert.ok(ids.includes('ge'));
});

test('paint: pika yuka paints the intersection, not Pikachu-only', () => {
  resetSuggestLive();
  rememberSuggestGroups([{ name: 'Pikachu', printings: [{ id: 'pika-base', name: 'Pikachu', set: 'Base Set' }] }]);
  rememberPrintings('artist:yuka-morii', [{ id: 'yuka-pika', name: 'Pikachu', set: 'Promo' }]);
  const out = liveSuggestGroups('pika yuka', { preferPerGroup: 4, kind: 'singles' });
  const ids = out.groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.ok(ids.includes('yuka-pika'));
});

test('paint: expedition stays a set browse (D00004M)', () => {
  resetSuggestLive();
  rememberSuggestGroups([{ name: 'Expedition Uniform', printings: [{ id: 'uniform', name: 'Expedition Uniform', set: 'Chilling Reign' }] }]);
  rememberPrintings('set:expedition-base-set', [{ id: 'exp1', name: 'Alakazam', set: 'Expedition Base Set' }]);
  const out = liveSuggestGroups('expedition', { preferPerGroup: 4, kind: 'singles' });
  const ids = out.groups.flatMap((group) => group.printings.map((row) => row.id));
  assert.ok(!ids.includes('uniform'));
  assert.ok(ids.includes('exp1'));
});
