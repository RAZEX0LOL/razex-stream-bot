import { canRun, executeCustomCommand } from './command-runner.js';
import { normalizeName } from './custom-commands-store.js';

const MAX_CHAT_LENGTH = 450;

export class StreamBotEngine {
  constructor({
    channel,
    commandStore,
    activityStore = null,
    loyaltyStore = null,
    musicQueue = null,
    timerRunner = null,
    sendMessage,
    logger = null,
    prefix = '!',
    pointsPerMessage = 1,
    now = () => Date.now()
  }) {
    this.channel = normalizeName(channel);
    this.commandStore = commandStore;
    this.activityStore = activityStore;
    this.loyaltyStore = loyaltyStore;
    this.musicQueue = musicQueue;
    this.timerRunner = timerRunner;
    this.sendMessage = sendMessage;
    this.logger = logger;
    this.prefix = String(prefix || '!').slice(0, 1);
    this.pointsPerMessage = Math.max(0, Math.floor(Number(pointsPerMessage) || 0));
    this.now = now;
    this.globalCooldowns = new Map();
    this.userCooldowns = new Map();
  }

  async handleMessage(event) {
    const chatMessage = normalizeChatEvent(event, this.channel);
    if (!chatMessage) {
      return { handled: false, reason: 'invalid-event' };
    }

    this.activityStore?.recordMessage(chatMessage);
    this.timerRunner?.noteMessage();
    if (this.loyaltyStore) {
      const meta = { login: chatMessage.login, name: chatMessage.name };
      this.loyaltyStore.touch(chatMessage.userId, meta);
      if (this.pointsPerMessage > 0) {
        this.loyaltyStore.earn(chatMessage.userId, this.pointsPerMessage, meta);
      }
    }

    const parsed = parseCommand(chatMessage.text, this.prefix);
    if (!parsed) {
      return { handled: false, reason: 'not-a-command' };
    }

    const builtInReply = this.runBuiltIn(parsed, chatMessage);
    if (builtInReply) {
      return this.reply(builtInReply, { command: parsed.name, builtIn: true });
    }

    const custom = this.commandStore?.get(parsed.name);
    if (!custom) {
      return { handled: false, reason: 'unknown-command', command: parsed.name };
    }

    if (!canRun(custom.minRole, chatMessage)) {
      return { handled: false, reason: 'role', command: custom.name };
    }

    if (
      custom.allowedUsers?.length > 0 &&
      !custom.allowedUsers.includes(chatMessage.login) &&
      !chatMessage.isBroadcaster
    ) {
      return { handled: false, reason: 'allowlist', command: custom.name };
    }

    if (this.isCoolingDown(custom, chatMessage)) {
      return { handled: false, reason: 'cooldown', command: custom.name };
    }

    const reply = await executeCustomCommand(custom, chatMessage, parsed, {
      activityStore: this.activityStore,
      musicQueue: this.musicQueue,
      store: this.commandStore
    });
    this.markCooldown(custom, chatMessage);

    if (!reply) {
      return { handled: true, command: custom.name, reply: '' };
    }
    return this.reply(reply, { command: custom.name });
  }

  runBuiltIn(command, chatMessage) {
    if (command.name === 'points' && this.loyaltyStore) {
      return `${chatMessage.name}: ${this.loyaltyStore.balance(chatMessage.userId)} points`;
    }
    if (command.name === 'top' && this.activityStore) {
      const leaders = this.activityStore
        .topByDays(7, 5)
        .map((user, index) => `${index + 1}. ${user.name} — ${user.xp} XP`);
      return leaders.length > 0 ? `Top chatters: ${leaders.join(' · ')}` : 'No activity yet.';
    }
    return '';
  }

  isCoolingDown(custom, chatMessage) {
    const now = this.now();
    const globalUntil = this.globalCooldowns.get(custom.name) ?? 0;
    const userUntil = this.userCooldowns.get(`${custom.name}:${chatMessage.userId}`) ?? 0;
    return globalUntil > now || userUntil > now;
  }

  markCooldown(custom, chatMessage) {
    const now = this.now();
    if (custom.cooldownSeconds > 0) {
      this.globalCooldowns.set(custom.name, now + custom.cooldownSeconds * 1000);
    }
    if (custom.userCooldownSeconds > 0) {
      this.userCooldowns.set(
        `${custom.name}:${chatMessage.userId}`,
        now + custom.userCooldownSeconds * 1000
      );
    }
  }

  async reply(value, metadata) {
    const reply = sanitizeChatText(value);
    if (!reply) {
      return { handled: true, ...metadata, reply: '' };
    }
    await this.sendMessage(reply);
    this.logger?.info?.(`Command ${metadata.command} replied.`);
    return { handled: true, ...metadata, reply };
  }
}

export function normalizeChatEvent(event, channel = '') {
  const source = event && typeof event === 'object' ? event : {};
  const userId = String(source.userId ?? source.chatter_user_id ?? '').trim();
  const login = String(source.login ?? source.chatter_user_login ?? '').trim().toLowerCase();
  const name = String(source.name ?? source.chatter_user_name ?? login).trim();
  const text = String(source.text ?? source.message?.text ?? '').trim();
  if (!userId || !login || !name) {
    return null;
  }

  const badgeNames = new Set(
    (Array.isArray(source.badges) ? source.badges : [])
      .map((badge) => String(badge?.set_id ?? badge?.setId ?? badge ?? '').toLowerCase())
      .filter(Boolean)
  );

  return {
    userId,
    login,
    name: name.slice(0, 60),
    text: text.slice(0, 500),
    isBroadcaster: login === channel || badgeNames.has('broadcaster'),
    isModerator: badgeNames.has('moderator') || badgeNames.has('lead_moderator'),
    isVip: badgeNames.has('vip'),
    isSubscriber: badgeNames.has('subscriber') || badgeNames.has('founder'),
    isRegular: Boolean(source.isRegular)
  };
}

export function sanitizeChatText(value) {
  return String(value ?? '')
    .replace(/[\r\n\0]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CHAT_LENGTH);
}

function parseCommand(text, prefix) {
  const value = String(text ?? '').trim();
  if (!value.startsWith(prefix)) {
    return null;
  }
  const parts = value.slice(prefix.length).trim().split(/\s+/).filter(Boolean);
  const name = normalizeName(parts.shift());
  return name ? { name, args: parts } : null;
}
