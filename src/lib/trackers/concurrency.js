'use strict';

function normalizeConcurrency(value, fallback, max = 10) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, parsed));
}

async function mapLimit(items, limit, mapper) {
  const list = Array.isArray(items) ? items : [];
  const concurrency = normalizeConcurrency(limit, 1, list.length || 1);
  const out = new Array(list.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const idx = next;
      next += 1;
      if (idx >= list.length) return;
      out[idx] = await mapper(list[idx], idx);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, list.length); i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return out;
}

module.exports = {
  mapLimit,
  normalizeConcurrency,
};
