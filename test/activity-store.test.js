import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ActivityStore } from '../src/activity-store.js';

test('records activity and daily top', () => {
  const store = createStore();
  store.load();

  store.recordMessage({
    userId: '1',
    login: 'vasya',
    name: 'Vasya'
  });
  store.recordMessage({
    userId: '2',
    login: 'masha',
    name: 'Masha'
  });
  store.recordMessage({
    userId: '2',
    login: 'masha',
    name: 'Masha'
  });

  assert.deepEqual(
    store.getDailyTop(2).map((user) => user.name),
    ['Masha', 'Vasya']
  );
  assert.equal(store.findUserByLogin('@masha').xp, 4);

  store.flush();
  assert.ok(fs.existsSync(store.storePath));
});

test('records duel stats', () => {
  const store = createStore();
  store.load();
  store.recordMessage({ userId: '1', login: 'vasya', name: 'Vasya' });
  store.recordMessage({ userId: '2', login: 'masha', name: 'Masha' });

  store.recordDuel({
    challenger: { userId: '1', login: 'vasya', name: 'Vasya' },
    target: { userId: '2', login: 'masha', name: 'Masha' },
    winnerLogin: 'masha'
  });

  assert.equal(store.findUserByLogin('vasya').duelsLost, 1);
  assert.equal(store.findUserByLogin('masha').duelsWon, 1);
});

test('records explicit duel target before user is seen and merges later', () => {
  const store = createStore();
  store.load();
  store.recordMessage({ userId: '1', login: 'vasya', name: 'Vasya' });

  store.recordDuel({
    challenger: { userId: '1', login: 'vasya', name: 'Vasya' },
    target: { login: 'masha', name: 'masha' },
    winnerLogin: 'masha'
  });

  assert.equal(store.findUserByLogin('masha').duelsWon, 1);
  assert.match(store.findUserByLogin('masha').id, /^manual:/);

  store.recordMessage({ userId: '2', login: 'masha', name: 'Masha' });

  assert.equal(store.findUserByLogin('masha').id, '2');
  assert.equal(store.findUserByLogin('masha').duelsWon, 1);
});

test('picks random daily user excluding challenger', () => {
  const store = createStore();
  store.load();
  store.recordMessage({ userId: '1', login: 'razex', name: 'Razex' });
  store.recordMessage({ userId: '2', login: 'vasya', name: 'Vasya' });
  store.recordMessage({ userId: '3', login: 'masha', name: 'Masha' });

  assert.equal(
    store.getRandomDailyUser({
      excludeUserId: '1',
      random: () => 0
    }).login,
    'vasya'
  );
});

function createStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twich-bot-test-'));
  return new ActivityStore({
    storePath: path.join(dir, 'activity.json'),
    xpPerMessage: 2,
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    },
    now: () => new Date('2026-05-08T10:00:00.000Z')
  });
}

test('topByDays sums per-day buckets over a window and ranks by xp', () => {
  let day = new Date('2026-06-01T12:00:00Z');
  const store = createStore({ now: () => day });
  store.load();
  // Bob chats on day 1 and day 3; Ann chats a lot on day 3 only.
  store.recordMessage({ userId: '1', login: 'bob', name: 'Bob' });
  day = new Date('2026-06-03T12:00:00Z');
  store.recordMessage({ userId: '1', login: 'bob', name: 'Bob' });
  store.recordMessage({ userId: '2', login: 'ann', name: 'Ann' });
  store.recordMessage({ userId: '2', login: 'ann', name: 'Ann' });
  store.recordMessage({ userId: '2', login: 'ann', name: 'Ann' });

  // Window = today (day 3) only → Ann (3) above Bob (1).
  const today = store.topByDays(1, 10);
  assert.deepEqual(today.map((u) => u.name), ['Ann', 'Bob']);
  assert.equal(today[0].messages, 3);

  // Window = 10 days → Bob has 2 total (day1+day3), Ann 3.
  const wide = store.topByDays(10, 10);
  assert.equal(wide.find((u) => u.name === 'Bob').messages, 2);
  assert.equal(wide.find((u) => u.name === 'Ann').messages, 3);
});

test('drawActiveWinner picks from the active pool (or null when empty)', () => {
  const day = new Date('2026-06-10T12:00:00Z');
  const store = createStore({ now: () => day });
  store.load();
  assert.equal(store.drawActiveWinner({ days: 30 }), null);
  store.recordMessage({ userId: '1', login: 'bob', name: 'Bob' });
  store.recordMessage({ userId: '2', login: 'ann', name: 'Ann' });
  assert.equal(store.drawActiveWinner({ days: 30, random: () => 0 }).name, 'Bob');
  assert.equal(store.drawActiveWinner({ days: 30, random: () => 0.99 }).name, 'Ann');
});

test('pruneOldDays drops buckets older than the retention window', () => {
  const store = createStore({ now: () => new Date('2026-06-20T12:00:00Z') });
  store.load();
  store.data.daily['2024-01-01'] = { users: { x: { messages: 1, xp: 1 } } };
  store.data.daily['2026-06-19'] = { users: { y: { messages: 1, xp: 1 } } };
  const removed = store.pruneOldDays(370);
  assert.equal(removed, 1);
  assert.equal(store.data.daily['2024-01-01'], undefined);
  assert.ok(store.data.daily['2026-06-19']);
});

test('statsByDays zero-fills silent days and sums totals; topDuelists ranks by wins', () => {
  let day = new Date('2026-06-01T12:00:00Z');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twich-bot-stats-'));
  const store = new ActivityStore({
    storePath: path.join(dir, 'activity.json'),
    xpPerMessage: 2,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    now: () => day
  });
  store.load();
  store.recordMessage({ userId: '1', login: 'bob', name: 'Bob' });
  store.recordMessage({ userId: '2', login: 'ann', name: 'Ann' });
  day = new Date('2026-06-03T12:00:00Z'); // day 2 is silent
  store.recordMessage({ userId: '1', login: 'bob', name: 'Bob' });

  const stats = store.statsByDays(3);
  assert.equal(stats.perDay.length, 3);
  assert.deepEqual(stats.perDay.map((d) => d.messages), [2, 0, 1]);
  assert.deepEqual(stats.perDay.map((d) => d.activeUsers), [2, 0, 1]);
  assert.equal(stats.totals.messages, 3);
  assert.equal(stats.totals.xp, 6);
  assert.equal(stats.totals.activeUsers, 2);
  assert.equal(stats.top[0].login, 'bob');

  store.recordDuel({ challenger: { userId: '1', login: 'bob', name: 'Bob' }, target: { userId: '2', login: 'ann', name: 'Ann' }, winnerLogin: 'bob' });
  store.recordDuel({ challenger: { userId: '1', login: 'bob', name: 'Bob' }, target: { userId: '2', login: 'ann', name: 'Ann' }, winnerLogin: 'bob' });
  const duelists = store.topDuelists(5);
  assert.equal(duelists[0].login, 'bob');
  assert.equal(duelists[0].duelsWon, 2);
  assert.equal(duelists[1].duelsLost, 2);
});
