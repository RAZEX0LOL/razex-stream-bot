const TWITCH_API_BASE_URL = 'https://api.twitch.tv/helix';
const TWITCH_VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';

export class TwitchApi {
  constructor({ clientId, accessToken, fetchImpl = fetch }) {
    if (!clientId) {
      throw new Error('TwitchApi requires clientId.');
    }

    if (!accessToken) {
      throw new Error('TwitchApi requires accessToken.');
    }

    this.clientId = clientId;
    this.accessToken = accessToken;
    this.fetch = fetchImpl;
  }

  async validateToken() {
    const response = await this.fetch(TWITCH_VALIDATE_URL, {
      headers: {
        Authorization: `OAuth ${this.accessToken}`
      }
    });

    return parseTwitchResponse(response, 'validate token');
  }

  async getUserByLogin(login) {
    const data = await this.request('/users', {
      query: {
        login
      }
    });

    const user = data.data?.[0];
    if (!user) {
      throw new Error(`Twitch user not found by login: ${login}`);
    }

    return user;
  }

  // Current live stream for a broadcaster, or null when offline. Used e.g. by the
  // uptime feature to compute how long the stream has been running.
  async getStream(broadcasterId) {
    const data = await this.request('/streams', { query: { user_id: broadcasterId } });
    return data.data?.[0] ?? null;
  }

  // Channel info (last/current game + title) for a broadcaster. Public data, no extra
  // scope — used by shoutouts to say what the target streamer was last playing.
  async getChannelInfo(broadcasterId) {
    const data = await this.request('/channels', { query: { broadcaster_id: broadcasterId } });
    return data.data?.[0] ?? null;
  }

  // Create a clip of the last ~30s of the live stream. Needs the clips:edit scope on
  // the broadcaster token and the channel to be live. Returns { id, edit_url }.
  async createClip(broadcasterId) {
    const data = await this.request('/clips', {
      method: 'POST',
      query: { broadcaster_id: broadcasterId }
    });
    return data.data?.[0] ?? null;
  }

  // Native Twitch shoutout (the blue "check them out" banner). Needs the
  // moderator:manage:shoutouts scope; rate-limited by Twitch (2 min / target 60 min).
  async sendShoutout({ fromBroadcasterId, toBroadcasterId, moderatorId }) {
    return this.request('/chat/shoutouts', {
      method: 'POST',
      query: {
        from_broadcaster_id: fromBroadcasterId,
        to_broadcaster_id: toBroadcasterId,
        moderator_id: moderatorId
      }
    });
  }

  async sendChatMessage({ broadcasterId, senderId, message, replyParentMessageId }) {
    if (!message || typeof message !== 'string') {
      throw new Error('Cannot send an empty chat message.');
    }

    if (message.length > 500) {
      throw new Error(`Chat message is too long: ${message.length}/500 characters.`);
    }

    const body = {
      broadcaster_id: broadcasterId,
      sender_id: senderId,
      message
    };

    if (replyParentMessageId) {
      body.reply_parent_message_id = replyParentMessageId;
    }

    const data = await this.request('/chat/messages', {
      method: 'POST',
      body
    });

    const result = data.data?.[0];
    if (result && result.is_sent === false) {
      const reason = result.drop_reason?.message || result.drop_reason?.code || 'unknown reason';
      throw new Error(`Twitch dropped chat message: ${reason}`);
    }

    return result;
  }

  async createEventSubSubscription({ type, version = '1', condition, sessionId }) {
    return this.request('/eventsub/subscriptions', {
      method: 'POST',
      body: {
        type,
        version,
        condition,
        transport: {
          method: 'websocket',
          session_id: sessionId
        }
      }
    });
  }

  async updateRedemptionStatus({ broadcasterId, rewardId, redemptionId, status }) {
    const data = await this.request('/channel_points/custom_rewards/redemptions', {
      method: 'PATCH',
      query: {
        broadcaster_id: broadcasterId,
        reward_id: rewardId,
        id: redemptionId
      },
      body: {
        status
      }
    });

    return data.data?.[0];
  }

  async getCustomRewards({ broadcasterId, onlyManageableRewards = true }) {
    const data = await this.request('/channel_points/custom_rewards', {
      query: {
        broadcaster_id: broadcasterId,
        only_manageable_rewards: onlyManageableRewards ? 'true' : 'false'
      }
    });
    return data.data ?? [];
  }

  async createCustomReward({ broadcasterId, title, cost, prompt, isUserInputRequired = true }) {
    const data = await this.request('/channel_points/custom_rewards', {
      method: 'POST',
      query: { broadcaster_id: broadcasterId },
      body: {
        title,
        cost,
        prompt,
        is_user_input_required: isUserInputRequired
      }
    });
    return data.data?.[0];
  }

  // Grant VIP to a user (needs channel:manage:vips on the broadcaster token). Returns
  // 204 with no body. Twitch errors (no free VIP slots, already VIP) surface as thrown.
  async addChannelVip({ broadcasterId, userId }) {
    return this.request('/channels/vips', {
      method: 'POST',
      query: { broadcaster_id: broadcasterId, user_id: userId }
    });
  }

  // Batch user lookup by id (avatars for the team tab). Helix /users takes up to 100
  // ids per call; chunks as needed. Returns the raw user rows.
  async getUsersByIds(ids) {
    const unique = [...new Set((ids ?? []).filter(Boolean))];
    const users = [];
    for (let i = 0; i < unique.length; i += 100) {
      const chunk = unique.slice(i, i + 100);
      const params = chunk.map((id) => `id=${encodeURIComponent(id)}`).join('&');
      const data = await this.request(`/users?${params}`);
      users.push(...(data.data ?? []));
    }
    return users;
  }

  // Full moderator list (needs moderation:read or channel:manage:moderators on the
  // broadcaster token). Paginates until Twitch stops returning a cursor.
  async getModerators({ broadcasterId }) {
    return this.fetchAllPages('/moderation/moderators', { broadcaster_id: broadcasterId });
  }

  // Full VIP list (needs channel:read:vips or channel:manage:vips).
  async getVips({ broadcasterId }) {
    return this.fetchAllPages('/channels/vips', { broadcaster_id: broadcasterId });
  }

  // Revoke moderator status (needs channel:manage:moderators). 204 with no body.
  async removeModerator({ broadcasterId, userId }) {
    return this.request('/moderation/moderators', {
      method: 'DELETE',
      query: { broadcaster_id: broadcasterId, user_id: userId }
    });
  }

  // Revoke VIP status (needs channel:manage:vips). 204 with no body.
  async removeChannelVip({ broadcasterId, userId }) {
    return this.request('/channels/vips', {
      method: 'DELETE',
      query: { broadcaster_id: broadcasterId, user_id: userId }
    });
  }

  // Collect every page of a paginated Helix list endpoint into one array.
  async fetchAllPages(endpoint, query, { pageSize = 100, maxPages = 20 } = {}) {
    const items = [];
    let cursor = null;
    for (let page = 0; page < maxPages; page += 1) {
      const data = await this.request(endpoint, {
        query: { ...query, first: String(pageSize), ...(cursor ? { after: cursor } : {}) }
      });
      items.push(...(data.data ?? []));
      cursor = data.pagination?.cursor ?? null;
      if (!cursor) break;
    }
    return items;
  }

  async deleteChatMessage({ broadcasterId, moderatorId, messageId }) {
    return this.request('/moderation/chat', {
      method: 'DELETE',
      query: {
        broadcaster_id: broadcasterId,
        moderator_id: moderatorId,
        message_id: messageId
      }
    });
  }

  async banUser({ broadcasterId, moderatorId, userId, duration, reason }) {
    const data = await this.request('/moderation/bans', {
      method: 'POST',
      query: {
        broadcaster_id: broadcasterId,
        moderator_id: moderatorId
      },
      body: {
        data: {
          user_id: userId,
          duration,
          reason
        }
      }
    });

    return data.data?.[0];
  }

  async unbanUser({ broadcasterId, moderatorId, userId }) {
    return this.request('/moderation/bans', {
      method: 'DELETE',
      query: {
        broadcaster_id: broadcasterId,
        moderator_id: moderatorId,
        user_id: userId
      }
    });
  }

  async request(path, { method = 'GET', query, body } = {}) {
    const url = new URL(`${TWITCH_API_BASE_URL}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, value);
      }
    }

    const headers = {
      Authorization: `Bearer ${this.accessToken}`,
      'Client-Id': this.clientId
    };

    const requestOptions = {
      method,
      headers
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      requestOptions.body = JSON.stringify(body);
    }

    const response = await this.fetch(url, requestOptions);
    return parseTwitchResponse(response, `${method} ${path}`);
  }
}

async function parseTwitchResponse(response, operation) {
  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const detail =
      typeof data === 'object' && data !== null
        ? data.message || JSON.stringify(data)
        : data || response.statusText;
    throw new Error(`Twitch ${operation} failed: HTTP ${response.status} ${detail}`);
  }

  return data ?? {};
}
