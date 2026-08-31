import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic, quarantineCorrupt } from './json-store.js';

// Per-channel loyalty currency ("очки"/"valuta канала"): a balance per viewer that the
// bot grants for watching/chatting and that viewers spend on commands, bets and
// raffles. This is the bot's OWN currency, separate from Twitch channel points, so a
// streamer can run a points economy without managing Twitch rewards. Persisted as a
// small JSON file like the other stores; the currency NAME and earn rates live in
// config, not here — this store only moves integers.

const DEFAULT_DATA = { version: 1, users: {} };

const MAX_NAME_LENGTH = 60;
// Hard cap so a runaway grant or an integer attack can't store absurd balances.
const MAX_BALANCE = 1_000_000_000;

export class LoyaltyStore {
  constructor({ storePath, logger, now = () => new Date() }) {
    this.storePath = path.resolve(process.cwd(), storePath);
    this.logger = logger;
    this.now = now;
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
      const users = parsed.users && typeof parsed.users === 'object' ? parsed.users : {};
      this.data = { version: 1, users: {} };
      for (const [id, entry] of Object.entries(users)) {
        const user = sanitizeUser(id, entry);
        if (user) {
          this.data.users[id] = user;
        }
      }
    } catch (error) {
      quarantineCorrupt(this.storePath, error, { logger: this.logger });
      this.logger?.warn('Failed to read loyalty store, starting empty.', error);
      this.data = structuredClone(DEFAULT_DATA);
    }
  }

  // Ensure a user row exists and refresh its display name/login (called on every chat
  // message so the leaderboard shows current names). Returns the row.
  touch(userId, { login = '', name = '' } = {}) {
    const id = String(userId ?? '').trim();
    if (!id) {
      return null;
    }
    let user = this.data.users[id];
    if (!user) {
      user = { login: '', name: '', points: 0, earnedTotal: 0, lastSeen: null };
      this.data.users[id] = user;
    }
    if (login) {
      user.login = String(login).slice(0, MAX_NAME_LENGTH);
    }
    if (name) {
      user.name = String(name).slice(0, MAX_NAME_LENGTH);
    }
    user.lastSeen = this.now().toISOString();
    return user;
  }

  balance(userId) {
    return this.data.users[String(userId)]?.points ?? 0;
  }

  // Grant points to a viewer. Negative amounts are ignored (use spend/set). Persists
  // and returns the new balance.
  earn(userId, amount, meta = {}) {
    const add = Math.floor(Number(amount) || 0);
    if (add <= 0) {
      return this.balance(userId);
    }
    const user = this.touch(userId, meta);
    if (!user) {
      return 0;
    }
    user.points = clampBalance(user.points + add);
    user.earnedTotal = clampBalance((user.earnedTotal ?? 0) + add);
    this.save();
    return user.points;
  }

  // Try to deduct `amount`. Returns { ok, balance }: ok=false (and no change) when the
  // viewer can't afford it. The single chokepoint for spends (bets, paid commands).
  spend(userId, amount, meta = {}) {
    const cost = Math.floor(Number(amount) || 0);
    const user = this.touch(userId, meta);
    if (!user) {
      return { ok: false, balance: 0 };
    }
    if (cost <= 0) {
      this.save();
      return { ok: true, balance: user.points };
    }
    if (user.points < cost) {
      return { ok: false, balance: user.points };
    }
    user.points = user.points - cost;
    this.save();
    return { ok: true, balance: user.points };
  }

  // Admin/streamer override: set an exact balance (panel "выдать/отнять"). `userId`
  // may not have chatted yet, so meta carries the name to show.
  set(userId, amount, meta = {}) {
    const user = this.touch(userId, meta);
    if (!user) {
      return 0;
    }
    user.points = clampBalance(Math.floor(Number(amount) || 0));
    this.save();
    return user.points;
  }

  // Grant `amount` to every user seen since `sinceMs` ago — the periodic "watch
  // reward" tick. Returns how many users were credited. Writes once.
  earnActive(amount, sinceMs) {
    const add = Math.floor(Number(amount) || 0);
    if (add <= 0) {
      return 0;
    }
    const cutoff = this.now().getTime() - sinceMs;
    let credited = 0;
    for (const user of Object.values(this.data.users)) {
      if (user.lastSeen && new Date(user.lastSeen).getTime() >= cutoff) {
        user.points = clampBalance(user.points + add);
        user.earnedTotal = clampBalance((user.earnedTotal ?? 0) + add);
        credited += 1;
      }
    }
    if (credited > 0) {
      this.save();
    }
    return credited;
  }

  // Resolve a viewer's id by login (case-insensitive) — the panel grants by login.
  // Returns null when nobody by that login has been seen yet.
  findIdByLogin(login) {
    const key = String(login ?? '').trim().toLowerCase();
    if (!key) {
      return null;
    }
    for (const [id, user] of Object.entries(this.data.users)) {
      if ((user.login || '').toLowerCase() === key) {
        return id;
      }
    }
    return null;
  }

  top(limit = 10) {
    return Object.entries(this.data.users)
      .map(([id, user]) => ({ id, name: user.name || user.login || id, points: user.points }))
      .sort((a, b) => b.points - a.points)
      .slice(0, Math.max(0, limit));
  }

  save() {
    this.ensureDirectory();
    writeJsonAtomic(this.storePath, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  ensureDirectory() {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
  }
}

function sanitizeUser(id, raw) {
  if (!id || !raw || typeof raw !== 'object') {
    return null;
  }
  return {
    login: String(raw.login ?? '').slice(0, MAX_NAME_LENGTH),
    name: String(raw.name ?? '').slice(0, MAX_NAME_LENGTH),
    points: clampBalance(Math.floor(Number(raw.points) || 0)),
    earnedTotal: clampBalance(Math.floor(Number(raw.earnedTotal) || 0)),
    lastSeen: raw.lastSeen ? String(raw.lastSeen) : null
  };
}

function clampBalance(value) {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.min(value, MAX_BALANCE);
}
