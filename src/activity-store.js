import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './json-store.js';

const DEFAULT_DATA = {
  version: 1,
  users: {},
  daily: {},
  loginToUserId: {}
};

const RANKS = [
  { minXp: 0, title: 'Новичок' },
  { minXp: 25, title: 'Свой в чате' },
  { minXp: 100, title: 'Завсегдатай' },
  { minXp: 250, title: 'Активист чата' },
  { minXp: 500, title: 'Легенда чата' },
  { minXp: 1000, title: 'Хранитель онлайна' }
];

export class ActivityStore {
  constructor({ storePath, xpPerMessage = 1, logger, now = () => new Date() }) {
    this.storePath = path.resolve(process.cwd(), storePath);
    this.xpPerMessage = xpPerMessage;
    this.logger = logger;
    this.now = now;
    this.data = structuredClone(DEFAULT_DATA);
    this.saveTimer = null;
    this.dirty = false;
  }

  load() {
    if (!fs.existsSync(this.storePath)) {
      this.ensureDirectory();
      this.saveNow();
      return;
    }

    const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
    this.data = {
      ...structuredClone(DEFAULT_DATA),
      ...parsed,
      users: parsed.users ?? {},
      daily: parsed.daily ?? {},
      loginToUserId: parsed.loginToUserId ?? {}
    };
    this.pruneOldDays();
  }

  recordMessage(chatMessage) {
    const user = this.upsertUser(chatMessage);
    const today = this.getTodayBucket();
    const dailyUser = this.upsertDailyUser(today, user.id);

    user.messages += 1;
    user.xp += this.xpPerMessage;
    user.lastSeenAt = this.now().toISOString();

    dailyUser.messages += 1;
    dailyUser.xp += this.xpPerMessage;
    dailyUser.name = user.name;
    dailyUser.login = user.login;
    dailyUser.lastSeenAt = user.lastSeenAt;

    this.markDirty();
    return user;
  }

  recordDuel({ challenger, target, winnerLogin }) {
    const challengerUser = this.upsertUser(challenger);
    const targetUser =
      target?.userId || target?.id
        ? this.upsertUser(target)
        : this.findUserByLogin(target?.login) ?? this.upsertManualUser(target);
    const normalizedWinner = normalizeLogin(winnerLogin);

    applyDuelResult(challengerUser, normalizedWinner === normalizeLogin(challengerUser.login));
    if (targetUser) {
      applyDuelResult(targetUser, normalizedWinner === normalizeLogin(targetUser.login));
    }

    this.markDirty();

    return {
      challenger: challengerUser,
      target: targetUser ?? null
    };
  }

  getUserByMessage(chatMessage) {
    return this.upsertUser(chatMessage);
  }

  findUserByLogin(login) {
    const normalizedLogin = normalizeLogin(login);
    const userId = this.data.loginToUserId[normalizedLogin];
    return userId ? this.data.users[userId] ?? null : null;
  }

  getDailyTop(limit) {
    const today = this.getTodayBucket();
    return Object.values(today.users)
      .sort((left, right) => {
        if (right.xp !== left.xp) {
          return right.xp - left.xp;
        }

        return right.messages - left.messages;
      })
      .slice(0, limit);
  }

  // Top chatters summed over the last `days` days (1 = today, 10, 30, 90, 180, 365…),
  // built from the per-day buckets. Returns [{ id, name, login, messages, xp }] sorted
  // by xp then messages. The data foundation for period stats + active-viewer giveaways.
  topByDays(days, limit = 10) {
    const cutoff = this.dateKeyDaysAgo(Math.max(0, days - 1));
    const totals = new Map();
    for (const [dateKey, day] of Object.entries(this.data.daily)) {
      if (dateKey < cutoff) {
        continue;
      }
      for (const [userId, dailyUser] of Object.entries(day.users ?? {})) {
        let total = totals.get(userId);
        if (!total) {
          total = { id: userId, name: dailyUser.name ?? userId, login: dailyUser.login ?? userId, messages: 0, xp: 0 };
          totals.set(userId, total);
        }
        total.messages += dailyUser.messages || 0;
        total.xp += dailyUser.xp || 0;
        if (dailyUser.name) total.name = dailyUser.name;
        if (dailyUser.login) total.login = dailyUser.login;
      }
    }
    return [...totals.values()]
      .sort((left, right) => (right.xp !== left.xp ? right.xp - left.xp : right.messages - left.messages))
      .slice(0, Math.max(0, limit));
  }

  // Period stats for the panel: a bar per day (zero-filled for silent days), totals and
  // the top chatters over the same window. `days` counts back from today inclusive.
  statsByDays(days, topLimit = 10) {
    const span = Math.max(1, Math.min(365, Math.floor(days) || 1));
    const perDay = [];
    const uniques = new Set();
    let messages = 0;
    let xp = 0;
    for (let n = span - 1; n >= 0; n -= 1) {
      const dateKey = this.dateKeyDaysAgo(n);
      const users = Object.values(this.data.daily[dateKey]?.users ?? {});
      let dayMessages = 0;
      let dayXp = 0;
      for (const user of users) {
        dayMessages += user.messages || 0;
        dayXp += user.xp || 0;
        uniques.add(user.id);
      }
      messages += dayMessages;
      xp += dayXp;
      perDay.push({ date: dateKey, messages: dayMessages, activeUsers: users.length });
    }
    return {
      days: span,
      perDay,
      totals: { messages, xp, activeUsers: uniques.size },
      top: this.topByDays(span, topLimit)
    };
  }

  // Lifetime duel leaderboard (duels are not bucketed per day).
  topDuelists(limit = 10) {
    return Object.values(this.data.users)
      .filter((user) => (user.duelsWon || 0) + (user.duelsLost || 0) > 0)
      .sort((left, right) => (right.duelsWon || 0) - (left.duelsWon || 0))
      .slice(0, Math.max(0, limit))
      .map((user) => ({
        id: user.id,
        name: user.name,
        login: user.login,
        duelsWon: user.duelsWon || 0,
        duelsLost: user.duelsLost || 0
      }));
  }

  // Pick a random winner among the top-`poolSize` most active chatters in the window —
  // a giveaway "for the most active". Returns the winning user or null when nobody
  // chatted in the window.
  drawActiveWinner({ days = 30, poolSize = 20, random = Math.random } = {}) {
    const pool = this.topByDays(days, poolSize).filter((user) => user.messages > 0);
    if (pool.length === 0) {
      return null;
    }
    return pool[Math.floor(random() * pool.length)];
  }

  // 'YYYY-MM-DD' for `n` days before now (n=0 → today). Day buckets are keyed this way,
  // so lexicographic string compare equals date order.
  dateKeyDaysAgo(n) {
    return new Date(this.now().getTime() - n * 86_400_000).toISOString().slice(0, 10);
  }

  // Drop day buckets older than `maxDays` (keeps ~a year for the longest window). Called
  // on load and whenever a new day starts, so history can't grow without bound.
  pruneOldDays(maxDays = 370) {
    const cutoff = this.dateKeyDaysAgo(maxDays);
    let removed = 0;
    for (const dateKey of Object.keys(this.data.daily)) {
      if (dateKey < cutoff) {
        delete this.data.daily[dateKey];
        removed += 1;
      }
    }
    return removed;
  }

  getRandomDailyUser({ excludeUserId, random = Math.random } = {}) {
    const today = this.getTodayBucket();
    const candidates = Object.values(today.users).filter((user) => user.id !== excludeUserId);
    if (candidates.length === 0) {
      return null;
    }

    const dailyUser = candidates[Math.floor(random() * candidates.length)];
    return this.data.users[dailyUser.id] ?? dailyUser;
  }

  getTodayStats(userId) {
    return this.getTodayBucket().users[userId] ?? {
      messages: 0,
      xp: 0
    };
  }

  getRankTitle(xp) {
    return RANKS.reduce((rank, candidate) => (xp >= candidate.minXp ? candidate.title : rank), RANKS[0].title);
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    if (this.dirty) {
      this.saveNow();
    }
  }

  upsertUser(chatMessage) {
    if (!chatMessage?.userId) {
      throw new Error('Cannot record activity without user id.');
    }

    const login = normalizeLogin(chatMessage.login || chatMessage.name || chatMessage.userId);
    const name = normalizeDisplayName(chatMessage.name || chatMessage.login || chatMessage.userId);
    this.mergeManualUserIfNeeded(chatMessage.userId, login);

    let user = this.data.users[chatMessage.userId];
    if (!user) {
      user = {
        id: chatMessage.userId,
        login,
        name,
        messages: 0,
        xp: 0,
        duelsWon: 0,
        duelsLost: 0,
        firstSeenAt: this.now().toISOString(),
        lastSeenAt: this.now().toISOString()
      };
      this.data.users[chatMessage.userId] = user;
    }

    user.login = login;
    user.name = name;
    this.data.loginToUserId[login] = chatMessage.userId;
    return user;
  }

  upsertManualUser(userInfo) {
    const login = normalizeLogin(userInfo?.login || userInfo?.name);
    if (!login) {
      return null;
    }

    const existing = this.findUserByLogin(login);
    if (existing) {
      return existing;
    }

    const id = `manual:${login}`;
    const name = normalizeDisplayName(userInfo?.name || login);
    const now = this.now().toISOString();
    const user = {
      id,
      login,
      name,
      messages: 0,
      xp: 0,
      duelsWon: 0,
      duelsLost: 0,
      firstSeenAt: now,
      lastSeenAt: now
    };

    this.data.users[id] = user;
    this.data.loginToUserId[login] = id;
    return user;
  }

  mergeManualUserIfNeeded(realUserId, login) {
    const existingUserId = this.data.loginToUserId[login];
    if (!existingUserId || existingUserId === realUserId || !existingUserId.startsWith('manual:')) {
      return;
    }

    const manualUser = this.data.users[existingUserId];
    if (!manualUser) {
      return;
    }

    const realUser = this.data.users[realUserId];
    if (realUser) {
      realUser.messages += manualUser.messages;
      realUser.xp += manualUser.xp;
      realUser.duelsWon += manualUser.duelsWon;
      realUser.duelsLost += manualUser.duelsLost;
      realUser.firstSeenAt = [realUser.firstSeenAt, manualUser.firstSeenAt].filter(Boolean).sort()[0];
    } else {
      this.data.users[realUserId] = {
        ...manualUser,
        id: realUserId
      };
    }

    for (const day of Object.values(this.data.daily)) {
      if (day.users?.[existingUserId]) {
        day.users[realUserId] = {
          ...day.users[existingUserId],
          id: realUserId
        };
        delete day.users[existingUserId];
      }
    }

    delete this.data.users[existingUserId];
    this.data.loginToUserId[login] = realUserId;
  }

  upsertDailyUser(dayBucket, userId) {
    if (!dayBucket.users[userId]) {
      const user = this.data.users[userId];
      dayBucket.users[userId] = {
        id: userId,
        login: user?.login ?? userId,
        name: user?.name ?? userId,
        messages: 0,
        xp: 0,
        lastSeenAt: this.now().toISOString()
      };
    }

    return dayBucket.users[userId];
  }

  getTodayBucket() {
    const dateKey = this.now().toISOString().slice(0, 10);
    if (!this.data.daily[dateKey]) {
      this.data.daily[dateKey] = {
        users: {}
      };
      // A new day started — trim buckets older than the longest stats window.
      this.pruneOldDays();
    }

    return this.data.daily[dateKey];
  }

  markDirty() {
    this.dirty = true;
    if (this.saveTimer) {
      return;
    }

    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) {
        this.saveNow();
      }
    }, 1000);
  }

  saveNow() {
    this.ensureDirectory();
    writeJsonAtomic(this.storePath, `${JSON.stringify(this.data, null, 2)}\n`);
    this.dirty = false;
  }

  ensureDirectory() {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
  }
}

function applyDuelResult(user, won) {
  if (won) {
    user.duelsWon += 1;
  } else {
    user.duelsLost += 1;
  }
}

export function normalizeLogin(login) {
  return String(login ?? '').replace(/^@/, '').trim().toLocaleLowerCase('ru-RU');
}

function normalizeDisplayName(name) {
  return String(name ?? '').replace(/[\r\n]/g, ' ').trim().slice(0, 40);
}
