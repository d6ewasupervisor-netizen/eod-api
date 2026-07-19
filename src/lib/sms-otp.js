'use strict';

/**
 * Twilio SMS one-time PIN helpers.
 * Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 * Optional: SMS_OTP_PEPPER (defaults to JWT_SECRET), SMS_OTP_TTL_MINUTES (default 10)
 */

const crypto = require('node:crypto');
const { query } = require('./db');

const PIN_LEN = 6;
const DEFAULT_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;

function twilioConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID
    && process.env.TWILIO_AUTH_TOKEN
    && process.env.TWILIO_FROM_NUMBER
  );
}

function pepper() {
  return process.env.SMS_OTP_PEPPER || process.env.JWT_SECRET || 'sms-otp-dev-pepper';
}

function ttlMs() {
  const m = Number(process.env.SMS_OTP_TTL_MINUTES || DEFAULT_TTL_MIN);
  return (Number.isFinite(m) && m > 0 ? m : DEFAULT_TTL_MIN) * 60 * 1000;
}

/** Normalize common US phone strings to E.164 +1… */
function toE164(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.trim().startsWith('+') && digits.length >= 10 && digits.length <= 15) {
    return `+${digits}`;
  }
  return null;
}

function maskPhone(e164) {
  if (!e164 || e164.length < 6) return '***';
  return `${e164.slice(0, 2)}***${e164.slice(-4)}`;
}

function generatePin() {
  // Cryptographically random 6-digit, never starting with 0 for readability
  const n = crypto.randomInt(100000, 1000000);
  return String(n);
}

function hashPin(email, pin) {
  return crypto
    .createHash('sha256')
    .update(`${String(email).toLowerCase()}|${pin}|${pepper()}`)
    .digest('hex');
}

async function lookupRosterPhone(email) {
  const em = String(email || '').trim().toLowerCase();
  const { rows } = await query(
    `SELECT phone FROM survey_roster WHERE lower(email) = $1 AND active = TRUE LIMIT 1`,
    [em]
  );
  if (rows[0]?.phone) {
    const e164 = toE164(rows[0].phone);
    if (e164) return e164;
  }
  // Fall back to employees table if present
  try {
    const emp = await query(
      `SELECT phone FROM employees WHERE lower(email) = $1 AND phone IS NOT NULL LIMIT 1`,
      [em]
    );
    if (emp.rows[0]?.phone) return toE164(emp.rows[0].phone);
  } catch (_) {
    /* employees may not exist in all envs */
  }
  return null;
}

async function sendTwilioSms({ to, body }) {
  if (!twilioConfigured()) {
    const err = new Error('SMS sign-in is not configured on the server (missing Twilio env).');
    err.code = 'TWILIO_NOT_CONFIGURED';
    throw err;
  }
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `Twilio SMS failed (${res.status})`);
    err.code = 'TWILIO_SEND_FAILED';
    err.twilio = data;
    throw err;
  }
  return data;
}

/**
 * Issue a new PIN for email, invalidate prior open challenges, send SMS.
 * @returns {{ maskedPhone: string, expiresInSeconds: number }}
 */
async function issueAndSendPin({ email, ip, userAgent }) {
  const em = String(email || '').trim().toLowerCase();
  const phone = await lookupRosterPhone(em);
  if (!phone) {
    const err = new Error(
      'No mobile number is on file for this email. Use the email sign-in link instead, or ask a supervisor to add your phone to the roster.'
    );
    err.code = 'NO_PHONE';
    throw err;
  }

  // Invalidate previous unused PINs for this email
  await query(
    `UPDATE sms_otp_challenges
        SET consumed_at = NOW()
      WHERE lower(email) = $1 AND consumed_at IS NULL`,
    [em]
  );

  const pin = generatePin();
  const pinHash = hashPin(em, pin);
  const expiresAt = new Date(Date.now() + ttlMs());

  await query(
    `INSERT INTO sms_otp_challenges (email, phone_e164, pin_hash, max_attempts, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [em, phone, pinHash, MAX_ATTEMPTS, expiresAt.toISOString(), ip || null, userAgent || null]
  );

  const minutes = Math.round(ttlMs() / 60000);
  await sendTwilioSms({
    to: phone,
    body: `Your Dump Bin sign-in code is ${pin}. It expires in ${minutes} minutes. Do not share this code.`,
  });

  return {
    maskedPhone: maskPhone(phone),
    expiresInSeconds: Math.round(ttlMs() / 1000),
  };
}

/**
 * Verify PIN; on success consume challenge and return email.
 */
async function verifyPin({ email, pin }) {
  const em = String(email || '').trim().toLowerCase();
  const code = String(pin || '').trim().replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) {
    const err = new Error('Enter the 6-digit code from your text message.');
    err.code = 'BAD_FORMAT';
    throw err;
  }

  const { pool } = require('./db');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, pin_hash, attempts, max_attempts, expires_at, consumed_at
         FROM sms_otp_challenges
        WHERE lower(email) = $1 AND consumed_at IS NULL
        ORDER BY issued_at DESC
        LIMIT 1
        FOR UPDATE`,
      [em]
    );

    if (!rows.length) {
      await client.query('ROLLBACK');
      const err = new Error('No active code for this email. Request a new text code.');
      err.code = 'NO_CHALLENGE';
      throw err;
    }

    const row = rows[0];
    if (row.consumed_at || new Date(row.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      const err = new Error('This code has expired. Request a new text code.');
      err.code = 'EXPIRED';
      throw err;
    }
    if (row.attempts >= row.max_attempts) {
      await client.query('ROLLBACK');
      const err = new Error('Too many incorrect attempts. Request a new text code.');
      err.code = 'LOCKED';
      throw err;
    }

    const expected = row.pin_hash;
    const actual = hashPin(em, code);
    const ok =
      expected.length === actual.length
      && crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(actual, 'utf8'));

    if (!ok) {
      await client.query(
        `UPDATE sms_otp_challenges SET attempts = attempts + 1 WHERE id = $1`,
        [row.id]
      );
      await client.query('COMMIT');
      const err = new Error('Incorrect code. Try again.');
      err.code = 'MISMATCH';
      throw err;
    }

    await client.query(
      `UPDATE sms_otp_challenges SET consumed_at = NOW(), attempts = attempts + 1 WHERE id = $1`,
      [row.id]
    );
    await client.query('COMMIT');
    return { email: em };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  twilioConfigured,
  toE164,
  maskPhone,
  issueAndSendPin,
  verifyPin,
  lookupRosterPhone,
};
