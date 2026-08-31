import crypto from 'node:crypto';

// In-memory, per-channel bus of "alerts" (meme videos, images, sounds, text popups)
// that OBS browser-source overlays poll and play. Unlike the music queue this is
// deliberately NOT persisted: a meme that fired before a restart must not replay
// when OBS reconnects. Overlays read it with a monotonic cursor (since), so each
// overlay plays every alert exactly once, in order, even across reconnects within
// the retained window.
//
// Two OBS layouts are supported by the SAME bus (the choice is the streamer's):
//   - one full-screen overlay that positions each alert itself (alert.position), or
//   - several named-slot overlays, each added as its own browser source and polling
//     only its slot (?slot=<name>). An alert with slot 'main' shows in the shared
//     overlay; any other slot shows only in the overlay bound to that name.

// Where an alert is drawn inside a full-screen overlay. Named-slot overlays ignore
// this and fill their own source, but it is still stored so a slot can opt to honor
// it. 'fullscreen' stretches to the whole source (used by big video memes).
export const ALERT_ANCHORS = [
  'center',
  'top-left',
  'top',
  'top-right',
  'left',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
  'fullscreen'
];

// What an alert renders. 'text' is a pure caption popup; the media kinds carry a URL
// the overlay loads from the media store; 'giveaway' is an animated draw (roulette of
// names that lands on the winner).
export const ALERT_KINDS = ['video', 'image', 'audio', 'text', 'giveaway', 'celebration'];

export const DEFAULT_SLOT = 'main';

const MAX_BUFFER = 50;
const MAX_TEXT_LENGTH = 280;
const MAX_DURATION_MS = 60_000;
const DEFAULT_DURATION_MS = 8_000;

// Normalize a slot name to a short, URL-safe, lowercase token. Empty / invalid input
// falls back to the shared 'main' slot so a misconfigured alert still shows somewhere.
export function normalizeSlot(slot) {
  const cleaned = String(slot ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return cleaned || DEFAULT_SLOT;
}

export class AlertBus {
  constructor({ maxBuffer = MAX_BUFFER, now = () => Date.now() } = {}) {
    this.maxBuffer = maxBuffer;
    this.now = now;
    this.seq = 0;
    this.buffer = [];
    this.mutedUntil = 0;
  }

  // Panic button: drop all incoming alerts for `minutes` (mods use it when the
  // overlay gets spammed). Muted alerts are discarded, not queued, so unmuting
  // never floods the stream with a backlog.
  mute(minutes) {
    const min = Math.max(0, Math.min(180, Number(minutes) || 0));
    this.mutedUntil = min > 0 ? this.now() + min * 60_000 : 0;
    return this.mutedUntil;
  }

  isMuted() {
    return this.mutedUntil > this.now();
  }

  // Enqueue an alert for the overlays to play. Returns the stored record (with its
  // assigned seq), or throws when the payload is unusable. `seq` is the cursor value
  // overlays compare against; it strictly increases. Returns null while muted.
  push(input = {}) {
    if (this.isMuted()) {
      return null;
    }
    const alert = sanitizeAlert(input, { now: this.now });
    this.seq += 1;
    alert.seq = this.seq;
    this.buffer.push(alert);
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.splice(0, this.buffer.length - this.maxBuffer);
    }
    return structuredClone(alert);
  }

  // Alerts newer than `cursor` for the given slot (or all slots when slot is null/''),
  // plus the cursor to send next time. An overlay calls this in a poll loop:
  //   { alerts, cursor } = bus.since(lastCursor, mySlot)
  // A first poll with cursor 0 returns only alerts still in the buffer — fine, since
  // anything evicted is older than the retained window and already played elsewhere.
  since(cursor = 0, slot = null) {
    const after = Number(cursor) || 0;
    const wantSlot = slot ? normalizeSlot(slot) : null;
    const alerts = this.buffer
      .filter((alert) => alert.seq > after && (wantSlot === null || alert.slot === wantSlot))
      .map((alert) => structuredClone(alert));
    return { alerts, cursor: this.seq };
  }

  // The current head cursor without returning any alerts. An overlay calls this once
  // on load so it only plays alerts fired AFTER it connected (no backlog flood).
  head() {
    return this.seq;
  }

  // Distinct non-default slot names currently in the buffer — used by the panel to
  // hint which named OBS sources are actually receiving alerts.
  activeSlots() {
    const slots = new Set();
    for (const alert of this.buffer) {
      if (alert.slot !== DEFAULT_SLOT) {
        slots.add(alert.slot);
      }
    }
    return [...slots];
  }

  clear() {
    this.buffer = [];
  }
}

// Validate + coerce a raw alert into the stored shape. Throws when a media kind is
// missing its URL or a text alert has no text, so a broken trigger fails loudly at
// push time rather than silently showing an empty overlay.
export function sanitizeAlert(raw, { now = () => Date.now() } = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const kind = ALERT_KINDS.includes(source.kind) ? source.kind : 'video';

  const mediaUrl = typeof source.mediaUrl === 'string' ? source.mediaUrl.trim() : '';
  const text = String(source.text ?? '').trim().slice(0, MAX_TEXT_LENGTH);

  if (kind !== 'text' && kind !== 'giveaway' && kind !== 'celebration' && !mediaUrl) {
    throw new Error(`Alert of kind "${kind}" requires a mediaUrl.`);
  }
  if (kind === 'text' && !text) {
    throw new Error('Text alert requires text.');
  }

  // Giveaway alert: a roulette of candidate names that lands on the winner.
  let giveaway = null;
  if (kind === 'giveaway') {
    const winner = String(source.winner ?? '').trim().slice(0, 60);
    if (!winner) {
      throw new Error('Giveaway alert requires a winner.');
    }
    const names = (Array.isArray(source.names) ? source.names : [])
      .map((n) => String(n ?? '').trim().slice(0, 60))
      .filter(Boolean)
      .slice(0, 60);
    giveaway = { winner, names: names.length ? names : [winner], prize: clampOffsetUp(source.prize) };
  }

  const anchor = ALERT_ANCHORS.includes(source.position?.anchor)
    ? source.position.anchor
    : 'center';

  return {
    id: source.id ? String(source.id) : crypto.randomUUID(),
    slot: normalizeSlot(source.slot),
    kind,
    mediaUrl: mediaUrl || null,
    text: text || null,
    giveaway,
    // Watch-streak celebration: show confetti unless explicitly disabled, plus an
    // optional sound (a relative media URL).
    confetti: source.confetti !== false,
    soundUrl: typeof source.soundUrl === 'string' && source.soundUrl.trim() ? source.soundUrl.trim() : null,
    soundVolume: clampVolume(source.soundVolume),
    durationMs: clampDuration(source.durationMs, kind === 'giveaway' ? 9000 : undefined),
    volume: clampVolume(source.volume),
    position: {
      anchor,
      // Free-form fine offsets in % of the source, applied on top of the anchor.
      x: clampOffset(source.position?.x),
      y: clampOffset(source.position?.y),
      // Scale of the media relative to its natural/source size (0.1–3).
      scale: clampScale(source.position?.scale)
    },
    title: String(source.title ?? '').trim().slice(0, 80) || null,
    createdAt: new Date(now()).toISOString()
  };
}

// Non-negative integer (prize amount), capped to avoid silly values.
function clampOffsetUp(value) {
  const n = Math.floor(Number(value) || 0);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1_000_000) : 0;
}

function clampDuration(value, fallback = DEFAULT_DURATION_MS) {
  const ms = Math.floor(Number(value));
  if (!Number.isFinite(ms) || ms <= 0) {
    return fallback;
  }
  return Math.min(ms, MAX_DURATION_MS);
}

function clampVolume(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 80;
  }
  return Math.min(100, Math.max(0, Math.round(num)));
}

function clampOffset(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  return Math.min(100, Math.max(-100, Math.round(num)));
}

function clampScale(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return 1;
  }
  return Math.min(3, Math.max(0.1, Math.round(num * 100) / 100));
}
