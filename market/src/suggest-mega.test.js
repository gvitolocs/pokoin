import test from 'node:test';
import assert from 'node:assert/strict';
import { hasRivalMechanic, megaAliasCompact, rankNames, rankNamesExhaustive } from './suggest-rank.js';

const top = (query, n = 1) => rankNames(query).slice(0, n).map((row) => row.display);
const rankOf = (query, name) => rankNames(query).findIndex((row) => row.display === name);

test('mega + name reaches the XY titles M <Name> EX', () => {
  assert.deepEqual(top('mega rayquaza'), ['M Rayquaza ex']);
  for (const query of ['mega r', 'mega ra', 'mega ray', 'mega rayq']) {
    assert.deepEqual(top(query), ['M Rayquaza ex'], query);
  }
  assert.deepEqual(top('mega charizard', 3).sort(), ['M Charizard ex', 'Mega Charizard X ex', 'Mega Charizard Y ex'].sort());
  assert.ok(rankOf('mega lucario ex', 'M Lucario ex') >= 0);
  assert.equal(top('mega lucario ex')[0], 'Mega Lucario ex');
});

test('the mega alias only applies to M titles, never Mr. Mime', () => {
  assert.equal(megaAliasCompact('mega rayquaza'), 'mrayquaza');
  assert.equal(megaAliasCompact('mega'), '');
  assert.equal(megaAliasCompact('megarayquaza'), '');
  assert.ok(!top('mega r', 10).some((name) => /^Mr\.? Mime/i.test(name)));
});

test('M <Name> EX is a Mega card, not a rival mechanic of mega', () => {
  assert.equal(hasRivalMechanic('M Rayquaza ex', ['mega']), false);
  assert.equal(hasRivalMechanic('Rayquaza GX', ['mega']), true);
});

test('bare mega leads with Mega names, Meganium close behind; meg/megan complete to Meganium', () => {
  const mega = rankNames('mega').map((row) => row.display);
  assert.match(mega[0], /^Mega /);
  const meganium = mega.indexOf('Meganium');
  assert.ok(meganium > 0 && meganium < 6, `Meganium at ${meganium}`);
  assert.equal(top('meg')[0], 'Meganium');
  assert.equal(top('megan')[0], 'Meganium');
  assert.equal(top('meganium')[0], 'Meganium');
});

test('rankNames equals the exhaustive scan on mega queries (memo includes the alias)', () => {
  for (const query of ['mega rayquaza', 'megarayquaza', 'mega', 'mega r', 'meganium', 'm rayquaza']) {
    assert.deepEqual(
      rankNames(query).map((row) => [row.display, row.score]),
      rankNamesExhaustive(query).map((row) => [row.display, row.score]),
      query,
    );
  }
});

test('the printing scorer counts a typed mega as covered by an XY M title', async () => {
  const { scoreEntry, tokenizeQuery, nameTokens } = await import('./search-score.js');
  const doc = (name) => ({ langText: { en: { name: nameTokens(name), set: [] } }, prior: 1 });
  const score = (query, name) => scoreEntry(tokenizeQuery(query).tokens, doc(name));
  assert.equal(score('mega rayquaza', 'M Rayquaza EX').coverage, 2);
  assert.equal(score('mega rayquaza', 'Rayquaza').coverage, 1);
  assert.equal(score('mega rayquaza', 'Mr. Mime').coverage, 0);
  // Bare mega: a Mega name edges out the Meganium completion, slightly.
  const mega = score('mega', 'M Rayquaza EX');
  const meganium = score('mega', 'Meganium');
  assert.equal(mega.coverage, meganium.coverage);
  assert.ok(mega.quality > meganium.quality && mega.quality - meganium.quality < 0.5);
  // Plain rayquaza still prefers the plain name.
  assert.ok(score('rayquaza', 'Rayquaza').quality > score('rayquaza', 'M Rayquaza EX').quality);
});
