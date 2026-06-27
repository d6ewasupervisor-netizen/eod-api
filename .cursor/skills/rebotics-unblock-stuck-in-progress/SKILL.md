---
name: rebotics-unblock-stuck-in-progress
description: Identifies and closes a Rebotics/Store Intelligence task that is stuck in_progress, blocking all other tasks for a store from being opened. Use when every task PUT for a store returns "You are already working on another task — finish the previous one first", or when a specific task is in_progress with scan_status=DONE but cannot be marked completed due to an unanswered survey.
disable-model-invocation: true
---

# Rebotics — Unblock Stuck in_progress Task

## Symptom

Every `PUT /api/v1/tasks/{taskId}/ { status: in_progress }` for a store returns HTTP 400:

```json
{ "non_field_errors": ["You are already working on another task — \"[TASK TITLE]\". To start a new one, finish the previous one."] }
```

The blocking task name is embedded in that error body — extract it to identify which task to close.

## Step 1 — Identify the blocking task

```js
try {
  await api.reboticsJson(token, 'PUT', `/api/v1/tasks/${anyTaskId}/`, { status: 'in_progress' });
} catch (err) {
  // err.body contains the blocking task title
  console.log(JSON.stringify(err.body));
  // e.g. "You are already working on another task - \"P05W1-2026 8848847 084-DRY NOODLES\""
}
```

Extract the DBKey from the task title (7–9 digit number), then find the task via backward SI search.

## Step 2 — Inspect the blocking task

```js
const task = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${blockingTaskId}/`);
console.log(task.status?.id);    // expect: in_progress
console.log(task.scan_status);   // expect: DONE (CV already processed)
const capture = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${blockingTaskId}/capture/retailer/?ordering=aisle&show_reports=true`);
// check: all sections have isDoneReport === true
```

## Step 3 — Clear pending actions

```js
const reports = captureSections(capture).map(s => s.report).filter(isDoneReport);
for (const report of reports) {
  const detail = await api.reboticsJson(token, 'GET',
    `/api/v1/tasks/${taskId}/processing/actions/${report.id}/?show_actions=below`);
  const payload = correctionPayloads(detail.report_actions || []);
  if (payload.length)
    await api.reboticsJson(token, 'PATCH', `/api/v4/processing/actions/${report.id}/update_actions/`, payload);
}
```

## Step 4 — Answer the survey (ALL items, not just required)

Store 63 tasks commonly have 200+ non-required textbox items. Answering only `required` items leaves `is_completed: false` and blocks `PUT completed`.

```js
const surveyId = task.survey?.id;
const responseId = task.result?.survey_response?.id;
const resp = await api.reboticsJson(token, 'GET', `/api/v1/surveys/${surveyId}/responses/${responseId}/`);

if (!resp.is_completed) {
  if (!resp.start_time)
    await api.reboticsJson(token, 'PUT', `/api/v1/surveys/${surveyId}/responses/${responseId}/start/`);

  const survey = await api.reboticsJson(token, 'GET', `/api/v1/surveys/${surveyId}/`);
  const existingIds = new Set((resp.answers || []).map(a => a.item));
  // Answer EVERY unanswered item — use '0' for all textbox/numeric items
  const batch = survey.items
    .filter(i => !existingIds.has(i.id))
    .map(i => ({ item: i.id, answer: '0' }));

  if (batch.length)
    await api.reboticsJson(token, 'PATCH',
      `/api/v1/surveys/${surveyId}/responses/${responseId}/`, { answers: batch });
}
```

## Step 5 — Close the blocking task

```js
await api.reboticsJson(token, 'PUT', `/api/v1/tasks/${blockingTaskId}/`, { status: 'completed' });
const final = await api.reboticsJson(token, 'GET', `/api/v1/tasks/${blockingTaskId}/`);
console.log(final.status?.id);   // completed
console.log(final.scan_status);  // DONE
```

## Step 6 — Retry all previously-blocked tasks

Once the blocker is closed, all other tasks for that store can be opened normally.

## Common failure modes

| Error | Cause | Fix |
|-------|-------|-----|
| `survey_required` on PUT completed | Survey has unanswered items (even non-required) | Answer ALL items (Step 4) |
| HTTP 409 on PUT | Task period has expired | Cannot complete via API; needs admin SI override |
| HTTP 400 still after blocker closed | Another task is now in_progress | Repeat Steps 1–5 for the new blocker |

## Notes

- `ReboticsApiError` has a `.body` property — always inspect `err.body`, not just `err.message`, to get the actual API response including the blocking task name.
- The "already working on another task" lock is store-scoped: one `in_progress` task per store blocks all other tasks for that store.
- Shift management (`openShift`/`closeShift`) does **not** bypass this lock — the lock is at the task level, not the shift level.
