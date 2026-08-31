// Drives the periodic timers from a TimerStore: wakes every `checkSeconds`, and for
// each enabled timer whose interval elapsed AND which has seen enough new chat lines,
// sends its next message (round-robin through the timer's messages). Chat-line counting
// is fed from outside via noteMessage() so the runner stays independent of the chat
// transport (EventSub/IRC). Kept as a small testable class: tick() can be called
// directly with an injected clock instead of relying on the real interval.

export class TimerRunner {
  constructor({ store, sendMessage, checkSeconds = 15, logger, now = () => Date.now() }) {
    this.store = store;
    this.sendMessage = sendMessage;
    this.checkMs = Math.max(1, checkSeconds) * 1000;
    this.logger = logger;
    this.now = now;
    this.timer = null;
    this.lineCount = 0;
    // Per-timer runtime state keyed by timer id: { firedAt, linesAtFire, cursor }.
    this.state = new Map();
  }

  // Count a chat line toward every timer's "min lines since last fire" gate.
  noteMessage() {
    this.lineCount += 1;
  }

  start() {
    if (this.timer) {
      return;
    }
    // Seed firedAt = now so timers wait a full interval before their first post
    // instead of firing immediately on startup.
    for (const timer of this.store.list()) {
      this.state.set(timer.id, { firedAt: this.now(), linesAtFire: this.lineCount, cursor: 0 });
    }
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.logger?.warn?.('Timer tick failed.', error));
    }, this.checkMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // One scheduler pass: send every due timer's next message. Returns the messages it
  // sent (for tests). A timer is due when its interval elapsed and enough new chat
  // lines arrived since it last fired.
  async tick() {
    const sent = [];
    const nowMs = this.now();
    for (const timer of this.store.list()) {
      if (!timer.enabled || timer.messages.length === 0) {
        continue;
      }
      const state = this.state.get(timer.id) ?? { firedAt: 0, linesAtFire: 0, cursor: 0 };
      const elapsed = nowMs - state.firedAt >= timer.intervalSeconds * 1000;
      const enoughLines = this.lineCount - state.linesAtFire >= timer.minLines;
      if (!elapsed || !enoughLines) {
        this.state.set(timer.id, state);
        continue;
      }
      const message = timer.messages[state.cursor % timer.messages.length];
      try {
        await this.sendMessage(message);
        sent.push(message);
      } catch (error) {
        this.logger?.warn?.(`Timer "${timer.name}" failed to send.`, error);
      }
      this.state.set(timer.id, {
        firedAt: nowMs,
        linesAtFire: this.lineCount,
        cursor: (state.cursor + 1) % timer.messages.length
      });
    }
    return sent;
  }
}
