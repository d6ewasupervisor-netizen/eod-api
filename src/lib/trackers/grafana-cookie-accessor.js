'use strict';

// In-process seam between the live grafana-bridge instance (created during
// index.js boot) and same-process readers (e.g. server-side reconciliation).
// Boot calls setGrafanaBridge(instance) once. Readers call getGrafanaCookie().
//
// SCOPE: same-process only. The cookie value is a secret and is NEVER exposed
// over any HTTP endpoint. Out-of-process readers require a different seam.

let bridge = null;

function setGrafanaBridge(instance) {
  bridge = instance || null;
  return bridge;
}

function getGrafanaBridge() {
  return bridge;
}

// Sync. Returns the cached valid cookie, or null when the bridge is absent,
// disabled, or not yet seeded. NEVER returns a known-stale cookie — the bridge's
// own getGrafanaCookie() owns that guarantee. Callers MUST treat null as a hard
// not-ready/stale auth condition and fail noisily (503-style), not zero rows.
function getGrafanaCookie() {
  if (!bridge) return null;
  return bridge.getGrafanaCookie();
}

module.exports = {
  setGrafanaBridge,
  getGrafanaBridge,
  getGrafanaCookie,
};
