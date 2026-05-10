// AI chat bridge for the SAS extension side panel.
//
// The extension forwards the user's Cloudflare Access cookie
// (`CF_Authorization`) as the `Cf-Access-Jwt-Assertion` header, so requests
// land here already gated by the global `requireAuth` in index.js. We just
// proxy to Anthropic and shield the API key.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const DEFAULT_MAX_TOKENS = 1024;
// Hard ceiling regardless of what the client asks for. Protects against a
// runaway tool loop or buggy client burning the Anthropic bill.
const MAX_TOKENS_CEILING = Number(process.env.ANTHROPIC_MAX_TOKENS_CEILING) || 8192;

function createAiRouter({ logger = console } = {}) {
  const express = require('express');
  const router = express.Router();

  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      configured: Boolean(process.env.ANTHROPIC_API_KEY),
      model: DEFAULT_MODEL,
      email: req.user?.email || null,
    });
  });

  router.post('/chat', async (req, res) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    }

    const body = req.body || {};

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return res.status(400).json({ error: 'messages[] is required' });
    }
    if (body.stream) {
      return res.status(400).json({
        error: 'stream is not supported by this proxy yet',
      });
    }

    // Permissive passthrough — the proxy is the trust boundary (API key +
    // Cloudflare Access + email allowlist), so we forward whatever the
    // client sends to Anthropic. Two guards stay in place: clamp
    // max_tokens to MAX_TOKENS_CEILING, and strip `stream` defensively.
    const payload = { ...body };
    payload.model = payload.model || DEFAULT_MODEL;
    const requested = Number(payload.max_tokens) || DEFAULT_MAX_TOKENS;
    payload.max_tokens = Math.min(requested, MAX_TOKENS_CEILING);
    delete payload.stream;

    try {
      const upstream = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(payload),
      });

      const text = await upstream.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { raw: text }; }

      if (!upstream.ok) {
        logger.error?.('[ai/chat] upstream', upstream.status, body);
        return res.status(upstream.status).json({
          error: body?.error?.message || `Anthropic returned ${upstream.status}`,
          details: body,
        });
      }

      return res.json(body);
    } catch (err) {
      logger.error?.('[ai/chat] fetch threw:', err.message);
      return res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createAiRouter };
