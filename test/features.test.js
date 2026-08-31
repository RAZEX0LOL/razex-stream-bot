import assert from 'node:assert/strict';
import test from 'node:test';
import { ALL_FEATURES, applyFeatures, listFeatures } from '../src/features/index.js';
import { formatUptime } from '../src/features/uptime.js';

function makeCtx() {
  const registered = [];
  return {
    random: () => 0.5,
    registerCommand: (names, handler, opts) => registered.push({ names, handler, opts }),
    registered
  };
}

test('listFeatures exposes name/scope/description for the catalog', () => {
  const list = listFeatures();
  assert.ok(list.length >= 2);
  const ping = list.find((f) => f.name === 'ping');
  assert.equal(ping.scope, 'shared');
  assert.ok(list.find((f) => f.name === 'dice').scope === 'optional');
  assert.ok(ping.description.length > 0);
});

test('applyFeatures: shared always, optional only when opted in', () => {
  const ctx1 = makeCtx();
  const applied1 = applyFeatures(ctx1, { enabled: [] });
  assert.deepEqual(applied1, ['ping']); // only shared
  assert.equal(ctx1.registered.length, 1);

  const ctx2 = makeCtx();
  const applied2 = applyFeatures(ctx2, { enabled: ['dice'] });
  assert.deepEqual(applied2.sort(), ['dice', 'ping']);
  assert.equal(ctx2.registered.length, 2);
});

test('applyFeatures ignores unknown opt-ins and is case-insensitive', () => {
  const ctx = makeCtx();
  const applied = applyFeatures(ctx, { enabled: ['DICE', 'nope'] });
  assert.deepEqual(applied.sort(), ['dice', 'ping']);
});

test('every feature descriptor is well-formed', () => {
  for (const feature of ALL_FEATURES) {
    assert.ok(feature.name, 'has name');
    assert.ok(['shared', 'optional'].includes(feature.scope), 'valid scope');
    assert.equal(typeof feature.register, 'function', 'has register()');
  }
});

test('formatUptime renders hours+minutes', () => {
  assert.equal(formatUptime(0), '0 мин');
  assert.equal(formatUptime(45 * 60000), '45 мин');
  assert.equal(formatUptime((2 * 60 + 5) * 60000), '2 ч 5 мин');
});

test('uptime feature reports live duration and offline state via ctx.api', async () => {
  const ctx = {
    ...makeCtx(),
    broadcasterId: '42',
    api: { getStream: async () => ({ started_at: new Date(Date.now() - 90 * 60000).toISOString() }) }
  };
  applyFeatures(ctx, { enabled: ['uptime'] });
  const cmd = ctx.registered.find((r) => r.names.includes('аптайм'));
  assert.ok(cmd);

  const sent = [];
  await cmd.handler({ reply: (m) => sent.push(m) });
  assert.match(sent[0], /Стрим идёт уже 1 ч 30 мин/);

  ctx.api.getStream = async () => null;
  await cmd.handler({ reply: (m) => sent.push(m) });
  assert.match(sent[1], /офлайн/);
});

test('dice feature registers a working roll command', async () => {
  const ctx = makeCtx();
  applyFeatures(ctx, { enabled: ['dice'] });
  const dice = ctx.registered.find((r) => r.names.includes('кубик'));
  assert.ok(dice);
  const sent = [];
  await dice.handler({ chatMessage: { name: 'Bob' }, reply: (m) => sent.push(m) });
  assert.match(sent[0], /Bob выбросил 🎲 [1-6]/);
});
