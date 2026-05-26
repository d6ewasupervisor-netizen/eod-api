// Hub API — snapshot reads and manual backup trigger.

const express = require('express');
const { requireAuth } = require('../auth-middleware');
const { getSnapshot } = require('../hub-state');
const { sendBackup } = require('../hub-backup');

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

router.post('/:visitId/backup-now', requireAuth, async (req, res) => {
  try {
    const result = await sendBackup(req.params.visitId, 'interval', { sentBy: 0 });
    if (!result.sent) {
      return res.status(502).json({
        sent: false,
        error: result.error || 'Backup send failed',
        sequence: result.sequence,
      });
    }
    return res.json({ sent: true, sequence: result.sequence });
  } catch (err) {
    if (err.message === 'Invalid visitId') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[hub] backup-now failed:', err.message);
    return res.status(500).json({ error: 'Failed to send hub backup' });
  }
});

module.exports = router;
