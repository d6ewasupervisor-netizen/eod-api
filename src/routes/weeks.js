// GET /api/weeks
//
// Fiscal dump-bin Kompass folder weeks from `src/lib/fiscal-calendar.js`,
// ascending by week start date. Frontend uses `.weeks[]` entries with
// `{ start, end, short, prefix }` (`prefix` is POSIX with trailing slash).

const path = require('path');
const express = require('express');
const { requireAuth } = require('../auth-middleware');
const { FISCAL_CALENDARS, getFolderInfo } = require('../lib/fiscal-calendar');

const router = express.Router();

router.get('/', requireAuth, (_req, res) => {
  try {
    const weeks = [];
    const fiscalYears = Object.keys(FISCAL_CALENDARS)
      .map((y) => parseInt(y, 10))
      .filter((y) => !Number.isNaN(y))
      .sort((a, b) => a - b);

    for (const fy of fiscalYears) {
      const calendar = FISCAL_CALENDARS[fy];
      const periodKeys = Object.keys(calendar.periods || {}).sort();
      for (const periodStr of periodKeys) {
        const periodData = calendar.periods[periodStr];
        if (!periodData || !periodData.weeks) continue;
        const periodNum = parseInt(periodStr, 10);
        if (Number.isNaN(periodNum)) continue;
        for (const weekStr of ['1', '2', '3', '4']) {
          const weekData = periodData.weeks[weekStr];
          if (!weekData) continue;
          const weekNum = parseInt(weekStr, 10);
          if (Number.isNaN(weekNum)) continue;
          const info = getFolderInfo(periodNum, weekNum, fy);
          let prefix = `${info.relativePath.split(path.sep).join('/')}/`;
          const dumpBinSeg = `${info.dumpBinPath}/`;
          if (prefix.startsWith(dumpBinSeg)) prefix = prefix.slice(dumpBinSeg.length);
          weeks.push({
            start: info.startDate,
            end: info.endDate,
            short: info.periodWeek,
            prefix,
          });
        }
      }
    }

    weeks.sort((a, b) => String(a.start).localeCompare(String(b.start)));
    return res.json({ weeks });
  } catch (err) {
    console.error('[weeks] error', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
