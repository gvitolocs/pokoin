import assert from 'node:assert/strict';
import test from 'node:test';
import { associateRoleLabel, isAmbassadorRole, isFounderRole } from './associate-roles.js';

test('roster roles read as titles on badges', () => {
  assert.equal(associateRoleLabel('founder_ambassador'), 'Founder Ambassador');
  assert.equal(associateRoleLabel('Ambassador'), 'Ambassador');
  assert.equal(associateRoleLabel('city_partner'), 'City Partner');
  assert.equal(isAmbassadorRole('founder_ambassador'), true);
  assert.equal(isAmbassadorRole('distributor'), false);
  assert.equal(isFounderRole('founder_ambassador'), true);
  assert.equal(isFounderRole('ambassador'), false);
});
