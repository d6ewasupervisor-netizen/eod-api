// Checklane Hub state — snapshot reads, dirty tracking, and write transitions.

const { query } = require('./lib/db');
const { resolveRank, resolveHubUser } = require('./hub-auth');
const { resolveAisleLabel } = require('./hub-aisle-designation');
const { PRESET_CATALOG } = require('./lib/aisle-designations');
const { getChatSummary } = require('./hub-messages');
const { isHubAdmin } = require('./hub-store-access');

const STATE_KEYS = [
  'not_started',
  'assigned',
  'in_progress',
  'needs_attention',
  'done_pending_signoff',
  'signed_off',
  'not_in_store',
];

const ACTION_SUMMARIES = {
  help_request: 'Needs assistance',
  missing_tag: 'Missing tag',
  nis: 'Not in store',
};

/** @type {Set<number>} visit_ids with unsent hub changes */
const dirtyVisits = new Set();

function parseVisitId(visitId) {
  const visitIdNum = Number(visitId);
  if (!Number.isFinite(visitIdNum)) {
    throw new Error('Invalid visitId');
  }
  return visitIdNum;
}

function markVisitDirty(visitId) {
  dirtyVisits.add(parseVisitId(visitId));
}

function clearVisitDirty(visitId) {
  dirtyVisits.delete(parseVisitId(visitId));
}

function isVisitDirty(visitId) {
  return dirtyVisits.has(parseVisitId(visitId));
}

function getDirtyVisitIds() {
  return [...dirtyVisits];
}

/**
 * Central write path for hub mutations. Runs writeFn against Postgres; on
 * success marks the visit dirty so the 15-minute backup job will email a snapshot.
 * All assign/start/mark-done/sign-off writes should go through here.
 */
async function applyTransition(visitId, writeFn) {
  const visitIdNum = parseVisitId(visitId);
  const result = await writeFn(visitIdNum);
  markVisitDirty(visitIdNum);
  return result;
}

function emptyStats() {
  return {
    total: 0,
    notStarted: 0,
    assigned: 0,
    inProgress: 0,
    needsAttention: 0,
    donePendingSignoff: 0,
    signedOff: 0,
    notInStore: 0,
    openTagFlags: 0,
    draftTags: 0,
    verifiedUnsentTags: 0,
  };
}

function buildStats(sections) {
  const stats = emptyStats();
  stats.total = sections.length;

  for (const row of sections) {
    switch (row.state) {
      case 'not_started':
        stats.notStarted += 1;
        break;
      case 'assigned':
        stats.assigned += 1;
        break;
      case 'in_progress':
        stats.inProgress += 1;
        break;
      case 'needs_attention':
        stats.needsAttention += 1;
        break;
      case 'done_pending_signoff':
        stats.donePendingSignoff += 1;
        break;
      case 'signed_off':
        stats.signedOff += 1;
        break;
      case 'not_in_store':
        stats.notInStore += 1;
        break;
      default:
        break;
    }
  }

  return stats;
}

function laneSortValue(lane) {
  const n = Number(String(lane || '').replace(/[^\d]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY;
}

function buildLaneMap(sections, pendingActions) {
  const pendingByDbkey = new Map();
  for (const action of pendingActions || []) {
    if (!action?.dbkey) continue;
    pendingByDbkey.set(String(action.dbkey), (pendingByDbkey.get(String(action.dbkey)) || 0) + 1);
  }

  const byLane = new Map();
  for (const section of sections || []) {
    const laneKey = String(section.lane || '').trim() || 'Unlabeled lane';
    if (!byLane.has(laneKey)) {
      byLane.set(laneKey, {
        lane: laneKey,
        total: 0,
        terminal: 0,
        inProgress: 0,
        needsAttention: 0,
        pendingSignoff: 0,
        pendingExceptions: 0,
        assignees: new Set(),
      });
    }
    const lane = byLane.get(laneKey);
    lane.total += 1;
    if (section.assignee_name) lane.assignees.add(section.assignee_name);
    if (section.state === 'in_progress') lane.inProgress += 1;
    if (section.state === 'needs_attention') lane.needsAttention += 1;
    if (section.state === 'done_pending_signoff') lane.pendingSignoff += 1;
    if (section.state === 'signed_off' || section.state === 'not_in_store') lane.terminal += 1;
    lane.pendingExceptions += pendingByDbkey.get(String(section.dbkey || '')) || 0;
  }

  const lanes = Array.from(byLane.values())
    .map((lane) => ({
      lane: lane.lane,
      total: lane.total,
      terminal: lane.terminal,
      inProgress: lane.inProgress,
      needsAttention: lane.needsAttention,
      pendingSignoff: lane.pendingSignoff,
      pendingExceptions: lane.pendingExceptions,
      progressPct: lane.total ? Math.round((lane.terminal / lane.total) * 100) : 0,
      assignees: Array.from(lane.assignees).sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => {
      const na = laneSortValue(a.lane);
      const nb = laneSortValue(b.lane);
      if (na !== nb) return na - nb;
      return a.lane.localeCompare(b.lane);
    });

  return {
    lanes,
    totals: {
      lanes: lanes.length,
      sections: lanes.reduce((sum, lane) => sum + lane.total, 0),
      terminal: lanes.reduce((sum, lane) => sum + lane.terminal, 0),
      pendingSignoff: lanes.reduce((sum, lane) => sum + lane.pendingSignoff, 0),
      pendingExceptions: lanes.reduce((sum, lane) => sum + lane.pendingExceptions, 0),
    },
  };
}

function buildTeamAwareness(sections) {
  const occupancy = [];
  const byUser = new Map();

  for (const section of sections || []) {
    if (!section?.assignee_id || !section.assignee_name) continue;
    if (section.state !== 'assigned' && section.state !== 'in_progress' && section.state !== 'needs_attention') continue;
    const existing = byUser.get(section.assignee_id) || {
      assigneeId: section.assignee_id,
      assigneeName: section.assignee_name,
      lanes: new Set(),
      activeCount: 0,
      blockedCount: 0,
    };
    existing.lanes.add(String(section.lane || '').trim() || 'Unlabeled');
    existing.activeCount += 1;
    if (section.state === 'needs_attention') existing.blockedCount += 1;
    byUser.set(section.assignee_id, existing);
  }

  for (const value of byUser.values()) {
    occupancy.push({
      assigneeId: value.assigneeId,
      assigneeName: value.assigneeName,
      lanes: Array.from(value.lanes).sort((a, b) => a.localeCompare(b)),
      activeCount: value.activeCount,
      blockedCount: value.blockedCount,
    });
  }

  occupancy.sort((a, b) => {
    if (b.blockedCount !== a.blockedCount) return b.blockedCount - a.blockedCount;
    if (b.activeCount !== a.activeCount) return b.activeCount - a.activeCount;
    return a.assigneeName.localeCompare(b.assigneeName);
  });

  return {
    occupancy,
    totals: {
      activePeople: occupancy.length,
      blockedPeople: occupancy.filter((p) => p.blockedCount > 0).length,
    },
  };
}

function buildExceptionQueue(sections, pendingActions) {
  const needsAttention = (sections || [])
    .filter((section) => section?.state === 'needs_attention')
    .map((section) => ({
      id: `section:${section.lane || ''}:${section.dbkey}`,
      type: 'section_state',
      severity: 'high',
      lane: section.lane || '',
      dbkey: section.dbkey,
      summary: 'Section requires attention',
      raisedBy: section.assignee_name || null,
      raisedAt: section.updated_at || null,
      blockingCloseout: true,
    }));

  const pending = (pendingActions || []).map((action) => ({
    id: `pending:${action.id}`,
    type: action.action_type || 'pending',
    severity: action.action_type === 'nis' ? 'high' : 'medium',
    lane: action.lane || '',
    dbkey: action.dbkey,
    summary: action.summary || ACTION_SUMMARIES[action.action_type] || action.action_type || 'Pending action',
    raisedBy: action.raised_by_name || null,
    raisedAt: action.raised_at || null,
    blockingCloseout: true,
  }));

  const items = [...pending, ...needsAttention]
    .sort((a, b) => {
      const ta = a.raisedAt ? new Date(a.raisedAt).getTime() : 0;
      const tb = b.raisedAt ? new Date(b.raisedAt).getTime() : 0;
      return tb - ta;
    });

  return {
    total: items.length,
    bySeverity: {
      high: items.filter((item) => item.severity === 'high').length,
      medium: items.filter((item) => item.severity === 'medium').length,
      low: items.filter((item) => item.severity === 'low').length,
    },
    items,
  };
}

function buildCloseoutChecklist({ sections, pendingActions, stats, photoCoverage }) {
  const totalSections = sections.length;
  const terminalSections = sections.filter((s) => s.state === 'signed_off' || s.state === 'not_in_store').length;
  const donePending = stats.donePendingSignoff || 0;
  const openAttention = stats.needsAttention || 0;
  const openPending = (pendingActions || []).length;
  const completedRequiringPhoto = sections.filter((s) => s.state === 'done_pending_signoff' || s.state === 'signed_off').length;
  const sectionsWithPhotos = photoCoverage?.sectionsWithPhotos || 0;

  const checklist = [
    {
      id: 'terminal-sections',
      label: 'All sections in a terminal state',
      ok: totalSections > 0 && terminalSections === totalSections,
      detail: `${terminalSections}/${totalSections} terminal`,
      blocking: true,
    },
    {
      id: 'pending-signoff',
      label: 'No sets waiting for sign-off',
      ok: donePending === 0,
      detail: donePending ? `${donePending} waiting` : 'Clear',
      blocking: true,
    },
    {
      id: 'exceptions-cleared',
      label: 'No unresolved help/NIS exceptions',
      ok: openPending === 0 && openAttention === 0,
      detail: (openPending || openAttention)
        ? `${openPending} pending + ${openAttention} needs attention`
        : 'Clear',
      blocking: true,
    },
    {
      id: 'bay-photos',
      label: 'Completed sets have bay photos',
      ok: completedRequiringPhoto === 0 || sectionsWithPhotos >= completedRequiringPhoto,
      detail: `${sectionsWithPhotos}/${completedRequiringPhoto} with photos`,
      blocking: false,
    },
  ];

  return {
    ready: checklist.every((item) => item.ok || !item.blocking),
    checklist,
  };
}

function buildNextActions({ myRank, myUserId, sections, pendingActions, closeoutChecklist, laneMap }) {
  const actions = [];
  const assignedToMe = (sections || []).filter((section) => Number(section.assignee_id) === Number(myUserId));

  if (myRank < 2) {
    const myInProgress = assignedToMe.find((section) => section.state === 'in_progress');
    const myAssigned = assignedToMe.find((section) => section.state === 'assigned');
    if (myInProgress) {
      actions.push({
        id: `resume:${myInProgress.dbkey}`,
        priority: 100,
        title: `Continue set ${myInProgress.dbkey}`,
        detail: `${myInProgress.lane || 'Unlabeled lane'} is in progress`,
        lane: myInProgress.lane || '',
        dbkey: myInProgress.dbkey,
        action: 'resume_section',
      });
    }
    if (myAssigned) {
      actions.push({
        id: `start:${myAssigned.dbkey}`,
        priority: 90,
        title: `Start set ${myAssigned.dbkey}`,
        detail: `${myAssigned.lane || 'Unlabeled lane'} is assigned to you`,
        lane: myAssigned.lane || '',
        dbkey: myAssigned.dbkey,
        action: 'start_section',
      });
    }
    if (!myInProgress && !myAssigned) {
      actions.push({
        id: 'wait-assignment',
        priority: 50,
        title: 'Ask lead for next assignment',
        detail: 'No active set is currently assigned to you',
        action: 'request_assignment',
      });
    }
  } else {
    const unassigned = (sections || []).filter((section) => section.state === 'not_started' && section.assignee_id == null);
    const donePending = (sections || []).filter((section) => section.state === 'done_pending_signoff');
    if (pendingActions.length) {
      actions.push({
        id: 'triage-pending',
        priority: 100,
        title: `Review ${pendingActions.length} pending exception${pendingActions.length === 1 ? '' : 's'}`,
        detail: 'Open the queue and verify or reject blocked sets',
        action: 'open_pending_queue',
      });
    }
    if (donePending.length) {
      actions.push({
        id: 'signoff-queue',
        priority: 95,
        title: `Sign off ${donePending.length} completed set${donePending.length === 1 ? '' : 's'}`,
        detail: 'Clear pending sign-offs to unblock closeout',
        action: 'open_pending_queue',
      });
    }
    if (unassigned.length) {
      const first = unassigned[0];
      actions.push({
        id: 'assign-work',
        priority: 90,
        title: `Assign ${unassigned.length} unowned set${unassigned.length === 1 ? '' : 's'}`,
        detail: `Start with ${first.dbkey} in ${first.lane || 'unlabeled lane'}`,
        lane: first.lane || '',
        dbkey: first.dbkey,
        action: 'open_assignments',
      });
    }
    if (closeoutChecklist?.ready) {
      actions.push({
        id: 'closeout-ready',
        priority: 85,
        title: 'Store is closeout-ready',
        detail: 'All blocking checklist items are clear',
        action: 'review_closeout',
      });
    }
  }

  const stalledLanes = laneMap?.lanes?.filter((lane) => lane.pendingExceptions > 0 || lane.needsAttention > 0) || [];
  if (stalledLanes.length) {
    const top = stalledLanes[0];
    actions.push({
      id: 'stalled-lane',
      priority: 70,
      title: `Lane ${top.lane} needs help`,
      detail: `${top.pendingExceptions} exception${top.pendingExceptions === 1 ? '' : 's'} · ${top.needsAttention} set${top.needsAttention === 1 ? '' : 's'} in attention`,
      lane: top.lane,
      action: 'open_lane_map',
    });
  }

  actions.sort((a, b) => b.priority - a.priority);
  return actions.slice(0, 6);
}

function summaryForPending(row) {
  const payload = row.payload || {};
  if (row.action_type === 'nis') {
    if (payload.summary && payload.summary !== 'Not in store') return payload.summary;
    if (payload.set_name) return 'Not in store · ' + payload.set_name;
  }
  if (payload.summary) return payload.summary;
  if (row.action_type === 'missing_tag' && payload.upc) {
    return `Missing tag: ${payload.upc}`;
  }
  return ACTION_SUMMARIES[row.action_type] || row.action_type;
}

async function getSnapshot(visitId, options = {}) {
  const visitIdNum = parseVisitId(visitId);
  const { user } = options;

  const [sectionResult, tagCountResult, draftTagResult, verifiedTagResult, pendingResult, photoCoverageResult] = await Promise.all([
    query(
      `SELECT ss.lane, ss.dbkey, ss.state, ss.assignee_id, ss.reset_id, ss.updated_at,
              ss.aisle_preset, ss.aisle_custom,
              hu.name AS assignee_name
       FROM section_state ss
       LEFT JOIN hub_users hu ON hu.id = ss.assignee_id
       WHERE ss.visit_id = $1
       ORDER BY ss.lane, ss.dbkey`,
      [visitIdNum],
    ),
    query(
      `SELECT COUNT(*)::int AS cnt
       FROM tag_flags
       WHERE visit_id = $1 AND status = 'flagged'`,
      [visitIdNum],
    ),
    query(
      `SELECT COUNT(*)::int AS cnt
       FROM tag_flags
       WHERE visit_id = $1 AND status = 'draft'`,
      [visitIdNum],
    ),
    query(
      `SELECT COUNT(*)::int AS cnt
       FROM tag_flags
       WHERE visit_id = $1 AND status = 'verified'`,
      [visitIdNum],
    ),
    query(
      `SELECT pa.id, pa.action_type, pa.dbkey, pa.lane, pa.payload, pa.raised_at, pa.status,
              hu.name AS raised_by_name
       FROM pending_actions pa
       JOIN hub_users hu ON hu.id = pa.raised_by
       WHERE pa.visit_id = $1 AND pa.status = 'pending'
         AND pa.action_type <> 'missing_tag'
       ORDER BY pa.raised_at ASC`,
      [visitIdNum],
    ),
    query(
      `SELECT COUNT(*)::int AS photo_count,
              COUNT(DISTINCT CONCAT(lane, '|', dbkey))::int AS section_count
       FROM section_bay_photos
       WHERE visit_id = $1`,
      [visitIdNum],
    ),
  ]);

  const sections = sectionResult.rows.map((row) => ({
    lane: row.lane || '',
    dbkey: row.dbkey,
    state: STATE_KEYS.includes(row.state) ? row.state : 'not_started',
    assignee_id: row.assignee_id,
    assignee_name: row.assignee_name || null,
    reset_id: row.reset_id != null ? Number(row.reset_id) : null,
    updated_at: row.updated_at ? row.updated_at.toISOString() : null,
    aisle_preset: row.aisle_preset || null,
    aisle_custom: row.aisle_custom || null,
    aisle_label: resolveAisleLabel(row.aisle_preset, row.aisle_custom),
  }));

  const stats = buildStats(sections);
  stats.openTagFlags = tagCountResult.rows[0]?.cnt ?? 0;
  stats.draftTags = draftTagResult.rows[0]?.cnt ?? 0;
  // Pending in the aisle tag batch = flagged (rep/sweep) + any legacy verified rows.
  stats.pendingTags = (tagCountResult.rows[0]?.cnt ?? 0) + (verifiedTagResult.rows[0]?.cnt ?? 0);
  stats.verifiedUnsentTags = stats.pendingTags;

  const pendingActions = pendingResult.rows.map((row) => ({
    id: row.id,
    action_type: row.action_type,
    dbkey: row.dbkey,
    lane: row.lane || '',
    sectionName: row.dbkey,
    raised_by_name: row.raised_by_name,
    raised_at: row.raised_at ? row.raised_at.toISOString() : null,
    summary: summaryForPending(row),
    status: row.status,
  }));

  const photoCoverage = {
    totalPhotos: photoCoverageResult.rows[0]?.photo_count ?? 0,
    sectionsWithPhotos: photoCoverageResult.rows[0]?.section_count ?? 0,
  };

  const laneMap = buildLaneMap(sections, pendingActions);
  const teamAwareness = buildTeamAwareness(sections);
  const exceptionQueue = buildExceptionQueue(sections, pendingActions);
  const closeoutChecklist = buildCloseoutChecklist({
    sections,
    pendingActions,
    stats,
    photoCoverage,
  });

  let myRank = 1;
  let myUserId = null;
  let chatSummary = { unreadTotal: 0, threadCount: 0 };
  let myTagSweepAisleKeys = [];
  let isHubAdminUser = false;
  let isProdDispatchApproverUser = false;
  let prodDispatchInbox = [];
  if (user) {
    myRank = await resolveRank(user, visitIdNum);
    const hubUser = await resolveHubUser(user);
    myUserId = hubUser.id;
    chatSummary = await getChatSummary(visitIdNum, myUserId, myRank);
    // Lazy require avoids a hub-state <-> hub-tag-sweep require cycle.
    const { userAssignedAisleKeys } = require('./hub-tag-sweep');
    myTagSweepAisleKeys = await userAssignedAisleKeys(visitIdNum, myUserId);
    isHubAdminUser = await isHubAdmin(user, hubUser);
    try {
      const { isProdDispatchEnabled, isProdDispatchApprover, listPendingForApprover } = require('./hub-prod-dispatch');
      isProdDispatchApproverUser = isProdDispatchApprover(user.email);
      if (isProdDispatchEnabled() && isProdDispatchApproverUser) {
        prodDispatchInbox = await listPendingForApprover(user.email);
      }
    } catch (err) {
      console.error('[hub-state] prod dispatch inbox failed:', err.message);
    }
  }

  const nextActions = buildNextActions({
    myRank,
    myUserId,
    sections,
    pendingActions,
    closeoutChecklist,
    laneMap,
  });

  return {
    visitId: visitIdNum,
    generatedAt: new Date().toISOString(),
    sections,
    stats,
    myRank,
    myUserId,
    isHubAdmin: isHubAdminUser,
    isProdDispatchApprover: isProdDispatchApproverUser,
    prodDispatchInbox,
    pendingActions,
    exceptionQueue,
    aislePresets: PRESET_CATALOG,
    chatSummary,
    myTagSweepAisleKeys,
    laneMap,
    nextActions,
    closeoutChecklist,
    teamAwareness,
    photoCoverage,
  };
}

module.exports = {
  getSnapshot,
  applyTransition,
  markVisitDirty,
  clearVisitDirty,
  isVisitDirty,
  getDirtyVisitIds,
  STATE_KEYS,
  ACTION_SUMMARIES,
};
