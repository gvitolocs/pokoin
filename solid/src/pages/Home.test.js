import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const home = read('./Home.jsx');

test('Recently seen repaints keep the painted order and tiles', () => {
  // Every paint after the first goes through the rail's own order and tiles.
  assert.match(home, /const recentIds = \(\) => stableRecentIds\(recentOrder, readRecentCardIds\(\)\)/);
  assert.match(home, /const railExtras = \(tiles = \[\]\) => \[\.\.\.recentTiles, \.\.\.readRecentTiles\(\), \.\.\.tiles\]/);
  const body = home.slice(home.indexOf('export default function Home()'));
  const loaders = body.slice(body.indexOf('function commit('), body.indexOf('onSettled(() =>'));
  assert.doesNotMatch(loaders, /readRecentCardIds\(\)\)?[,;)]/, 'loaders paint with recentIds(), not the stored list');
  assert.doesNotMatch(loaders, /localExtras\(/);
  assert.match(loaders, /noteRecents\(next\)/);
  // The account sync is the shared, throttled one and appends instead of replacing.
  assert.match(home, /syncRecentAccount\(\)/);
  assert.doesNotMatch(home, /syncRemoteRecentCardIds/);
});

test('the marketplace refreshes the stored rail behind its first paint', () => {
  assert.match(home, /async function refreshRailQuietly\(\) \{\n {4}await refreshRecentTiles\(\);/);
  assert.match(home, /storeRail\(\);\n {6}loadedAt = Date\.now\(\);\n {6}await refreshRailQuietly\(\);/);
  // Prices found on the page go into the stored copy only where it has none.
  assert.match(home, /tilePricePkn\(stored\.get\(String\(card\.id\)\)\) == null/);
  // A failed recent is forgotten by id; ids cut by the cap are not.
  assert.match(home, /pruneUnresolvedRecents\(readRecentCardIds\(\)\.filter\(\(id\) => !failed\.has\(id\)\)\)/);
});

test('the rail is warmed while the visitor browses', () => {
  const app = read('../App.jsx');
  assert.match(app, /warmRecentsRail\(\{ account: signedIn\(\) \}\)/);
  const card = read('./Card.jsx');
  assert.match(card, /rememberCardId\(merged\);\n[\s\S]{0,200}afterHero\(\(\) => whenIdle\(\(\) => \{\n {6}warmRecentCard\(merged\);\n {6}void warmRecentsRail\(\);/);
});

test('signed-in prices paint in the stored country while the settings read runs', () => {
  const buyer = read('../stores/buyer.js');
  assert.match(buyer, /return signedIn\(\) && settings\(\) == null && !failed\(\) && !knownCountry\(\);/);
  assert.match(buyer, /settings\(\) \? settings\(\)\.shipFromCountry : knownCountry\(\)\?\.country/);
  assert.match(buyer, /rememberCountry\(next\);\n {4}\}\)/);
});
