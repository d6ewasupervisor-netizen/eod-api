---
name: rebotics-api-auth
description: Authenticates to Kroger Store Intelligence (Rebotics) at krcs.rebotics.net and resolves store/task IDs. Use when working with Rebotics API, Store Intelligence backlog, dbkey/POG closeout, scan corrections, maintenance tasks, or FM-to-custom_id mapping.
---

# Rebotics API auth and IDs

## API base

`https://krcs.rebotics.net` (override with `REBOTICS_API_BASE`)

## Token (preferred)

Load env from `rebotics-carry-forward/.env`:

```js
const reboticsApi = require('C:/Users/tgaut/rebotics-carry-forward/lib/rebotics-api');
const { token, userId, username } = await reboticsApi.fetchTokenFromRailway();
```

Requires `RAILWAY_URL` and `SAS_AUTH_SECRET` (or `REBOTICS_BRIDGE_SECRET`).

Fallback: `REBOTICS_TOKEN` env var.

## Request headers

```js
{
  Authorization: `Token ${token}`,
  'Accept-Language': 'en',
  'X-Timezone': 'America/Los_Angeles',
  'Content-Type': 'application/json',
}
```

## Store ID mapping

| FM store | `custom_id` | Example internal id |
|----------|-------------|---------------------|
| 214 | `701-00214` | `3859` |
| 286 | `701-00286` | `3863` |

```js
function fmToCustomId(fm) {
  const n = String(fm).trim().replace(/^0+/, '');
  return `701-${n.padStart(5, '0')}`;
}
await reboticsApi.resolveStoreInternalId(token, customId, { date: 'YYYY-MM-DD' });
```

## Task listing

```http
GET /api/v1/tasks/?store={storeId}&from_date={date}&to_date={date}&offset=0&limit=200
```

Backlog: `status.id === 'incomplete'`, `status_reason` includes `"Backlog"`.

For closeout of specific dbkeys, query **today** and match exact POG in title (e.g. `9159792`, `9007409`).

Older dates list stale regenerated instances — mutate only today's live task ID.

## Shift (required before mutating tasks)

```http
POST /api/v1/shifts/
{ "store": storeId, "user": userId, "uuid": "<uuid>", "start": "<iso>" }
```

## Constraints

- Only **one task `in_progress` per user**. Finish task A before `PUT in_progress` on task B at the same store.
- Task date filter must match the task's `start` date (`YYYY-MM-DD`).

### close-backlog-tasks.js global blocker

`close-backlog-tasks.js` queries **any** user `in_progress` task globally and may try to close an unrelated task at another store first.

When closing a specific dbkey and an unrelated store blocks:

1. Run `process-backlog-corrections.js --task {id}`
2. Survey answer `0`
3. **Direct** `PUT /api/v1/tasks/{taskId}/ { "status": "completed" }`

Do not mutate unrelated blockers without user approval.

## Repo scripts (kompass-netcap)

| Script | Purpose |
|--------|---------|
| `scripts/process-backlog-corrections.js` | Clear idle identify/add/move/remove |
| `scripts/close-backlog-tasks.js` | Batch close (can hit global blocker) |
| `scripts/upload-to-tasks-direct.js` | SAS photos → live task IDs |
| `scripts/extract-after-pictures.js` | SAS CSV → local JPGs + manifest |

## Related skills

- `rebotics-current-task-layer-closeout`
- `rebotics-upload-sas-after-pictures`
- `rebotics-blurry-photo-cv-bypass`
- `rebotics-task-photo-correct-ids`
- Scan action PATCHes: `rebotics-reject-identify-actions`, `rebotics-confirm-missing-add-actions`, `rebotics-accept-invader-remove-actions`, `rebotics-accept-wandering-move-actions`
