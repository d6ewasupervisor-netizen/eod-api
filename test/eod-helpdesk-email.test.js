'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractPlanogramMeta } = require('../src/lib/helpdesk-email');
const {
  buildEodHelpdeskSubject,
  buildEodHelpdeskPlainText,
  resolveEodHelpdeskReportMeta,
} = require('../src/lib/eod-helpdesk-email');

test('extractPlanogramMeta parses vacuum set pog id', () => {
  const meta = extractPlanogramMeta('P06W3_8802771_D060_L00000_D03_C812_V866_F004_MX');
  assert.equal(meta.dbkey, '8802771');
  assert.equal(meta.categoryNumber, '812');
  assert.equal(meta.version, '866');
  assert.equal(meta.versionToken, 'V866');
  assert.equal(meta.footageToken, 'F004');
  assert.equal(meta.footageDisplay, '4');
  assert.equal(meta.footage, '4 ft');
});

test('extractPlanogramMeta handles VS version and F footage', () => {
  const meta = extractPlanogramMeta('P05W3_9023993_D701_L00653_D01_C055_VS02_F060_MX');
  assert.equal(meta.categoryNumber, '55');
  assert.equal(meta.version, 'S02');
  assert.equal(meta.versionToken, 'VS02');
  assert.equal(meta.footageToken, 'F060');
  assert.equal(meta.footageDisplay, '60');
});

test('buildEodHelpdeskSubject includes store, category, version, footage, report date', () => {
  const subject = buildEodHelpdeskSubject({
    storeNumber: '657',
    categoryNumber: '812',
    versionToken: 'V866',
    footageToken: 'F004',
    reportDate: '2026-07-07',
  });
  assert.equal(subject, 'FM657 C812 V866 F004 07/07/2026');
});

test('resolveEodHelpdeskReportMeta builds standardized body', () => {
  const meta = resolveEodHelpdeskReportMeta({
    storeNumber: '657',
    reportDate: '2026-07-07',
    issueTypeLabel: 'Set not in store',
    planogramId: 'P06W3_8802771_D060_L00000_D03_C812_V866_F004_MX',
    categoryName: 'VACUUMS/STEAMERS/CHEMICALS',
    userName: 'Jennifer Hilderbrand',
    userEmail: 'jennifer.hilderbrand@retailodyssey.com',
    photos: [],
  });

  const text = buildEodHelpdeskPlainText(meta);
  assert.match(text, /Hello, I would like to report the issue below:/);
  assert.match(text, /Date: 07\/07\/2026/);
  assert.match(text, /Issue type: Set not in store/);
  assert.match(text, /Store: FM657/);
  assert.match(text, /Category: 812 - VACUUMS\/STEAMERS\/CHEMICALS/);
  assert.match(text, /Version: 866/);
  assert.match(text, /Footage\/Doors: 4/);
  assert.match(text, /DBKey: 8802771/);
  assert.match(text, /Pictures: N\/A/);
});
