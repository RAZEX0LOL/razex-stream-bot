import { EventEmitter } from 'node:events';
import tls from 'node:tls';

const IRC_HOST = 'irc.chat.twitch.tv';
const IRC_PORT = 6697;

export class TwitchIrcClient extends EventEmitter {
  constructor({
    accessToken,
    login,
    channel,
    logger,
    host = IRC_HOST,
    port = IRC_PORT,
    reconnectDelayMs = 5000,
    connectImpl = tls.connect
  }) {
    super();
    this.accessToken = accessToken;
    this.login = login;
    this.channel = normalizeChannel(channel);
    this.logger = logger;
    this.host = host;
    this.port = port;
    this.reconnectDelayMs = reconnectDelayMs;
    this.connectImpl = connectImpl;
    this.socket = null;
    this.buffer = '';
    this.stopped = false;
  }

  start() {
    if (!this.login) {
      throw new Error('IRC listener requires bot login.');
    }

    if (!this.channel) {
      throw new Error('IRC listener requires channel login.');
    }

    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
  }

  isConnected() {
    return Boolean(this.socket && !this.socket.destroyed && this.socket.readyState === 'open');
  }

  connect() {
    const socket = this.connectImpl({
      host: this.host,
      port: this.port
    });
    this.socket = socket;

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      this.logger.info(`IRC connected as ${this.login}.`);
      this.sendRaw('CAP REQ :twitch.tv/tags twitch.tv/commands');
      this.sendRaw(`PASS oauth:${this.accessToken}`);
      this.sendRaw(`NICK ${this.login}`);
      this.sendRaw(`JOIN #${this.channel}`);
    });

    socket.on('data', (chunk) => this.handleData(chunk));
    socket.on('error', (error) => {
      this.logger.error('IRC socket error.', error);
    });
    socket.on('close', () => {
      if (this.stopped || socket !== this.socket) {
        return;
      }

      this.logger.warn('IRC socket closed.');
      this.scheduleReconnect();
    });
  }

  handleData(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      this.handleLine(line);
    }
  }

  handleLine(line) {
    if (!line) {
      return;
    }

    const message = parseIrcMessage(line);
    if (message.command === 'PING') {
      this.sendRaw(`PONG :${message.trailing}`);
      return;
    }

    if (message.command !== 'PRIVMSG') {
      return;
    }

    const event = ircMessageToChatEvent(message);
    if (event) {
      this.emit('chatMessage', event);
    }
  }

  sendRaw(line) {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(`${line}\r\n`);
    }
  }

  scheduleReconnect() {
    setTimeout(() => {
      if (!this.stopped) {
        this.connect();
      }
    }, this.reconnectDelayMs);
  }
}

export function parseIrcMessage(line) {
  let rest = line;
  let tags = {};
  let prefix = '';

  if (rest.startsWith('@')) {
    const spaceIndex = rest.indexOf(' ');
    tags = parseTags(rest.slice(1, spaceIndex));
    rest = rest.slice(spaceIndex + 1);
  }

  if (rest.startsWith(':')) {
    const spaceIndex = rest.indexOf(' ');
    prefix = rest.slice(1, spaceIndex);
    rest = rest.slice(spaceIndex + 1);
  }

  let trailing = '';
  const trailingIndex = rest.indexOf(' :');
  if (trailingIndex !== -1) {
    trailing = rest.slice(trailingIndex + 2);
    rest = rest.slice(0, trailingIndex);
  }

  const [command = '', ...params] = rest.split(/\s+/).filter(Boolean);
  return {
    tags,
    prefix,
    command,
    params,
    trailing
  };
}

export function ircMessageToChatEvent(message) {
  const login = message.tags.login || message.prefix.split('!')[0];
  const userId = message.tags['user-id'];
  if (!login || !userId) {
    return null;
  }

  return {
    message_id: message.tags.id ?? '',
    chatter_user_id: userId,
    chatter_user_login: login,
    chatter_user_name: message.tags['display-name'] || login,
    badges: parseBadges(message.tags.badges),
    message: {
      text: message.trailing
    },
    source: 'irc'
  };
}

function parseTags(rawTags) {
  return Object.fromEntries(
    rawTags.split(';').map((tag) => {
      const [key, value = ''] = tag.split('=');
      return [key, unescapeTag(value)];
    })
  );
}

function parseBadges(rawBadges = '') {
  return rawBadges
    .split(',')
    .filter(Boolean)
    .map((badge) => {
      const [setId, id = '1'] = badge.split('/');
      return {
        set_id: setId,
        id
      };
    });
}

function unescapeTag(value) {
  return value
    .replaceAll('\\s', ' ')
    .replaceAll('\\:', ';')
    .replaceAll('\\\\', '\\')
    .replaceAll('\\r', '\r')
    .replaceAll('\\n', '\n');
}

function normalizeChannel(channel) {
  return String(channel ?? '').replace(/^#/, '').trim().toLocaleLowerCase('en-US');
}
