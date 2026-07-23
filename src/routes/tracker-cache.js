'use strict';

const express = require('express');
const {
  getCache,
  putCache,
  listCaches,
  ensureRoot,
  trackerCacheRoot,
} = require('../lib/trackers/tracker-cache-store');

function checkSecret(req, res) {
  const secret = process.env.SAS_AUTH_SECRET || '';
  if (!secret) {
    res.status(503).json({ ok: false, error: 'SAS_AUTH_SECRET not configured' });
    return false;
  }
  const header = String(req.get('authorization') || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const alt = String(req.get('X-Auth-Secret') || '').trim();
  if (bearer !== secret && alt !== secret) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

function createTrackerCacheRouter() {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!checkSecret(req, res)) return;
    return next();
  });

  router.get('/', async (_req, res) => {
    try {
      ensureRoot();
      const listing = await listCaches();
      res.json({
        ...listing,
        root: trackerCacheRoot(),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  router.get('/:label/:kind', async (req, res) => {
    try {
      const result = await getCache(req.params.label, req.params.kind);
      res.json(result);
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message || String(err) });
    }
  });

  router.put('/:label/:kind', async (req, res) => {
    try {
      const replace = String(req.query.replace || '') === '1'
        || String(req.query.replace || '').toLowerCase() === 'true';
      const result = await putCache(req.params.label, req.params.kind, req.body || {}, { replace });
      res.json(result);
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message || String(err) });
    }
  });

  return router;
}

module.exports = {
  createTrackerCacheRouter,
};
