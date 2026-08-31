// Optional feature example: enabled per channel through local configuration.
// Use this as a template for OPTIONAL features (custom code for specific streamers).
export default {
  name: 'dice',
  scope: 'optional',
  description: 'Команда !кубик / !dice — бросок шестигранника.',
  register(ctx) {
    ctx.registerCommand(
      ['кубик', 'dice', 'roll'],
      async ({ chatMessage, reply }) => {
        const value = 1 + Math.floor(ctx.random() * 6);
        await reply(`${chatMessage.name} выбросил 🎲 ${value}`);
      },
      { cooldownSeconds: 3 }
    );
  }
};
