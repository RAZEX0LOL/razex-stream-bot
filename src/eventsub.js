import { EventEmitter } from 'node:events';

const EVENTSUB_WEBSOCKET_URL = 'wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30';
const REDEMPTION_ADD_TYPE = 'channel.channel_points_custom_reward_redemption.add';
const CHAT_MESSAGE_TYPE = 'channel.chat.message';
const STREAM_ONLINE_TYPE = 'stream.online';
const RAID_TYPE = 'channel.raid';
const CHAT_NOTIFICATION_TYPE = 'channel.chat.notification';

export class EventSubClient extends EventEmitter {
  constructor({
    api,
    chatApi = api,
    broadcasterId,
    chatUserId = null,
    enableRedemptions = true,
    enableChatMessages = false,
    enableStreamOnline = false,
    enableRaids = false,
    enableChatNotifications = false,
    rewardIds = [],
    logger,
    reconnectDelayMs = 5000,
    ensureToken = null,
    WebSocketImpl = WebSocket
  }) {
    super();
    this.api = api;
    this.chatApi = chatApi;
    this.ensureToken = ensureToken;
    this.broadcasterId = broadcasterId;
    this.chatUserId = chatUserId;
    this.enableRedemptions = enableRedemptions;
    this.enableChatMessages = enableChatMessages;
    this.enableStreamOnline = enableStreamOnline;
    this.enableRaids = enableRaids;
    this.enableChatNotifications = enableChatNotifications;
    this.rewardIds = rewardIds;
    this.logger = logger;
    this.reconnectDelayMs = reconnectDelayMs;
    // Exponential backoff so a flaky RF→Twitch path doesn't get hammered every 5s.
    // Resets to the base delay once a connection succeeds (session_welcome).
    this.maxReconnectDelayMs = 60000;
    this.reconnectAttempts = 0;
    this.WebSocketImpl = WebSocketImpl;
    this.socket = null;
    this.stopped = false;
    // Current EventSub session id + the session we last subscribed stream.online for,
    // so a hot enable (panel toggle) can subscribe on the live connection without a
    // restart, and never subscribes twice for the same session.
    this.sessionId = null;
    this.streamOnlineSession = null;
    this.watchdogTimer = null;
    this.lastMessageAt = 0;
    this.keepaliveTimeoutMs = 45000;
    this.seenMessageIds = new Set();
  }

  start() {
    this.stopped = false;
    this.connect(EVENTSUB_WEBSOCKET_URL, { subscribeOnWelcome: true });
  }

  stop() {
    this.stopped = true;
    this.clearWatchdog();
    if (this.socket) {
      this.socket.close(1000, 'Bot shutdown');
      this.socket = null;
    }
  }

  isConnected() {
    return this.socket?.readyState === (this.WebSocketImpl.OPEN ?? 1);
  }

  connect(url, { subscribeOnWelcome, closeAfterWelcome = null }) {
    const socket = new this.WebSocketImpl(url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.logger.info('EventSub WebSocket connected.');
    });

    socket.addEventListener('message', (event) => {
      this.handleRawMessage(event.data, { subscribeOnWelcome, closeAfterWelcome }).catch((error) => {
        this.logger.error('Failed to handle EventSub message.', error);
      });
    });

    socket.addEventListener('close', (event) => {
      if (this.stopped || socket !== this.socket) {
        return;
      }

      this.clearWatchdog();
      this.logger.warn(`EventSub WebSocket closed: code=${event.code} reason=${event.reason || '-'}`);
      this.scheduleReconnect();
    });

    socket.addEventListener('error', (event) => {
      this.logger.error('EventSub WebSocket error.', event.error ?? event.message ?? event);
    });
  }

  async handleRawMessage(rawData, { subscribeOnWelcome, closeAfterWelcome }) {
    this.lastMessageAt = Date.now();
    const message = JSON.parse(String(rawData));
    const messageId = message.metadata?.message_id;
    const messageType = message.metadata?.message_type;

    if (messageId && this.isDuplicate(messageId)) {
      this.logger.debug(`Ignored duplicate EventSub message: ${messageId}`);
      return;
    }

    switch (messageType) {
      case 'session_welcome':
        await this.handleWelcome(message.payload?.session, { subscribeOnWelcome, closeAfterWelcome });
        break;
      case 'session_keepalive':
        this.logger.debug('EventSub keepalive received.');
        break;
      case 'notification':
        this.handleNotification(message);
        break;
      case 'session_reconnect':
        this.handleReconnect(message.payload?.session?.reconnect_url);
        break;
      case 'revocation':
        this.logger.warn('EventSub subscription was revoked.', message.payload?.subscription);
        break;
      default:
        this.logger.debug(`Unhandled EventSub message type: ${messageType}`);
        break;
    }
  }

  async handleWelcome(session, { subscribeOnWelcome, closeAfterWelcome }) {
    if (!session?.id) {
      throw new Error('EventSub welcome message did not contain session id.');
    }

    this.sessionId = session.id;
    this.keepaliveTimeoutMs = Math.max(15000, (session.keepalive_timeout_seconds ?? 30) * 1000 + 5000);
    // A successful connection clears the backoff so the next blip starts at the base delay.
    this.reconnectAttempts = 0;
    this.armWatchdog();

    if (closeAfterWelcome) {
      closeAfterWelcome.close(1000, 'Switched to Twitch reconnect URL');
    }

    if (!subscribeOnWelcome) {
      this.logger.info('EventSub reconnected with existing subscriptions.');
      return;
    }

    // A fresh connection needs fresh subscriptions, which call Helix — make sure
    // the access token is current first, or an expired token causes a 401 loop.
    if (this.ensureToken) {
      await this.ensureToken();
    }

    await this.subscribeToConfiguredEvents(session.id);
  }

  async subscribeToConfiguredEvents(sessionId) {
    // Each subscription is independent: if one is rejected (e.g. redemptions 403 on a
    // non-affiliate channel), log it and keep the others so the connection stays alive
    // and Twitch doesn't close it for having zero subscriptions (which caused a reconnect
    // loop). At least one must succeed or Twitch drops the unused connection.
    let anyOk = false;
    const trySub = async (label, fn) => {
      try {
        await fn();
        anyOk = true;
      } catch (error) {
        this.logger.warn(`EventSub subscription "${label}" rejected (continuing): ${error.message}`);
      }
    };

    if (this.enableRedemptions) await trySub('redemptions', () => this.subscribeToRedemptions(sessionId));
    if (this.enableChatMessages) await trySub('chat.message', () => this.subscribeToChatMessages(sessionId));
    if (this.enableStreamOnline) await trySub('stream.online', () => this.subscribeToStreamOnline(sessionId));
    if (this.enableRaids) await trySub('channel.raid', () => this.subscribeToRaids(sessionId));
    if (this.enableChatNotifications) await trySub('chat.notification', () => this.subscribeToChatNotifications(sessionId));

    if (!anyOk) {
      this.logger.error('EventSub: no subscriptions succeeded — connection will be closed by Twitch.');
    }
  }

  async subscribeToRaids(sessionId) {
    await this.api.createEventSubSubscription({
      type: RAID_TYPE,
      condition: { to_broadcaster_user_id: this.broadcasterId },
      sessionId
    });
    this.logger.info('Subscribed to incoming raids.');
  }

  async subscribeToStreamOnline(sessionId) {
    await this.api.createEventSubSubscription({
      type: STREAM_ONLINE_TYPE,
      condition: {
        broadcaster_user_id: this.broadcasterId
      },
      sessionId
    });

    this.streamOnlineSession = sessionId;
    this.logger.info('Subscribed to stream.online notifications.');
  }

  // Hot-enable go-live notifications without restarting: flip the flag (so a future
  // reconnect re-subscribes too) and, if already connected, subscribe on the live
  // session right now. Idempotent — won't duplicate the subscription for a session.
  async enableStreamOnlineNow() {
    this.enableStreamOnline = true;
    if (!this.isConnected() || !this.sessionId) {
      return false; // will subscribe on the next welcome
    }
    if (this.streamOnlineSession === this.sessionId) {
      return true; // already subscribed for this session
    }
    await this.subscribeToStreamOnline(this.sessionId);
    return true;
  }

  async subscribeToRedemptions(sessionId) {
    const rewardIdsToSubscribe = this.rewardIds.length > 0 ? this.rewardIds : [null];

    for (const rewardId of rewardIdsToSubscribe) {
      const condition = {
        broadcaster_user_id: this.broadcasterId
      };

      if (rewardId) {
        condition.reward_id = rewardId;
      }

      await this.api.createEventSubSubscription({
        type: REDEMPTION_ADD_TYPE,
        condition,
        sessionId
      });

      this.logger.info(
        rewardId
          ? `Subscribed to channel point redemptions for reward ${rewardId}.`
          : 'Subscribed to all custom channel point redemptions.'
      );
    }
  }

  async subscribeToChatNotifications(sessionId) {
    if (!this.chatUserId) {
      throw new Error('Cannot subscribe to chat notifications without chatUserId.');
    }
    await this.chatApi.createEventSubSubscription({
      type: CHAT_NOTIFICATION_TYPE,
      condition: {
        broadcaster_user_id: this.broadcasterId,
        user_id: this.chatUserId
      },
      sessionId
    });
    this.logger.info('Subscribed to chat notifications (watch streaks etc.).');
  }

  async subscribeToChatMessages(sessionId) {
    if (!this.chatUserId) {
      throw new Error('Cannot subscribe to chat messages without chatUserId.');
    }

    await this.chatApi.createEventSubSubscription({
      type: CHAT_MESSAGE_TYPE,
      condition: {
        broadcaster_user_id: this.broadcasterId,
        user_id: this.chatUserId
      },
      sessionId
    });

    this.logger.info('Subscribed to channel chat messages.');
  }

  handleNotification(message) {
    const subscriptionType = message.metadata?.subscription_type || message.payload?.subscription?.type;
    const event = message.payload?.event;
    if (!event) {
      this.logger.warn(`EventSub ${subscriptionType} notification had no event payload.`);
      return;
    }

    if (subscriptionType === REDEMPTION_ADD_TYPE) {
      this.emit('redemption', event);
      return;
    }

    if (subscriptionType === CHAT_MESSAGE_TYPE) {
      this.emit('chatMessage', event);
      return;
    }

    if (subscriptionType === RAID_TYPE) {
      this.emit('raid', event);
      return;
    }

    if (subscriptionType === CHAT_NOTIFICATION_TYPE) {
      // Log every chat notification so watch-streak delivery is diagnosable (Twitch only
      // sends watch_streak under its own conditions/settings).
      this.logger.debug(
        `Chat notification: notice_type=${event?.notice_type} streak_count=${event?.watch_streak?.streak_count ?? '-'}`
      );
      if (event?.notice_type === 'watch_streak' && event.watch_streak) {
        // Twitch's field is streak_count (not streak); default to 1 so a real streak
        // notice always clears a minStreak of 1.
        this.emit('watchStreak', {
          userName: event.chatter_user_name || event.chatter_user_login || '',
          userLogin: event.chatter_user_login || '',
          streak: Number(event.watch_streak.streak_count ?? event.watch_streak.streak) || 1
        });
      }
      // Every notice (sub, resub, gift, community gift, raid, announcement, bits…) goes
      // out generically so the on-screen overlay feed can show all chat activity.
      this.emit('chatNotification', event);
      return;
    }

    if (subscriptionType === STREAM_ONLINE_TYPE) {
      this.emit('streamOnline', event);
      return;
    }

    this.logger.debug(`Ignored EventSub notification: ${subscriptionType}`);
  }

  handleReconnect(reconnectUrl) {
    if (!reconnectUrl) {
      this.logger.warn('EventSub asked to reconnect without reconnect_url.');
      this.scheduleReconnect();
      return;
    }

    const oldSocket = this.socket;
    this.logger.info('EventSub requested reconnect.');
    this.connect(reconnectUrl, { subscribeOnWelcome: false, closeAfterWelcome: oldSocket });
  }

  scheduleReconnect() {
    if (this.stopped) {
      return;
    }

    // Exponential backoff (5s, 10s, 20s … capped at 60s) plus up to 1s of jitter so
    // multiple bot instances don't reconnect in lockstep and pile onto Twitch.
    const base = Math.min(this.reconnectDelayMs * 2 ** this.reconnectAttempts, this.maxReconnectDelayMs);
    const delay = base + Math.floor(Math.random() * 1000);
    this.reconnectAttempts += 1;

    setTimeout(() => {
      if (!this.stopped) {
        this.connect(EVENTSUB_WEBSOCKET_URL, { subscribeOnWelcome: true });
      }
    }, delay);
  }

  armWatchdog() {
    this.clearWatchdog();
    this.watchdogTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > this.keepaliveTimeoutMs) {
        this.logger.warn('EventSub keepalive timeout. Reconnecting.');
        if (this.socket) {
          this.socket.close(4005, 'Keepalive timeout');
        } else {
          this.scheduleReconnect();
        }
      }
    }, Math.min(this.keepaliveTimeoutMs, 30000));
  }

  clearWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  isDuplicate(messageId) {
    if (this.seenMessageIds.has(messageId)) {
      return true;
    }

    this.seenMessageIds.add(messageId);
    if (this.seenMessageIds.size > 1000) {
      const oldestMessageId = this.seenMessageIds.values().next().value;
      this.seenMessageIds.delete(oldestMessageId);
    }

    return false;
  }
}
