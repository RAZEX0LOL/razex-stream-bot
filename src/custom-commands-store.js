import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic, quarantineCorrupt } from './json-store.js';
import {
  COMMAND_TYPES,
  DYNAMIC_SOURCES,
  MUSIC_ACTIONS,
  ROLE_ORDER,
  isValidRole
} from './command-runner.js';

const DEFAULT_DATA = { version: 2, commands: [] };

const MAX_COMMANDS = 100;
const MAX_NAME_LENGTH = 40;
const MAX_ALIASES = 5;
const MAX_RESPONSE_LENGTH = 400;
const MAX_RESPONSES = 20;
const MAX_COOLDOWN = 3600;

// Per-channel command builder ("конструктор команд"): each record is a trigger + who
// may run it + cooldowns + a typed action (text / random / counter / music / dynamic),
// editable from the panel and persisted to a small JSON file like the other stores.
// The chat handler looks these up after the built-in commands, so built-ins always win.
export class CustomCommandsStore {
  constructor({ storePath, logger }) {
    this.storePath = path.resolve(process.cwd(), storePath);
    this.logger = logger;
    this.data = structuredClone(DEFAULT_DATA);
    this.index = new Map();
  }

  load() {
    if (!fs.existsSync(this.storePath)) {
      this.ensureDirectory();
      this.save();
      this.reindex();
      return;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      const commands = Array.isArray(parsed.commands) ? parsed.commands : [];
      this.data = {
        version: 2,
        commands: commands.map(sanitizeCommand).filter(Boolean).slice(0, MAX_COMMANDS)
      };
    } catch (error) {
      quarantineCorrupt(this.storePath, error, { logger: this.logger });
      this.logger?.warn('Failed to read custom commands store, starting empty.', error);
      this.data = structuredClone(DEFAULT_DATA);
    }
    this.reindex();
  }

  // Index by name AND every alias so an in-chat "!смерти" resolves the same record
  // as its canonical "!деаты".
  reindex() {
    this.index = new Map();
    for (const command of this.data.commands) {
      this.index.set(command.name, command);
      for (const alias of command.aliases) {
        if (!this.index.has(alias)) {
          this.index.set(alias, command);
        }
      }
    }
  }

  list() {
    return this.data.commands.map((command) => structuredClone(command));
  }

  get(name) {
    return this.index.get(normalizeName(name)) ?? null;
  }

  // Create or update a command (keyed by normalized name). Throws on bad input or
  // when the command cap is reached. Returns the stored record.
  upsert(input) {
    const command = sanitizeCommand(input);
    if (!command) {
      throw new Error('Проверь поля команды: нужно имя и заполненное действие.');
    }

    // An alias must not collide with another command's name/alias.
    for (const alias of command.aliases) {
      const owner = this.index.get(alias);
      if (owner && owner.name !== command.name) {
        throw new Error(`Алиас «${alias}» уже занят командой «${owner.name}».`);
      }
    }

    const existingIndex = this.data.commands.findIndex((entry) => entry.name === command.name);
    if (existingIndex >= 0) {
      this.data.commands[existingIndex] = command;
    } else {
      if (this.data.commands.length >= MAX_COMMANDS) {
        throw new Error(`Достигнут лимит команд (${MAX_COMMANDS}).`);
      }
      this.data.commands.push(command);
    }

    this.save();
    this.reindex();
    return structuredClone(command);
  }

  remove(name) {
    const key = normalizeName(name);
    const before = this.data.commands.length;
    this.data.commands = this.data.commands.filter((command) => command.name !== key);
    const removed = this.data.commands.length !== before;
    if (removed) {
      this.save();
      this.reindex();
    }
    return removed;
  }

  // Bump a counter command's value by `by` and persist. Returns the new value (or
  // null when the command is missing / not a counter). Used by the command runner.
  increment(name, by = 1) {
    const command = this.index.get(normalizeName(name));
    if (!command || command.type !== 'counter') {
      return null;
    }
    command.config.value = (Number(command.config.value) || 0) + by;
    this.save();
    return command.config.value;
  }

  // Reset a counter to a value (default 0) from the panel.
  resetCounter(name, value = 0) {
    const command = this.index.get(normalizeName(name));
    if (!command || command.type !== 'counter') {
      return null;
    }
    const num = Math.floor(Number(value));
    command.config.value = Number.isFinite(num) ? num : 0;
    this.save();
    return command.config.value;
  }

  save() {
    this.ensureDirectory();
    writeJsonAtomic(this.storePath, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  ensureDirectory() {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
  }
}

// Normalize a command name the same way parseCommand does: lowercase (ru-aware),
// no leading prefix, no spaces. So a stored "!Донат" matches an in-chat "!донат".
export function normalizeName(name) {
  return String(name ?? '')
    .trim()
    .replace(/^[!/.]+/, '')
    .split(/\s+/)[0]
    .slice(0, MAX_NAME_LENGTH)
    .toLocaleLowerCase('ru-RU');
}

// Validate + coerce a raw record into the stored shape. Returns null when the command
// is unusable (no name, or an action with no usable payload). Handles MIGRATION from
// the old flat shape ({ response, privileged }) → typed text command with minRole.
export function sanitizeCommand(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const name = normalizeName(source.name);
  if (!name) {
    return null;
  }

  const type = COMMAND_TYPES.includes(source.type) ? source.type : 'text';
  const config = sanitizeConfig(type, source);
  if (!config) {
    return null;
  }

  const aliases = [];
  for (const rawAlias of Array.isArray(source.aliases) ? source.aliases : []) {
    const alias = normalizeName(rawAlias);
    if (alias && alias !== name && !aliases.includes(alias) && aliases.length < MAX_ALIASES) {
      aliases.push(alias);
    }
  }

  // Optional per-user allowlist: when non-empty, ONLY these logins may run the
  // command (on top of the role gate). Lets a streamer make personal commands.
  const allowedUsers = [];
  for (const rawUser of Array.isArray(source.allowedUsers) ? source.allowedUsers : []) {
    const login = String(rawUser ?? '').replace(/^@/, '').trim().toLowerCase();
    if (login && !allowedUsers.includes(login) && allowedUsers.length < 50) {
      allowedUsers.push(login);
    }
  }

  return {
    name,
    aliases,
    type,
    minRole: resolveMinRole(source),
    allowedUsers,
    cooldownSeconds: clampCooldown(source.cooldownSeconds),
    userCooldownSeconds: clampCooldown(source.userCooldownSeconds),
    config
  };
}

// New schema stores minRole; old schema stored privileged:boolean. Migrate true →
// "moderator", false/absent → "everyone".
function resolveMinRole(source) {
  if (isValidRole(source.minRole)) {
    return source.minRole;
  }
  return source.privileged === true ? 'moderator' : 'everyone';
}

function clampCooldown(value) {
  let seconds = Math.floor(Number(value ?? 0));
  if (!Number.isFinite(seconds) || seconds < 0) {
    seconds = 0;
  }
  return Math.min(seconds, MAX_COOLDOWN);
}

function trimText(value, max = MAX_RESPONSE_LENGTH) {
  return String(value ?? '').trim().slice(0, max);
}

// Build + validate the per-type config. Returns null when the required payload is
// missing so the whole command is rejected.
function sanitizeConfig(type, source) {
  const raw = source.config && typeof source.config === 'object' ? source.config : {};

  if (type === 'random') {
    const responses = (Array.isArray(raw.responses) ? raw.responses : [])
      .map((entry) => trimText(entry))
      .filter(Boolean)
      .slice(0, MAX_RESPONSES);
    return responses.length > 0 ? { responses } : null;
  }

  if (type === 'counter') {
    const template = trimText(raw.template);
    if (!template) {
      return null;
    }
    const value = Math.floor(Number(raw.value ?? 0));
    return { template, value: Number.isFinite(value) ? value : 0 };
  }

  if (type === 'music') {
    const action = MUSIC_ACTIONS.includes(raw.action) ? raw.action : 'current';
    return { action };
  }

  if (type === 'dynamic') {
    const sourceName = DYNAMIC_SOURCES.includes(raw.source) ? raw.source : null;
    const template = trimText(raw.template) || '{value}';
    return sourceName ? { source: sourceName, template } : null;
  }

  // text (default) — accept config.response or the legacy flat source.response.
  const response = trimText(raw.response ?? source.response);
  return response ? { response } : null;
}

// Parse a pasted list of simple commands (Nightbot/StreamElements migration) into
// upsertable text-command records. One command per line: the first token (optionally
// prefixed with !) is the command name, the rest is the response. Blank lines and
// lines starting with # or // are skipped. $(...) placeholders survive as-is (the
// renderer understands them). Returns { commands, skipped }.
export function parseCommandImport(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const commands = [];
  let skipped = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) {
      continue;
    }
    const match = line.match(/^[!/.]?(\S+)\s+(.+)$/);
    if (!match) {
      skipped += 1;
      continue;
    }
    const name = normalizeName(match[1]);
    const response = match[2].trim();
    if (!name || !response) {
      skipped += 1;
      continue;
    }
    commands.push({ name, type: 'text', config: { response } });
  }
  return { commands, skipped };
}

// Legacy helper kept for callers/tests that still render {user}/{target} directly.
// The richer renderer lives in command-runner.js (renderResponse).
export function renderTemplate(template, { user, target } = {}) {
  return String(template ?? '')
    .replaceAll('{user}', user ?? '')
    .replaceAll('{target}', target || user || '');
}

export { ROLE_ORDER };
