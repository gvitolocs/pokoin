import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const panel = fs.readFileSync(new URL('./StrategiesPanel.jsx', import.meta.url), 'utf8');
const editor = fs.readFileSync(new URL('./StrategyEditor.jsx', import.meta.url), 'utf8');
const form = fs.readFileSync(new URL('../desk/ListingForm.jsx', import.meta.url), 'utf8');
const drawer = fs.readFileSync(new URL('../inventory/ListingEditDrawer.jsx', import.meta.url), 'utf8');

/**
 * One strategy editor, two homes: the Pricer tab and the listing drawer's
 * "New strategy" step. A second copy of the form is what this rules out.
 */

test('StrategyEditor is the one form, exported for both places', () => {
  assert.match(editor, /export default function StrategyEditor\(props\) \{/);
  assert.match(editor, /export function createStrategyEditor\(options = \{\}\) \{/);
  assert.match(editor, /async function save\(\)/, 'the editor saves through the host');
  assert.match(editor, /options\.save\(draft\(\)\)/);
});

test('the Pricer tab and the listing drawer both import it', () => {
  assert.match(panel, /import StrategyEditor, \{ createStrategyEditor \} from '\.\/StrategyEditor\.jsx';/);
  assert.match(panel, /<StrategyEditor editor=\{editor\} \/>/);
  assert.match(form, /import StrategyEditor, \{ createStrategyEditor \} from '\.\.\/pricer\/StrategyEditor\.jsx';/);
  assert.match(form, /<StrategyEditor editor=\{strategyEditor\} \/>/);
  // The drawer's second step is Back plus the editor's own "New strategy" title.
  assert.match(form, /class="pricer-back" onClick=\{\(\) => setStrategyStep\(false\)\}/);
  assert.match(editor, /'New strategy'/);
  // The drawer is that form: it is the only thing that carries the step.
  assert.match(drawer, /variant="drawer"/);
  assert.doesNotMatch(drawer, /StrategyEditor/, 'the step belongs to the form, not the shell');
});

test('the Pricer tab still drives it through the pricing store', () => {
  assert.match(panel, /save: \(draft\) => pricing\.saveStrategy\(draft\)/);
  assert.match(panel, /remove: \(id\) => pricing\.deleteStrategy\(id\)/);
  assert.match(panel, /onBack: \(\) => props\.onBack\?\.\(\)/);
});

test('the drawer prices through the same store and never the network itself', () => {
  for (const line of [
    'props.pricing.apply(',
    'props.pricing.saveGroup(',
    'props.pricing.saveStrategy(',
    'pricingMenuEntries',
    'pricingMenuLabel',
    'pricingSavePlan',
    'pricingDryRunBody',
    'pricingDryRunPrice',
  ]) assert.ok(form.includes(line), line);
  // The menu is a listbox with one trigger; the row editor's price waits for it.
  assert.match(form, /role="listbox"/);
  assert.match(form, /aria-expanded=\{pricingOpen\(\) \? 'true' : 'false'\}/);
  assert.match(form, /readOnly=\{drawer\(\) && followsPricing\(\)\}/);
  assert.doesNotMatch(form.slice(form.indexOf('async function priceByPricing')), /fetch\(/, 'no request of its own');
});
