'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildStoredPayload,
  payloadForResend,
  attachmentsToStored,
  attachmentsFromStored,
  attachmentsMetaList,
  mapResendEventToDelivery,
  resolveListSort,
  rowToDetail,
  contentDispositionHeader,
  sanitizeDownloadFilename,
  decodeStoredAttachmentContent,
  isViewableContentType,
  buildEmailEml,
  getEmailAttachment,
} = require('../src/lib/resend-outbox');

describe('resend-outbox payload roundtrip', () => {
  it('serializes buffer attachments to base64 and restores for resend', () => {
    const original = {
      from: 'Test <test@example.com>',
      to: ['a@example.com'],
      subject: 'Hello',
      html: '<p>Hi</p>',
      attachments: [{ filename: 'a.pdf', content: Buffer.from('pdf-bytes'), content_type: 'application/pdf' }],
    };
    const stored = buildStoredPayload(original);
    assert.equal(stored.attachments[0].content_base64, Buffer.from('pdf-bytes').toString('base64'));
    const restored = payloadForResend(stored);
    assert.equal(restored.attachments[0].filename, 'a.pdf');
    assert.equal(restored.attachments[0].content, stored.attachments[0].content_base64);
  });

  it('maps resend delivery events', () => {
    assert.equal(mapResendEventToDelivery('delivered'), 'delivered');
    assert.equal(mapResendEventToDelivery('bounced'), 'failed');
    assert.equal(mapResendEventToDelivery('sent'), 'sent');
  });

  it('attachment helpers filter invalid rows', () => {
    const stored = attachmentsToStored([
      { filename: 'x.txt', content: 'abc' },
      { filename: '', content: 'skip' },
    ]);
    assert.equal(stored.length, 1);
    const back = attachmentsFromStored(stored);
    assert.equal(back[0].filename, 'x.txt');
    assert.equal(back[0].content, 'abc');
  });

  it('preserves inline attachment contentId through outbox roundtrip', () => {
    const stored = attachmentsToStored([
      { filename: 'signoff_0.jpg', content: 'aW1hZ2U=', content_type: 'image/jpeg', contentId: 'signoff_0' },
    ]);
    assert.equal(stored[0].content_id, 'signoff_0');
    const restored = attachmentsFromStored(stored);
    assert.equal(restored[0].contentId, 'signoff_0');

    const payload = payloadForResend(buildStoredPayload({
      from: 'EOD <eod@example.com>',
      to: ['lead@example.com'],
      subject: 'Signoff',
      html: '<img src="cid:signoff_0">',
      attachments: [{ filename: 'signoff_0.jpg', content: 'aW1hZ2U=', content_type: 'image/jpeg', contentId: 'signoff_0' }],
    }));
    assert.equal(payload.attachments[0].contentId, 'signoff_0');
  });

  it('retentionDays defaults to 30', () => {
    const prev = process.env.EMAIL_OUTBOX_RETENTION_DAYS;
    delete process.env.EMAIL_OUTBOX_RETENTION_DAYS;
    const { retentionDays } = require('../src/lib/resend-outbox');
    assert.equal(retentionDays(), 30);
    if (prev) process.env.EMAIL_OUTBOX_RETENTION_DAYS = prev;
  });

  it('resolveListSort whitelists columns and defaults safely', () => {
    assert.deepEqual(resolveListSort('subject', 'asc'), {
      col: 'subject',
      dir: 'ASC',
      sortBy: 'subject',
    });
    assert.deepEqual(resolveListSort('bad-column', 'up'), {
      col: 'created_at',
      dir: 'DESC',
      sortBy: 'createdAt',
    });
  });
});

describe('resend-outbox download helpers', () => {
  it('attachmentsMetaList strips base64 and reports size/viewable', () => {
    const bytes = Buffer.from('hello-pdf');
    const meta = attachmentsMetaList([
      { filename: 'report.pdf', content_type: 'application/pdf', content_base64: bytes.toString('base64') },
      { filename: 'skip-me' },
    ]);
    assert.equal(meta.length, 2);
    assert.equal(meta[0].filename, 'report.pdf');
    assert.equal(meta[0].hasContent, true);
    assert.equal(meta[0].viewable, true);
    assert.equal(meta[0].sizeBytes, bytes.length);
    assert.equal(meta[0].content_base64, undefined);
    assert.equal(meta[1].hasContent, false);
  });

  it('rowToDetail does not expose attachment content or stored payload body', () => {
    const detail = rowToDetail({
      id: 42,
      source_system: 'eod-api',
      source_type: 'test',
      resend_id: 're_123',
      status: 'sent',
      delivery_status: 'delivered',
      from_address: 'from@example.com',
      to_addresses: ['to@example.com'],
      cc_addresses: [],
      bcc_addresses: [],
      subject: 'Hello',
      html_body: '<p>Hi</p>',
      text_body: 'Hi',
      attachments: [
        { filename: 'a.txt', content_type: 'text/plain', content_base64: Buffer.from('hi').toString('base64') },
      ],
      stored_payload: {
        from: 'from@example.com',
        to: ['to@example.com'],
        subject: 'Hello',
        html: '<p>Hi</p>',
        attachments: [
          { filename: 'a.txt', content_type: 'text/plain', content_base64: Buffer.from('hi').toString('base64') },
        ],
      },
      resend_allowed: true,
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    assert.equal(detail.id, 42);
    assert.equal(detail.attachments[0].filename, 'a.txt');
    assert.equal(detail.attachments[0].content_base64, undefined);
    assert.equal(detail.storedPayload, undefined);
    assert.equal(detail.hasStoredPayload, true);
    assert.equal(detail.canDownload, true);
  });

  it('contentDispositionHeader and sanitizeDownloadFilename are safe', () => {
    assert.equal(sanitizeDownloadFilename('a/b:c.pdf'), 'a_b_c.pdf');
    const header = contentDispositionHeader('Signoff 🎉.pdf', { inline: true });
    assert.match(header, /^inline;/);
    assert.match(header, /filename\*=UTF-8''Signoff%20/);
  });

  it('decodeStoredAttachmentContent and isViewableContentType work', () => {
    const buf = decodeStoredAttachmentContent({ content_base64: Buffer.from('abc').toString('base64') });
    assert.equal(buf.toString(), 'abc');
    assert.equal(isViewableContentType('image/png', 'x.bin'), true);
    assert.equal(isViewableContentType(null, 'photo.JPG'), true);
    assert.equal(isViewableContentType('application/zip', 'x.zip'), false);
  });

  it('buildEmailEml produces a multipart .eml with body and attachment', async () => {
    const pdfB64 = Buffer.from('%PDF-1.4 mock').toString('base64');
    const row = {
      id: 7,
      source_system: 'eod-api',
      source_type: 'signoff',
      resend_id: 're_abc',
      from_address: 'EOD <eod@example.com>',
      to_addresses: ['lead@example.com'],
      cc_addresses: [],
      bcc_addresses: [],
      reply_to: null,
      subject: 'Store 123 Signoff',
      html_body: '<p>Signoff attached</p>',
      text_body: 'Signoff attached',
      attachments: [
        { filename: 'signoff.pdf', content_type: 'application/pdf', content_base64: pdfB64 },
      ],
      stored_payload: {},
      metadata: {},
      created_at: '2026-07-01T12:00:00.000Z',
    };
    const pool = {
      query: async () => ({ rows: [row] }),
    };
    const eml = await buildEmailEml(pool, 7);
    assert.equal(eml.contentType, 'message/rfc822');
    assert.match(eml.filename, /\.eml$/);
    const text = eml.content.toString('utf8');
    assert.match(text, /Subject:\s*Store 123 Signoff/i);
    assert.match(text, /Content-Type:\s*multipart\//i);
    assert.match(text, /signoff\.pdf/);
    assert.match(text, /X-Email-Outbox-Id:\s*7/i);
  });

  it('getEmailAttachment returns decoded bytes for a valid index', async () => {
    const content = Buffer.from('photo-bytes');
    const pool = {
      query: async () => ({
        rows: [{
          id: 9,
          metadata: {},
          attachments: [
            { filename: 'bay.jpg', content_type: 'image/jpeg', content_base64: content.toString('base64') },
          ],
        }],
      }),
    };
    const att = await getEmailAttachment(pool, 9, 0);
    assert.equal(att.filename, 'bay.jpg');
    assert.equal(att.contentType, 'image/jpeg');
    assert.equal(att.viewable, true);
    assert.equal(att.content.equals(content), true);
  });

  it('getEmailAttachment rejects compacted emails', async () => {
    const pool = {
      query: async () => ({
        rows: [{
          id: 10,
          metadata: { compactedAt: new Date().toISOString() },
          attachments: [],
        }],
      }),
    };
    await assert.rejects(
      () => getEmailAttachment(pool, 10, 0),
      (err) => err.statusCode === 409,
    );
  });
});
