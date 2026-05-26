// GET /api/hub/:visitId/snapshot — read-only section_state snapshot.

const express = require('express');
const { requireAuth } = require('../auth-middleware');
const { getSnapshot } = require('../hub-state');

const router = express.Router();

router.get('/:visitId/snapshot', requireAuth, async (req, res) => {
  try {
    const snapshot = await getSnapshot(req.params.visitId);
    return res.json(snapshot);
  } catch (err) {
    if (err.message === 'Invalid visitId') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[hub] snapshot failed:', err.message);
    return res.status(500).json({ error: 'Failed to load hub snapshot' });
  }
});

module.exports = router;
