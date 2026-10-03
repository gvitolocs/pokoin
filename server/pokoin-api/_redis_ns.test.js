'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const ns = require('./_redis_ns');

test('namespaces keep search and marketplace families apart', () => {
  assert.equal(ns.marketplaceKey('home', 'react'), 'pokoin:marketplace:v1:home:react');
  assert.equal(ns.sellerKey('uid', 'profile'), 'pokoin:seller:v1:uid:profile');
  assert.equal(ns.rateLimitKey('poko-chat', 'abc'), 'pokoin:rl:v1:poko-chat:abc');
  assert.equal(ns.lockKey('ct-reconcile', 'uid'), 'pokoin:lock:v1:ct-reconcile:uid');
  assert.equal(ns.generationKey('card:pokemon:1'), 'pokoin:marketplace:v1:gen:card:pokemon:1');
  assert.notEqual(ns.marketplaceKey('card', '1').startsWith('pokoin:card:'), true);
});
