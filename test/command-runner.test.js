import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canRun,
  executeCustomCommand,
  messageRole,
  pickRandom,
  renderResponse
} from '../src/command-runner.js';

function msg(overrides = {}) {
  return { name: 'Bob', userId: '1', isBroadcaster: false, isModerator: false, isSubscriber: false, ...overrides };
}

test('messageRole picks the highest role from badges', () => {
  assert.equal(messageRole(msg()), 'everyone');
  assert.equal(messageRole(msg({ isSubscriber: true })), 'subscriber');
  assert.equal(messageRole(msg({ isModerator: true })), 'moderator');
  assert.equal(messageRole(msg({ isBroadcaster: true, isModerator: true })), 'broadcaster');
});

test('canRun enforces the minimum role', () => {
  assert.equal(canRun('everyone', msg()), true);
  assert.equal(canRun('subscriber', msg()), false);
  assert.equal(canRun('subscriber', msg({ isSubscriber: true })), true);
  assert.equal(canRun('moderator', msg({ isSubscriber: true })), false);
  assert.equal(canRun('moderator', msg({ isModerator: true })), true);
  assert.equal(canRun('broadcaster', msg({ isModerator: true })), false);
  assert.equal(canRun('broadcaster', msg({ isBroadcaster: true })), true);
});

test('renderResponse substitutes the supported placeholders', () => {
  const ctx = { user: 'Bob', target: 'Ann', count: 7, song: 'A - B', queue: '2', value: '5 мин', args: ['hi', 'there'] };
  assert.equal(renderResponse('{user} -> {target}', ctx), 'Bob -> Ann');
  assert.equal(renderResponse('{count} смертей', ctx), '7 смертей');
  assert.equal(renderResponse('сейчас {song}, в очереди {queue}', ctx), 'сейчас A - B, в очереди 2');
  assert.equal(renderResponse('аптайм {value}', ctx), 'аптайм 5 мин');
  assert.equal(renderResponse('{1} и {2} ({args})', ctx), 'hi и there (hi there)');
  // target falls back to user when empty
  assert.equal(renderResponse('обнял {target}', { user: 'Bob', target: '' }), 'обнял Bob');
});

test('renderResponse accepts jeetbot/Nightbot $(name) placeholders as aliases', () => {
  const ctx = { user: 'Bob', target: 'Ann', count: 7, args: ['hi', 'there'] };
  assert.equal(renderResponse('$(user) обнял $(target)', ctx), 'Bob обнял Ann');
  assert.equal(renderResponse('счёт: $(count)', ctx), 'счёт: 7');
  assert.equal(renderResponse('$(1)+$(2)=$(query)', ctx), 'hi+there=hi there');
  // mixing both syntaxes works
  assert.equal(renderResponse('{user} / $(user)', ctx), 'Bob / Bob');
});

test('renderResponse supports {random}, {random:A-B} and {time}', () => {
  const opts = { random: () => 0.5, now: () => new Date(2026, 0, 1, 9, 5) };
  assert.equal(renderResponse('выпало {random}', {}, opts), 'выпало 51');
  assert.equal(renderResponse('кубик {random:1-6}', {}, opts), 'кубик 4');
  assert.equal(renderResponse('$(random)', {}, opts), '51');
  assert.equal(renderResponse('сейчас {time}', {}, opts), 'сейчас 09:05');
  assert.equal(renderResponse('на канале {channel}', { channel: 'razex' }), 'на канале razex');
});

test('renderResponse {victim} prefers mention, then random chatter, then author', () => {
  // explicit @mention wins
  assert.equal(renderResponse('{user} обнял {victim}', { user: 'Bob', target: 'Ann', randomUser: 'Eve' }), 'Bob обнял Ann');
  // no mention → random active chatter
  assert.equal(renderResponse('{user} обнял {victim}', { user: 'Bob', target: '', randomUser: 'Eve' }), 'Bob обнял Eve');
  // no mention and empty chat → falls back to the author
  assert.equal(renderResponse('{user} обнял {victim}', { user: 'Bob', target: '', randomUser: '' }), 'Bob обнял Bob');
});

test('renderResponse {random_user} is always the random chatter (author if empty)', () => {
  assert.equal(renderResponse('случайный: {random_user}', { user: 'Bob', target: 'Ann', randomUser: 'Eve' }), 'случайный: Eve');
  assert.equal(renderResponse('случайный: {random_user}', { user: 'Bob', randomUser: '' }), 'случайный: Bob');
  // not swallowed by the {random:A-B} number token
  assert.equal(renderResponse('$(random_user)', { user: 'Bob', randomUser: 'Eve' }), 'Eve');
});

test('pickRandom returns a member or empty for no options', () => {
  assert.equal(pickRandom(['only']), 'only');
  assert.equal(pickRandom([], () => 0), '');
  assert.equal(pickRandom(['a', 'b', 'c'], () => 0.99), 'c');
});

test('executeCustomCommand renders text and random types', async () => {
  const text = { type: 'text', config: { response: 'привет {user}' } };
  assert.equal(await executeCustomCommand(text, msg(), { args: [] }), 'привет Bob');

  const random = { type: 'random', config: { responses: ['x', 'y'] } };
  assert.equal(await executeCustomCommand(random, msg(), { args: [] }, { random: () => 0 }), 'x');
});

test('executeCustomCommand resolves {victim} from a random active chatter', async () => {
  const calls = [];
  const activityStore = {
    getRandomDailyUser: ({ excludeUserId }) => {
      calls.push(excludeUserId);
      return { name: 'Eve' };
    }
  };
  const cmd = { type: 'text', config: { response: '{user} спёр трусы у {victim}!' } };
  // no @mention → picks the random chatter, excluding the caller
  assert.equal(await executeCustomCommand(cmd, msg(), { args: [] }, { activityStore }), 'Bob спёр трусы у Eve!');
  assert.deepEqual(calls, ['1']);
  // explicit @mention overrides the random pick
  assert.equal(await executeCustomCommand(cmd, msg(), { args: ['@Ann'] }, { activityStore }), 'Bob спёр трусы у Ann!');
});

test('executeCustomCommand increments a counter through the store', async () => {
  const custom = { name: 'деаты', type: 'counter', config: { template: '{count} смертей', value: 4 } };
  const store = { increment: () => 5 };
  assert.equal(await executeCustomCommand(custom, msg(), { args: [] }, { store }), '5 смертей');
});

test('executeCustomCommand reads music queue state', async () => {
  const musicQueue = {
    state: () => ({ nowPlaying: { title: 'Now' }, length: 3 }),
    skip: () => ({ finished: { title: 'Now' }, nowPlaying: { title: 'Next' } })
  };
  assert.equal(await executeCustomCommand({ type: 'music', config: { action: 'current' } }, msg(), { args: [] }, { musicQueue }), 'Сейчас играет: Now');
  assert.equal(await executeCustomCommand({ type: 'music', config: { action: 'queue' } }, msg(), { args: [] }, { musicQueue }), 'В очереди 3 трека.');
  assert.equal(await executeCustomCommand({ type: 'music', config: { action: 'skip' } }, msg(), { args: [] }, { musicQueue }), 'Пропустил. Сейчас играет: Next');
});

test('executeCustomCommand resolves dynamic values, tolerating failures', async () => {
  const dynamics = { get: async (source) => (source === 'uptime' ? '2 ч 5 мин' : '') };
  assert.equal(await executeCustomCommand({ type: 'dynamic', config: { source: 'uptime', template: 'в эфире {value}' } }, msg(), { args: [] }, { dynamics }), 'в эфире 2 ч 5 мин');

  const broken = { get: async () => { throw new Error('api down'); } };
  assert.equal(await executeCustomCommand({ type: 'dynamic', config: { source: 'uptime', template: 'в эфире {value}' } }, msg(), { args: [] }, { dynamics: broken }), 'в эфире');
});

test('renderResponse supports {countdown} and {countup} (and $(countdown ...))', () => {
  const now = () => new Date('2026-06-24T12:00:00');
  assert.equal(renderResponse('до НГ {countdown:2026-06-26T12:00:00}', {}, { now }), 'до НГ 2 дн');
  assert.equal(renderResponse('стримлю уже {countup:2026-06-24T09:30:00}', {}, { now }), 'стримлю уже 2 ч 30 мин');
  assert.equal(renderResponse('$(countdown 2026-06-24T13:00:00)', {}, { now }), '1 ч');
  assert.equal(renderResponse('{countdown:2020-01-01}', {}, { now }), 'уже наступило');
  assert.equal(renderResponse('{countdown:непонятно}', {}, { now }), '');
});

test('messageRole and canRun understand VIP (between subscriber and moderator)', () => {
  assert.equal(messageRole(msg({ isVip: true })), 'vip');
  assert.equal(messageRole(msg({ isVip: true, isModerator: true })), 'moderator');
  // VIP can run vip-gated and subscriber-gated commands, but not moderator ones.
  assert.equal(canRun('vip', msg({ isVip: true })), true);
  assert.equal(canRun('subscriber', msg({ isVip: true })), true);
  assert.equal(canRun('moderator', msg({ isVip: true })), false);
  // A plain subscriber cannot run vip-gated commands.
  assert.equal(canRun('vip', msg({ isSubscriber: true })), false);
});

test('urlfetch: executeCustomCommand fetches a remote URL into the reply', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return { ok: true, text: async () => '  Случайный\nфакт  ' };
  };
  const cmd = { type: 'text', config: { response: 'Факт: $(urlfetch https://api.example.com/fact)' } };
  const out = await executeCustomCommand(cmd, msg(), { args: [] }, {
    fetch: fakeFetch,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }]
  });
  assert.equal(out, 'Факт: Случайный факт');
  assert.equal(calls[0], 'https://api.example.com/fact');
});

test('urlfetch: blocks internal hosts and tolerates fetch errors', async () => {
  // SSRF guard: localhost is never fetched → token resolves to ''.
  const cmd1 = { type: 'text', config: { response: 'x{urlfetch:http://127.0.0.1/secret}y' } };
  assert.equal(await executeCustomCommand(cmd1, msg(), { args: [] }, { fetch: async () => { throw new Error('should not be called'); } }), 'xy');

  // A failing fetch also collapses to ''.
  const cmd2 = { type: 'text', config: { response: 'a{urlfetch:https://example.com/down}b' } };
  assert.equal(await executeCustomCommand(cmd2, msg(), { args: [] }, {
    fetch: async () => ({ ok: false }),
    lookup: async () => [{ address: '93.184.216.34', family: 4 }]
  }), 'ab');
});

test('urlfetch: blocks private DNS answers and redirects to internal hosts', async () => {
  let fetchCalls = 0;
  const privateDns = { type: 'text', config: { response: 'x{urlfetch:https://private.example/data}y' } };
  const privateOut = await executeCustomCommand(privateDns, msg(), { args: [] }, {
    fetch: async () => {
      fetchCalls += 1;
      return { ok: true, text: async () => 'secret' };
    },
    lookup: async () => [{ address: '10.0.0.4', family: 4 }]
  });
  assert.equal(privateOut, 'xy');
  assert.equal(fetchCalls, 0);

  const redirect = { type: 'text', config: { response: 'x{urlfetch:https://public.example/start}y' } };
  const redirectOut = await executeCustomCommand(redirect, msg(), { args: [] }, {
    fetch: async () => {
      fetchCalls += 1;
      return {
        ok: false,
        status: 302,
        headers: { get: () => 'http://169.254.169.254/latest/meta-data' }
      };
    },
    lookup: async () => [{ address: '93.184.216.34', family: 4 }]
  });
  assert.equal(redirectOut, 'xy');
  assert.equal(fetchCalls, 1);
});
