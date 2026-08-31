import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoyaltyStore } from '../src/loyalty-store.js';

function tmpStore(now) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-'));
  return new LoyaltyStore({ storePath: path.join(dir, 'loyalty.json'), now });
}

test('earn adds points and tracks the running total', () => {
  const store = tmpStore();
  assert.equal(store.earn('1', 10, { name: 'Bob' }), 10);
  assert.equal(store.earn('1', 5), 15);
  assert.equal(store.earn('1', -3), 15); // negative ignored
  assert.equal(store.balance('1'), 15);
  assert.equal(store.data.users['1'].earnedTotal, 15);
});

test('spend deducts only when affordable', () => {
  const store = tmpStore();
  store.earn('1', 20);
  assert.deepEqual(store.spend('1', 25), { ok: false, balance: 20 });
  assert.deepEqual(store.spend('1', 8), { ok: true, balance: 12 });
  assert.equal(store.balance('1'), 12);
});

test('set overrides the balance exactly, even for an unseen user', () => {
  const store = tmpStore();
  assert.equal(store.set('99', 500, { name: 'Ann' }), 500);
  assert.equal(store.balance('99'), 500);
  assert.equal(store.set('99', -10), 0); // clamped to 0
});

test('top returns the highest balances first with display names', () => {
  const store = tmpStore();
  store.earn('1', 30, { name: 'Bob' });
  store.earn('2', 50, { name: 'Ann' });
  store.earn('3', 10, { login: 'cara' });
  const top = store.top(2);
  assert.deepEqual(top.map((u) => u.name), ['Ann', 'Bob']);
  assert.equal(top[0].points, 50);
});

test('earnActive credits only users seen within the window', () => {
  let t = 1_000_000;
  const store = tmpStore(() => new Date(t));
  store.touch('1', { name: 'Recent' });
  t += 10 * 60_000; // 10 min later
  store.touch('2', { name: 'AlsoRecent' });
  // user 1 was seen 10 min ago, user 2 just now; window = 5 min → only user 2.
  const credited = store.earnActive(7, 5 * 60_000);
  assert.equal(credited, 1);
  assert.equal(store.balance('2'), 7);
  assert.equal(store.balance('1'), 0);
});

test('store persists balances across reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-reload-'));
  const opts = { storePath: path.join(dir, 'loyalty.json') };
  const a = new LoyaltyStore(opts);
  a.earn('1', 42, { name: 'Bob' });
  const b = new LoyaltyStore(opts);
  b.load();
  assert.equal(b.balance('1'), 42);
  assert.equal(b.top(1)[0].name, 'Bob');
});
