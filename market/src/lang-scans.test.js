import assert from 'node:assert/strict';
import test from 'node:test';
import { langScanLabel, langScanLanguage, langScanUrl } from './lang-scans.js';

const scans = 'de,fr,it:swsh/swsh3/136';

test('a listed western language paints the TCGdex scan', () => {
  assert.equal(langScanUrl(scans, 'it'), 'https://cdn.pokoin.com/tcgdex/it/swsh/swsh3/136.webp');
  assert.equal(langScanUrl(scans, 'DE'), 'https://cdn.pokoin.com/tcgdex/de/swsh/swsh3/136.webp');
  assert.equal(langScanUrl('it:sv/sv03.5/199', 'it'), 'https://cdn.pokoin.com/tcgdex/it/sv/sv03.5/199.webp');
});

test('English, Japanese, Korean and unlisted languages keep the leftover scan', () => {
  for (const lang of ['en', 'jp', 'ko', 'zh', 'es', 'pt', '', undefined]) {
    assert.equal(langScanUrl(scans, lang), '', String(lang));
  }
});

test('missing or malformed scan lists are ignored', () => {
  assert.equal(langScanUrl('', 'it'), '');
  assert.equal(langScanUrl(undefined, 'it'), '');
  assert.equal(langScanUrl('it', 'it'), '');
  assert.equal(langScanUrl(':swsh/swsh3/136', 'it'), '');
  assert.equal(langScanUrl('it:../../etc/passwd', 'it'), '');
  assert.equal(langScanUrl('it:swsh/swsh3', 'it'), '');
  assert.equal(langScanUrl('constructor:a/b/c', 'constructor'), '');
});

test('a painted URL names its language for the desk caption', () => {
  const url = langScanUrl(scans, 'fr');
  assert.equal(langScanLanguage(url), 'fr');
  assert.equal(langScanLabel(url), 'French scan');
  assert.equal(langScanLabel('https://cdn.pokoin.com/154035_rapid-strike.jpg'), '');
  assert.equal(langScanLabel(''), '');
});
