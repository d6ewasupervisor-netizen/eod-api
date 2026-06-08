'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildReconciliationKey,
  classifyReconciliation,
  normalizePeriodWeek,
} = require('../src/lib/trackers/sheet-reconciliation');
const {
  DEFAULT_NOT_IN_STORE_PATTERNS,
  isBacklogException,
  matchNotInStore,
} = require('../src/lib/trackers/not-in-store-patterns');

function tracker(overrides = {}) {
  return {
    store: '19',
    periodWeek: 'P05W2',
    categoryId: '201',
    dbkey: '9009204',
    setType: 'Blitz',
    K: '',
    L: '',
    ...overrides,
  };
}

function prod(overrides = {}) {
  return {
    source: 'prod',
    storeNumber: '19',
    planogramId: 'P05W2_9009204_D701_L00000_D03_C201_V340_I024_MX',
    categoryId: '201',
    dbkey: '9009204',
    categoryCompletionStatus: 'done',
    categoryExceptionReason: '',
    comment: '',
    afterPhotoRequired: true,
    afterPictureUrls: ['https://example.test/after.jpg'],
    ...overrides,
  };
}

function si(overrides = {}) {
  return {
    source: 'si',
    storeNumber: '19',
    raw: { title: 'P05W2-2026 9009204 201-CANDY - CHECKLANE 417 Reset' },
    categoryId: '201',
    dbkey: '9009204',
    status: 'completed',
    ...overrides,
  };
}

function byKey(result) {
  return new Map(result.proposals.map((proposal) => [proposal.key, proposal]));
}

test('pattern helpers normalize backlog and not-in-store phrases safely', () => {
  assert.equal(isBacklogException(' Backlog - Revisit Needed '), true);
  assert.equal(isBacklogException('Backlog – Revisit'), true);
  assert.equal(matchNotInStore('not in store'), 'confirmed');
  assert.equal(matchNotInStore('store does not have'), 'confirmed');
  assert.equal(matchNotInStore('Do Not Have In Store'), 'confirmed');
  assert.equal(matchNotInStore(' do not have rack '), 'confirmed');
  assert.equal(matchNotInStore(" store doesn't have "), 'confirmed');
  assert.equal(matchNotInStore('not inn store'), 'confirmed');
  assert.equal(matchNotInStore("store doesn't carry it"), 'candidate');
  assert.equal(matchNotInStore('stre dosnt hav it'), 'candidate');
  assert.equal(matchNotInStore('not in SI'), 'none');
});

test('approved not-in-store seed list includes Tyson review phrases', () => {
  assert.deepEqual(DEFAULT_NOT_IN_STORE_PATTERNS, [
    'not in store',
    'store does not have',
    'do not have in store',
    'do not have rack',
    "store doesn't have",
    'not inn store',
  ]);
});

test('period normalization isolates blank period and normalizes P#W#', () => {
  assert.equal(normalizePeriodWeek('P05W2'), 'P05W2');
  assert.equal(normalizePeriodWeek('p5w2'), 'P05W2');
  assert.equal(normalizePeriodWeek('P05W2_9009204_D701_L00000_D03_C201_V340_I024_MX'), 'P05W2');
  assert.equal(normalizePeriodWeek(''), '');
  assert.equal(buildReconciliationKey({ store: '19', categoryId: '201', dbkey: '9009204' }), '|19|201|9009204');
});

test('period parsing falls through non-period planogram labels to SI task title', () => {
  const key = buildReconciliationKey({
    storeNumber: '19',
    categoryId: '201',
    dbkey: '9009204',
    planogramId: '201-CANDY - CHECKLANE 340',
    raw: { title: 'P05W2-2026 9009204 201-CANDY - CHECKLANE 340 Reset' },
  });
  assert.equal(key, 'P05W2|19|201|9009204');
});

test('backlog wins even with whitespace and not-in-store comment', () => {
  const result = classifyReconciliation({
    trackerRows: [tracker()],
    prodRows: [prod({
      categoryCompletionStatus: 'not_done',
      categoryExceptionReason: ' Backlog - Revisit Needed  ',
      comment: 'not in store',
    })],
    siRows: [],
  });
  const proposal = result.proposals[0];
  assert.equal(proposal.bucket, 'leave_alone_backlog');
  assert.equal(proposal.proposed, null);
  assert.equal(result.byBucket.leave_alone_backlog, 1);
});

test('not-in-SI claim absent in SI becomes confirmed_not_in_si write proposal', () => {
  const result = classifyReconciliation({
    trackerRows: [tracker()],
    prodRows: [prod({ categoryCompletionStatus: 'not_done', comment: 'not in SI' })],
    siRows: [],
  });
  const proposal = result.proposals[0];
  assert.equal(proposal.bucket, 'confirmed_not_in_si');
  assert.deepEqual(proposal.proposed, { K: 'Yes', L: 'confirmed not in SI' });
});

test('not-in-SI claim present in SI is visibly reclassified by live SI state', () => {
  const result = classifyReconciliation({
    trackerRows: [tracker()],
    prodRows: [prod({ categoryCompletionStatus: 'not_done', comment: 'not in SI' })],
    siRows: [si({ status: 'incomplete' })],
  });
  const proposal = result.proposals[0];
  assert.equal(proposal.bucket, 'judgment_call');
  assert.equal(proposal.proposed, null);
  assert.match(proposal.reason, /PROD comment says not in SI/);
  assert.match(proposal.reason, /matching incomplete task/);
});

test('not-in-SI claim present and complete in SI becomes mirror_si_to_prod with visible reason', () => {
  const result = classifyReconciliation({
    trackerRows: [tracker()],
    prodRows: [prod({ categoryCompletionStatus: 'not_done', comment: 'not in SI' })],
    siRows: [si({ status: 'completed' })],
  });
  const proposal = result.proposals[0];
  assert.equal(proposal.bucket, 'mirror_si_to_prod');
  assert.equal(proposal.proposed, null);
  assert.match(proposal.reason, /matching completed task/);
});

test('not-in-store confirmed phrase proposes K/L write and preserves comment verbatim', () => {
  const result = classifyReconciliation({
    trackerRows: [tracker({ K: 'No', L: 'old note' })],
    prodRows: [prod({
      categoryCompletionStatus: 'not_done',
      categoryExceptionReason: 'Not an Executable KOMPASS event',
      comment: 'not in store',
    })],
    siRows: [],
  });
  const proposal = result.proposals[0];
  assert.equal(proposal.bucket, 'not_in_store_closeout');
  assert.deepEqual(proposal.current, { K: 'No', L: 'old note' });
  assert.deepEqual(proposal.proposed, { K: 'Yes', L: 'not in store' });
});

test('not-in-store candidate surfaces without proposed write', () => {
  const result = classifyReconciliation({
    trackerRows: [tracker()],
    prodRows: [prod({ categoryCompletionStatus: 'not_done', comment: "store doesn't carry it" })],
    siRows: [],
  });
  const proposal = result.proposals[0];
  assert.equal(proposal.bucket, 'not_in_store_candidate');
  assert.equal(proposal.proposed, null);
  assert.equal(proposal.candidatePhrase, "store doesn't carry it");
  assert.deepEqual(result.pendingPatternCandidates, [{
    key: 'P05W2|19|201|9009204',
    phrase: "store doesn't carry it",
  }]);
});

test('Not an Executable KOMPASS event without qualifying comment is judgment_call', () => {
  const result = classifyReconciliation({
    trackerRows: [tracker({ dbkey: '8885976' })],
    prodRows: [prod({
      dbkey: '8885976',
      categoryCompletionStatus: 'not_done',
      categoryExceptionReason: 'Not an Executable KOMPASS event',
      comment: '',
    })],
    siRows: [],
  });
  const proposal = result.proposals[0];
  assert.equal(proposal.key, 'P05W2|19|201|8885976');
  assert.equal(proposal.bucket, 'judgment_call');
  assert.equal(proposal.proposed, null);
});

test('unknown blank completion is explicit judgment_call', () => {
  const result = classifyReconciliation({
    trackerRows: [tracker()],
    prodRows: [prod({ categoryCompletionStatus: 'unknown' })],
    siRows: [],
  });
  const proposal = result.proposals[0];
  assert.equal(proposal.bucket, 'judgment_call');
  assert.match(proposal.reason, /blank\/unknown/);
});

test('matched_both is the only normal compare bucket with a write proposal', () => {
  const result = classifyReconciliation({
    trackerRows: [tracker({ K: '', L: 'needs checking' })],
    prodRows: [prod({ categoryCompletionStatus: 'done' })],
    siRows: [si({ status: 'completed' })],
  });
  const proposal = result.proposals[0];
  assert.equal(proposal.bucket, 'matched_both');
  assert.deepEqual(proposal.proposed, { K: 'Yes', L: '' });
});

test('mirror buckets are proposal-only and never write', () => {
  const result = classifyReconciliation({
    trackerRows: [
      tracker({ dbkey: '1111111' }),
      tracker({ dbkey: '2222222' }),
    ],
    prodRows: [
      prod({ dbkey: '1111111', categoryCompletionStatus: 'done' }),
      prod({ dbkey: '2222222', categoryCompletionStatus: 'not_done' }),
    ],
    siRows: [
      si({ dbkey: '1111111', status: 'created' }),
      si({ dbkey: '2222222', status: 'completed' }),
    ],
  });
  const proposals = byKey(result);
  assert.equal(proposals.get('P05W2|19|201|1111111').bucket, 'mirror_prod_to_si');
  assert.equal(proposals.get('P05W2|19|201|1111111').proposed, null);
  assert.equal(proposals.get('P05W2|19|201|2222222').bucket, 'mirror_si_to_prod');
  assert.equal(proposals.get('P05W2|19|201|2222222').proposed, null);
});

test('sub-100 category 082 joins tracker, PROD, and SI by normalized key', () => {
  const result = classifyReconciliation({
    trackerRows: [tracker({ categoryId: '082', dbkey: '8509659' })],
    prodRows: [prod({ categoryId: '82', dbkey: '8509659', categoryCompletionStatus: 'done' })],
    siRows: [si({ categoryId: '082', dbkey: '8509659', status: 'completed' })],
  });
  const proposal = result.proposals[0];
  assert.equal(buildReconciliationKey({ periodWeek: 'p5w2', store: '19', categoryId: '082', dbkey: '8509659' }), 'P05W2|19|82|8509659');
  assert.equal(proposal.key, 'P05W2|19|82|8509659');
  assert.equal(proposal.bucket, 'matched_both');
});

test('same store/category/dbkey from a different period does not match', () => {
  const result = classifyReconciliation({
    trackerRows: [tracker({ periodWeek: 'P04W4', dbkey: '8509659' })],
    prodRows: [prod({ periodWeek: 'P05W2', planogramId: 'P05W2_8509659_D701_L00000_D01_C082_V856_F002_MX', categoryId: '82', dbkey: '8509659', categoryCompletionStatus: 'done' })],
    siRows: [si({ raw: { title: 'P05W2-2026 8509659 082-SINGLE SERVE BEVERAGE 861 NII' }, categoryId: '082', dbkey: '8509659', status: 'completed' })],
  });
  assert.equal(result.byBucket.no_match, 2);
  assert.equal(result.byBucket.matched_both || 0, 0);
});

test('no_match distinguishes tracker-only and system-only rows', () => {
  const result = classifyReconciliation({
    trackerRows: [tracker({ dbkey: '1000001' })],
    prodRows: [prod({ dbkey: '2000002', categoryCompletionStatus: 'done' })],
    siRows: [si({ dbkey: '3000003', status: 'completed' })],
  });
  const proposals = byKey(result);
  assert.equal(proposals.get('P05W2|19|201|1000001').bucket, 'no_match');
  assert.match(proposals.get('P05W2|19|201|1000001').reason, /Tracker row has no matching PROD or SI row/);
  assert.equal(proposals.get('P05W2|19|201|2000002').bucket, 'no_match');
  assert.match(proposals.get('P05W2|19|201|2000002').reason, /PROD row has no matching tracker row/);
  assert.equal(proposals.get('P05W2|19|201|3000003').bucket, 'no_match');
  assert.match(proposals.get('P05W2|19|201|3000003').reason, /SI row has no matching tracker row/);
  assert.equal(result.byBucket.no_match, 3);
});

test('no-op suppression drops already satisfied write proposals and counts them', () => {
  const result = classifyReconciliation({
    trackerRows: [tracker({ K: 'Yes', L: '' })],
    prodRows: [prod({ categoryCompletionStatus: 'done' })],
    siRows: [si({ status: 'completed' })],
  });
  assert.equal(result.proposals.length, 0);
  assert.equal(result.alreadySatisfied, 1);
});

test('ignored keys suppress system-only no_match rows for already done tracker rows', () => {
  const ignoredKey = 'P05W2|19|201|9009204';
  const result = classifyReconciliation({
    trackerRows: [],
    prodRows: [prod({ categoryCompletionStatus: 'done' })],
    siRows: [si({ status: 'completed' })],
    ignoredKeys: [ignoredKey],
  });
  assert.equal(result.proposals.length, 0);
  assert.deepEqual(result.byBucket, {});
});

test('only safe buckets carry write proposals', () => {
  const result = classifyReconciliation({
    trackerRows: [
      tracker({ dbkey: '1000001' }),
      tracker({ dbkey: '1000002' }),
      tracker({ dbkey: '1000003' }),
      tracker({ dbkey: '1000004' }),
    ],
    prodRows: [
      prod({ dbkey: '1000001', categoryCompletionStatus: 'done' }),
      prod({ dbkey: '1000002', categoryCompletionStatus: 'not_done', comment: 'not in SI' }),
      prod({ dbkey: '1000003', categoryCompletionStatus: 'not_done', comment: 'not in store' }),
      prod({ dbkey: '1000004', categoryCompletionStatus: 'done' }),
    ],
    siRows: [
      si({ dbkey: '1000001', status: 'completed' }),
      si({ dbkey: '1000004', status: 'created' }),
    ],
  });
  const writeBuckets = result.proposals.filter((proposal) => proposal.proposed).map((proposal) => proposal.bucket).sort();
  assert.deepEqual(writeBuckets, ['confirmed_not_in_si', 'matched_both', 'not_in_store_closeout'].sort());
});
