import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WORKING_MESSAGE,
  isApiRequestPath,
  isNetworkError,
  isOriginDownError,
  isOriginDownStatus,
  isPipelineFailure,
  isTunnelHtml,
  publicErrorMessage,
} from './working-page.js';

test('API paths include same-origin /api and api.pokoin.com', () => {
  assert.equal(isApiRequestPath('/api/marketplace-home'), true);
  assert.equal(isApiRequestPath('https://api.pokoin.com/healthz'), true);
  assert.equal(isApiRequestPath('/chain/swap/pools'), false);
});

test('origin-down is 530 / tunnel copy, not a missing card', () => {
  assert.equal(isOriginDownStatus(530), true);
  assert.equal(isOriginDownError(new Error(WORKING_MESSAGE)), true);
  assert.equal(
    isOriginDownError(
      new Error('nope'),
      502,
      'The host is configured as a Cloudflare Tunnel, but Cloudflare is currently unable to reach it.',
    ),
    true,
  );
  assert.equal(isOriginDownError(new Error('Card not found'), 404), false);
  assert.equal(isTunnelHtml('unable to reach it'), true);
  assert.equal(isPipelineFailure('connect ECONNREFUSED 127.0.0.1:5432'), true);
  assert.equal(
    isOriginDownError(new Error('connect ECONNREFUSED 127.0.0.1:5432'), 500),
    true,
  );
  assert.equal(publicErrorMessage(new Error('connect ECONNREFUSED 127.0.0.1:5432')), WORKING_MESSAGE);
  assert.equal(publicErrorMessage(new Error('Card not found')), 'Card not found');
});

test('browser Failed to fetch is a network error', () => {
  const error = new TypeError('Failed to fetch');
  assert.equal(isNetworkError(error), true);
  assert.equal(isNetworkError(new Error('CardTrader unavailable.')), false);
});
