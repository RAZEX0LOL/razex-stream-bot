import path from 'node:path';
import { ActivityStore } from './activity-store.js';
import { CustomCommandsStore } from './custom-commands-store.js';
import { loadDotEnv, normalizeAccessToken, readEnv } from './env.js';
import { TwitchIrcClient } from './irc-client.js';
import { createLogger } from './logger.js';
import { LoyaltyStore } from './loyalty-store.js';
import { StreamBotEngine, sanitizeChatText } from './stream-bot-engine.js';

loadDotEnv();

const logger = createLogger('stream-bot');
const accessToken = normalizeAccessToken(readEnv('TWITCH_ACCESS_TOKEN', { required: true }));
const botLogin = readEnv('TWITCH_BOT_LOGIN', { required: true }).toLowerCase();
const channel = readEnv('TWITCH_CHANNEL', { required: true }).toLowerCase();
const dataDir = path.resolve(process.cwd(), readEnv('DATA_DIR', { defaultValue: '.data' }));

const commandStore = new CustomCommandsStore({
  storePath: path.join(dataDir, 'commands.json'),
  logger
});
const activityStore = new ActivityStore({
  storePath: path.join(dataDir, 'activity.json'),
  logger
});
const loyaltyStore = new LoyaltyStore({
  storePath: path.join(dataDir, 'loyalty.json'),
  logger
});

commandStore.load();
activityStore.load();
loyaltyStore.load();
seedCommands(commandStore);

const irc = new TwitchIrcClient({
  accessToken,
  login: botLogin,
  channel,
  logger
});

const engine = new StreamBotEngine({
  channel,
  commandStore,
  activityStore,
  loyaltyStore,
  prefix: readEnv('COMMAND_PREFIX', { defaultValue: '!' }),
  pointsPerMessage: readEnv('POINTS_PER_MESSAGE', { defaultValue: '1' }),
  sendMessage: async (message) => {
    const safe = sanitizeChatText(message);
    if (safe) {
      irc.sendRaw(`PRIVMSG #${channel} :${safe}`);
    }
  },
  logger
});

irc.on('chatMessage', (event) => {
  if (event.chatter_user_login === botLogin) {
    return;
  }
  engine.handleMessage(event).catch((error) => logger.error('Message handling failed.', error));
});

irc.start();
logger.info(`Listening to #${channel}.`);

function shutdown() {
  logger.info('Stopping.');
  irc.stop();
  activityStore.flush();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function seedCommands(store) {
  if (store.list().length > 0) {
    return;
  }
  store.upsert({
    name: 'hello',
    type: 'text',
    minRole: 'everyone',
    config: { response: 'Hello, {user}!' }
  });
  store.upsert({
    name: 'roll',
    type: 'text',
    minRole: 'everyone',
    userCooldownSeconds: 10,
    config: { response: '{user} rolled {random:1-100}.' }
  });
  store.upsert({
    name: 'wins',
    type: 'counter',
    minRole: 'moderator',
    config: { template: 'Stream wins: {count}', value: 0 }
  });
}
