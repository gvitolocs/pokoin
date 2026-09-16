import assert from 'node:assert/strict';
import test from 'node:test';
import { compactQuery, parseTypedQuery, rankNames } from './suggest-rank.js';

function topName(query) {
  const parsed = parseTypedQuery(query);
  const nameQuery = parsed.nameQuery || query;
  return rankNames(nameQuery)[0]?.display || '';
}

function assertName(query, want, extra = {}) {
  const parsed = parseTypedQuery(query);
  const got = topName(query);
  assert.equal(compactQuery(got).startsWith(compactQuery(want)) || compactQuery(got) === compactQuery(want) || got === want, true, `${query} → ${got}, want ${want}`);
  assert.equal(got, want, `${query} ranked ${got}`);
  if (extra.keepName) {
    assert.match(compactQuery(parsed.nameQuery), extra.keepName, `${query} peeled name ${parsed.nameQuery}`);
  }
  if (extra.era) {
    assert.ok(parsed.eras.includes(extra.era), `${query} eras ${parsed.eras}`);
  }
  if (extra.noEra) {
    assert.ok(!parsed.eras.includes(extra.noEra), `${query} unexpectedly peeled ${extra.noEra}`);
  }
}

test('glaceon plasma peels the Plasma expansions, not Evolving Skies', () => {
  const parsed = parseTypedQuery('glaceon plasma');
  assert.equal(compactQuery(parsed.nameQuery), 'glaceon');
  assert.ok(parsed.setTokens.some((token) => token.compact === 'plasma'));
  assert.equal(topName('glaceon plasma'), 'Glaceon');
});

test('expedition peels Expedition Base Set, not Expedition Uniform', () => {
  const parsed = parseTypedQuery('expedition');
  assert.equal(parsed.nameQuery, '');
  assert.ok(parsed.setTokens.some((token) => token.compact === 'expedition'));
  assert.ok(parsed.setTokens.some((token) => (
    (token.setNames || []).some((name) => /expedition base set/i.test(name))
  )));
  assert.equal(topName('expedition pikachu'), 'Pikachu');
});

test('pair LEGEND is the card, not Paldea plus Call of Legends Dialga', () => {
  assertName('Palkia & Dialga Legend', 'Palkia & Dialga LEGEND', { noEra: 'Scarlet & Violet' });
  assertName('Palkia & Dialga LEGEND', 'Palkia & Dialga LEGEND');
  assertName('palkia and dialga legend', 'Palkia & Dialga LEGEND');
  assertName('Kyogre & Groudon LEGEND', 'Kyogre & Groudon LEGEND');
  assertName('Suicune & Entei LEGEND', 'Suicune & Entei LEGEND');
});

test('solo HGSS LEGEND halves keep LEGEND on the name', () => {
  assertName('Lugia LEGEND', 'Lugia LEGEND', { noEra: 'Call of Legends' });
  assertName('Ho-Oh LEGEND', 'Ho-Oh LEGEND', { noEra: 'Call of Legends' });
});

test('palkia legen / sl still peel Call of Legends', () => {
  const legen = parseTypedQuery('palkia legen');
  assert.equal(compactQuery(legen.nameQuery), 'palkia');
  assert.ok(legen.eras.includes('Call of Legends'));
  const sl = parseTypedQuery('palkai sl');
  assert.ok(sl.eras.includes('Call of Legends'));
  assert.equal(topName('palkia legen'), 'Palkia');
});

test('call of legends phrase still peels the set', () => {
  const parsed = parseTypedQuery('flareon call of legendsd');
  assert.ok(parsed.eras.includes('Call of Legends'));
  assert.equal(compactQuery(parsed.nameQuery), 'flareon');
});

test('Tag Team GX pairs keep tag team on the name', () => {
  assertName('Slowpoke & Psyduck Tag Team GX', 'Slowpoke & Psyduck Tag Team GX', { noEra: 'Sun & Moon' });
  assertName('Reshiram & Charizard GX', 'Reshiram & Charizard GX');
  assertName('Gardevoir & Sylveon GX', 'Gardevoir & Sylveon GX');
  assertName('Pikachu & Zekrom GX', 'Pikachu & Zekrom GX');
});

test('BREAK / LV.X / ex / V / VMAX / VSTAR / V-UNION stay on the card name', () => {
  assertName('Greninja BREAK', 'Greninja BREAK');
  assertName('Mewtwo LV.X', 'Mewtwo LV.X');
  assertName('Palkia LV.X', 'Palkia LV.X');
  assertName('Mimikyu ex', 'Mimikyu ex');
  assertName('Charizard VMAX', 'Charizard VMAX');
  assertName('Charizard VSTAR', 'Charizard VSTAR');
  assertName('Pikachu V', 'Pikachu V');
  assertName('Morpeko V-UNION', 'Morpeko V-UNION');
  assertName('morpeko v union', 'Morpeko V-UNION');
});

test('DP level numbers stay a name, not a collector peel', () => {
  const parsed = parseTypedQuery('Shuppet Lv.17');
  assert.equal(parsed.numberTokens.length, 0);
  assertName('Shuppet Lv.17', 'Shuppet Lv.17');
});

test('delta / prism / gold-star glyphs compact to the typed words', () => {
  assert.equal(compactQuery('Pikachu δ Delta Species'), 'pikachudeltaspecies');
  assert.equal(compactQuery('pikachu delta species'), 'pikachudeltaspecies');
  assertName('Pikachu δ Delta Species', 'Pikachu δ Delta Species');
  assertName('pikachu delta species', 'Pikachu δ Delta Species');
  assertName('Victini Prism Star', 'Victini ◇ Prism Star');
  assertName('Flareon Gold Star', 'Flareon ☆ Gold Star');
});

test('owned Pokemon, forms, mega, radiant, and paradox prefixes rank the printing name', () => {
  assertName("N's Zoroark ex", "N's Zoroark ex");
  assertName("Team Rocket's Meowth", "Team Rocket's Meowth");
  assertName("Iono's Bellibolt ex", "Iono's Bellibolt ex");
  assertName('Radiant Greninja', 'Radiant Greninja');
  assertName('Mega Lucario ex', 'Mega Lucario ex');
  assertName('mega lucario ex', 'Mega Lucario ex');
  assertName('Alolan Vulpix', 'Alolan Vulpix');
  assertName('Galarian Obstagoon', 'Galarian Obstagoon');
  assertName('Hisuian Growlithe', 'Hisuian Growlithe');
  assertName('Paldean Wooper', 'Paldean Wooper');
  assertName('Origin Forme Palkia VSTAR', 'Origin Forme Palkia VSTAR');
  assertName('Shining Charizard', 'Shining Charizard', { noEra: 'Sun & Moon' });
});

test('trainer and energy names still rank', () => {
  assert.ok(/Cynthia|Camilla/i.test(topName('Cynthia')));
  assert.ok(/Research|Professor/i.test(topName("Professor's Research")) || topName("Professor's Research").includes('Professor'));
  assert.equal(topName('Quick Ball'), 'Quick Ball');
});
