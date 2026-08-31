import assert from 'node:assert/strict';
import test from 'node:test';
import { EventSubClient } from '../src/eventsub.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

test('ensureToken is awaited before (re)subscribing on a fresh connection', async () => {
  const order = [];
  const client = new EventSubClient({
    api: {
      createEventSubSubscription: async () => {
        order.push('subscribe');
        return {};
      }
    },
    broadcasterId: 'b1',
    enableRedemptions: true,
    enableChatMessages: false,
    ensureToken: async () => {
      order.push('ensureToken');
    },
    logger: silent
  });

  await client.handleWelcome(
    { id: 'sess-1', keepalive_timeout_seconds: 30 },
    { subscribeOnWelcome: true, closeAfterWelcome: null }
  );
  client.clearWatchdog();

  assert.deepEqual(order, ['ensureToken', 'subscribe']);
});

test('ensureToken is not called when carrying over existing subscriptions', async () => {
  let ensureCalls = 0;
  const client = new EventSubClient({
    api: { createEventSubSubscription: async () => ({}) },
    broadcasterId: 'b1',
    ensureToken: async () => {
      ensureCalls += 1;
    },
    logger: silent
  });

  await client.handleWelcome(
    { id: 'sess-2', keepalive_timeout_seconds: 30 },
    { subscribeOnWelcome: false, closeAfterWelcome: null }
  );
  client.clearWatchdog();

  assert.equal(ensureCalls, 0);
});

test('reconnect uses exponential backoff capped at 60s, reset on a successful welcome', async () => {
  const client = new EventSubClient({
    api: { createEventSubSubscription: async () => ({}) },
    broadcasterId: 'b1',
    ensureToken: async () => {},
    logger: silent
  });

  const delays = [];
  const realSetTimeout = global.setTimeout;
  const realRandom = Math.random;
  global.setTimeout = (_fn, ms) => { delays.push(ms); return 0; };
  Math.random = () => 0; // strip jitter for a deterministic assertion
  try {
    for (let i = 0; i < 6; i += 1) client.scheduleReconnect();
    assert.deepEqual(delays, [5000, 10000, 20000, 40000, 60000, 60000]);

    // A successful connection resets the backoff to the base delay.
    await client.handleWelcome(
      { id: 's', keepalive_timeout_seconds: 30 },
      { subscribeOnWelcome: false, closeAfterWelcome: null }
    );
    client.clearWatchdog();
    delays.length = 0;
    client.scheduleReconnect();
    assert.deepEqual(delays, [5000]);
  } finally {
    global.setTimeout = realSetTimeout;
    Math.random = realRandom;
  }
});

test('subscribes to stream.online and emits streamOnline notifications', async () => {
  const subscribed = [];
  const client = new EventSubClient({
    api: {
      createEventSubSubscription: async ({ type }) => {
        subscribed.push(type);
        return {};
      }
    },
    broadcasterId: 'b1',
    enableRedemptions: false,
    enableStreamOnline: true,
    logger: silent
  });

  await client.subscribeToConfiguredEvents('sess-3');
  assert.deepEqual(subscribed, ['stream.online']);

  const events = [];
  client.on('streamOnline', (e) => events.push(e));
  client.handleNotification({
    metadata: { subscription_type: 'stream.online' },
    payload: { event: { id: 'live-1' } }
  });
  assert.deepEqual(events, [{ id: 'live-1' }]);
});

test('subscribes to channel.raid and emits raid notifications', async () => {
  const subscribed = [];
  const client = new EventSubClient({
    api: {
      createEventSubSubscription: async ({ type }) => {
        subscribed.push(type);
        return {};
      }
    },
    broadcasterId: 'b1',
    enableRedemptions: false,
    enableRaids: true,
    logger: silent
  });

  await client.subscribeToConfiguredEvents('sess-r');
  assert.deepEqual(subscribed, ['channel.raid']);

  const events = [];
  client.on('raid', (e) => events.push(e));
  client.handleNotification({
    metadata: { subscription_type: 'channel.raid' },
    payload: { event: { from_broadcaster_user_login: 'raider', viewers: 42 } }
  });
  assert.equal(events[0].from_broadcaster_user_login, 'raider');
  assert.equal(events[0].viewers, 42);
});

test('enableStreamOnlineNow hot-subscribes on the live session, idempotently', async () => {
  let subs = 0;
  const client = new EventSubClient({
    api: {
      createEventSubSubscription: async ({ type }) => {
        if (type === 'stream.online') subs += 1;
        return {};
      }
    },
    broadcasterId: 'b1',
    enableRedemptions: false,
    enableStreamOnline: false,
    logger: silent
  });

  // Not connected yet → flag flips, but no subscription (will happen on welcome).
  assert.equal(await client.enableStreamOnlineNow(), false);
  assert.equal(client.enableStreamOnline, true);
  assert.equal(subs, 0);

  // Simulate a live connection.
  client.socket = { readyState: 1 };
  client.sessionId = 'sess-x';

  assert.equal(await client.enableStreamOnlineNow(), true);
  assert.equal(subs, 1);
  // Second call for the same session must not subscribe again.
  assert.equal(await client.enableStreamOnlineNow(), true);
  assert.equal(subs, 1);
});

test('channel.chat.notification emits watchStreak only for watch_streak notices', async () => {
  const subscribed = [];
  const client = new EventSubClient({
    api: { createEventSubSubscription: async () => ({}) },
    chatApi: { createEventSubSubscription: async ({ type }) => { subscribed.push(type); return {}; } },
    broadcasterId: 'b1', chatUserId: 'u1',
    enableRedemptions: false,
    enableChatNotifications: true,
    logger: silent
  });
  await client.subscribeToConfiguredEvents('sess-n');
  assert.deepEqual(subscribed, ['channel.chat.notification']);

  const events = [];
  client.on('watchStreak', (e) => events.push(e));
  // a resub notice → ignored
  client.handleNotification({ metadata: { subscription_type: 'channel.chat.notification' }, payload: { event: { notice_type: 'resub' } } });
  // a watch_streak notice → emitted
  client.handleNotification({ metadata: { subscription_type: 'channel.chat.notification' }, payload: { event: { notice_type: 'watch_streak', chatter_user_name: 'Vasya', watch_streak: { streak_count: 7 } } } });
  assert.equal(events.length, 1);
  assert.equal(events[0].userName, 'Vasya');
  assert.equal(events[0].streak, 7);
});
