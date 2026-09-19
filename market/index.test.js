import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('card bootstrap recognizes canonical slugged and numeric card URLs', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const source = html.match(/path\.match\((\/\^.*?\/i)\)/);
  assert.ok(source, 'card bootstrap route matcher is present');
  const route = eval(source[1]); // eslint-disable-line no-eval

  assert.deepEqual(
    route.exec('/marketplace/en/cards/713754')?.slice(1),
    ['en', '713754'],
  );
  assert.deepEqual(
    route.exec('/marketplace/en/cards/713754/card-jumbo-ice-cream-091-094-phantasmal-flames')?.slice(1),
    ['en', '713754'],
  );
  assert.deepEqual(
    route.exec('/marketplace/it/cards/713754/card-jumbo-ice-cream-091-094-phantasmal-flames')?.slice(1),
    ['it', '713754'],
  );
  assert.equal(route.test('/api/marketplace-card-page?cardId=713754'), false);
});
