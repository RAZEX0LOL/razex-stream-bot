import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CustomCommandsStore,
  normalizeName,
  renderTemplate,
  sanitizeCommand
, parseCommandImport } from '../src/custom-commands-store.js';

function createStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-cmd-'));
  const store = new CustomCommandsStore({ storePath: path.join(dir, 'commands.json'), logger: null });
  store.load();
  return store;
}

test('normalizeName strips prefix/spaces and lowercases (ru-aware)', () => {
  assert.equal(normalizeName('!Донат'), 'донат');
  assert.equal(normalizeName('  /Rules now '), 'rules');
  assert.equal(normalizeName('ПРАВИЛА'), 'правила');
});

test('sanitizeCommand requires name+payload, clamps cooldown, migrates legacy shape', () => {
  assert.equal(sanitizeCommand({ name: '', response: 'x' }), null);
  assert.equal(sanitizeCommand({ name: 'a', response: '   ' }), null);
  // Legacy flat shape ({ response, privileged }) migrates to a typed text command.
  const c = sanitizeCommand({ name: '!Донат', response: '  hi ', cooldownSeconds: -5, privileged: 'yes' });
  assert.deepEqual(c, {
    name: 'донат',
    aliases: [],
    type: 'text',
    minRole: 'everyone',
    allowedUsers: [],
    cooldownSeconds: 0,
    userCooldownSeconds: 0,
    config: { response: 'hi' }
  });
  assert.equal(sanitizeCommand({ name: 'a', response: 'x', cooldownSeconds: 99999 }).cooldownSeconds, 3600);
  assert.equal(sanitizeCommand({ name: 'a', response: 'x', privileged: true }).minRole, 'moderator');
});

test('sanitizeCommand validates each typed action and rejects empty payloads', () => {
  assert.equal(sanitizeCommand({ name: 'r', type: 'random', config: { responses: [] } }), null);
  assert.deepEqual(sanitizeCommand({ name: 'r', type: 'random', config: { responses: [' a ', '', 'b'] } }).config, {
    responses: ['a', 'b']
  });
  assert.equal(sanitizeCommand({ name: 'c', type: 'counter', config: {} }), null);
  assert.deepEqual(sanitizeCommand({ name: 'c', type: 'counter', config: { template: '{count}!', value: 3 } }).config, {
    template: '{count}!',
    value: 3
  });
  assert.equal(sanitizeCommand({ name: 'm', type: 'music', config: { action: 'bogus' } }).config.action, 'current');
  assert.equal(sanitizeCommand({ name: 'd', type: 'dynamic', config: { template: 'x' } }), null);
  assert.deepEqual(sanitizeCommand({ name: 'd', type: 'dynamic', config: { source: 'uptime' } }).config, {
    source: 'uptime',
    template: '{value}'
  });
});

test('sanitizeCommand keeps a clean alias list (deduped, no self, capped, no prefix)', () => {
  const c = sanitizeCommand({ name: 'донат', response: 'x', aliases: ['!Donate', 'donate', 'донат', ' поддержать '] });
  assert.deepEqual(c.aliases, ['donate', 'поддержать']);
});

test('renderTemplate substitutes {user} and {target} (target falls back to user)', () => {
  assert.equal(renderTemplate('{user}, привет', { user: 'Bob' }), 'Bob, привет');
  assert.equal(renderTemplate('обнял {target}', { user: 'Bob', target: 'Ann' }), 'обнял Ann');
  assert.equal(renderTemplate('обнял {target}', { user: 'Bob', target: '' }), 'обнял Bob');
});

test('upsert creates then updates by normalized name, persists, reindexes', () => {
  const store = createStore();
  store.upsert({ name: '!Донат', response: 'first' });
  assert.equal(store.get('донат').config.response, 'first');
  store.upsert({ name: 'донат', response: 'second', cooldownSeconds: 10 });
  assert.equal(store.list().length, 1);
  assert.equal(store.get('!донат').config.response, 'second');
  assert.equal(store.get('донат').cooldownSeconds, 10);
});

test('upsert rejects bad input and survives reload', () => {
  const store = createStore();
  assert.throws(() => store.upsert({ name: '', response: '' }), /имя/);
  store.upsert({ name: 'правила', response: 'будь добр' });

  const reopened = new CustomCommandsStore({ storePath: store.storePath, logger: null });
  reopened.load();
  assert.equal(reopened.get('правила').config.response, 'будь добр');
});

test('aliases resolve to the same record and collisions are rejected', () => {
  const store = createStore();
  store.upsert({ name: 'донат', response: 'x', aliases: ['donate'] });
  assert.equal(store.get('donate').name, 'донат');
  assert.throws(() => store.upsert({ name: 'другая', response: 'y', aliases: ['donate'] }), /занят/);
});

test('counter increment and reset persist', () => {
  const store = createStore();
  store.upsert({ name: 'деаты', type: 'counter', config: { template: '{count}', value: 0 } });
  assert.equal(store.increment('деаты'), 1);
  assert.equal(store.increment('деаты'), 2);
  assert.equal(store.resetCounter('деаты'), 0);
  assert.equal(store.increment('правила'), null); // missing
  store.upsert({ name: 'привет', response: 'x' });
  assert.equal(store.increment('привет'), null); // not a counter
});

test('remove deletes and reports', () => {
  const store = createStore();
  store.upsert({ name: 'a', response: 'x' });
  assert.equal(store.remove('A'), true);
  assert.equal(store.remove('a'), false);
  assert.equal(store.get('a'), null);
});

test('parseCommandImport parses a pasted list into text commands', () => {
  const { commands, skipped } = parseCommandImport(
    '!дискорд Залетай: discord.gg/x\n# коммент\nсоцсети наши соцсети тут\n!плохая\n\n!со Аптайм $(uptime)'
  );
  assert.equal(commands.length, 3);
  assert.deepEqual(commands[0], { name: 'дискорд', type: 'text', config: { response: 'Залетай: discord.gg/x' } });
  assert.equal(commands[1].name, 'соцсети');
  assert.equal(commands[2].config.response, 'Аптайм $(uptime)');
  // "!плохая" has no response → skipped; comment ignored (not counted).
  assert.equal(skipped, 1);
});

test('allowedUsers sanitize: normalized logins, deduped, capped', () => {
  const cmd = sanitizeCommand({
    name: 'приват',
    type: 'text',
    response: 'секретная команда',
    allowedUsers: ['@Vasya ', 'best_FRIEND', 'vasya', '', null]
  });
  assert.deepEqual(cmd.allowedUsers, ['vasya', 'best_friend']);
  // Absent → empty array (role-only gating).
  assert.deepEqual(sanitizeCommand({ name: 'x', type: 'text', response: 'y' }).allowedUsers, []);
});
