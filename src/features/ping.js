// Shared feature example: a trivial liveness command available to every channel.
// Use this as a template for new SHARED features (apply to all streamers).
export default {
  name: 'ping',
  scope: 'shared',
  description: 'Команда !пинг / !ping — проверка, что бот в чате.',
  register(ctx) {
    ctx.registerCommand(
      ['пинг', 'ping'],
      async ({ reply }) => {
        await reply('Понг! 🏓 Бот на связи.');
      },
      { cooldownSeconds: 5 }
    );
  }
};
