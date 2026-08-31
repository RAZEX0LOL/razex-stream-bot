import assert from 'node:assert/strict';
import test from 'node:test';
import { StreamBotEngine, normalizeChatEvent, sanitizeChatText } from '../src/stream-bot-engine.js';

function event(text, role = 'viewer') {
  return {
    chatter_user_id: 'u1',
    chatter_user_login: 'alice',
    chatter_user_name: 'Alice',
    badges: role === 'moderator' ? [{ set_id: 'moderator' }] : [],
    message: { text }
  };
}

function command(overrides = {}) {
  return {
    name: 'hello',
    aliases: [],
    type: 'text',
    minRole: 'everyone',
    allowedUsers: [],
    cooldownSeconds: 0,
    userCooldownSeconds: 0,
    config: { response: 'Hello, {user}!' },
    ...overrides
  };
}

test('normalizes Twitch IRC events into the core chat shape', () => {
  assert.deepEqual(normalizeChatEvent(event('hello'), 'streamer'), {
    userId: 'u1',
    login: 'alice',
    name: 'Alice',
    text: 'hello',
    isBroadcaster: false,
    isModerator: false,
    isVip: false,
    isSubscriber: false,
    isRegular: false
  });
});

test('runs a custom command and sends the rendered reply', async () => {
  const sent = [];
  const engine = new StreamBotEngine({
    channel: 'streamer',
    commandStore: { get: () => command() },
    sendMessage: async (message) => sent.push(message)
  });

  const result = await engine.handleMessage(event('!hello'));
  assert.equal(result.reply, 'Hello, Alice!');
  assert.deepEqual(sent, ['Hello, Alice!']);
});

test('enforces role gates and per-user cooldowns', async () => {
  let now = 1000;
  const sent = [];
  const protectedCommand = command({ minRole: 'moderator', userCooldownSeconds: 10 });
  const engine = new StreamBotEngine({
    channel: 'streamer',
    commandStore: { get: () => protectedCommand },
    sendMessage: async (message) => sent.push(message),
    now: () => now
  });

  assert.equal((await engine.handleMessage(event('!hello'))).reason, 'role');
  assert.equal((await engine.handleMessage(event('!hello', 'moderator'))).handled, true);
  assert.equal((await engine.handleMessage(event('!hello', 'moderator'))).reason, 'cooldown');
  now += 10_000;
  assert.equal((await engine.handleMessage(event('!hello', 'moderator'))).handled, true);
  assert.equal(sent.length, 2);
});

test('records activity and awards loyalty points for regular chat', async () => {
  let recorded = 0;
  let earned = 0;
  const engine = new StreamBotEngine({
    channel: 'streamer',
    commandStore: { get: () => null },
    activityStore: { recordMessage: () => { recorded += 1; } },
    loyaltyStore: {
      touch() {},
      earn: (_id, value) => { earned += value; },
      balance: () => earned
    },
    pointsPerMessage: 3,
    sendMessage: async () => {}
  });

  const result = await engine.handleMessage(event('hello chat'));
  assert.equal(result.reason, 'not-a-command');
  assert.equal(recorded, 1);
  assert.equal(earned, 3);
});

test('sanitizes IRC newlines and caps outgoing messages', () => {
  const value = sanitizeChatText(`hello\r\nPRIVMSG #other :injected ${'x'.repeat(500)}`);
  assert.equal(value.includes('\n'), false);
  assert.equal(value.length, 450);
});
