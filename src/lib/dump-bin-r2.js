'use strict';

const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');

function notConfiguredError() {
  const err = new Error('Dump bin R2 is not configured');
  err.code = 'DUMP_BIN_NOT_CONFIGURED';
  return err;
}

function isConfigured() {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET
  );
}

function assertConfigured() {
  if (!isConfigured()) throw notConfiguredError();
}

function bucket() {
  return process.env.R2_BUCKET;
}

function endpointUrl() {
  const raw = process.env.R2_ENDPOINT;
  if (raw) return String(raw).replace(/\/+$/, '');
  const id = process.env.R2_ACCOUNT_ID;
  return id ? `https://${id}.r2.cloudflarestorage.com` : null;
}

let _client;

function getClient() {
  assertConfigured();
  if (!_client) {
    const endpoint = endpointUrl();
    if (!endpoint) {
      const err = new Error('R2 endpoint could not be determined (set R2_ACCOUNT_ID or R2_ENDPOINT)');
      err.code = 'DUMP_BIN_NOT_CONFIGURED';
      throw err;
    }
    _client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return _client;
}

async function listObjectsV2All({ Prefix, Delimiter }) {
  const client = getClient();
  const allCommonPrefixes = [];
  const allContents = [];
  let ContinuationToken;
  for (;;) {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix,
        Delimiter,
        ContinuationToken,
      })
    );
    if (resp.CommonPrefixes?.length) allCommonPrefixes.push(...resp.CommonPrefixes);
    if (resp.Contents?.length) allContents.push(...resp.Contents);
    if (!resp.IsTruncated) break;
    ContinuationToken = resp.NextContinuationToken;
    if (!ContinuationToken) break;
  }
  return { CommonPrefixes: allCommonPrefixes, Contents: allContents };
}

/**
 * @param {string} prefix
 * @returns {Promise<{ prefix: string, folders: Array<{ name: string, prefix: string }>, files: Array<{ name: string, key: string, size: number, uploaded: string }> }>}
 */
async function listByPrefix(prefix) {
  assertConfigured();
  const raw = String(prefix ?? '');
  const normalizedPrefix = raw && !raw.endsWith('/') ? `${raw}/` : raw;
  const { CommonPrefixes, Contents } = await listObjectsV2All({
    Prefix: normalizedPrefix,
    Delimiter: '/',
  });
  const folders = (CommonPrefixes || []).map((cp) => {
    const p = cp.Prefix;
    return {
      name: p.slice(normalizedPrefix.length).replace(/\/$/, ''),
      prefix: p,
    };
  });
  const files = (Contents || [])
    .map((obj) => {
      const rec = {
        name: obj.Key.slice(normalizedPrefix.length),
        key: obj.Key,
        size: obj.Size != null ? Number(obj.Size) : 0,
      };
      if (obj.LastModified) rec.uploaded = obj.LastModified.toISOString();
      return rec;
    })
    .filter((f) => f.name);
  return { prefix: normalizedPrefix, folders, files };
}

function throwIfNotFound(err) {
  const code = err.Code || err.code || err.name;
  const status = err.$metadata && err.$metadata.httpStatusCode;
  if (code === 'NoSuchKey' || status === 404) {
    const e = new Error('Not found');
    e.code = 'NOT_FOUND';
    e.status = 404;
    throw e;
  }
}

/**
 * @param {string} key
 * @returns {Promise<{ body: import('stream').Readable, contentType: string, contentLength: number|undefined, etag: string|undefined, filename: string }>}
 */
async function getObjectStream(key) {
  assertConfigured();
  const k = String(key || '').trim();
  const client = getClient();
  try {
    const out = await client.send(
      new GetObjectCommand({
        Bucket: bucket(),
        Key: k,
      })
    );
    const filename = k.split('/').pop() || k;
    let etag = out.ETag;
    if (typeof etag === 'string') etag = etag.replace(/"/g, '');
    return {
      body: out.Body,
      contentType: out.ContentType || 'application/octet-stream',
      contentLength: out.ContentLength,
      etag,
      filename,
    };
  } catch (err) {
    throwIfNotFound(err);
    throw err;
  }
}

async function bodyToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * @param {string} key
 * @returns {Promise<Buffer>}
 */
async function getObjectBuffer(key) {
  assertConfigured();
  const k = String(key || '').trim();
  const client = getClient();
  try {
    const out = await client.send(
      new GetObjectCommand({
        Bucket: bucket(),
        Key: k,
      })
    );
    return await bodyToBuffer(out.Body);
  } catch (err) {
    throwIfNotFound(err);
    throw err;
  }
}

/**
 * Mirrors the Cloudflare Worker `listKompassWeeks` against R2 via S3 ListObjectsV2.
 * @returns {Promise<{ weeks: Array<Record<string, unknown>> }>}
 */
async function listKompassWeeks() {
  assertConfigured();
  const weeks = [];
  const { CommonPrefixes: periodPrefixes } = await listObjectsV2All({
    Prefix: 'Kompass/',
    Delimiter: '/',
  });
  for (const cp of periodPrefixes || []) {
    const periodPrefix = cp.Prefix;
    const { CommonPrefixes: weekPrefixes } = await listObjectsV2All({
      Prefix: periodPrefix,
      Delimiter: '/',
    });
    for (const wk of weekPrefixes || []) {
      const weekPrefix = wk.Prefix;
      const weekName = weekPrefix.slice(periodPrefix.length).replace(/\/$/, '');
      const match = weekName.match(/P(\d+)W(\d+) - (\d+\.\d+\.\d+) to (\d+\.\d+\.\d+)/);
      if (match) {
        const [, period, week, startStr, endStr] = match;
        const [sm, sd, sy] = startStr.split('.').map(Number);
        const [em, ed, ey] = endStr.split('.').map(Number);
        weeks.push({
          label: weekName,
          period: `P${period}`,
          week: `W${week}`,
          short: `P${period}W${week}`,
          start: new Date(sy, sm - 1, sd).toISOString(),
          end: new Date(ey, em - 1, ed, 23, 59, 59).toISOString(),
          prefix: weekPrefix,
        });
      }
    }
  }
  weeks.sort((a, b) => new Date(a.start) - new Date(b.start));
  return { weeks };
}

module.exports = {
  isConfigured,
  listByPrefix,
  getObjectStream,
  getObjectBuffer,
  listKompassWeeks,
};
