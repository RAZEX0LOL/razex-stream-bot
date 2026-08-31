import assert from 'node:assert/strict';
import test from 'node:test';
import { AlertBus, normalizeSlot, sanitizeAlert } from '../src/alert-bus.js';

test('normalizeSlot lowercases, slugifies and falls back to main', () => {
  assert.equal(normalizeSlot('Main'), 'main');
  assert.equal(normalizeSlot('  Top Right!! '), 'top-right');
  assert.equal(normalizeSlot(''), 'main');
  assert.equal(normalizeSlot(null), 'main');
  assert.equal(normalizeSlot('a'.repeat(50)).length, 32);
});

test('sanitizeAlert requires media for media kinds and text for text kind', () => {
  assert.throws(() => sanitizeAlert({ kind: 'video' }), /requires a mediaUrl/);
  assert.throws(() => sanitizeAlert({ kind: 'text', text: '   ' }), /requires text/);
  const video = sanitizeAlert({ kind: 'video', mediaUrl: '/media/x.mp4' });
  assert.equal(video.kind, 'video');
  assert.equal(video.mediaUrl, '/media/x.mp4');
  assert.equal(video.slot, 'main');
});

test('sanitizeAlert clamps duration, volume, offsets and scale', () => {
  const alert = sanitizeAlert({
    kind: 'image',
    mediaUrl: '/m/p.png',
    durationMs: 999_999,
    volume: 200,
    position: { anchor: 'top-left', x: 999, y: -999, scale: 99 }
  });
  assert.equal(alert.durationMs, 60_000);
  assert.equal(alert.volume, 100);
  assert.equal(alert.position.anchor, 'top-left');
  assert.equal(alert.position.x, 100);
  assert.equal(alert.position.y, -100);
  assert.equal(alert.position.scale, 3);
});

test('sanitizeAlert defaults bad anchor to center and bad duration to default', () => {
  const alert = sanitizeAlert({ kind: 'text', text: 'привет', position: { anchor: 'nope' }, durationMs: -5 });
  assert.equal(alert.position.anchor, 'center');
  assert.equal(alert.durationMs, 8_000);
  assert.equal(alert.mediaUrl, null);
  assert.equal(alert.text, 'привет');
});

test('push assigns strictly increasing seq and clones the record', () => {
  const bus = new AlertBus();
  const a = bus.push({ kind: 'text', text: 'a' });
  const b = bus.push({ kind: 'text', text: 'b' });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.equal(bus.head(), 2);
});

test('since returns only alerts newer than the cursor and advances it', () => {
  const bus = new AlertBus();
  bus.push({ kind: 'text', text: 'one' });
  bus.push({ kind: 'text', text: 'two' });

  const first = bus.since(0);
  assert.equal(first.alerts.length, 2);
  assert.equal(first.cursor, 2);

  bus.push({ kind: 'text', text: 'three' });
  const next = bus.since(first.cursor);
  assert.equal(next.alerts.length, 1);
  assert.equal(next.alerts[0].text, 'three');
  assert.equal(next.cursor, 3);
});

test('since filters by slot, treating main as the shared slot', () => {
  const bus = new AlertBus();
  bus.push({ kind: 'text', text: 'shared' }); // main
  bus.push({ kind: 'text', text: 'corner', slot: 'top-right' });

  assert.deepEqual(
    bus.since(0, 'main').alerts.map((a) => a.text),
    ['shared']
  );
  assert.deepEqual(
    bus.since(0, 'top-right').alerts.map((a) => a.text),
    ['corner']
  );
  // No slot filter → everything.
  assert.equal(bus.since(0).alerts.length, 2);
});

test('buffer is capped, evicting the oldest alerts', () => {
  const bus = new AlertBus({ maxBuffer: 3 });
  for (let i = 1; i <= 5; i += 1) {
    bus.push({ kind: 'text', text: String(i) });
  }
  const all = bus.since(0);
  assert.deepEqual(all.alerts.map((a) => a.text), ['3', '4', '5']);
  // Cursor still reflects the true head, so a fresh poll won't replay evicted alerts.
  assert.equal(all.cursor, 5);
});

test('activeSlots lists distinct non-default slots', () => {
  const bus = new AlertBus();
  bus.push({ kind: 'text', text: 'a' }); // main
  bus.push({ kind: 'text', text: 'b', slot: 'cam' });
  bus.push({ kind: 'text', text: 'c', slot: 'cam' });
  bus.push({ kind: 'text', text: 'd', slot: 'corner' });
  assert.deepEqual(bus.activeSlots().sort(), ['cam', 'corner']);
});

test('giveaway alert: requires a winner, carries names + prize, default duration', () => {
  assert.throws(() => sanitizeAlert({ kind: 'giveaway' }), /requires a winner/);
  const a = sanitizeAlert({ kind: 'giveaway', winner: 'Ann', names: ['Bob', 'Ann', 'Cara'], prize: 500 });
  assert.equal(a.kind, 'giveaway');
  assert.equal(a.giveaway.winner, 'Ann');
  assert.deepEqual(a.giveaway.names, ['Bob', 'Ann', 'Cara']);
  assert.equal(a.giveaway.prize, 500);
  assert.equal(a.durationMs, 9000);
  // No names → falls back to [winner].
  assert.deepEqual(sanitizeAlert({ kind: 'giveaway', winner: 'Solo' }).giveaway.names, ['Solo']);
});

test('mute drops incoming alerts and expires', () => {
  let t = 1000;
  const bus = new AlertBus({ now: () => t });
  bus.mute(5);
  assert.equal(bus.isMuted(), true);
  assert.equal(bus.push({ kind: 'text', text: 'spam' }), null);
  assert.equal(bus.since(0).alerts.length, 0);
  t += 5 * 60_000 + 1;
  assert.equal(bus.isMuted(), false);
  assert.ok(bus.push({ kind: 'text', text: 'back' }));
  bus.mute(5);
  bus.mute(0); // explicit unmute
  assert.equal(bus.isMuted(), false);
});
