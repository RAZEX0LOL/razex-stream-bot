import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic, quarantineCorrupt } from './json-store.js';

const DEFAULT_DATA = {
  version: 1,
  blockedKeywords: [],
  maxDurationSeconds: 0,
  checkLyrics: false
};

// Limits kept generous; the panel just needs sane bounds to avoid garbage input.
const MAX_DURATION_CAP = 36000; // 10 hours
const MAX_KEYWORDS = 200;
const MAX_KEYWORD_LENGTH = 80;

// Runtime-editable DMCA guard settings (blocklist + duration cap), persisted to a
// small JSON file so they survive restarts and can be changed from the web panel.
export class FilterStore {
  constructor({ storePath, defaults = {}, logger }) {
    this.storePath = path.resolve(process.cwd(), storePath);
    this.logger = logger;
    this.data = { ...structuredClone(DEFAULT_DATA), ...sanitize(defaults) };
  }

  load() {
    if (!fs.existsSync(this.storePath)) {
      // First run: seed the file from config-provided defaults.
      this.ensureDirectory();
      this.save();
      return;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      this.data = { ...structuredClone(DEFAULT_DATA), ...sanitize(parsed) };
    } catch (error) {
      quarantineCorrupt(this.storePath, error, { logger: this.logger });
      this.logger?.warn('Failed to read filter store, keeping defaults.', error);
    }
  }

  get() {
    return {
      blockedKeywords: [...this.data.blockedKeywords],
      maxDurationSeconds: this.data.maxDurationSeconds,
      checkLyrics: this.data.checkLyrics
    };
  }

  state() {
    return this.get();
  }

  update(patch) {
    const next = sanitize({ ...this.data, ...patch });
    this.data.blockedKeywords = next.blockedKeywords;
    this.data.maxDurationSeconds = next.maxDurationSeconds;
    this.data.checkLyrics = next.checkLyrics;
    this.save();
    return this.get();
  }

  save() {
    this.ensureDirectory();
    writeJsonAtomic(this.storePath, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  ensureDirectory() {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
  }
}

export function sanitize(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};

  const blockedKeywords = Array.isArray(source.blockedKeywords)
    ? dedupe(
        source.blockedKeywords
          .map((keyword) => (typeof keyword === 'string' ? keyword.trim().slice(0, MAX_KEYWORD_LENGTH) : ''))
          .filter(Boolean)
      ).slice(0, MAX_KEYWORDS)
    : [];

  let maxDurationSeconds = Math.floor(Number(source.maxDurationSeconds ?? 0));
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds < 0) {
    maxDurationSeconds = 0;
  }
  maxDurationSeconds = Math.min(maxDurationSeconds, MAX_DURATION_CAP);

  return { blockedKeywords, maxDurationSeconds, checkLyrics: source.checkLyrics === true };
}

function dedupe(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = value.toLocaleLowerCase('ru-RU');
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}
