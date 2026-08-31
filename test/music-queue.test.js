import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MusicQueue } from '../src/music-queue.js';

function createQueue(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-queue-'));
  const queue = new MusicQueue({
    storePath: path.join(dir, 'queue.json'),
    now: () => new Date('2026-06-01T00:00:00Z'),
    ...overrides
  });
  queue.load();
  return queue;
}

test('monitorVolume is separate from viewer volume, clamped and persisted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-queue-'));
  const p = path.join(dir, 'queue.json');
  const queue = new MusicQueue({ storePath: p });
  queue.load();
  assert.equal(queue.state().monitorVolume, 100); // default
  queue.setVolume(40);
  queue.setMonitorVolume(150); // clamps to 100
  assert.equal(queue.state().monitorVolume, 100);
  queue.setMonitorVolume(25);
  assert.equal(queue.state().monitorVolume, 25);
  assert.equal(queue.state().volume, 40); // viewer volume untouched
  const reloaded = new MusicQueue({ storePath: p });
  reloaded.load();
  assert.equal(reloaded.state().monitorVolume, 25); // survives reload
  assert.equal(reloaded.state().volume, 40);
});

test('first track becomes now playing at position 0', () => {
  const queue = createQueue();
  const { item, position } = queue.add({ videoId: 'a'.repeat(11), title: 'First' });

  assert.equal(position, 0);
  assert.equal(queue.state().nowPlaying.id, item.id);
  assert.equal(queue.state().queue.length, 0);
});

test('second track waits in queue', () => {
  const queue = createQueue();
  queue.add({ videoId: 'a'.repeat(11), title: 'First' });
  const { position } = queue.add({ videoId: 'b'.repeat(11), title: 'Second' });

  assert.equal(position, 1);
  assert.equal(queue.state().queue.length, 1);
});

test('advance promotes next track', () => {
  const queue = createQueue();
  queue.add({ videoId: 'a'.repeat(11), title: 'First' });
  queue.add({ videoId: 'b'.repeat(11), title: 'Second' });

  const { finished, nowPlaying } = queue.advance();
  assert.equal(finished.title, 'First');
  assert.equal(nowPlaying.title, 'Second');
  assert.equal(queue.state().queue.length, 0);
});

test('advance on last track clears now playing', () => {
  const queue = createQueue();
  queue.add({ videoId: 'a'.repeat(11), title: 'First' });

  const { nowPlaying } = queue.advance();
  assert.equal(nowPlaying, null);
});

test('clear empties everything', () => {
  const queue = createQueue();
  queue.add({ videoId: 'a'.repeat(11), title: 'First' });
  queue.add({ videoId: 'b'.repeat(11), title: 'Second' });
  queue.clear();

  const state = queue.state();
  assert.equal(state.nowPlaying, null);
  assert.equal(state.queue.length, 0);
});

test('respects max waiting queue length', () => {
  const queue = createQueue({ maxQueueLength: 1 });
  queue.add({ videoId: 'a'.repeat(11), title: 'Now playing' });
  queue.add({ videoId: 'b'.repeat(11), title: 'Waiting' });
  assert.throws(() => queue.add({ videoId: 'c'.repeat(11), title: 'Overflow' }), /заполнена/);
});

test('persists across reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-queue-'));
  const storePath = path.join(dir, 'queue.json');
  const first = new MusicQueue({ storePath });
  first.load();
  first.add({ videoId: 'a'.repeat(11), title: 'Persisted' });

  const second = new MusicQueue({ storePath });
  second.load();
  assert.equal(second.state().nowPlaying.title, 'Persisted');
});

test('rejects track without videoId', () => {
  const queue = createQueue();
  assert.throws(() => queue.add({ title: 'No id' }));
});

test('addMany queues multiple tracks and promotes the first', () => {
  const queue = createQueue();
  const result = queue.addMany([
    { videoId: 'a'.repeat(11), title: 'One' },
    { videoId: 'b'.repeat(11), title: 'Two' },
    { videoId: 'c'.repeat(11), title: 'Three' }
  ]);

  assert.equal(result.added, 3);
  assert.equal(result.skipped, 0);
  assert.equal(queue.state().nowPlaying.title, 'One');
  assert.equal(queue.state().queue.length, 2);
});

test('addMany stops at maxQueueLength and reports skipped', () => {
  const queue = createQueue({ maxQueueLength: 2 });
  const result = queue.addMany([
    { videoId: 'a'.repeat(11), title: 'One' },
    { videoId: 'b'.repeat(11), title: 'Two' },
    { videoId: 'c'.repeat(11), title: 'Three' },
    { videoId: 'd'.repeat(11), title: 'Four' }
  ]);

  // One promotes to nowPlaying (frees a slot), queue holds Two+Three, Four is rejected.
  assert.equal(result.added, 3);
  assert.equal(result.skipped, 1);
  assert.equal(queue.state().nowPlaying.title, 'One');
  assert.equal(queue.state().queue.length, 2);
});

test('addMany skips entries without videoId', () => {
  const queue = createQueue();
  const result = queue.addMany([{ title: 'bad' }, { videoId: 'a'.repeat(11), title: 'Good' }]);
  assert.equal(result.added, 1);
});

test('volume defaults to 100 and is clamped on set', () => {
  const queue = createQueue();
  assert.equal(queue.state().volume, 100);
  assert.equal(queue.state().muted, false);

  assert.equal(queue.setVolume(40), 40);
  assert.equal(queue.state().volume, 40);

  assert.equal(queue.setVolume(150), 100);
  assert.equal(queue.setVolume(-10), 0);
  assert.equal(queue.setVolume('abc'), 100);
});

test('muted toggles and persists in state', () => {
  const queue = createQueue();
  assert.equal(queue.setMuted(true), true);
  assert.equal(queue.state().muted, true);
  assert.equal(queue.setMuted(false), false);
});

test('volume and muted survive reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-queue-'));
  const storePath = path.join(dir, 'queue.json');
  const queue = new MusicQueue({ storePath });
  queue.load();
  queue.setVolume(55);
  queue.setMuted(true);

  const reopened = new MusicQueue({ storePath });
  reopened.load();
  assert.equal(reopened.state().volume, 55);
  assert.equal(reopened.state().muted, true);
});

test('removeMany cancels several queued tracks, leaves now playing and others', () => {
  const queue = createQueue();
  queue.add({ videoId: 'a'.repeat(11), title: 'Now' }); // becomes nowPlaying
  const b = queue.add({ videoId: 'b'.repeat(11), title: 'B' }).item;
  const c = queue.add({ videoId: 'c'.repeat(11), title: 'C' }).item;
  const d = queue.add({ videoId: 'd'.repeat(11), title: 'D' }).item;

  const removed = queue.removeMany([b.id, d.id, 'missing']);
  assert.equal(removed, 2);
  const state = queue.state();
  assert.equal(state.nowPlaying.title, 'Now');
  assert.deepEqual(state.queue.map((i) => i.id), [c.id]);
});

test('removeMany with empty or non-array input is a no-op', () => {
  const queue = createQueue();
  queue.add({ videoId: 'a'.repeat(11), title: 'Now' });
  queue.add({ videoId: 'b'.repeat(11), title: 'B' });
  assert.equal(queue.removeMany([]), 0);
  assert.equal(queue.removeMany(undefined), 0);
  assert.equal(queue.state().queue.length, 1);
});

test('AutoDJ fills the air when the request queue is empty, requests take priority', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mq-autodj-'));
  const queue = new MusicQueue({ storePath: path.join(dir, 'q.json') });
  queue.setAutoDjTracks([{ videoId: 'bg1', title: 'BG One' }, { videoId: 'bg2', title: 'BG Two' }]);

  // Off by default → nothing auto-starts.
  assert.equal(queue.state().nowPlaying, null);

  // Enabling with an empty queue starts a background track.
  queue.setAutoDjEnabled(true);
  assert.equal(queue.state().nowPlaying.videoId, 'bg1');
  assert.equal(queue.state().nowPlaying.requestedBy, 'AutoDJ');

  // A viewer request jumps ahead of AutoDJ.
  queue.add({ videoId: 'req1', title: 'Requested' });
  assert.equal(queue.state().queue.length, 1);
  assert.equal(queue.advance().nowPlaying.videoId, 'req1');

  // After the request, AutoDJ resumes round-robin (bg2, then back to bg1).
  assert.equal(queue.advance().nowPlaying.videoId, 'bg2');
  assert.equal(queue.advance().nowPlaying.videoId, 'bg1');
});

test('AutoDJ state and tracks survive reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mq-autodj-reload-'));
  const opts = { storePath: path.join(dir, 'q.json') };
  const a = new MusicQueue(opts);
  a.setAutoDjTracks([{ videoId: 'bg1', title: 'BG' }]);
  a.setAutoDjEnabled(true);
  const b = new MusicQueue(opts);
  b.load();
  assert.equal(b.state().autoDj.enabled, true);
  assert.equal(b.state().autoDj.count, 1);
});

test('autoDjState exposes the full track list for the panel', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mq-adj-'));
  const q = new MusicQueue({ storePath: path.join(dir, 'q.json') });
  q.load();
  q.setAutoDjTracks([
    { videoId: 'aaaaaaaaaaa', title: 'Song A', url: 'https://youtu.be/aaaaaaaaaaa', durationSec: 200 },
    { videoId: 'bbbbbbbbbbb', title: 'Song B', url: 'https://youtu.be/bbbbbbbbbbb', durationSec: 125 }
  ]);
  const s = q.autoDjState();
  assert.equal(s.count, 2);
  assert.equal(s.tracks[0].title, 'Song A');
  assert.equal(s.tracks[1].durationSec, 125);
  assert.equal(typeof s.index, 'number');
});

test('seek and progress live in memory, reset on track change', () => {
  const queue = createQueue();
  queue.load();
  queue.add({ videoId: 'aaa', title: 'A' });
  queue.add({ videoId: 'bbb', title: 'B' });

  const seek = queue.requestSeek(75.5);
  assert.deepEqual(seek, { seq: 1, toSec: 75.5 });
  queue.reportProgress(76, 190);
  let s = queue.state();
  assert.equal(s.seek.seq, 1);
  assert.equal(s.progress.positionSec, 76);
  assert.equal(s.progress.durationSec, 190);
  assert.ok(s.progress.at > 0);

  // Negative/garbage input clamps to zero.
  assert.equal(queue.requestSeek(-10).toSec, 0);
  assert.equal(queue.reportProgress('x', 'y').positionSec, 0);

  // Advancing to the next track clears both (no stale seek on the new song).
  queue.advance();
  s = queue.state();
  assert.equal(s.progress, null);
  assert.equal(s.seek, null);

  // Nothing playback-related leaks into the persisted store file.
  const raw = JSON.parse(fs.readFileSync(queue.storePath, 'utf8'));
  assert.equal('progress' in raw, false);
  assert.equal('seek' in raw, false);
});

test('upcomingVideoIds returns queued tracks first, then AutoDJ round-robin', () => {
  const queue = createQueue();
  queue.load();
  queue.setAutoDjTracks([
    { videoId: 'dj000000001', title: 'DJ1' },
    { videoId: 'dj000000002', title: 'DJ2' }
  ]);
  queue.setAutoDjEnabled(true);
  // With AutoDJ on and empty request queue, promoteNext already started DJ1 → index=1.
  // Add two viewer requests: they play before AutoDJ resumes.
  queue.add({ videoId: 'req00000001', title: 'R1' });
  queue.add({ videoId: 'req00000002', title: 'R2' });
  assert.deepEqual(queue.upcomingVideoIds(1), ['req00000001']);
  assert.deepEqual(queue.upcomingVideoIds(3), ['req00000001', 'req00000002', 'dj000000002']);

  const empty = createQueue();
  empty.load();
  assert.deepEqual(empty.upcomingVideoIds(2), []);
});

test('overlay mode toggles persist and appear in state()', () => {
  const queue = createQueue();
  queue.load();
  let s = queue.state();
  assert.equal(s.audioOnly, false);
  assert.equal(s.lowq, false);

  queue.setOverlayMode({ audioOnly: true });
  s = queue.state();
  assert.equal(s.audioOnly, true);
  assert.equal(s.lowq, false);

  queue.setOverlayMode({ lowq: true, audioOnly: false });
  s = queue.state();
  assert.equal(s.audioOnly, false);
  assert.equal(s.lowq, true);

  // Non-boolean patch keys are ignored (no accidental reset).
  queue.setOverlayMode({ foo: 'bar' });
  assert.equal(queue.state().lowq, true);

  // Persists across reload.
  const reopened = new MusicQueue({ storePath: queue.storePath });
  reopened.load();
  assert.equal(reopened.state().lowq, true);
});

test('reportProgress carries overlay health (stalls/stalledNow/bufferSec)', () => {
  const queue = createQueue();
  queue.load();
  queue.reportProgress(42, 180, { stalls: 3, stalledNow: true, bufferSec: 1.5 });
  const p = queue.state().progress;
  assert.equal(p.positionSec, 42);
  assert.equal(p.stalls, 3);
  assert.equal(p.stalledNow, true);
  assert.equal(p.bufferSec, 1.5);
  // Defaults clean when omitted / garbage.
  queue.reportProgress(1, 2, { stalls: -5, stalledNow: 'x', bufferSec: 'y' });
  const p2 = queue.state().progress;
  assert.equal(p2.stalls, 0);
  assert.equal(p2.stalledNow, false);
  assert.equal(p2.bufferSec, 0);
});

test('repeat flag: default off, toggles, persists, and surfaces in state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mq-repeat-'));
  const p = path.join(dir, 'q.json');
  const q = new MusicQueue({ storePath: p });
  q.load();
  assert.equal(q.state().repeat, false);
  assert.equal(q.setRepeat(true), true);
  assert.equal(q.state().repeat, true);
  // Persisted across reload.
  const q2 = new MusicQueue({ storePath: p });
  q2.load();
  assert.equal(q2.state().repeat, true);
  assert.equal(q2.setRepeat(false), false);
  assert.equal(q2.state().repeat, false);
});
