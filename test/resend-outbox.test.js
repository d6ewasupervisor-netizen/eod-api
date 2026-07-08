'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildStoredPayload,
  payloadForResend,
  attachmentsToStored,
  attachmentsFromStored,
  mapResendEventToDelivery,
  resolveListSort,
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
