import assert from 'node:assert/strict';
import test from 'node:test';
import { compactQuery, parseTypedQuery } from './suggest-rank.js';
import {
  activeLanguages,
  docFromPrinting,
  explainQuery,
  nameTokens,
  rankFreeText,
  scoreEntry,
  scoreGroups,
  tokenEvidence,
  tokenizeQuery,
} from './search-score.js';

const top = (query, opts) => rankFreeText(query, opts).map((row) => row.display);
const rankOf = (query, display, opts) => rankFreeText(query, { limit: 200, ...opts })
  .findIndex((row) => row.display === display);

// --- One model, coverage-first (the reported regressions) --------------------

test('palkia legend and pakia legend both lead with the compound LEGEND card', () => {
  // Case A (correct spelling) and Case B (typo) must converge — no engine fork.
  assert.equal(top('palkia legend')[0], 'Palkia & Dialga LEGEND');
  assert.equal(top('pakia legend')[0], 'Palkia & Dialga LEGEND');
});

test('the compound name outranks the single Palkia when both tokens hit the name', () => {
  assert.ok(rankOf('pakia legend', 'Palkia & Dialga LEGEND') < rankOf('pakia legend', 'Palkia'));
});

test('lugia legend and its one-edit typo degrade to the same card, no engine switch', () => {
  assert.equal(top('lugia legend')[0], 'Lugia LEGEND');
  assert.equal(top('lugai legend')[0], 'Lugia LEGEND');
});

test('pika + mechanic ranks the matching Pikachu form first, never a set', () => {
  for (const [query, form] of [
    ['pika ex', 'Pikachu ex'],
    ['pika gx', 'Pikachu GX'],
    ['pika v', 'Pikachu V'],
    ['pika vmax', 'Pikachu VMAX'],
  ]) {
    assert.equal(top(query)[0], form, `${query} → ${form}`);
  }
});

test('the full Pokemon name behaves under the same token rules', () => {
  assert.equal(top('pikachu ex')[0], 'Pikachu ex');
  assert.equal(top('pikachu gx')[0], 'Pikachu GX');
  assert.equal(top('pikachu vmax')[0], 'Pikachu VMAX');
});

test('real compound names resolve by component, combination and one-edit typo', () => {
  // Uses actual canonical strings in the catalog.
  const cases = [
    ['reshiram charizard', 'Reshiram & Charizard GX'],
    ['espeon deoxys', 'Espeon & Deoxys GX'],
    ['arceus dialga palkia', 'Arceus & Dialga & Palkia GX'],
  ];
  for (const [query, card] of cases) {
    assert.equal(top(query)[0], card, query);
    // A one-edit typo in the first component must not change the interpretation.
    const typo = query.replace(/^(\w)(\w)/, '$2$1'); // transpose first two letters
    assert.ok(rankOf(typo, card) >= 0, `${typo} still reaches ${card}`);
  }
});

test('coverage dominates: more tokens matched beats a more popular single-token card', () => {
  const two = rankFreeText('reshiram charizard', { limit: 1 })[0];
  assert.equal(two.coverage, 2);
});

// --- Short-token policy (Section 6) ------------------------------------------

test('short tokens (ex/gx/v) match exactly but are never prefix/typo-expanded', () => {
  const { tokens } = tokenizeQuery('gx');
  // exact hit on a name token
  assert.ok(tokenEvidence(tokens[0], { langText: { en: { name: ['pikachu', 'gx'] } } }));
  // must NOT prefix-expand to `gxsomething` or fuzzy-expand to a set
  assert.equal(tokenEvidence(tokens[0], { langText: { en: { name: ['gxfoobar'] } } }), null);
  assert.equal(tokenEvidence(tokens[0], { langText: { en: { set: ['galar'] } } }), null);
});

test('pika ex works via pika-prefix + ex-exact evidence, NOT set parsing (no PokeKyun)', () => {
  // Regression for the accidental `pikaex`≈PokéKyun fuzzy that used to save it.
  const ex = explainQuery('pika ex', 'Pikachu ex');
  const via = Object.fromEntries(ex.perToken.map((row) => [row.token, row.via]));
  assert.equal(via.pika, 'name-prefix');
  assert.equal(via.ex, 'name-exact');
  assert.equal(ex.coverage, 2);
  // And the legacy parser no longer needs a set peel to make it work: the query
  // is plain free text with no set token.
  assert.deepEqual(parseTypedQuery('pika ex').setTokens, []);
});

// --- Typo coverage ratio (no accidental cross-word matches) -------------------

test('a typo may cover only when it changes few characters, not a different word', () => {
  // pakia → Palkia (1/5 edits) counts; palkia → Pikachu (2.5/6) does not.
  assert.ok(scoreEntry(tokenizeQuery('pakia').tokens,
    { prior: 1, langText: { en: { name: ['palkia'] } } }).coverage === 1);
  assert.equal(scoreEntry(tokenizeQuery('palkia').tokens,
    { prior: 1, langText: { en: { name: ['pikachu'] } } }).coverage, 0);
});

// --- Multilingual: server-authoritative (Section 3-7) ------------------------
// The local vocab is English-only; localized names arrive on hydrated rows as
// localized_name / localized_set. These fixtures use REAL official translations
// to stand in for server-hydrated rows (stamped with the fetch language).

function stamp(rows, lang) {
  return rows.map((row) => ({ ...row, search_lang: lang }));
}

test('activeLanguages is [selected, en], or just [en] for English', () => {
  assert.deepEqual(activeLanguages('en'), ['en']);
  assert.deepEqual(activeLanguages('de'), ['de', 'en']);
  assert.deepEqual(activeLanguages('JP'), ['jp', 'en']);
});

test('German term and its English name both find the card while German is selected', () => {
  const groups = [
    { name: 'Charizard', printings: stamp([{ id: '1', name: 'Charizard', set: 'Base Set', localized_name: 'Glurak', localized_set: 'Basis' }], 'de') },
    { name: 'Blastoise', printings: stamp([{ id: '2', name: 'Blastoise', set: 'Base Set', localized_name: 'Turtok', localized_set: 'Basis' }], 'de') },
  ];
  assert.equal(scoreGroups('glurak', groups, { lang: 'de' }).groups[0].name, 'Charizard');
  // English never disappears when another language is selected.
  assert.equal(scoreGroups('charizard', groups, { lang: 'de' }).groups[0].name, 'Charizard');
});

test('a selected-language exact match is only slightly preferred over English', () => {
  const doc = docFromPrinting({ id: '1', name: 'Charizard', localized_name: 'Glurak', search_lang: 'de' }, { lang: 'de' });
  const de = scoreEntry(tokenizeQuery('glurak').tokens, doc, ['de', 'en']);
  const en = scoreEntry(tokenizeQuery('charizard').tokens, doc, ['de', 'en']);
  assert.ok(de.quality > en.quality, 'selected-language exact is stronger');
  assert.ok(de.quality < en.quality * 1.1, 'but only slightly — no ranking wall');
});

test('localized fields are ignored unless the row was fetched in the active language', () => {
  // Stale cross-language row: fetched as Italian, now French is selected.
  const italianRow = { id: '1', name: 'Charizard', localized_name: 'Charizard', localized_set: 'Set Italiano', search_lang: 'it' };
  const asFrench = docFromPrinting(italianRow, { lang: 'fr' });
  assert.equal(asFrench.langText.fr, undefined, 'no French text from an Italian row');
  const asItalian = docFromPrinting(italianRow, { lang: 'it' });
  assert.ok(asItalian.langText.it, 'Italian text is trusted under Italian');
});

// --- Unicode normalization (Section 8) ---------------------------------------

test('compactQuery preserves voiced Japanese kana (dakuten must survive)', () => {
  assert.equal(compactQuery('ピカチュウ'), 'ピカチュウ');
  assert.notEqual(compactQuery('ピ'), compactQuery('ヒ')); // pi !== hi
  assert.notEqual(compactQuery('ビ'), compactQuery('ヒ')); // bi !== hi
  assert.notEqual(compactQuery('パ'), compactQuery('ハ')); // pa !== ha
});

test('compactQuery collapses NFC and NFD forms of the same string', () => {
  for (const s of ['ピ', 'ビ', 'ヴ', 'パ', 'Pokémon', 'Flabébé']) {
    assert.equal(compactQuery(s), compactQuery(s.normalize('NFD')));
    assert.equal(compactQuery(s), compactQuery(s.normalize('NFC')));
  }
});

test('compactQuery folds Latin diacritics but preserves other scripts', () => {
  assert.equal(compactQuery('Pokémon'), 'pokemon');
  assert.equal(compactQuery('Flabébé'), 'flabebe');
  assert.equal(compactQuery('Épée'), 'epee');
  assert.equal(compactQuery('Пикачу'), 'пикачу'); // Cyrillic preserved
  assert.equal(compactQuery('皮卡丘'), '皮卡丘'); // Chinese preserved
  assert.equal(compactQuery('리자몽'), '리자몽'); // Korean preserved
});

test('a Japanese localized row is searchable by its voiced kana', () => {
  const row = { id: '9', name: 'Charizard ex', localized_name: 'リザードンex', search_lang: 'jp' };
  const ev = tokenEvidence(tokenizeQuery('リザードン').tokens[0], docFromPrinting(row, { lang: 'jp' }), ['jp', 'en']);
  assert.ok(ev && ev.lang === 'jp', 'matched the Japanese localized name');
});

// --- Explain helper (Section 14) ---------------------------------------------

test('explainQuery reports per-token evidence, coverage and score', () => {
  const ex = explainQuery('pakia legend', 'Palkia & Dialga LEGEND');
  assert.equal(ex.coverage, 2);
  const via = Object.fromEntries(ex.perToken.map((row) => [row.token, row.via]));
  assert.equal(via.pakia, 'name-typo');
  assert.equal(via.legend, 'name-exact');
  assert.match(ex.text, /coverage = 2\/2/);
});

test('nameTokens splits words and merges possessive forms', () => {
  assert.deepEqual(nameTokens("N's Zoroark"), ['ns', 'zoroark']);
  assert.deepEqual(nameTokens('Palkia & Dialga LEGEND'), ['palkia', 'dialga', 'legend']);
});
