'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const path = require('node:path');

const TARGET = path.resolve(__dirname, 'poko-bets.js');
process.env.POKONTACT_SERVICE_TOKEN = 'svc';

// Minimal in-memory Firestore: docs, merge sets, serialized transactions.
function fakeFirestore(seed = {}) {
  const docs = new Map(Object.entries(seed).map(([key, value]) => [key, structuredClone(value)]));
  let auto = 0;
  let chain = Promise.resolve();
  function ref(collection, id) {
    const key = `${collection}/${id}`;
    return {
      key,
      async get() {
        return { exists: docs.has(key), data: () => structuredClone(docs.get(key)) };
      },
      async set(value, opts) { write(key, value, opts); },
    };
  }
  function write(key, value, opts) {
    const clean = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== SERVER_TS));
    docs.set(key, opts?.merge ? { ...(docs.get(key) || {}), ...clean } : clean);
  }
  const firestore = {
    docs,
    collection(name) {
      return { doc: (id) => ref(name, id ?? `auto${auto += 1}`) };
    },
    runTransaction(fn) {
      const run = chain.then(async () => {
        const writes = [];
        const result = await fn({
          get: (r) => r.get(),
          set: (r, value, opts) => writes.push([r.key, value, opts]),
        });
        for (const [key, value, opts] of writes) write(key, value, opts);
        return result;
      });
      chain = run.catch(() => {});
      return run;
    },
  };
  return firestore;
}
const SERVER_TS = Symbol('ts');

function load({ firestore, links }) {
  const originalLoad = Module._load;
  delete require.cache[TARGET];
  Module._load = function load(request, parent, isMain) {
    if (request === './_marketplace_db') {
      return {
        marketplaceQuery: async (_sql, [ids]) => ({
          rows: ids.filter((id) => links[id]).map((id) => ({ discord_user_id: id, firebase_uid: links[id] })),
        }),
      };
    }
    if (request === './_firebase') {
      const admin = { firestore: Object.assign(() => firestore, { FieldValue: { serverTimestamp: () => SERVER_TS } }) };
      return { getFirebaseAdmin: () => admin };
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    return require(TARGET);
  } finally {
    Module._load = originalLoad;
  }
}

async function call(handler, body, token = 'svc') {
  const res = {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
  await handler({ method: 'POST', headers: { authorization: `Bearer ${token}` }, body }, res);
  return res;
}

const GUILD = '111111111111';
const GAME = '7000000001';
const LINKS = { 22222: 'uidA', 33333: 'uidB', 44444: 'uidC' };

function setup(balances = { uidA: 1000, uidB: 500, uidC: 300 }, consents = ['uidA', 'uidB', 'uidC']) {
  const seed = {};
  for (const [uid, availablePkn] of Object.entries(balances)) seed[`balances/${uid}`] = { availablePkn };
  for (const uid of consents) seed[`poko_bets_consent/${uid}`] = { enabled: true };
  const firestore = fakeFirestore(seed);
  return { firestore, handler: load({ firestore, links: LINKS }) };
}

const bal = (firestore, uid) => firestore.docs.get(`balances/${uid}`)?.availablePkn;
const stakeBody = (discordUserId, side, amountPkn) => ({ action: 'stake', guildId: GUILD, gameId: GAME, discordUserId, side, amountPkn, closesAt: Date.now() + 60_000 });

test('requires the service token', async () => {
  const { handler } = setup();
  assert.equal((await call(handler, { action: 'balances' }, 'wrong')).statusCode, 401);
});

test('cannot bet more than the site balance, even with concurrent bets', async () => {
  const { handler, firestore } = setup({ uidA: 100 });
  const over = await call(handler, stakeBody('22222', 'win', 101));
  assert.equal(over.statusCode, 402);
  assert.match(over.body.error, /insufficient_balance:100/);
  assert.equal(bal(firestore, 'uidA'), 100);

  // Two different rounds racing for the same 100 PKN: only one fits.
  const results = await Promise.all([
    call(handler, stakeBody('22222', 'win', 80)),
    call(handler, { ...stakeBody('22222', 'win', 80), gameId: '7000000002' }),
  ]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 402]);
  assert.equal(bal(firestore, 'uidA'), 20);
});

test('changing a bet reuses the previous stake against the balance', async () => {
  const { handler, firestore } = setup({ uidA: 100 });
  await call(handler, stakeBody('22222', 'win', 60));
  const changed = await call(handler, stakeBody('22222', 'loss', 100));
  assert.equal(changed.statusCode, 200);
  assert.equal(bal(firestore, 'uidA'), 0);
  assert.equal(firestore.docs.get(`poko_bet_rounds/${GUILD}_${GAME}`).totalPkn, 100);
});

test('settle pays winners pari-mutuel from escrow, exactly, and only once', async () => {
  const { handler, firestore } = setup();
  await call(handler, stakeBody('22222', 'win', 100));
  await call(handler, stakeBody('33333', 'win', 200));
  await call(handler, stakeBody('44444', 'loss', 301 - 1));
  await call(handler, { action: 'close', guildId: GUILD, gameId: GAME });
  assert.equal((await call(handler, stakeBody('22222', 'win', 10))).body.error, 'round_closed');

  const settled = await call(handler, { action: 'settle', guildId: GUILD, gameId: GAME, outcome: 'win' });
  assert.equal(settled.body.status, 'settled');
  // pot 600, winners 300: A gets 200, B gets 400
  assert.deepEqual(settled.body.payouts, { 22222: 200, 33333: 400, 44444: 0 });
  assert.equal(bal(firestore, 'uidA'), 1100);
  assert.equal(bal(firestore, 'uidB'), 700);
  assert.equal(bal(firestore, 'uidC'), 0);

  const again = await call(handler, { action: 'settle', guildId: GUILD, gameId: GAME, outcome: 'loss' });
  assert.equal(again.body.idempotent, true);
  assert.equal(bal(firestore, 'uidC'), 0, 'a second settle never pays again');
});

test('no winners or refund returns every stake', async () => {
  const { handler, firestore } = setup();
  await call(handler, stakeBody('22222', 'loss', 100));
  const res = await call(handler, { action: 'settle', guildId: GUILD, gameId: GAME, outcome: 'win' });
  assert.equal(res.body.status, 'refunded');
  assert.equal(bal(firestore, 'uidA'), 1000);

  await call(handler, { ...stakeBody('33333', 'win', 50), gameId: '7000000003' });
  await call(handler, { action: 'refund', guildId: GUILD, gameId: '7000000003' });
  assert.equal(bal(firestore, 'uidB'), 500);
});

test('payout rounding never creates or destroys PKN', () => {
  const { handler } = setup();
  const { computePayouts } = handler._test;
  const stakes = {
    a: { side: 'win', amountPkn: 3 },
    b: { side: 'win', amountPkn: 3 },
    c: { side: 'win', amountPkn: 1 },
    d: { side: 'loss', amountPkn: 10 },
  };
  const { payouts } = computePayouts(stakes, 'win');
  assert.equal(Object.values(payouts).reduce((s, v) => s + v, 0), 17);
});

test('rejects malformed amounts and sides', async () => {
  const { handler } = setup();
  for (const amountPkn of [0, -5, 1.5, '10abc', 2 ** 60]) {
    assert.equal((await call(handler, stakeBody('22222', 'win', amountPkn))).statusCode, 400);
  }
  assert.equal((await call(handler, stakeBody('22222', 'draw', 10))).statusCode, 400);
});

test('stakes after the round deadline are refused server-side', async () => {
  const { handler, firestore } = setup();
  const late = await call(handler, { ...stakeBody('22222', 'win', 10), closesAt: Date.now() - 1 });
  assert.equal(late.body.error, 'round_closed');
  assert.equal((await call(handler, { ...stakeBody('22222', 'win', 10), closesAt: undefined })).statusCode, 400);

  // the first stake pins the deadline; a later stake cannot extend it
  await call(handler, { ...stakeBody('22222', 'win', 10), closesAt: Date.now() + 30 });
  const round = firestore.docs.get(`poko_bet_rounds/${GUILD}_${GAME}`);
  assert.ok(round.closesAtMs <= Date.now() + 30);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const extended = await call(handler, { ...stakeBody('33333', 'win', 10), closesAt: Date.now() + 60_000 });
  assert.equal(extended.body.error, 'round_closed');
  assert.equal(bal(firestore, 'uidB'), 500);
});

test('redeem_bonus pays 20 PKN once per Discord account and once per Pokoin account', async () => {
  const links = { ...LINKS };
  const firestore = fakeFirestore({ 'balances/uidA': { availablePkn: 5 } });
  let handler = load({ firestore, links });
  const first = await call(handler, { action: 'redeem_bonus', discordUserId: '22222' });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.amountPkn, 20);
  assert.equal(bal(firestore, 'uidA'), 25);
  const ledger = [...firestore.docs.entries()].filter(([key, doc]) => key.startsWith('ledger_entries/') && doc.type === 'poko_discord_bonus');
  assert.equal(ledger.length, 1);

  // same Discord account again
  assert.equal((await call(handler, { action: 'redeem_bonus', discordUserId: '22222' })).body.error, 'bonus_already_claimed_discord');

  // same Discord account relinked to another Pokoin profile
  links['22222'] = 'uidB';
  handler = load({ firestore, links });
  assert.equal((await call(handler, { action: 'redeem_bonus', discordUserId: '22222' })).body.error, 'bonus_already_claimed_discord');

  // same Pokoin profile linked from another Discord account
  links['55555'] = 'uidA';
  handler = load({ firestore, links });
  assert.equal((await call(handler, { action: 'redeem_bonus', discordUserId: '55555' })).body.error, 'bonus_already_claimed_account');

  assert.equal(bal(firestore, 'uidA'), 25);
  assert.equal(bal(firestore, 'uidB'), undefined);
});


// --- Discord wallets (unlinked players) -------------------------------------

const wallet = (firestore, id) => firestore.docs.get(`poko_discord_wallets/${id}`);
const youngDiscordId = () => String((BigInt(Date.now() - 2 * 86400000) - 1420070400000n) << 22n);

test('linked users without consent cannot stake; unlinked users play from their wallet', async () => {
  const { handler } = setup(undefined, ['uidA']);
  assert.equal((await call(handler, stakeBody('33333', 'win', 10))).body.error, 'no_consent');
  const empty = await call(handler, stakeBody('99999', 'win', 10));
  assert.equal(empty.body.error, 'insufficient_balance:0');
});

test('balances: consenting accounts, private non-consenting accounts, wallets for the rest', async () => {
  const { handler, firestore } = setup(undefined, ['uidA']);
  firestore.docs.set('poko_discord_wallets/99999', { availablePkn: 7, status: 'active' });
  const res = await call(handler, { action: 'balances', discordUserIds: ['22222', '33333', '99999'] });
  assert.deepEqual(res.body.balances, [
    { discordUserId: '22222', linked: true, consent: true, availablePkn: 1000 },
    { discordUserId: '33333', linked: true, consent: false },
    { discordUserId: '99999', linked: false, consent: false, wallet: true, walletMerged: false, availablePkn: 7 },
  ]);
});

test('wallet bonus: once per Discord account, double clicks pay once, new accounts refused', async () => {
  const { handler, firestore } = setup();
  const results = await Promise.all([1, 2, 3].map(() => call(handler, { action: 'redeem_bonus', discordUserId: '99999' })));
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409, 409]);
  assert.equal(wallet(firestore, '99999').availablePkn, 20);
  assert.equal((await call(handler, { action: 'redeem_bonus', discordUserId: youngDiscordId() })).body.error, 'discord_account_too_new');
  assert.equal((await call(handler, { action: 'redeem_bonus', discordUserId: '88888' })).statusCode, 200, 'another old account is fine');
});

test('linking merges the wallet once into the Pokoin account, then the account is used', async () => {
  const links = { ...LINKS };
  const firestore = fakeFirestore({ 'balances/uidX': { availablePkn: 5 }, 'poko_bets_consent/uidX': { enabled: true } });
  let handler = load({ firestore, links });
  await call(handler, { action: 'redeem_bonus', discordUserId: '99999' });
  links['99999'] = 'uidX';
  handler = load({ firestore, links });
  const results = await Promise.all([1, 2].map(() => call(handler, { action: 'merge_wallet', discordUserId: '99999' })));
  assert.deepEqual(results.map((r) => r.body.merged).sort(), [false, true], 'double /connect moves once');
  assert.equal(bal(firestore, 'uidX'), 25);
  assert.equal(wallet(firestore, '99999').status, 'merged');
  assert.equal(wallet(firestore, '99999').availablePkn, 0);
  // bonus cannot be claimed again by the Discord user nor through the account
  assert.equal((await call(handler, { action: 'redeem_bonus', discordUserId: '99999' })).body.error, 'bonus_already_claimed_discord');
  links['77777'] = 'uidX';
  handler = load({ firestore, links });
  assert.equal((await call(handler, { action: 'redeem_bonus', discordUserId: '77777' })).body.error, 'bonus_already_claimed_account');
  const st = await call(handler, stakeBody('99999', 'win', 25));
  assert.equal(st.body.holder, 'account');
  assert.equal(bal(firestore, 'uidX'), 0);
});

test('unlink + relink cannot re-merge, re-fund or re-bonus the wallet', async () => {
  const links = { ...LINKS };
  const firestore = fakeFirestore({ 'poko_bets_consent/uidX': { enabled: true }, 'poko_bets_consent/uidY': { enabled: true } });
  let handler = load({ firestore, links });
  await call(handler, { action: 'redeem_bonus', discordUserId: '99999' });
  links['99999'] = 'uidX';
  handler = load({ firestore, links });
  await call(handler, { action: 'merge_wallet', discordUserId: '99999' });
  delete links['99999'];
  handler = load({ firestore, links });
  assert.equal((await call(handler, stakeBody('99999', 'win', 1))).body.error, 'wallet_merged_relink');
  assert.equal((await call(handler, { action: 'redeem_bonus', discordUserId: '99999' })).body.error, 'bonus_already_claimed_discord');
  links['99999'] = 'uidY';
  handler = load({ firestore, links });
  const again = await call(handler, { action: 'merge_wallet', discordUserId: '99999' });
  assert.equal(again.body.reason, 'already_merged');
  assert.equal(bal(firestore, 'uidY') || 0, 0);
  assert.equal(bal(firestore, 'uidX'), 20);
});

test('alt farming: a second wallet bonus is not carried into an already-bonused account', async () => {
  const links = { ...LINKS };
  const firestore = fakeFirestore({ 'poko_bets_consent/uidX': { enabled: true } });
  let handler = load({ firestore, links });
  await call(handler, { action: 'redeem_bonus', discordUserId: '99999' });
  await call(handler, { action: 'redeem_bonus', discordUserId: '88888' });
  links['99999'] = 'uidX';
  links['88888'] = 'uidX';
  handler = load({ firestore, links });
  await call(handler, { action: 'merge_wallet', discordUserId: '99999' });
  const second = await call(handler, { action: 'merge_wallet', discordUserId: '88888' });
  assert.equal(second.body.forfeitedPkn, 20);
  assert.equal(second.body.movedPkn, 0);
  assert.equal(bal(firestore, 'uidX'), 20);
});

test('merges are capped per Pokoin account; the excess stays frozen on the wallet', async () => {
  const links = { ...LINKS, 99999: 'uidX' };
  const firestore = fakeFirestore({ 'poko_discord_wallets/99999': { availablePkn: 500, status: 'active' } });
  const handler = load({ firestore, links });
  const merged = await call(handler, { action: 'merge_wallet', discordUserId: '99999' });
  const cap = handler._test.WALLET_MERGE_CAP;
  assert.equal(merged.body.movedPkn, cap);
  assert.equal(merged.body.frozenPkn, 500 - cap);
  assert.equal(bal(firestore, 'uidX'), cap);
  assert.equal(wallet(firestore, '99999').frozenPkn, 500 - cap);
});

test('linking mid-round: wallet stakes are paid to the Pokoin account', async () => {
  const links = { ...LINKS };
  const firestore = fakeFirestore({ 'poko_discord_wallets/99999': { availablePkn: 30, status: 'active' }, 'balances/uidA': { availablePkn: 100 }, 'poko_bets_consent/uidA': { enabled: true } });
  let handler = load({ firestore, links });
  await call(handler, stakeBody('99999', 'win', 30));
  await call(handler, stakeBody('22222', 'loss', 30));
  links['99999'] = 'uidX';
  handler = load({ firestore, links });
  await call(handler, { action: 'merge_wallet', discordUserId: '99999' });
  const settled = await call(handler, { action: 'settle', guildId: GUILD, gameId: GAME, outcome: 'win' });
  assert.deepEqual(settled.body.payouts, { 99999: 60, 22222: 0 });
  assert.equal(bal(firestore, 'uidX'), 60);
  assert.equal(wallet(firestore, '99999').availablePkn, 0);
});

test('reward_game: only allowlisted users, once per game, daily cap, config-driven amount', async () => {
  const links = { ...LINKS };
  const firestore = fakeFirestore({
    'poko_config/game_rewards': { discordUserIds: ['99999'], amountPkn: 1, dailyCap: 2 },
  });
  const handler = load({ firestore, links });
  const reward = (gameId, discordUserId = '99999') => call(handler, { action: 'reward_game', guildId: GUILD, gameId, discordUserId });
  assert.equal((await reward('1', '22222')).body.error, 'not_eligible', 'not in the admin allowlist');
  const twice = await Promise.all([reward('1'), reward('1')]);
  assert.deepEqual(twice.map((r) => r.body.rewarded).sort(), [false, true], 'one payment per game');
  assert.equal(wallet(firestore, '99999').availablePkn, 1);
  assert.equal((await reward('2')).body.rewarded, true);
  const capped = await reward('3');
  assert.equal(capped.body.reason, 'daily_cap');
  assert.equal(wallet(firestore, '99999').availablePkn, 2);
  links['99999'] = 'uidZ';
  const linked = load({ firestore, links });
  firestore.docs.set('poko_game_reward_days/99999_' + new Date().toISOString().slice(0, 10), { count: 0 });
  const toAccount = await call(linked, { action: 'reward_game', guildId: GUILD, gameId: '4', discordUserId: '99999' });
  assert.equal(toAccount.body.holder, 'account');
  assert.equal(bal(firestore, 'uidZ'), 3, 'wallet (2) merged + reward (1)');
});

test('reward_game is off when no config exists', async () => {
  const { handler } = setup();
  assert.equal((await call(handler, { action: 'reward_game', guildId: GUILD, gameId: '1', discordUserId: '22222' })).body.error, 'not_eligible');
});
