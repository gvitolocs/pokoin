import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');

/**
 * CARD-01 P3. `cheap` and `offers` are one grid row of `.card-desk` stretched
 * together, so whichever of them changes height moves its neighbour and the
 * content under both. The measured trace: the Cheapest listings cell opened 84 px
 * and answered 90 px, twice in one arrow step.
 */
test('a desk cell body costs a row before it has an answer', () => {
  const reserve = css.match(/\.desk-cell > :not\(\.cell-title\) \{([^}]*)\}/)[1];
  assert.match(reserve, /min-height:\s*2\.4rem/);
  // 2.4rem is the row it reserves: a listing row and a shimmer row are that tall,
  // so the rule raises an empty state to one row and never touches a full one.
  assert.match(css, /\.cell-cheap \.shop-row \{[^}]*min-height:\s*2\.4rem/);
  assert.match(css, /\.cell-skel > span \{ height: 2\.4rem; \}/);
  // `.cell-title` is excluded: a cell always has its title, and reserving under it
  // would put an empty slot inside the header line.
  assert.doesNotMatch(css, /\.desk-cell > \.cell-title \{[^}]*min-height/);
});

test('the waiting status line costs the line the sentence will cost', () => {
  // A whitespace-only <p> has no line box, so "No listings yet." arrived taller
  // than the blank it replaced; the space has to be preserved to hold the height.
  const rule = css.match(/\.desk-cell \.empty-shop \.status \{([^}]*)\}/)[1];
  assert.match(rule, /white-space:\s*pre-wrap/);
  assert.match(rule, /margin:\s*0/);
});

test('the desk skeletons are held to the same 250 ms as every other skeleton', () => {
  const appear = css.slice(0, css.indexOf('@keyframes skel-shimmer'));
  const block = appear.match(/\.offer-bar-skel,\n\.cell-skel > span \{([^}]*)\}/)[1];
  assert.match(block, /animation-name: skel-appear, skel-shimmer;/);
  assert.match(block, /animation-delay: 250ms, 0s;/);
  // `animation: skel-shimmer …` as a shorthand would reset that delay, which is
  // how the desk came to show a shimmer for a second over an answer it already had.
  const shimmer = css.slice(css.indexOf('.offer-bar-skel,\n.cell-skel > span {\n  display: block;'));
  assert.doesNotMatch(shimmer.slice(0, shimmer.indexOf('}')), /animation:/);
  // Shimmer motion is still off for anyone who asks for no motion.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.offer-bar-skel,\s*\.cell-skel > span \{ animation: none; \}/);
});
