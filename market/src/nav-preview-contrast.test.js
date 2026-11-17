import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

/** WCAG 2 contrast ratio between two #rrggbb colours. */
function contrast(one, two) {
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5]
      .map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
      .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [high, low] = [luminance(one), luminance(two)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}

const rule = (selector) => {
  const match = css.match(new RegExp(`${selector}[^{]*\\{[^}]*\\}`));
  assert.ok(match, `${selector} is styled`);
  return match[0];
};

test('the Scan cards and CardGTS tiles keep their ink on hover', () => {
  const rest = rule('\\.nav-preview \\.nav-scan,');
  const hover = rule('\\.nav-preview \\.nav-scan:hover,');
  const restColor = rest.match(/color:\s*(#[0-9a-f]{6})/)[1];
  // Without its own colour the label takes `.icon-nav a:hover` gold: 1.1:1 on the tile.
  const hoverColor = hover.match(/color:\s*(#[0-9a-f]{6})/);
  assert.ok(hoverColor, 'the hover rule names a colour');
  assert.equal(hoverColor[1], restColor);
  // Both tiles, on hover and on the keyboard ring.
  for (const tile of ['nav-scan', 'nav-cardgts']) {
    assert.match(hover, new RegExp(`\\.nav-preview \\.${tile}:hover,`));
    assert.match(hover, new RegExp(`\\.nav-preview \\.${tile}:focus-visible`));
  }
  const ground = hover.match(/background:\s*(#[0-9a-f]{6})/)[1];
  assert.ok(contrast(hoverColor[1], ground) >= 4.5, `${hoverColor[1]} on ${ground} is ${contrast(hoverColor[1], ground)}`);
  // The label inherits it and never re-golds itself.
  assert.doesNotMatch(rule('\\.nav-preview \\.nav-scan strong,'), /var\(--yellow\)/);
});
