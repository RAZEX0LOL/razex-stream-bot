import dice from './dice.js';
import ping from './ping.js';
import uptime from './uptime.js';

// Central feature registry. Each feature is a descriptor { name, scope, register(ctx) }.
// `scope: 'shared'` features load for every channel; `scope: 'optional'` features load
// only when that channel opts in through its local configuration.
// To add a feature: drop a module in src/features/ and add it here.
export const ALL_FEATURES = [ping, dice, uptime];

// Wire enabled features into a session via the provided context. Returns the names
// of the features that were actually applied. `enabled` is the channel's opt-in list.
export function applyFeatures(ctx, { enabled = [] } = {}) {
  const optIn = new Set((Array.isArray(enabled) ? enabled : []).map((name) => String(name).toLowerCase()));
  const applied = [];
  for (const feature of ALL_FEATURES) {
    if (feature.scope === 'shared' || optIn.has(feature.name.toLowerCase())) {
      feature.register(ctx);
      applied.push(feature.name);
    }
  }
  return applied;
}

// Catalog for a UI: which features exist and whether they are shared (always on) or
// optional (toggleable per channel).
export function listFeatures() {
  return ALL_FEATURES.map((feature) => ({
    name: feature.name,
    scope: feature.scope,
    description: feature.description ?? ''
  }));
}
