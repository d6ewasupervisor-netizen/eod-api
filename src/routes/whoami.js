// GET /api/whoami
//
// Same JSON as GET /api/me (magic-link session or Cloudflare Access). Dump Bin
// and other callers use this path; `/api/me` remains the canonical probe for extensions.

const express = require('express');
const { requireAuth } = require('../auth-middleware');
const { identityHandler } = require('./_identity');

const router = express.Router();

router.get('/', requireAuth, identityHandler);

module.exports = router;
