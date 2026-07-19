'use strict';
/**
 * Ensures mock/test identities in seed_roster.json:
 *  - tyson.a.gauthier@gmail.com → mock lead, District 8 (8B stores)
 *  - d6ewa.supervisor@gmail.com → supervisor for all District 8 stores
 *  - tyson.gauthier@retailodyssey.com → master admin (all D8 + global via KOMPASS admin)
 */
const fs = require('fs');
const path = require('path');

const seedPath = path.join(__dirname, '..', 'seed', 'seed_roster.json');
const r = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

const D8 = Object.entries(r.store_districts || {})
  .filter(([, d]) => String(d) === '8')
  .map(([s]) => Number(s))
  .filter((n) => Number.isFinite(n))
  .sort((a, b) => a - b);

// 8B lead stores (realistic mock lead scope)
const MOCK_LEAD_STORES = [23, 28, 31, 459].filter((s) => D8.includes(s));

function upsertPerson(row) {
  const email = row.email.toLowerCase();
  const idx = r.roster.findIndex((p) => String(p.email).toLowerCase() === email);
  if (idx >= 0) {
    r.roster[idx] = { ...r.roster[idx], ...row, email };
  } else {
    r.roster.push({ ...row, email });
  }
}

// Master admin — Tyson RO
upsertPerson({
  workday_id: '800175315',
  name: 'Tyson Gauthier A',
  email: 'tyson.gauthier@retailodyssey.com',
  phone: '(509) 572-7660',
  title: 'Supervisor Retail',
  role: 'supervisor',
  team: 'Division 701 · Master Admin',
  supervisor_email: null,
  district: '8',
  master_admin: true,
});
// Full D8 store access + supervisor of record on every D8 store
r.store_access['tyson.gauthier@retailodyssey.com'] = [...D8];
for (const store of D8) {
  const key = String(store);
  const list = new Set(r.store_supervisors[key] || r.store_supervisors[store] || []);
  list.add('tyson.gauthier@retailodyssey.com');
  r.store_supervisors[key] = [...list];
}

// D8 supervisor — d6ewa
upsertPerson({
  workday_id: 'mock-d6ewa-sup',
  name: 'D6/D8 Supervisor Desk',
  email: 'd6ewa.supervisor@gmail.com',
  phone: null,
  title: 'District Supervisor',
  role: 'supervisor',
  team: 'District 8',
  supervisor_email: null,
  district: '8',
});
r.store_access['d6ewa.supervisor@gmail.com'] = [...D8];
for (const store of D8) {
  const key = String(store);
  const list = new Set(r.store_supervisors[key] || []);
  list.add('d6ewa.supervisor@gmail.com');
  r.store_supervisors[key] = [...list];
}

// Mock lead — personal Gmail
upsertPerson({
  workday_id: 'mock-tyson-gmail-lead',
  name: 'Tyson Gauthier (Mock Lead)',
  email: 'tyson.a.gauthier@gmail.com',
  phone: '(509) 572-7660',
  title: 'Merchandiser Retail Team Lead',
  role: 'lead',
  team: 'Kompass 8B',
  supervisor_email: 'd6ewa.supervisor@gmail.com',
  district: '8',
});
r.store_access['tyson.a.gauthier@gmail.com'] = [...MOCK_LEAD_STORES];

// Sort roster for stability
r.roster.sort((a, b) => String(a.email).localeCompare(String(b.email)));

fs.writeFileSync(seedPath, JSON.stringify(r, null, 1) + '\n');
console.log('D8 stores', D8);
console.log('mock lead stores', MOCK_LEAD_STORES);
console.log('roster size', r.roster.length);
console.log('patched identities OK');
