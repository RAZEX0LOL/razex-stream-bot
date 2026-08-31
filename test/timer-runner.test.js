import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimerStore, sanitizeTimer } from '../src/timer-store.js';
import { TimerRunner } from '../src/timer-runner.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timer-'));
  return new TimerStore({ storePath: path.join(dir, 'timers.json') });
}

test('sanitizeTimer requires a name and at least one message, clamps interval', () => {
  assert.equal(sanitizeTimer({ messages: ['hi'] }), null);
  assert.equal(sanitizeTimer({ name: 'X', messages: [] }), null);
  const t = sanitizeTimer({ name: 'Discord', messages: ['join!', ' '], intervalSeconds: 5, minLines: -3 });
  assert.equal(t.messages.length, 1);
  assert.equal(t.intervalSeconds, 30); // clamped up to MIN_INTERVAL
  assert.equal(t.minLines, 0);
  assert.equal(t.enabled, true);
});

test('store upsert/remove and persistence', () => {
  const store = tmpStore();
  const t = store.upsert({ name: 'Discord', messages: ['join'], intervalSeconds: 60 });
  assert.equal(store.list().length, 1);
  store.upsert({ ...t, messages: ['join us'] });
  assert.equal(store.get(t.id).messages[0], 'join us');
  assert.equal(store.remove(t.id), true);
  assert.equal(store.list().length, 0);
});

test('runner fires only after the interval AND enough chat lines', async () => {
  const store = tmpStore();
  store.upsert({ name: 'T', messages: ['m1', 'm2'], intervalSeconds: 60, minLines: 3 });

  let t = 1_000_000;
  const sent = [];
  const runner = new TimerRunner({ store, sendMessage: async (m) => sent.push(m), now: () => t });
  // Seed state at "now".
  runner.start();
  runner.stop(); // we drive tick() manually

  // Interval not elapsed yet → nothing.
  t += 10_000;
  for (let i = 0; i < 5; i += 1) runner.noteMessage();
  assert.deepEqual(await runner.tick(), []);

  // Interval elapsed but not enough lines since last fire.
  t += 60_000;
  // lineCount currently 5; linesAtFire was 0 at start → diff 5 >= 3 → enough.
  assert.deepEqual(await runner.tick(), ['m1']);

  // Right after firing: interval not elapsed → nothing.
  assert.deepEqual(await runner.tick(), []);

  // Elapse interval but no new lines → blocked by minLines.
  t += 60_000;
  assert.deepEqual(await runner.tick(), []);

  // Add lines and elapse → next message (round-robin → m2).
  for (let i = 0; i < 3; i += 1) runner.noteMessage();
  t += 60_000;
  assert.deepEqual(await runner.tick(), ['m2']);
});

test('disabled timers never fire', async () => {
  const store = tmpStore();
  store.upsert({ name: 'Off', messages: ['x'], intervalSeconds: 30, minLines: 0, enabled: false });
  let t = 1000;
  const sent = [];
  const runner = new TimerRunner({ store, sendMessage: async (m) => sent.push(m), now: () => t });
  t += 999_999;
  assert.deepEqual(await runner.tick(), []);
});
