const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');
const { Pool } = require('pg');
const { requireAuth } = require('./auth-middleware');
const sasBridge = require('./sas-bridge');
const shiftManagement = require('./shift-management');

const logger = {
  info: (...a) => console.log('[INFO]', ...a),
  error: (...a) => console.error('[ERROR]', ...a),
};

const resend = new Resend(process.env.RESEND_API_KEY);
const PORT = process.env.PORT || 3001;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS store_data (
      store_number TEXT PRIMARY KEY,
      manager_names JSONB DEFAULT '[]',
      recipient_emails JSONB DEFAULT '[]'
    )
  `);
}

async function getStoreData(storeNumber) {
  const { rows } = await pool.query(
    'SELECT * FROM store_data WHERE store_number = $1',
    [storeNumber]
  );
  if (!rows.length) return { managerNames: [], recipientEmails: [] };
  return {
    managerNames: rows[0].manager_names ?? [],
    recipientEmails: rows[0].recipient_emails ?? [],
  };
}

async function upsertStoreData(storeNumber, { managerNames = [], recipientEmails = [] }) {
  const existing = await getStoreData(storeNumber);
  const mergedManagers = [...new Set([...existing.managerNames, ...managerNames])];
  const mergedEmails = [...new Set([...existing.recipientEmails, ...recipientEmails])];
  await pool.query(
    `INSERT INTO store_data (store_number, manager_names, recipient_emails)
     VALUES ($1, $2, $3)
     ON CONFLICT (store_number) DO UPDATE
       SET manager_names = $2,
           recipient_emails = $3`,
    [storeNumber, JSON.stringify(mergedManagers), JSON.stringify(mergedEmails)]
  );
  return { managerNames: mergedManagers, recipientEmails: mergedEmails };
}

function buildFromAddress(storeNumber) {
  return `EOD_FM${String(storeNumber).padStart(3, '0')}@retail-odyssey.com`;
}

function buildHtml({ body, signoffPhotos, userName, userEmail }) {
  const hasPhotos = Array.isArray(signoffPhotos) && signoffPhotos.length > 0;

  const photoSection = hasPhotos
    ? `<h3 style="font-family:sans-serif;">Sign-Off Sheets</h3>
${signoffPhotos
  .map(
    (_, i) =>
      `<img src="cid:signoff_${i}" style="max-width:100%; margin-bottom:12px; display:block;">`
  )
  .join('\n')}`
    : '';

  const signature =
    userName || userEmail
      ? `<hr>
<p style="font-size:13px; color:#555; font-family:sans-serif;">
  ${userName ?? ''}<br>
  Retail Odyssey<br>
  ${userEmail ?? ''}
</p>`
      : '';

  return `<!DOCTYPE html>
<html>
<body>
${photoSection}
<pre style="font-family:sans-serif; white-space:pre-wrap; word-break:break-word;">${body}</pre>
${signature}
</body>
</html>`;
}

async function start() {
  await initDb();
  logger.info('Database initialized');

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // ─── GLOBAL AUTH GATE ───────────────────────────────────────────────────────
  // Routes that bypass user auth (bot endpoints, email approval links, image serving)
  const PUBLIC_PATHS = [
    '/sas-session',
    '/sas-session/status',
  ];

  const PUBLIC_PREFIXES = [
    '/api/shift-request/',
    '/sas-shift-request/',
    '/api/signoff-photos/',
  ];

  app.use((req, res, next) => {
    if (PUBLIC_PATHS.includes(req.path)) return next();
    if (PUBLIC_PREFIXES.some(p => req.path.startsWith(p))) return next();
    return requireAuth(req, res, next);
  });

  // Initialize SAS bridge (session receiver, upload queue, worker)
  await sasBridge.init(app, pool);

  // Initialize shift management endpoints
  await shiftManagement.initShiftRequestsTable(pool);
  shiftManagement.registerRoutes(app, resend, pool);

  app.post('/send-eod', async (req, res) => {
    const {
      storeNumber,
      subject,
      body,
      recipients,
      pdfBase64,
      pdfFilename,
      userName,
      userEmail,
      signoffPhotos,
      checkInManager,
      checkOutManager,
    } = req.body;

    if (!storeNumber || !subject || !body || !recipients?.length) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: storeNumber, subject, body, recipients',
      });
    }

    const from = buildFromAddress(storeNumber);
    const attachments = [];

    if (pdfBase64) {
      attachments.push({
        filename: pdfFilename || `EOD_Store${storeNumber}.pdf`,
        content: pdfBase64,
      });
    }

    if (Array.isArray(signoffPhotos)) {
      signoffPhotos.forEach((photo, i) => {
        const match = photo.match(/^data:(image\/\w+);base64,/);
        const contentType = match ? match[1] : 'image/jpeg';
        const ext = contentType.split('/')[1] || 'jpg';
        const rawBase64 = photo.replace(/^data:image\/\w+;base64,/, '');
        attachments.push({
          filename: `signoff_${i}.${ext}`,
          content: rawBase64,
          contentId: `signoff_${i}`,
          content_type: contentType,
        });
      });
    }

    const html = buildHtml({ body, signoffPhotos, userName, userEmail });

    try {
      const { data, error } = await resend.emails.send({
        from,
        to: Array.isArray(recipients) ? recipients : [recipients],
        subject,
        html,
        attachments,
      });

      if (error) {
        logger.error({ error, storeNumber }, 'Resend API error sending EOD email');
        return res.status(502).json({ success: false, error: error.message ?? String(error) });
      }

      logger.info({ id: data?.id, storeNumber, from }, 'EOD email sent');

      logger.info('Attempting store data upsert for store:', storeNumber);
      try {
        await upsertStoreData(storeNumber, {
          managerNames: [checkInManager, checkOutManager].filter(Boolean),
          recipientEmails: recipients || []
        });
        logger.info('Store data upserted successfully for store:', storeNumber);
      } catch (err) {
        logger.error('Store data upsert failed:', err.message);
      }

      return res.json({ success: true, id: data?.id });
    } catch (err) {
      logger.error({ err, storeNumber }, 'Unexpected error sending EOD email');
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/store-data/:storeNumber', async (req, res) => {
    try {
      const data = await getStoreData(req.params.storeNumber);
      return res.json({ success: true, ...data });
    } catch (err) {
      logger.error({ err }, 'Error fetching store data');
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/store-data/:storeNumber', async (req, res) => {
    const { managerNames, recipientEmails } = req.body;
    try {
      const data = await upsertStoreData(req.params.storeNumber, {
        managerNames,
        recipientEmails,
      });
      return res.json({ success: true, ...data });
    } catch (err) {
      logger.error({ err }, 'Error upserting store data');
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  app.listen(PORT, () => {
    logger.info(`EOD API listening on port ${PORT}`);
  });
}

start().catch((err) => {
  logger.error({ err }, 'Failed to start EOD API');
  process.exit(1);
});