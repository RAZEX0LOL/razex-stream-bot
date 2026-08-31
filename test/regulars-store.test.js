import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RegularsStore, normalizeLogin } from '../src/regulars-store.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regulars-'));
  return new RegularsStore({ storePath: path.join(dir, 'regulars.json') });
}

test('normalizeLogin strips @ and lowercases', () => {
  assert.equal(normalizeLogin('@Bob'), 'bob');
  assert.equal(normalizeLogin(' ANN '), 'ann');
  assert.equal(normalizeLogin(null), '');
});

test('add/has/remove are case-insensitive and idempotent', () => {
  const store = tmpStore();
  assert.equal(store.add('@Bob'), true);
  assert.equal(store.add('bob'), false); // already present
  assert.equal(store.has('BOB'), true);
  assert.equal(store.has('ann'), false);
  assert.deepEqual(store.list(), ['bob']);
  assert.equal(store.remove('Bob'), true);
  assert.equal(store.has('bob'), false);
  assert.equal(store.remove('bob'), false);
});

test('persists across reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regulars-reload-'));
  const opts = { storePath: path.join(dir, 'regulars.json') };
  const a = new RegularsStore(opts);
  a.add('ann'); a.add('bob');
  const b = new RegularsStore(opts);
  b.load();
  assert.equal(b.has('ann'), true);
  assert.deepEqual(b.list(), ['ann', 'bob']);
});
