'use strict';

// Live Grafana/Query-46 SI source for server-side reconciliation.
//
// Fetches Query 46 from the Grafana reporting layer over the wire, using the
// in-process Grafana cookie published by grafana-bridge via the accessor seam,
// then hands the PARSED response payload to normalizeQuery46Rows (the proven
// si-grafana-adapter, which owns all frame-unwrapping and the keystone
// Commodity-prefix category derivation).
//
// Request mechanics (body byte-shape, headers, 6h window, manual redirect,
// HTML/302/401/403 session detection) are lifted VERBATIM from the proven
// three-way-join proof so the live response matches the frozen fixture the
// adapter was proven against. Two deliberate lib-vs-proof changes:
//   - NEVER process.exit: every failure throws (a lib running inside eod-api
//     must not kill the service). Stale-cookie failures throw a typed
//     SiGrafanaSessionError so the ingest chooser can fail noisily and decide
//     fallback; all other failures throw a generic Error.
//   - Returns normalizeQuery46Rows(payload), not raw frame rows.
//
// The cookie SOURCE is the accessor (getGrafanaCookie), NOT the proof's .cookie
// file. A null cookie is a hard not-ready/stale condition and throws; it must
// never silently resolve to zero rows.

const { normalizeQuery46Rows } = require('./si-grafana-adapter');
const { getGrafanaCookie: accessorGetGrafanaCookie } = require('./grafana-cookie-accessor');

const DEFAULT_DS_QUERY_URL = 'https://krcs-reporting.rebotics.net/api/ds/query';
const DATASOURCE_UID = 'Drt7OkEGk';
const DATASOURCE_TYPE = 'grafana-postgresql-datasource';
const DEFAULT_FETCH_TIMEOUT_MS = parseInt(process.env.SI_GRAFANA_FETCH_TIMEOUT_MS || '180000', 10);
const QUERY_WINDOW_MS = 21600000; // 6h, lifted verbatim from the proof request body.

class SiGrafanaSessionError extends Error {
  constructor(message = 'Grafana session expired or invalid; recapture cookie.') {
    super(message);
    this.name = 'SiGrafanaSessionError';
    this.siGrafanaStale = true;
  }
}

function createGrafanaRequestBody(rawSql, nowMs = Date.now()) {
  return JSON.stringify({
    from: String(nowMs - QUERY_WINDOW_MS),
    to: String(nowMs),
    queries: [
      {
        refId: 'A',
        datasource: { type: DATASOURCE_TYPE, uid: DATASOURCE_UID },
        rawSql,
        format: 'table',
      },
    ],
  });
}

function isHtmlBody(contentType, text) {
  const lowerType = String(contentType || '').toLowerCase();
  const lowerText = String(text || '').slice(0, 1000).toLowerCase();
  return (
    lowerType.includes('text/html')
    || lowerText.includes('<!doctype html')
    || lowerText.includes('<html')
    || (lowerText.includes('grafana') && lowerText.includes('login'))
  );
}

function grafanaErrorMessage(error) {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    if (typeof error.message === 'string') return error.message;
    if (error.data && typeof error.data.message === 'string') return error.data.message;
  }
  return JSON.stringify(error);
}

async function defaultTransport(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Fetch + validate Query 46, returning the PARSED Grafana payload.
// Throws SiGrafanaSessionError on any stale/invalid-session signal; throws a
// generic Error on transport/HTTP/JSON/query errors. Never returns on failure,
// never returns an empty payload to paper over a bad session.
async function fetchQuery46Payload({
  rawSql,
  cookie,
  dsQueryUrl = DEFAULT_DS_QUERY_URL,
  transport = defaultTransport,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  if (!rawSql || !String(rawSql).trim()) {
    throw new Error('si-grafana-source: rawSql is required.');
  }
  if (!cookie) {
    throw new SiGrafanaSessionError('si-grafana-source: no Grafana cookie available (accessor returned null).');
  }

  const response = await transport(dsQueryUrl, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'x-datasource-uid': DATASOURCE_UID,
      'x-grafana-org-id': '1',
      'x-plugin-id': DATASOURCE_TYPE,
    },
    body: createGrafanaRequestBody(rawSql, now()),
  }, timeoutMs);

  const responseText = await response.text();
  const contentType = (response.headers && typeof response.headers.get === 'function')
    ? (response.headers.get('content-type') || '')
    : '';

  if (
    response.status === 302
    || response.status === 401
    || response.status === 403
    || isHtmlBody(contentType, responseText)
  ) {
    throw new SiGrafanaSessionError();
  }

  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch (error) {
    if (!response.ok) {
      throw new Error(`si-grafana-source: Grafana HTTP error ${response.status} ${response.statusText}`);
    }
    throw new Error(`si-grafana-source: Grafana response was not JSON: ${error.message}`);
  }

  if (!response.ok) {
    throw new Error(`si-grafana-source: Grafana HTTP error ${response.status} ${response.statusText}`);
  }

  const result = payload && payload.results && payload.results.A;
  if (Number(result && result.status) === 401) {
    throw new SiGrafanaSessionError();
  }
  if (result && result.error) {
    throw new Error(`si-grafana-source: Grafana query error: ${grafanaErrorMessage(result.error)}`);
  }

  return payload;
}

// Top-level SI fetch for the ingest chooser. Reads the cookie from the accessor
// (overridable for tests), fetches Query 46, and returns adapter-normalized,
// classify()-keyable SI rows. Propagates SiGrafanaSessionError / Error; the
// caller fails noisily and never substitutes zero rows.
async function fetchSiRowsViaGrafana({
  rawSql,
  getGrafanaCookie = accessorGetGrafanaCookie,
  dsQueryUrl = DEFAULT_DS_QUERY_URL,
  transport = defaultTransport,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  const cookie = getGrafanaCookie();
  const payload = await fetchQuery46Payload({
    rawSql,
    cookie,
    dsQueryUrl,
    transport,
    timeoutMs,
    now,
  });
  return normalizeQuery46Rows(payload);
}

module.exports = {
  SiGrafanaSessionError,
  createGrafanaRequestBody,
  fetchQuery46Payload,
  fetchSiRowsViaGrafana,
  DEFAULT_DS_QUERY_URL,
  DATASOURCE_UID,
  DATASOURCE_TYPE,
};
