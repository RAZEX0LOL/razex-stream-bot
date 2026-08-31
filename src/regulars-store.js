import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic, quarantineCorrupt } from './json-store.js';

// Per-channel "regulars" — the streamer's list of trusted viewers (by login). Regulars
// rank above everyone in the role order (so commands can be gated to "regulars+") and
// are exempt from auto-moderation, matching Nightbot's Regulars feature. Stored as a
// small JSON list; lookups are case-insensitive by login.

const DEFAULT_DATA = { version: 1, logins: [] };
const MAX_REGULARS = 1000;
const MAX_LOGIN_LENGTH = 40;

export class RegularsStore {
  constructor({ storePath, logger }) {
    this.storePath = path.resolve(process.cwd(), storePath);
    this.logger = logger;
    this.set = new Set();
  }

  load() {
    if (!fs.existsSync(this.storePath)) {
      this.ensureDirectory();
      this.save();
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      const logins = Array.isArray(parsed.logins) ? parsed.logins : [];
      this.set = new Set(logins.map(normalizeLogin).filter(Boolean).slice(0, MAX_REGULARS));
    } catch (error) {
      quarantineCorrupt(this.storePath, error, { logger: this.logger });
      this.logger?.warn('Failed to read regulars store, starting empty.', error);
      this.set = new Set();
    }
  }

  has(login) {
    return this.set.has(normalizeLogin(login));
  }

  list() {
    return [...this.set].sort();
  }

  // Add a login. Returns true when newly added (false when already present / invalid).
  add(login) {
    const key = normalizeLogin(login);
    if (!key || this.set.has(key) || this.set.size >= MAX_REGULARS) {
      return false;
    }
    this.set.add(key);
    this.save();
    return true;
  }

  remove(login) {
    const key = normalizeLogin(login);
    if (!this.set.delete(key)) {
      return false;
    }
    this.save();
    return true;
  }

  save() {
    this.ensureDirectory();
    writeJsonAtomic(this.storePath, `${JSON.stringify({ version: 1, logins: [...this.set] }, null, 2)}\n`);
  }

  ensureDirectory() {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
  }
}

export function normalizeLogin(login) {
  return String(login ?? '')
    .trim()
    .replace(/^@/, '')
    .slice(0, MAX_LOGIN_LENGTH)
    .toLowerCase();
}
