// GET /api/verify-token?token=...
//
// Single-use exchange: validates the link JWT, marks link_requests.used_at if
// still unused, and returns a long-lived (45-day default) session JWT plus the
// signed-in email. The browser stores `token` in localStorage.eodSession and
// uses it as `Authorization: Bearer <token>` for every subsequent API call.
//
// This is the key difference from district6's verify-token: D6 keeps the link
// alive across multiple page loads (you may revisit the same link before
// signing) and consumes it later in /api/submit. EOD has no separate "submit"
// step -- the link IS the sign-in -- so we mark it used here.

const express = require('express');
const { verifyLinkToken } = require('../lib/tokens');
const { issueSessionToken } = require('../lib/session-jwt');
const { pool } = require('../lib/db');

const router = express.Router();

router.get('/', async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) {
    return res.status(400).json({ ok: false, error: 'Missing token.' });
  }

  try {
    const payload = verifyLinkToken(token);
    const jti = payload.jti;
    const email = payload.email;

    // Mark used_at atomically; if rowCount===0 the link doesn't exist
    // (revoked) or was already used by a prior click.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT used_at FROM link_requests WHERE jti = $1 LIMIT 1 FOR UPDATE`,
        [jti],
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, error: 'Link not recognized. Request a new one.' });
      }
      if (rows[0].used_at) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, error: 'This link has already been used. Request a new one to sign in on this device.' });
      }
      await client.query('UPDATE link_requests SET used_at = NOW() WHERE jti = $1', [jti]);
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    const sessionToken = issueSessionToken(email);
    return res.json({ ok: true, email, token: sessionToken });
  } catch (err) {
    if (err && (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError')) {
      return res.status(400).json({ ok: false, error: 'This link is invalid or expired.' });
    }
    console.error('[verify-token] error', err);
    return res.status(500).json({ ok: false, error: 'Could not verify link.' });
  }
});

module.exports = router;
