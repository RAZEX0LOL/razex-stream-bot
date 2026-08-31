import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FilterStore, sanitize } from '../src/filter-store.js';

function createStore(defaults = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filter-store-'));
  const storePath = path.join(dir, 'filter.json');
  const store = new FilterStore({ storePath, defaults, logger: null });
  store.load();
  return { store, storePath };
}

test('seeds the file from config defaults on first run', () => {
  const { store, storePath } = createStore({ blockedKeywords: ['Eminem'], maxDurationSeconds: 600 });
  assert.deepEqual(store.get(), { blockedKeywords: ['Eminem'], maxDurationSeconds: 600, checkLyrics: false });
  assert.ok(fs.existsSync(storePath));
});

test('update persists and is readable by a fresh instance', () => {
  const { store, storePath } = createStore();
  store.update({ blockedKeywords: ['drake', 'drake'], maxDurationSeconds: 300, checkLyrics: true });

  const reopened = new FilterStore({ storePath, logger: null });
  reopened.load();
  assert.deepEqual(reopened.get(), { blockedKeywords: ['drake'], maxDurationSeconds: 300, checkLyrics: true });
});

test('sanitize dedupes case-insensitively but keeps display case', () => {
  const result = sanitize({ blockedKeywords: ['Eminem', 'eminem', '  Drake  '], maxDurationSeconds: 120 });
  assert.deepEqual(result.blockedKeywords, ['Eminem', 'Drake']);
  assert.equal(result.maxDurationSeconds, 120);
});

test('sanitize clamps invalid duration to zero and caps the max', () => {
  assert.equal(sanitize({ maxDurationSeconds: -5 }).maxDurationSeconds, 0);
  assert.equal(sanitize({ maxDurationSeconds: 'abc' }).maxDurationSeconds, 0);
  assert.equal(sanitize({ maxDurationSeconds: 999999 }).maxDurationSeconds, 36000);
});
