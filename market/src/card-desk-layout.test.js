import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');
const chrome = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'components/Chrome.jsx'), 'utf8');
const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'App.jsx'), 'utf8');

test('card desk version row cannot overflow past the scan', () => {
  assert.match(css, /\.art-num-row \{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\) auto/);
  assert.match(css, /select\.collector-badge\.version-badge \{[^}]*width:\s*100%/);
  assert.match(css, /select\.collector-badge\.version-badge \{[^}]*min-width:\s*0/);
  assert.match(css, /\.card-page\.flutter-page \{[^}]*overflow-x:\s*clip/);
  assert.match(css, /\.card-desk \{[^}]*min-width:\s*0/);
});

test('extension side-panel desk clips chrome and keeps the version select shrinking', () => {
  assert.match(app, /classList\.toggle\('is-extension-desk'/);
  assert.match(css, /html\.is-extension-desk \.foot \{[^}]*display:\s*none/);
  assert.match(css, /html\.is-extension-desk \.art-num-row \{[^}]*2\.25rem minmax\(0,\s*1fr\) 2\.25rem/);
  assert.match(chrome, /extensionDesk \? 'Search cards'/);
  assert.match(app, /originDown && !board && !framed/);
  assert.match(app, /framedByChromeExtension\(\)/);
});
