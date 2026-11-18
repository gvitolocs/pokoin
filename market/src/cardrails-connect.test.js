import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CARDRAILS_REDIRECT_BASE,
  cardRailsAuthFrom,
  cardRailsCancelUrl,
  cardRailsRedirectUrl,
  isCardRailsCodeChallenge,
  isCardRailsCodeChallengeMethod,
  isCardRailsParamsValid,
  isCardRailsState,
  parseCardRailsParams,
} from './cardrails-connect.js';

const VALID_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

test('state validation matches the contract regex', () => {
  assert.equal(isCardRailsState('0123456789abcdef'), true);
  assert.equal(isCardRailsState('a'.repeat(128)), true);
  assert.equal(isCardRailsState('0123456789abcde'), false);
  assert.equal(isCardRailsState('a'.repeat(129)), false);
  assert.equal(isCardRailsState('has space 12345678'), false);
  assert.equal(isCardRailsState(''), false);
  assert.equal(isCardRailsState(null), false);
  assert.equal(isCardRailsState(undefined), false);
});

test('code challenge validation matches the contract regex', () => {
  assert.equal(isCardRailsCodeChallenge(VALID_CHALLENGE), true);
  assert.equal(isCardRailsCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), true);
  assert.equal(isCardRailsCodeChallenge('tooshort'), false);
  assert.equal(isCardRailsCodeChallenge(`${'a'.repeat(43)}=`), false);
  assert.equal(isCardRailsCodeChallenge(`${'a'.repeat(42)}+`), false);
  assert.equal(isCardRailsCodeChallenge(''), false);
});

test('only S256 is accepted', () => {
  assert.equal(isCardRailsCodeChallengeMethod('S256'), true);
  assert.equal(isCardRailsCodeChallengeMethod('plain'), false);
  assert.equal(isCardRailsCodeChallengeMethod('s256'), false);
  assert.equal(isCardRailsCodeChallengeMethod(''), false);
});

test('parseCardRailsParams reads the exact app query names', () => {
  const parsed = parseCardRailsParams(
    `state=0123456789abcdef&code_challenge=${VALID_CHALLENGE}&code_challenge_method=S256`,
  );
  assert.deepEqual(parsed, {
    state: '0123456789abcdef',
    codeChallenge: VALID_CHALLENGE,
    codeChallengeMethod: 'S256',
  });
  assert.deepEqual(parseCardRailsParams(''), { state: '', codeChallenge: '', codeChallengeMethod: '' });
  assert.deepEqual(
    parseCardRailsParams(new URLSearchParams('state=0123456789abcdef')),
    { state: '0123456789abcdef', codeChallenge: '', codeChallengeMethod: '' },
  );
});

test('the full app query validates', () => {
  const good = `state=0123456789abcdef&code_challenge=${VALID_CHALLENGE}&code_challenge_method=S256`;
  assert.equal(isCardRailsParamsValid(good), true);
  assert.equal(isCardRailsParamsValid(`${good}&platform=ios`), true, 'extra params are ignored');
  assert.equal(
    isCardRailsParamsValid(`state=short&code_challenge=${VALID_CHALLENGE}&code_challenge_method=S256`),
    false,
  );
  assert.equal(
    isCardRailsParamsValid(`state=0123456789abcdef&code_challenge=${VALID_CHALLENGE}&code_challenge_method=plain`),
    false,
  );
});

test('redirect and cancel deep links carry the values URL-encoded', () => {
  const code = 'AbC-dEf_123';
  const state = '0123456789abcdef';
  assert.equal(
    cardRailsRedirectUrl(code, state),
    'cardrails://auth/pokoin?code=AbC-dEf_123&state=0123456789abcdef',
  );
  // base64url values pass through; anything unsafe is percent-encoded.
  assert.equal(
    cardRailsRedirectUrl('a+b/c=d', state),
    'cardrails://auth/pokoin?code=a%2Bb%2Fc%3Dd&state=0123456789abcdef',
  );
  assert.equal(
    cardRailsCancelUrl(state),
    'cardrails://auth/pokoin?error=access_denied&state=0123456789abcdef',
  );
  assert.equal(CARDRAILS_REDIRECT_BASE, 'cardrails://auth/pokoin');
});

test('the sign-in return keeps this exact URL', () => {
  const target = '/connect/cardrails?state=0123456789abcdef&code_challenge_method=S256';
  assert.equal(
    cardRailsAuthFrom(target),
    `/auth?from=${encodeURIComponent(target)}`,
  );
  assert.equal(cardRailsAuthFrom(''), '/auth?from=%2Fconnect%2Fcardrails');
});
