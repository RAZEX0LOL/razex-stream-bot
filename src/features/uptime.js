// Optional feature example that calls the Twitch API: !аптайм / !uptime reports
// how long the stream has been live. Enable it in the channel's local configuration.
// Template for features that need ctx.api + ctx.broadcasterId.
export default {
  name: 'uptime',
  scope: 'optional',
  description: 'Команда !аптайм / !uptime — сколько уже идёт стрим.',
  register(ctx) {
    ctx.registerCommand(
      ['аптайм', 'uptime'],
      async ({ reply }) => {
        if (!ctx.api || !ctx.broadcasterId) {
          await reply('Не получается узнать аптайм.');
          return;
        }
        let stream = null;
        try {
          stream = await ctx.api.getStream(ctx.broadcasterId);
        } catch (error) {
          ctx.logger?.warn?.('uptime: getStream failed.', error);
        }
        if (!stream || !stream.started_at) {
          await reply('Стрим сейчас офлайн.');
          return;
        }
        await reply(`Стрим идёт уже ${formatUptime(Date.now() - new Date(stream.started_at).getTime())}.`);
      },
      { cooldownSeconds: 15 }
    );
  }
};

export function formatUptime(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    return `${hours} ч ${minutes} мин`;
  }
  return `${minutes} мин`;
}
