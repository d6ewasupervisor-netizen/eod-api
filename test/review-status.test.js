/**
 * Host status response builder tests (decision payload retention contract).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Inline mirror of buildStatusResponse in review-decision.js
function buildStatusResponse(session) {
  if (!session) return { notFound: true };
  if (session.status === 'pending') {
    if (new Date(session.expires_at) < new Date()) return { expired: true };
    return { status: 'pending' };
  }
  if (session.status === 'purged') return { purged: true };
  if (session.decision_payload) {
    return { decided: true, payload: session.decision_payload };
  }
  if (session.status === 'expired') return { expired: true };
  return { purged: true };
}

describe('eod-api review status responses', () => {
  it('returns decided while decision_payload is retained', () => {
    const body = buildStatusResponse({
      status: 'approved',
      decision_payload: { action: 'approve', sectionEdits: { 'section:test': 'edited' } },
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    assert.equal(body.decided, true);
    assert.equal(body.payload.sectionEdits['section:test'], 'edited');
  });

  it('returns purged after ack consumed payload', () => {
    const body = buildStatusResponse({
      status: 'approved',
      decision_payload: null,
      payload_acked_at: new Date().toISOString(),
    });
    assert.equal(body.purged, true);
  });

  it('returns expired for pending past session TTL', () => {
    const body = buildStatusResponse({
      status: 'pending',
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal(body.expired, true);
  });
});
