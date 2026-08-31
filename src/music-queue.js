import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic, quarantineCorrupt } from './json-store.js';

const DEFAULT_DATA = {
  version: 1,
  nowPlaying: null,
  queue: [],
  paused: false,
  volume: 100,
  // Streamer's private monitor volume — a second player page (/monitor) she opens for her
  // own ears plays at this level, independent of `volume` (what viewers hear on stream).
  monitorVolume: 100,
  muted: false,
  // Repeat the current track: the overlay restarts it on end instead of advancing.
  repeat: false,
  // AutoDJ: a background playlist that fills the air when the request queue is empty.
  // Tracks loop round-robin; viewer requests always take priority over them.
  autoDj: { enabled: false, tracks: [], index: 0 },
  // Overlay display mode, toggled from the panel and read live by the OBS overlay
  // (no URL change / source re-add needed): audioOnly drops the video, lowq uses a
  // light ~48kbps audio for throttled connections.
  // videoHeight: per-channel cap (null = global default) so a weak connection can
  // keep video at 480p/360p instead of losing it entirely.
  overlay: { audioOnly: false, lowq: false, videoHeight: null }
};

function sanitizeAutoDj(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const tracks = (Array.isArray(source.tracks) ? source.tracks : [])
    .filter((t) => t && t.videoId)
    .map((t) => ({
      videoId: String(t.videoId),
      title: String(t.title ?? t.videoId),
      url: t.url ?? `https://www.youtube.com/watch?v=${t.videoId}`,
      durationSec: Number.isFinite(Number(t.durationSec)) ? Number(t.durationSec) : null
    }))
    .slice(0, 200);
  const index = Number.isInteger(source.index) && source.index >= 0 ? source.index : 0;
  return { enabled: source.enabled === true, tracks, index: tracks.length ? index % tracks.length : 0 };
}

function clampVolume(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return DEFAULT_DATA.volume;
  }
  return Math.min(100, Math.max(0, Math.round(num)));
}

export class MusicQueue {
  constructor({ storePath, maxQueueLength = 50, logger, now = () => new Date() }) {
    this.storePath = path.resolve(process.cwd(), storePath);
    this.maxQueueLength = maxQueueLength;
    this.logger = logger;
    this.now = now;
    this.data = structuredClone(DEFAULT_DATA);
    // Playback progress/seek live in memory only (reported every ~2s by the OBS
    // overlay; persisting them would churn the store file for no benefit).
    this.progress = null; // { positionSec, durationSec, at }
    this.seekRequest = null; // { seq, toSec } — overlay applies once per seq
    this.seekSeq = 0;
  }

  // Panel asks to jump to `seconds` in the current track; the overlay picks it up on
  // its next state poll (~2s) and moves audio.currentTime.
  requestSeek(seconds) {
    const toSec = Math.max(0, Number(seconds) || 0);
    this.seekSeq += 1;
    this.seekRequest = { seq: this.seekSeq, toSec };
    return this.seekRequest;
  }

  // Panel toggles the overlay display mode; the OBS overlay reads it live from state().
  setOverlayMode(patch = {}) {
    if (typeof patch.audioOnly === 'boolean') this.data.overlay.audioOnly = patch.audioOnly;
    if (patch.videoHeight === null || Number.isFinite(Number(patch.videoHeight))) {
      this.data.overlay.videoHeight = patch.videoHeight === null ? null : Number(patch.videoHeight);
    }
    if (typeof patch.lowq === 'boolean') this.data.overlay.lowq = patch.lowq;
    this.save();
    return { ...this.data.overlay };
  }

  // The overlay reports where playback actually is, plus its own health: how many times
  // it had to stop and rebuffer recently (stalls/min), whether it's stalled right now,
  // and how many seconds of buffer it has ahead. This is measured IN THE STREAMER'S OBS
  // (their real connection), so the panel can show a live quality indicator.
  reportProgress(positionSec, durationSec, health = {}) {
    this.progress = {
      positionSec: Math.max(0, Number(positionSec) || 0),
      durationSec: Math.max(0, Number(durationSec) || 0),
      at: this.now().getTime(),
      stalls: Math.max(0, Math.floor(Number(health.stalls) || 0)),
      stalledNow: health.stalledNow === true,
      bufferSec: Math.max(0, Number(health.bufferSec) || 0)
    };
    return this.progress;
  }

  load() {
    if (!fs.existsSync(this.storePath)) {
      this.ensureDirectory();
      this.save();
      return;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      this.data = {
        ...structuredClone(DEFAULT_DATA),
        ...parsed,
        nowPlaying: parsed.nowPlaying ?? null,
        queue: Array.isArray(parsed.queue) ? parsed.queue : [],
        paused: parsed.paused === true,
        volume: clampVolume(parsed.volume ?? DEFAULT_DATA.volume),
        monitorVolume: clampVolume(parsed.monitorVolume ?? DEFAULT_DATA.monitorVolume),
        muted: parsed.muted === true,
        repeat: parsed.repeat === true,
        autoDj: sanitizeAutoDj(parsed.autoDj),
        overlay: {
          audioOnly: parsed.overlay?.audioOnly === true,
          videoHeight: Number.isFinite(Number(parsed.overlay?.videoHeight)) ? Number(parsed.overlay.videoHeight) : null,
          lowq: parsed.overlay?.lowq === true
        }
      };
    } catch (error) {
      quarantineCorrupt(this.storePath, error, { logger: this.logger });
      this.logger?.warn('Failed to read music queue, starting fresh.', error);
      this.data = structuredClone(DEFAULT_DATA);
    }
  }

  add(track) {
    if (!track?.videoId) {
      throw new Error('Не получилось распознать трек.');
    }

    if (this.data.queue.length >= this.maxQueueLength) {
      throw new Error('Очередь музыки заполнена.');
    }

    const item = this.buildItem(track);
    this.data.queue.push(item);

    let position;
    if (!this.data.nowPlaying) {
      this.promoteNext();
      position = 0;
    } else {
      position = this.data.queue.length;
    }

    this.save();
    return { item, position };
  }

  // Bulk add (e.g. a playlist): fills the queue up to maxQueueLength and writes
  // the store once. Returns how many were actually added and how many were left
  // out because the queue filled up.
  addMany(tracks) {
    const added = [];
    let skipped = 0;
    for (const track of tracks ?? []) {
      if (!track?.videoId) {
        continue;
      }
      if (this.data.queue.length >= this.maxQueueLength) {
        skipped += 1;
        continue;
      }
      this.data.queue.push(this.buildItem(track));
      if (!this.data.nowPlaying) {
        this.promoteNext();
      }
      added.push(track);
    }

    if (added.length > 0) {
      this.save();
    }
    return { added: added.length, skipped };
  }

  buildItem(track) {
    return {
      id: crypto.randomUUID(),
      videoId: track.videoId,
      title: track.title ?? track.videoId,
      url: track.url ?? `https://www.youtube.com/watch?v=${track.videoId}`,
      requestedBy: track.requestedBy ?? '',
      requestedByLogin: track.requestedByLogin ?? '',
      requestedAt: this.now().toISOString()
    };
  }

  advance() {
    const finished = this.data.nowPlaying;
    this.promoteNext();
    this.save();
    return { finished, nowPlaying: this.data.nowPlaying };
  }

  skip() {
    return this.advance();
  }

  remove(id) {
    const before = this.data.queue.length;
    this.data.queue = this.data.queue.filter((item) => item.id !== id);
    const removed = this.data.queue.length !== before;
    if (removed) {
      this.save();
    }

    return removed;
  }

  // Cancel several queued tracks at once (panel multi-select). Never touches the
  // currently playing track. Returns how many were actually removed.
  removeMany(ids) {
    const toRemove = new Set((Array.isArray(ids) ? ids : []).map((id) => String(id)));
    if (toRemove.size === 0) {
      return 0;
    }
    const before = this.data.queue.length;
    this.data.queue = this.data.queue.filter((item) => !toRemove.has(item.id));
    const removed = before - this.data.queue.length;
    if (removed > 0) {
      this.save();
    }
    return removed;
  }

  clear() {
    this.data.queue = [];
    this.data.nowPlaying = null;
    this.save();
  }

  setPaused(paused) {
    this.data.paused = Boolean(paused);
    this.save();
    return this.data.paused;
  }

  setVolume(volume) {
    this.data.volume = clampVolume(volume);
    this.save();
    return this.data.volume;
  }

  setMonitorVolume(volume) {
    this.data.monitorVolume = clampVolume(volume);
    this.save();
    return this.data.monitorVolume;
  }

  setMuted(muted) {
    this.data.muted = Boolean(muted);
    this.save();
    return this.data.muted;
  }

  setRepeat(repeat) {
    this.data.repeat = Boolean(repeat);
    this.save();
    return this.data.repeat;
  }

  state() {
    return {
      nowPlaying: this.data.nowPlaying,
      queue: this.data.queue,
      paused: this.data.paused,
      volume: this.data.volume,
      monitorVolume: this.data.monitorVolume,
      muted: this.data.muted,
      repeat: this.data.repeat,
      length: this.data.queue.length,
      autoDj: { enabled: this.data.autoDj.enabled, count: this.data.autoDj.tracks.length },
      progress: this.progress,
      seek: this.seekRequest,
      audioOnly: this.data.overlay.audioOnly,
      videoHeight: this.data.overlay.videoHeight,
      lowq: this.data.overlay.lowq
    };
  }

  // Video ids of the next `count` tracks that will play, in order — queued requests
  // first, then AutoDJ round-robin. Used to pre-resolve (warm the stream-URL cache)
  // so track transitions don't stall on a cold yt-dlp resolve.
  upcomingVideoIds(count = 1) {
    const ids = [];
    for (const item of this.data.queue) {
      if (item.videoId) ids.push(item.videoId);
      if (ids.length >= count) return ids;
    }
    const autoDj = this.data.autoDj;
    if (autoDj.enabled && autoDj.tracks.length > 0) {
      for (let i = 0; ids.length < count && i < autoDj.tracks.length; i += 1) {
        const track = autoDj.tracks[(autoDj.index + i) % autoDj.tracks.length];
        if (track?.videoId) ids.push(track.videoId);
      }
    }
    return ids;
  }

  // Full AutoDJ track list for the panel (so the streamer isn't loading a playlist blind).
  // `index` is the position of the NEXT background track to play.
  autoDjState() {
    return {
      enabled: this.data.autoDj.enabled,
      index: this.data.autoDj.index,
      count: this.data.autoDj.tracks.length,
      tracks: this.data.autoDj.tracks.map((t) => ({
        title: t.title || t.videoId || '—',
        url: t.url || (t.videoId ? `https://youtu.be/${t.videoId}` : ''),
        durationSec: Number.isFinite(t.durationSec) ? t.durationSec : null
      }))
    };
  }

  // Replace the AutoDJ background playlist. Resets the rotation. When AutoDJ is on and
  // nothing is playing, immediately starts a background track so the air isn't dead.
  setAutoDjTracks(tracks) {
    this.data.autoDj.tracks = sanitizeAutoDj({ tracks }).tracks;
    this.data.autoDj.index = 0;
    if (this.data.autoDj.enabled && !this.data.nowPlaying) {
      this.promoteNext();
    }
    this.save();
    return this.state();
  }

  setAutoDjEnabled(enabled) {
    this.data.autoDj.enabled = Boolean(enabled);
    // Turning it on with a dead queue kicks off background playback right away.
    if (this.data.autoDj.enabled && !this.data.nowPlaying && this.data.queue.length === 0) {
      this.promoteNext();
    }
    this.save();
    return this.state();
  }

  // Promote the next track: a viewer request first, otherwise (when AutoDJ is on) the
  // next background track round-robin. Returns the new nowPlaying (or null for silence).
  promoteNext() {
    // New track → stale progress/seek from the previous one must not leak through.
    this.progress = null;
    this.seekRequest = null;
    const requested = this.data.queue.shift();
    if (requested) {
      this.data.nowPlaying = requested;
      return this.data.nowPlaying;
    }
    const autoDj = this.data.autoDj;
    if (autoDj.enabled && autoDj.tracks.length > 0) {
      const track = autoDj.tracks[autoDj.index % autoDj.tracks.length];
      autoDj.index = (autoDj.index + 1) % autoDj.tracks.length;
      this.data.nowPlaying = this.buildItem({ ...track, requestedBy: 'AutoDJ', requestedByLogin: '' });
      return this.data.nowPlaying;
    }
    this.data.nowPlaying = null;
    return null;
  }

  save() {
    this.ensureDirectory();
    writeJsonAtomic(this.storePath, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  ensureDirectory() {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
  }
}
