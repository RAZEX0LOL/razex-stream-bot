import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic, quarantineCorrupt } from './json-store.js';

// Per-channel timers ("таймеры"): periodic chat messages, the Nightbot/StreamElements
// staple. Each timer posts one of its messages every `intervalSeconds`, but only if at
// least `minLines` chat lines passed since it last fired (so a dead chat isn't spammed).
// The store holds config + persistence; firing/scheduling lives in TimerRunner.

const DEFAULT_DATA = { version: 1, timers: [] };

const MAX_TIMERS = 30;
const MAX_NAME_LENGTH = 40;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 400;
const MIN_INTERVAL = 30;
const MAX_INTERVAL = 86_400;

export class TimerStore {
  constructor({ storePath, logger }) {
    this.storePath = path.resolve(process.cwd(), storePath);
    this.logger = logger;
    this.data = structuredClone(DEFAULT_DATA);
  }

  load() {
    if (!fs.existsSync(this.storePath)) {
      this.ensureDirectory();
      this.save();
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      const timers = (Array.isArray(parsed.timers) ? parsed.timers : [])
        .map(sanitizeTimer)
        .filter(Boolean)
        .slice(0, MAX_TIMERS);
      this.data = { version: 1, timers };
    } catch (error) {
      quarantineCorrupt(this.storePath, error, { logger: this.logger });
      this.logger?.warn('Failed to read timer store, starting empty.', error);
      this.data = structuredClone(DEFAULT_DATA);
    }
  }

  list() {
    return this.data.timers.map((timer) => structuredClone(timer));
  }

  get(id) {
    return this.data.timers.find((timer) => timer.id === id) ?? null;
  }

  upsert(input) {
    const timer = sanitizeTimer({ ...input, id: input.id || crypto.randomUUID() });
    if (!timer) {
      throw new Error('Проверь таймер: нужно имя, хотя бы одно сообщение и интервал.');
    }
    const index = this.data.timers.findIndex((entry) => entry.id === timer.id);
    if (index >= 0) {
      this.data.timers[index] = timer;
    } else {
      if (this.data.timers.length >= MAX_TIMERS) {
        throw new Error(`Достигнут лимит таймеров (${MAX_TIMERS}).`);
      }
      this.data.timers.push(timer);
    }
    this.save();
    return structuredClone(timer);
  }

  remove(id) {
    const before = this.data.timers.length;
    this.data.timers = this.data.timers.filter((timer) => timer.id !== id);
    const removed = this.data.timers.length !== before;
    if (removed) {
      this.save();
    }
    return removed;
  }

  save() {
    this.ensureDirectory();
    writeJsonAtomic(this.storePath, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  ensureDirectory() {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
  }
}

export function sanitizeTimer(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const name = String(source.name ?? '').trim().slice(0, MAX_NAME_LENGTH);
  if (!name) {
    return null;
  }
  const messages = (Array.isArray(source.messages) ? source.messages : [])
    .map((message) => String(message ?? '').trim().slice(0, MAX_MESSAGE_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_MESSAGES);
  if (messages.length === 0) {
    return null;
  }
  return {
    id: source.id ? String(source.id) : crypto.randomUUID(),
    name,
    messages,
    intervalSeconds: clampInterval(source.intervalSeconds),
    minLines: clampMinLines(source.minLines),
    enabled: source.enabled !== false
  };
}

function clampInterval(value) {
  const seconds = Math.floor(Number(value ?? 300));
  if (!Number.isFinite(seconds)) {
    return 300;
  }
  return Math.min(Math.max(seconds, MIN_INTERVAL), MAX_INTERVAL);
}

function clampMinLines(value) {
  const lines = Math.floor(Number(value ?? 5));
  if (!Number.isFinite(lines) || lines < 0) {
    return 0;
  }
  return Math.min(lines, 1000);
}
