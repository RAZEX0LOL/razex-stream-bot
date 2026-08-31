// Execution layer for the per-channel command builder ("конструктор команд").
// The store (custom-commands-store.js) holds the records; this module knows how to
// validate the shared vocabulary (types, roles, sources) and how to TURN a stored
// record into a chat reply. Keeping it separate keeps chat-commands.js small and
// lets the store reuse the same constants for sanitising without a circular import.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// Command action types the builder understands. `text` is the legacy default.
export const COMMAND_TYPES = ['text', 'random', 'counter', 'music', 'dynamic'];

// Minimum chat role allowed to run a command, ordered from least to most privileged.
// 'regular' is the streamer's trusted-viewers list (above everyone); 'vip' sits between
// subscriber and moderator (matches Twitch/Nightbot userlevels).
export const ROLE_ORDER = ['everyone', 'regular', 'subscriber', 'vip', 'moderator', 'broadcaster'];
export const ROLE_LEVELS = Object.fromEntries(ROLE_ORDER.map((role, index) => [role, index]));

export const ROLE_LABELS = {
  everyone: 'все',
  regular: 'регуляры+',
  subscriber: 'подписчики',
  vip: 'VIP+',
  moderator: 'модеры+',
  broadcaster: 'стример'
};

// What a `music` command can do. current/queue are read-only; skip mutates the queue
// (the streamer gates it via minRole).
export const MUSIC_ACTIONS = ['current', 'queue', 'skip'];

// What a `dynamic` command can pull from the Twitch API. All three come from a single
// getStream() call, so the dynamics provider can serve them from one cached response.
export const DYNAMIC_SOURCES = ['uptime', 'game', 'title'];

export function isValidRole(role) {
  return ROLE_ORDER.includes(role);
}

// The chat author's effective role from their parsed badges (highest wins).
export function messageRole(chatMessage) {
  if (chatMessage.isBroadcaster) return 'broadcaster';
  if (chatMessage.isModerator) return 'moderator';
  if (chatMessage.isVip) return 'vip';
  if (chatMessage.isSubscriber) return 'subscriber';
  if (chatMessage.isRegular) return 'regular';
  return 'everyone';
}

// True when the author meets the command's minimum role.
export function canRun(minRole, chatMessage) {
  const need = ROLE_LEVELS[minRole] ?? 0;
  const have = ROLE_LEVELS[messageRole(chatMessage)] ?? 0;
  return have >= need;
}

export function pickRandom(responses, random = Math.random) {
  const list = Array.isArray(responses) ? responses.filter((entry) => entry) : [];
  if (list.length === 0) {
    return '';
  }
  return list[Math.floor(random() * list.length)];
}

// Substitute placeholders in a response template. Supported tokens:
//   {user}            author name
//   {target}/{touser} first argument (a mentioned nick) or the author
//   {victim}          mentioned nick, else a random active chatter, else the author
//                     (jeetbot-style "do X to someone": works on @mention or random)
//   {random_user}     always a random active chatter (or the author if chat is empty)
//   {count}           counter value (counter type)
//   {song}            currently playing track title (or "ничего")
//   {queue}           number of tracks waiting
//   {value}           the resolved value for dynamic commands
//   {args}            all arguments joined by spaces
//   {1} {2} …         individual arguments (1-based)
// jeetbot/Nightbot-style $(name) is accepted as an alias for {name} (see
// normalizeDollarSyntax) so streamers migrating from those bots keep their habits.
export function renderResponse(template, ctx = {}, { random = Math.random, now = () => new Date() } = {}) {
  const args = Array.isArray(ctx.args) ? ctx.args : [];
  return normalizeDollarSyntax(String(template ?? ''))
    .replace(/\{(\d+)\}/g, (_, index) => args[Number(index) - 1] ?? '')
    // {random} → 1..100; {random:A-B} → inclusive range (jeetbot/Nightbot $(random)).
    .replace(/\{random(?::(-?\d+)-(-?\d+))?\}/g, (_, lo, hi) => {
      if (lo !== undefined && hi !== undefined) {
        const min = Math.min(Number(lo), Number(hi));
        const max = Math.max(Number(lo), Number(hi));
        return String(min + Math.floor(random() * (max - min + 1)));
      }
      return String(1 + Math.floor(random() * 100));
    })
    .replaceAll('{time}', formatClock(now()))
    // {countdown:2026-12-31} → time left; {countup:2026-01-01} → time elapsed.
    .replace(/\{countdown:([^}]+)\}/g, (_, date) => formatCountdown(date, now(), false))
    .replace(/\{countup:([^}]+)\}/g, (_, date) => formatCountdown(date, now(), true))
    .replaceAll('{args}', args.join(' '))
    .replaceAll('{user}', ctx.user ?? '')
    .replaceAll('{touser}', ctx.target || ctx.user || '')
    .replaceAll('{target}', ctx.target || ctx.user || '')
    // {victim}: chosen @mention → random active chatter → author (the targeting the
    // jeetbot-style fun commands need). {random_user}: always a random chatter.
    .replaceAll('{victim}', ctx.target || ctx.randomUser || ctx.user || '')
    .replaceAll('{random_user}', ctx.randomUser || ctx.user || '')
    .replaceAll('{channel}', ctx.channel ?? '')
    .replaceAll('{count}', ctx.count ?? '')
    .replaceAll('{song}', ctx.song ?? '')
    .replaceAll('{queue}', ctx.queue ?? '')
    .replaceAll('{value}', ctx.value ?? '')
    .trim();
}

// HH:MM in 24h, used by the {time} placeholder.
function formatClock(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Time left until (countdown) or elapsed since (countup) a target date, humanized in
// Russian. Empty string for an unparseable date so a typo doesn't break the message.
function formatCountdown(dateStr, nowDate, up) {
  const target = new Date(String(dateStr).trim());
  if (Number.isNaN(target.getTime())) {
    return '';
  }
  const nowMs = nowDate instanceof Date ? nowDate.getTime() : Date.now();
  const diff = up ? nowMs - target.getTime() : target.getTime() - nowMs;
  if (diff <= 0) {
    return up ? '0 мин' : 'уже наступило';
  }
  return humanizeDuration(diff);
}

function humanizeDuration(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days} дн`);
  if (hours) parts.push(`${hours} ч`);
  if (minutes || parts.length === 0) parts.push(`${minutes} мин`);
  return parts.join(' ');
}

// Rewrite jeetbot/Nightbot-style $(name) placeholders into our {name} form before
// substitution, so $(user) === {user}, $(1) === {1}, $(args) === {args}, etc.
// `query` is mapped to `args` because that's the Nightbot name for "all arguments".
// $(countdown 2026-12-31) / $(countup …) keep their date argument.
function normalizeDollarSyntax(template) {
  return template
    .replace(/\$\((countdown|countup|urlfetch)\s+([^)]+)\)/gi, (_, name, arg) => `{${name.toLowerCase()}:${arg.trim()}}`)
    .replace(/\$\((\w+)\)/g, (_, name) => `{${name === 'query' ? 'args' : name}}`);
}

// Resolve any {urlfetch:URL} tokens left by renderResponse by GETting each URL and
// inserting its (trimmed, single-line, length-capped) body. This is the async second
// pass of command rendering, run after the synchronous placeholder substitution.
// Network failures and unsafe URLs collapse to '' so a command never throws.
export async function resolveAsyncTokens(text, { fetchImpl = fetch, lookupImpl = lookup, timeoutMs = 5000 } = {}) {
  const value = String(text ?? '');
  if (!value.includes('{urlfetch:')) {
    return value;
  }
  const tokens = [...value.matchAll(/\{urlfetch:([^}]+)\}/g)];
  const results = await Promise.all(tokens.map((m) => fetchUrlText(m[1].trim(), { fetchImpl, lookupImpl, timeoutMs })));
  let i = 0;
  return value.replace(/\{urlfetch:[^}]+\}/g, () => results[i++]).trim();
}

async function fetchUrlText(url, { fetchImpl, lookupImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let currentUrl = url;
    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      if (!(await isSafeHttpUrl(currentUrl, lookupImpl))) {
        return '';
      }
      const response = await fetchImpl(currentUrl, { signal: controller.signal, redirect: 'manual' });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers?.get?.('location');
        if (!location || redirectCount === 3) {
          return '';
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!response.ok) {
        return '';
      }
      const body = await readResponseText(response, 4096);
      return body.replace(/\s+/g, ' ').trim().slice(0, 380);
    }
    return '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseText(response, maxBytes) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return '';
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    return (await response.text()).slice(0, maxBytes);
  }

  const chunks = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - size;
    chunks.push(value.subarray(0, remaining));
    size += Math.min(value.byteLength, remaining);
    if (value.byteLength > remaining) {
      await reader.cancel();
      break;
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

// Resolve every hostname and require every answer to be globally routable. Redirects
// are validated again before they are followed, so public URLs cannot bounce into the
// host's loopback, container network, cloud metadata endpoint, or another private range.
async function isSafeHttpUrl(raw, lookupImpl) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }
  if (url.username || url.password) {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local')) return false;
  if (isIP(host)) return isPublicIpAddress(host);

  const answers = await lookupImpl(host, { all: true, verbatim: true });
  const records = Array.isArray(answers) ? answers : [answers];
  return records.length > 0 && records.every((record) => isPublicIpAddress(record.address));
}

function isPublicIpAddress(raw) {
  const address = String(raw ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (family === 6) {
    return !(
      address === '::' ||
      address === '::1' ||
      address.startsWith('::ffff:') ||
      /^f[cd]/.test(address) ||
      /^fe[89ab]/.test(address) ||
      address.startsWith('ff') ||
      address.startsWith('2001:db8:') ||
      address.startsWith('64:ff9b:')
    );
  }
  return false;
}

// Build the placeholder context shared by all command types. song/queue come from the
// (sync) music queue state so they work inside any text/random template too.
function baseContext(chatMessage, command, { musicQueue, activityStore, random = Math.random } = {}) {
  const args = Array.isArray(command.args) ? command.args : [];
  const target = String(args[0] ?? '').replace(/^@/, '').slice(0, 40);
  const ctx = { user: chatMessage.name, target, args };
  // A random active chatter (excluding the caller) for {victim}/{random_user}.
  if (activityStore?.getRandomDailyUser) {
    const picked = activityStore.getRandomDailyUser({ excludeUserId: chatMessage.userId, random });
    ctx.randomUser = picked?.name ?? '';
  }
  if (musicQueue) {
    const state = musicQueue.state();
    ctx.song = state.nowPlaying ? state.nowPlaying.title : 'ничего';
    ctx.queue = String(state.length);
  }
  return ctx;
}

function musicReply(action, musicQueue) {
  if (!musicQueue) {
    return 'Музыка сейчас недоступна.';
  }
  const state = musicQueue.state();
  if (action === 'queue') {
    return state.length > 0 ? `В очереди ${state.length} ${pluralizeTracks(state.length)}.` : 'Очередь музыки пуста.';
  }
  if (action === 'skip') {
    const { finished, nowPlaying } = musicQueue.skip();
    return nowPlaying
      ? `Пропустил. Сейчас играет: ${nowPlaying.title}`
      : `Пропустил${finished ? ` «${finished.title}»` : ''}. Очередь пуста.`;
  }
  // default: current
  return state.nowPlaying ? `Сейчас играет: ${state.nowPlaying.title}` : 'Сейчас ничего не играет.';
}

// Turn a stored command into the reply string to send (or '' to stay silent).
// `deps` provides the moving parts: { musicQueue, store, dynamics, random }.
export async function executeCustomCommand(custom, chatMessage, command, deps = {}) {
  const ctx = baseContext(chatMessage, command, {
    musicQueue: deps.musicQueue,
    activityStore: deps.activityStore,
    random: deps.random
  });
  const config = custom.config ?? {};
  const opts = { random: deps.random ?? Math.random };

  let reply;
  switch (custom.type) {
    case 'random':
      reply = renderResponse(pickRandom(config.responses, deps.random), ctx, opts);
      break;

    case 'counter': {
      const value = deps.store?.increment ? deps.store.increment(custom.name) : config.value ?? 0;
      reply = renderResponse(config.template, { ...ctx, count: value }, opts);
      break;
    }

    case 'music':
      return musicReply(config.action, deps.musicQueue);

    case 'dynamic': {
      let value = '';
      try {
        value = (await deps.dynamics?.get?.(config.source)) ?? '';
      } catch {
        value = '';
      }
      reply = renderResponse(config.template, { ...ctx, value }, opts);
      break;
    }

    case 'text':
    default:
      reply = renderResponse(config.response, ctx, opts);
  }

  // Second pass: resolve any {urlfetch:URL} tokens by calling the remote URL.
  return resolveAsyncTokens(reply, {
    fetchImpl: deps.fetch ?? fetch,
    lookupImpl: deps.lookup ?? lookup
  });
}

function pluralizeTracks(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'трек';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'трека';
  return 'треков';
}
