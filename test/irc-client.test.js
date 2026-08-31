import assert from 'node:assert/strict';
import test from 'node:test';
import { ircMessageToChatEvent, parseIrcMessage } from '../src/irc-client.js';

test('parses Twitch IRC PRIVMSG with tags', () => {
  const message = parseIrcMessage(
    '@badge-info=;badges=moderator/1;color=#1E90FF;display-name=Razex;id=msg-1;login=razex;user-id=42 :razex!razex@razex.tmi.twitch.tv PRIVMSG #channel :!топ'
  );
  const event = ircMessageToChatEvent(message);

  assert.equal(message.command, 'PRIVMSG');
  assert.equal(event.message_id, 'msg-1');
  assert.equal(event.chatter_user_id, '42');
  assert.equal(event.chatter_user_login, 'razex');
  assert.equal(event.message.text, '!топ');
  assert.deepEqual(event.badges, [{ set_id: 'moderator', id: '1' }]);
});

test('parses IRC PING', () => {
  const message = parseIrcMessage('PING :tmi.twitch.tv');

  assert.equal(message.command, 'PING');
  assert.equal(message.trailing, 'tmi.twitch.tv');
});
